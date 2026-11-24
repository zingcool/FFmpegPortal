/**
 * 任务队列与执行器。
 * 权威依据：docs/web-service-design.md §8
 *
 * 设计取舍：默认同时只跑 1 个 ffmpeg 进程（吃满配额核心）。
 * VMAF 本身已是多线程 CPU 密集任务，再叠多进程并行会让各进程互相抢核心，
 * 总吞吐不增反降且内存峰值不可控。需要吞吐应加容器副本。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { probeVideo } from './ffprobe.js';
import { decideNormalization } from './normalize.js';
import { runComparison } from './ffmpeg.js';
import { buildCsv, buildHtml, buildResultJson } from './report.js';
import { ensureDir, removeDir } from './upload.js';
import { AppError } from './errors.js';

const nowIso = () => new Date().toISOString();

/** 给命令做可读的 shell 展示（仅用于日志/复现，不执行） */
function formatCommand(bin, args) {
  return [bin, ...args]
    .map((a) => (/[\s;'"$`|&<>()]/.test(a) ? `'${String(a).replace(/'/g, `'\\''`)}'` : a))
    .join(' ');
}

export class JobQueue {
  #db;
  #cfg;
  #log;
  #ffmpegVersion;
  #runningJobs = new Set();
  #current = null; // { jobId, itemId, kill }
  #stopping = false;
  #idleWaiters = [];

  constructor({ db, cfg, log = console, ffmpegVersion = '' }) {
    this.#db = db;
    this.#cfg = cfg;
    this.#log = log;
    this.#ffmpegVersion = ffmpegVersion;
  }

  /** 启动：恢复中断任务并开始调度 */
  start() {
    const rec = this.#db.recoverInterrupted();
    if (rec.items || rec.jobs) {
      this.#log.warn?.(`启动恢复：${rec.items} 个 item / ${rec.jobs} 个任务 从「进行中」回退为「排队」`);
    }
    this.notify();
  }

  /** 有新任务入库时调用 */
  notify() {
    if (this.#stopping) return;
    setImmediate(() => this.#pump());
  }

  get activeCount() {
    return this.#runningJobs.size;
  }

  #pump() {
    if (this.#stopping) return;
    while (this.#runningJobs.size < this.#cfg.concurrency) {
      const jobId = this.#db.findNextPendingJobId([...this.#runningJobs]);
      if (!jobId || this.#runningJobs.has(jobId)) break;
      this.#runningJobs.add(jobId);
      this.#runJob(jobId)
        .catch((err) => this.#log.error?.({ err, jobId }, '任务执行异常'))
        .finally(() => {
          this.#runningJobs.delete(jobId);
          this.#pump();
          if (this.#runningJobs.size === 0) this.#drainIdleWaiters();
        });
    }
    if (this.#runningJobs.size === 0) this.#drainIdleWaiters();
  }

  #drainIdleWaiters() {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const w of waiters) w();
  }

  /** 等待队列空闲（测试用） */
  async drain() {
    if (this.#runningJobs.size === 0) return;
    await new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #runJob(jobId) {
    let job = this.#db.getJobRow(jobId);
    if (!job) return;
    if (job.status === 'canceled') return;

    if (job.status === 'queued') {
      this.#db.updateJob(jobId, { status: 'running', started_at: nowIso() });
      job = this.#db.getJobRow(jobId);
    }

    const ref = this.#db.getReference(job.reference_id);
    if (!ref) {
      this.#failJob(jobId, '参考视频不存在或已被删除');
      return;
    }
    this.#db.touchReference(ref.id);

    const refProbe = ref.probe;
    if (!refProbe || !refProbe.width) {
      this.#failJob(jobId, '参考视频缺少有效的探测信息');
      return;
    }

    // 逐个 item 处理（顺序执行；并发由 concurrency 控制「同时跑几个任务」）
    for (;;) {
      if (this.#stopping) {
        // 停机中：把任务退回排队，保留 inputs 供重启后续跑
        this.#db.updateJob(jobId, { status: 'queued', started_at: null });
        this.#log.warn?.({ jobId }, '服务停机，任务已退回排队');
        return;
      }
      const cur = this.#db.getJobRow(jobId);
      if (!cur || cur.status === 'canceled') {
        this.#db.skipQueuedItems(jobId);
        return; // 取消由 cancel() 负责收尾
      }
      const item = this.#db.findNextQueuedItem(jobId);
      if (!item) break;
      await this.#processItem(cur, item, refProbe);
    }

    await this.#finalize(jobId);
  }

  async #processItem(job, item, refProbe) {
    const jobDir = path.join(this.#cfg.jobsDir, job.id);
    const logsDir = path.join(jobDir, 'logs');
    await ensureDir(logsDir);

    // ---- 探测 ----
    this.#db.updateItem(item.id, { status: 'probing', started_at: nowIso() });
    let probe;
    try {
      probe = await probeVideo(this.#cfg.ffprobePath, item.stored_path);
    } catch (err) {
      this.#failItem(item.id, err);
      return;
    }

    // ---- 归一化 ----
    let norm;
    try {
      norm = decideNormalization(refProbe, probe, {
        maxDurationS: job.max_duration_s ?? undefined,
        fpsOverride: job.fps_override ?? undefined,
      });
    } catch (err) {
      this.#failItem(item.id, err);
      return;
    }

    // 任务级归一化快照（用于报告展示；各 item 的帧率/时长可能略有差异）
    if (!job.normalization) {
      this.#db.updateJob(job.id, {
        normalization: {
          width: norm.width,
          height: norm.height,
          fps: norm.fps,
          durationS: norm.durationS,
          pixFmt: norm.pixFmt,
          reference: refProbe,
        },
      });
    }

    const metrics = String(job.metrics).split(',').filter(Boolean);
    const vmafJsonPath = metrics.includes('vmaf') ? path.join(logsDir, `${item.id}.vmaf.json`) : null;

    this.#db.updateItem(item.id, {
      status: 'running',
      probe_json: probe,
      compared_seconds: norm.durationS,
      compared_frames: norm.comparedFrames,
    });

    // ---- 执行 ----
    try {
      const res = await runComparison({
        ffmpegPath: this.#cfg.ffmpegPath,
        targetPath: item.stored_path,
        referencePath: this.#db.getReference(job.reference_id).storedPath,
        norm,
        metrics,
        modelPath: this.#cfg.vmafModelPath,
        threads: job.ffmpeg_threads ?? this.#cfg.ffmpegThreads,
        vmafJsonPath,
        timeoutMs: this.#cfg.timeoutMs,
        onChild: (c) => {
          this.#current = { jobId: job.id, itemId: item.id, kill: c.kill };
        },
      });

      this.#db.updateItem(item.id, {
        status: 'done',
        psnr: res.metrics.psnr?.mean ?? null,
        psnr_min: res.metrics.psnr?.min ?? null,
        ssim: res.metrics.ssim?.mean ?? null,
        vmaf: res.metrics.vmaf?.mean ?? null,
        vmaf_min: res.metrics.vmaf?.min ?? null,
        vmaf_harmonic: res.metrics.vmaf?.harmonicMean ?? null,
        compared_frames: res.frames ?? norm.comparedFrames,
        elapsed_ms: res.elapsedMs,
        ffmpeg_cmd: formatCommand(this.#cfg.ffmpegPath, res.args),
        finished_at: nowIso(),
      });
    } catch (err) {
      const jobNow = this.#db.getJobRow(job.id);
      if (jobNow?.status === 'canceled') {
        // 任务已被取消导致的失败不算失败，标记为跳过
        this.#db.updateItem(item.id, { status: 'skipped', error: '任务已取消', finished_at: nowIso() });
      } else if (this.#stopping) {
        // 服务停机导致的中断：退回排队，重启后继续（不可判失败，否则会丢任务）
        this.#db.updateItem(item.id, { status: 'queued', started_at: null, error: null });
        this.#log.warn?.({ itemId: item.id }, '服务停机，item 已退回排队等待重启后继续');
      } else {
        this.#failItem(item.id, err, { logsDir, stderrTail: err?.details?.stderrTail });
      }
    } finally {
      this.#current = null;
    }
  }

  #failItem(itemId, err, { logsDir, stderrTail } = {}) {
    const message = `${err?.code ? `[${err.code}] ` : ''}${err?.message ?? '未知错误'}`;
    let logPath = null;
    if (logsDir && stderrTail) {
      logPath = path.join(logsDir, `${itemId}.log`);
      // 同步写，避免与后续清理竞态；仅保留末尾一段
      try {
        fs.writeFileSync(logPath, String(stderrTail).slice(-256 * 1024), 'utf8');
      } catch {
        logPath = null;
      }
    }
    this.#db.updateItem(itemId, {
      status: 'failed',
      error: message.slice(0, 2000),
      log_path: logPath,
      finished_at: nowIso(),
    });
    this.#log.warn?.({ itemId, err: message }, '待测项评分失败');
  }

  #failJob(jobId, message) {
    this.#db.updateJob(jobId, { status: 'failed', error: message, finished_at: nowIso() });
    this.#log.error?.({ jobId, message }, '任务失败');
  }

  /** 汇总报告生成 + 输入清理 */
  async #finalize(jobId) {
    const job0 = this.#db.getJobRow(jobId);
    if (!job0) return;
    if (job0.status === 'canceled') return;

    const counts = this.#db.countItemsByStatus(jobId);
    // 仍有未完成项（停机/中断）时不收尾，避免误删 inputs 或误判最终状态
    if (counts.queued + counts.probing + counts.running > 0) {
      this.#db.updateJob(jobId, { status: 'queued', started_at: null });
      this.#log.warn?.({ jobId, counts }, '仍有未完成项，跳过收尾并退回排队');
      return;
    }
    const ok = counts.done > 0;

    // 先落最终状态，再生成报告 —— 否则 report/result.json 里会残留 running
    this.#db.updateJob(jobId, {
      status: ok ? 'done' : 'failed',
      finished_at: nowIso(),
      error: ok ? null : '所有待测视频均评分失败',
    });

    const job = this.#db.getJobRow(jobId);
    const items = this.#db.listItems(jobId);
    const jobDir = path.join(this.#cfg.jobsDir, jobId);
    await ensureDir(jobDir);

    try {
      const csv = buildCsv(job, items);
      await fsp.writeFile(path.join(jobDir, 'report.csv'), `\uFEFF${csv}`, 'utf8');

      const html = buildHtml(job, items, { ffmpegVersion: this.#ffmpegVersion });
      await fsp.writeFile(path.join(jobDir, 'report.html'), html, 'utf8');

      const result = buildResultJson(job, items);
      await fsp.writeFile(path.join(jobDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      this.#log.error?.({ err, jobId }, '生成报告失败');
      this.#failJob(jobId, `生成报告失败: ${err.message}`);
      return;
    }

    if (!this.#cfg.keepInputs) {
      await removeDir(path.join(jobDir, 'inputs'));
    }

    this.#log.info?.({ jobId, done: counts.done, failed: counts.failed }, '任务完成');
  }

  /** 取消任务：标记状态、跳过剩余项、终止正在跑的 ffmpeg */
  cancel(jobId) {
    const job = this.#db.getJobRow(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', `任务不存在: ${jobId}`, { status: 404 });
    if (['done', 'failed', 'canceled'].includes(job.status)) {
      throw new AppError('JOB_ALREADY_FINISHED', `任务已结束（${job.status}），无法取消`, { status: 409 });
    }

    this.#db.updateJob(jobId, { status: 'canceled', finished_at: nowIso() });
    this.#db.skipQueuedItems(jobId);

    if (this.#current?.jobId === jobId) {
      this.#log.info?.({ jobId, itemId: this.#current.itemId }, '取消任务：终止正在运行的 ffmpeg');
      this.#current.kill('SIGTERM');
      setTimeout(() => {
        if (this.#current?.jobId === jobId) this.#current.kill('SIGKILL');
      }, 5000).unref?.();
    }
    return this.#db.getJobRow(jobId);
  }

  /** 停机：停止调度并终止在跑的进程 */
  async shutdown({ timeoutMs = 8000 } = {}) {
    this.#stopping = true;
    if (this.#current) {
      try {
        this.#current.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    const started = Date.now();
    while (this.#runningJobs.size > 0 && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.#runningJobs.size > 0 && this.#current) {
      try {
        this.#current.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}
