/**
 * 任务接口：创建 / 查询 / 取消 / 删除 / 报告下载。
 * 权威依据：docs/web-service-design.md §4.4 §4.5
 */
import path from 'node:path';
import fsp from 'node:fs/promises';

import { AppError } from '../lib/errors.js';
import { probeVideo } from '../lib/ffprobe.js';
import { parseMetricsParam } from '../lib/ffmpeg.js';
import { newId, safeExtension, sanitizeDisplayName, savePartToFile, ensureDir, removeDir } from '../lib/upload.js';
import { safeParseJson } from '../lib/db.js';

const nowIso = () => new Date().toISOString();

/** 统一的 job 对外表示 */
function jobSummary(db, row) {
  const counts = db.countItemsByStatus(row.id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    jobId: row.id,
    status: row.status,
    metrics: String(row.metrics).split(',').filter(Boolean),
    referenceId: row.reference_id,
    progress: { total, done: counts.done, failed: counts.failed, skipped: counts.skipped, pending: counts.queued + counts.probing + counts.running },
    normalization: safeParseJson(row.normalization),
    error: row.error ?? null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function jobDetail(db, row) {
  const items = db.listItems(row.id);
  return {
    ...jobSummary(db, row),
    items: items.map((it) => {
      const metrics = {};
      if (it.psnr !== null) metrics.psnr = { mean: it.psnr };
      if (it.psnr_min !== null) (metrics.psnr ??= {}).min = it.psnr_min;
      if (it.ssim !== null) metrics.ssim = { mean: it.ssim };
      if (it.vmaf !== null) metrics.vmaf = { mean: it.vmaf };
      if (it.vmaf_min !== null) (metrics.vmaf ??= {}).min = it.vmaf_min;
      if (it.vmaf_harmonic !== null) (metrics.vmaf ??= {}).harmonicMean = it.vmaf_harmonic;
      return {
        itemId: it.id,
        seq: it.seq,
        name: it.orig_name,
        status: it.status,
        sizeBytes: it.size_bytes,
        probe: safeParseJson(it.probe_json),
        compared: { frames: it.compared_frames, seconds: it.compared_seconds },
        metrics,
        elapsedMs: it.elapsed_ms,
        error: it.error ?? null,
      };
    }),
  };
}

export async function registerJobRoutes(app, { cfg, db, queue, selfCheck }) {
  /** 创建任务：1 个参考（referenceId 复用 或 reference 文件）+ N 个 targets */
  app.post('/api/jobs', async (req, reply) => {
    if (!req.isMultipart()) {
      throw new AppError('INVALID_MULTIPART', '请求必须是 multipart/form-data', { status: 400 });
    }

    // 未就绪（ffmpeg/模型缺失、数据目录不可写）时拒绝建任务，避免必然失败的任务堆积
    if (selfCheck) {
      const ready = await selfCheck.fresh().catch(() => null);
      if (ready && !ready.ok) {
        const failed = ready.checks.filter((c) => !c.ok).map((c) => c.name).join(', ');
        throw new AppError('NOT_READY', `服务未就绪，拒绝创建任务（未通过: ${failed}）`, { status: 503 });
      }
    }

    // 队列上限
    const active = db.countActiveJobs();
    if (active >= cfg.maxQueue) {
      throw new AppError('QUEUE_FULL', `队列已满（${active}/${cfg.maxQueue}），请稍后重试`, { status: 429 });
    }

    const jobId = newId('job');
    const inputsDir = await ensureDir(path.join(cfg.jobsDir, jobId, 'inputs'));
    const maxFileBytes = cfg.maxFileMb * 1024 * 1024;
    const maxJobBytes = cfg.maxJobMb * 1024 * 1024;

    const fields = {};
    const targets = [];
    let referenceUpload = null; // { origName, storedPath, sizeBytes, sha256 }
    let totalBytes = 0;
    let aborted = false;

    const cleanup = async () => {
      await removeDir(path.join(cfg.jobsDir, jobId));
      if (referenceUpload) await removeDir(path.dirname(referenceUpload.storedPath));
    };

    try {
      const parts = req.parts({
        limits: { fileSize: maxFileBytes, files: 201, fields: 20, parts: 220 },
      });

      for await (const part of parts) {
        if (part.type === 'field') {
          fields[part.fieldname] = part.value;
          continue;
        }

        // 文件
        const origName = sanitizeDisplayName(part.filename);
        const ext = safeExtension(origName);

        if (part.fieldname === 'reference') {
          if (referenceUpload) {
            throw new AppError('INVALID_MULTIPART', '只能上传一个 reference 文件', { status: 400 });
          }
          const refDir = await ensureDir(path.join(cfg.refsDir, `tmp_${jobId}`));
          const storedPath = path.join(refDir, `source${ext}`);
          const saved = await savePartToFile(part, storedPath, { maxBytes: maxFileBytes });
          totalBytes += saved.bytes;
          referenceUpload = { origName, storedPath, sizeBytes: saved.bytes, sha256: saved.sha256 };
        } else if (part.fieldname === 'targets') {
          const itemId = newId('itm');
          const storedPath = path.join(inputsDir, `${itemId}${ext}`);
          const saved = await savePartToFile(part, storedPath, { maxBytes: maxFileBytes });
          totalBytes += saved.bytes;
          if (totalBytes > maxJobBytes) {
            throw new AppError(
              'JOB_TOO_LARGE',
              `任务总大小超过上限 ${cfg.maxJobMb} MB`,
              { status: 413 },
            );
          }
          targets.push({ itemId, origName, storedPath, sizeBytes: saved.bytes });
        } else {
          throw new AppError('INVALID_MULTIPART', `不支持的文件字段 ${part.fieldname}（应为 reference 或 targets）`, {
            status: 400,
          });
        }
      }
    } catch (err) {
      aborted = true;
      await cleanup();
      throw err;
    }

    if (aborted) return null; // 保险，正常不会走到

    try {
      // ---- 指标 ----
      const metrics = parseMetricsParam(fields.metrics);
      if (targets.length === 0) {
        throw new AppError('NO_TARGETS', '至少需要上传一个待测视频（字段名 targets）', { status: 400 });
      }

      // ---- 参考视频 ----
      let reference = null;
      if (fields.referenceId) {
        reference = db.getReference(String(fields.referenceId).trim());
        if (!reference) {
          throw new AppError('REFERENCE_NOT_FOUND', `参考视频不存在: ${fields.referenceId}`, { status: 404 });
        }
        if (referenceUpload) await removeDir(path.dirname(referenceUpload.storedPath));
      } else if (referenceUpload) {
        const existing = db.findReferenceBySha(referenceUpload.sha256);
        if (existing && (await fsp.stat(existing.storedPath).then(() => true).catch(() => false))) {
          await removeDir(path.dirname(referenceUpload.storedPath));
          reference = existing;
        } else {
          let probe;
          try {
            probe = await probeVideo(cfg.ffprobePath, referenceUpload.storedPath);
          } catch (err) {
            throw new AppError(err.code ?? 'PROBE_FAILED', `参考视频探测失败: ${err.message}`, { status: 422 });
          }
          const refId = newId('ref');
          const finalDir = await ensureDir(path.join(cfg.refsDir, refId));
          const finalPath = path.join(finalDir, `source${path.extname(referenceUpload.storedPath)}`);
          await fsp.rename(referenceUpload.storedPath, finalPath).catch(async () => {
            await fsp.copyFile(referenceUpload.storedPath, finalPath);
          });
          await removeDir(path.dirname(referenceUpload.storedPath));
          reference = db.insertReference({
            id: refId,
            origName: referenceUpload.origName,
            storedPath: finalPath,
            sizeBytes: referenceUpload.sizeBytes,
            sha256: referenceUpload.sha256,
            probe,
            createdAt: nowIso(),
          });
        }
      } else {
        throw new AppError('INVALID_MULTIPART', '需要提供 referenceId（复用）或 reference 文件', { status: 400 });
      }
      db.touchReference(reference.id);

      // ---- 可选参数 ----
      const fpsOverride = fields.fpsOverride !== undefined && fields.fpsOverride !== '' ? Number(fields.fpsOverride) : null;
      if (fpsOverride !== null && (!Number.isFinite(fpsOverride) || fpsOverride <= 0)) {
        throw new AppError('INVALID_PARAM', `fpsOverride 非法: ${fields.fpsOverride}`, { status: 400 });
      }
      const maxDurationS =
        fields.maxDurationS !== undefined && fields.maxDurationS !== '' ? Number(fields.maxDurationS) : null;
      if (maxDurationS !== null && (!Number.isFinite(maxDurationS) || maxDurationS <= 0)) {
        throw new AppError('INVALID_PARAM', `maxDurationS 非法: ${fields.maxDurationS}`, { status: 400 });
      }

      // ---- 建任务 ----
      db.insertJob({
        id: jobId,
        status: 'queued',
        metrics,
        referenceId: reference.id,
        ffmpegThreads: cfg.ffmpegThreads,
        fpsOverride,
        maxDurationS,
        createdAt: nowIso(),
      });
      db.insertItems(
        jobId,
        targets.map((t, i) => ({
          id: t.itemId,
          origName: t.origName,
          storedPath: t.storedPath,
          sizeBytes: t.sizeBytes,
          seq: i + 1,
          status: 'queued',
        })),
      );

      queue.notify();

      reply.code(202);
      return {
        jobId,
        status: 'queued',
        metrics,
        referenceId: reference.id,
        items: targets.map((t, i) => ({ itemId: t.itemId, seq: i + 1, name: t.origName, status: 'queued' })),
        createdAt: nowIso(),
      };
    } catch (err) {
      await cleanup();
      throw err;
    }
  });

  /** 任务列表 */
  app.get('/api/jobs', async (req) => {
    const limit = Math.min(Number(req.query?.limit ?? 20) || 20, 100);
    const offset = Math.max(Number(req.query?.offset ?? 0) || 0, 0);
    const status = req.query?.status ? String(req.query.status) : undefined;
    const rows = db.listJobs({ limit, offset, status });
    return { items: rows.map((r) => jobSummary(db, r)), limit, offset };
  });

  /** 任务详情 */
  app.get('/api/jobs/:id', async (req) => {
    const row = db.getJobRow(req.params.id);
    if (!row) throw new AppError('JOB_NOT_FOUND', `任务不存在: ${req.params.id}`, { status: 404 });
    return jobDetail(db, row);
  });

  /** 取消任务 */
  app.post('/api/jobs/:id/cancel', async (req) => {
    const row = queue.cancel(req.params.id);
    return jobSummary(db, row);
  });

  /** 删除任务与产物 */
  app.delete('/api/jobs/:id', async (req, reply) => {
    const row = db.getJobRow(req.params.id);
    if (!row) throw new AppError('JOB_NOT_FOUND', `任务不存在: ${req.params.id}`, { status: 404 });
    if (['queued', 'running'].includes(row.status)) {
      queue.cancel(row.id);
    }
    await removeDir(path.join(cfg.jobsDir, row.id));
    db.deleteJob(row.id);
    reply.code(204);
    return null;
  });

  /** 报告文件 */
  const reportFile = (name, contentType, disposition) => async (req, reply) => {
    const row = db.getJobRow(req.params.id);
    if (!row) throw new AppError('JOB_NOT_FOUND', `任务不存在: ${req.params.id}`, { status: 404 });
    const filePath = path.join(cfg.jobsDir, row.id, name);
    if (!(await fsp.stat(filePath).then(() => true).catch(() => false))) {
      throw new AppError('REPORT_NOT_READY', `报告尚未生成（任务状态: ${row.status}）`, { status: 404 });
    }
    reply.type(contentType);
    reply.header('Content-Disposition', `${disposition}; filename="${row.id}-${name}"`);
    return reply.send(await fsp.readFile(filePath));
  };

  app.get('/api/jobs/:id/report.csv', reportFile('report.csv', 'text/csv; charset=utf-8', 'attachment'));
  app.get('/api/jobs/:id/report.html', reportFile('report.html', 'text/html; charset=utf-8', 'inline'));
  app.get('/api/jobs/:id/result.json', reportFile('result.json', 'application/json; charset=utf-8', 'inline'));
}
