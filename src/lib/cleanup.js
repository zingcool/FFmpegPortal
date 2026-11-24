/**
 * 保留期清理与孤儿文件清扫。
 * 权威依据：docs/web-service-design.md §6
 *
 * 两类清理：
 *  1. 保留期（RETENTION_DAYS）：已结束任务超过保留期的，删除任务目录与数据库记录
 *  2. 孤儿扫描：磁盘上存在但数据库无记录的 jobs/<id>、refs/<id> 目录一律删除
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class CleanupService {
  #cfg;
  #db;
  #log;
  #timer = null;

  constructor({ cfg, db, log = console }) {
    this.#cfg = cfg;
    this.#db = db;
    this.#log = log;
  }

  /** 启动：先扫一次孤儿，再按小时级周期执行 */
  start() {
    this.sweep().catch((err) => this.#log.error?.({ err }, '清理失败'));
    const intervalMs = Math.min(this.#cfg.retentionDays * 24 * 3600 * 1000, 3600 * 1000);
    this.#timer = setInterval(() => {
      this.sweep().catch((err) => this.#log.error?.({ err }, '清理失败'));
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 执行一次完整清理，返回统计 */
  async sweep() {
    const stats = { expiredJobs: 0, orphanJobs: 0, orphanRefs: 0, bytesFreed: 0 };

    // ---- 1. 保留期清理 ----
    const cutoff = Date.now() - this.#cfg.retentionDays * 24 * 3600 * 1000;
    for (const row of this.#db.listFinishedJobsBefore(new Date(cutoff).toISOString())) {
      const dir = path.join(this.#cfg.jobsDir, row.id);
      stats.bytesFreed += await dirSize(dir);
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      this.#db.deleteJob(row.id);
      stats.expiredJobs++;
    }

    // ---- 2. 孤儿目录清理 ----
    for (const entry of await listDirs(this.#cfg.jobsDir)) {
      if (!this.#db.getJobRow(entry.name)) {
        const dir = path.join(this.#cfg.jobsDir, entry.name);
        stats.bytesFreed += await dirSize(dir);
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        stats.orphanJobs++;
      }
    }
    for (const entry of await listDirs(this.#cfg.refsDir)) {
      if (!this.#db.getReference(entry.name)) {
        const dir = path.join(this.#cfg.refsDir, entry.name);
        stats.bytesFreed += await dirSize(dir);
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        stats.orphanRefs++;
      }
    }

    const total = stats.expiredJobs + stats.orphanJobs + stats.orphanRefs;
    if (total > 0) {
      this.#log.info?.(
        { ...stats, freedMB: (stats.bytesFreed / 1048576).toFixed(1) },
        '清理完成',
      );
    }
    return stats;
  }
}

async function listDirs(root) {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory());
  } catch {
    return [];
  }
}

async function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += await dirSize(p);
      else if (entry.isFile()) total += (await fsp.stat(p)).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

export { fs };
