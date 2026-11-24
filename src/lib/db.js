/**
 * SQLite 数据层（Node 24 内置 node:sqlite，无原生编译依赖）。
 * 权威依据：docs/web-service-design.md §5
 */
import { DatabaseSync } from 'node:sqlite';

/** 值为 undefined / 布尔 / 对象时统一转换，避免 node:sqlite 类型报错 */
function toDbValue(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS references_ (
  id           TEXT PRIMARY KEY,
  orig_name    TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  probe_json   TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  fps          REAL,
  duration_s   REAL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ref_sha ON references_(sha256);

CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  metrics        TEXT NOT NULL,
  reference_id   TEXT,
  normalization  TEXT,
  ffmpeg_threads INTEGER,
  fps_override    REAL,
  max_duration_s  REAL,
  error          TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS job_items (
  id                TEXT PRIMARY KEY,
  job_id            TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  orig_name         TEXT NOT NULL,
  stored_path       TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  status            TEXT NOT NULL,
  probe_json        TEXT,
  compared_frames   INTEGER,
  compared_seconds  REAL,
  psnr              REAL,
  psnr_min          REAL,
  ssim              REAL,
  vmaf              REAL,
  vmaf_min          REAL,
  vmaf_harmonic     REAL,
  elapsed_ms        INTEGER,
  ffmpeg_cmd        TEXT,
  log_path          TEXT,
  error             TEXT,
  started_at        TEXT,
  finished_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_job ON job_items(job_id, seq);

PRAGMA user_version = 1;
`;

export class Db {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** 轻量迁移：为已存在的库补齐新增列（忽略「列已存在」错误） */
  #migrate() {
    const wanted = [
      ['jobs', 'fps_override', 'REAL'],
      ['jobs', 'max_duration_s', 'REAL'],
    ];
    for (const [table, column, type] of wanted) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        /* 已存在 */
      }
    }
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  // ---------- 通用 ----------

  #updateById(table, id, patch) {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (keys.length === 0) return 0;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const stmt = this.db.prepare(`UPDATE ${table} SET ${sets} WHERE id = ?`);
    const res = stmt.run(...keys.map((k) => toDbValue(patch[k])), id);
    return Number(res.changes ?? 0);
  }

  // ---------- 参考视频 ----------

  insertReference(ref) {
    this.db
      .prepare(
        `INSERT INTO references_
         (id, orig_name, stored_path, size_bytes, sha256, probe_json, width, height, fps, duration_s, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ref.id,
        ref.origName,
        ref.storedPath,
        ref.sizeBytes,
        ref.sha256,
        toDbValue(ref.probe),
        ref.probe?.width ?? null,
        ref.probe?.height ?? null,
        ref.probe?.fps ?? null,
        ref.probe?.durationS ?? null,
        ref.createdAt,
        null,
      );
    return this.getReference(ref.id);
  }

  getReference(id) {
    const row = this.db.prepare('SELECT * FROM references_ WHERE id = ?').get(id);
    return row ? hydrateReference(row) : null;
  }

  findReferenceBySha(sha256) {
    const row = this.db.prepare('SELECT * FROM references_ WHERE sha256 = ? ORDER BY created_at LIMIT 1').get(sha256);
    return row ? hydrateReference(row) : null;
  }

  listReferences({ limit = 50, offset = 0 } = {}) {
    return this.db
      .prepare('SELECT * FROM references_ ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset)
      .map(hydrateReference);
  }

  touchReference(id, at = new Date().toISOString()) {
    this.db.prepare('UPDATE references_ SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  deleteReference(id) {
    return Number(this.db.prepare('DELETE FROM references_ WHERE id = ?').run(id).changes ?? 0);
  }

  // ---------- 任务 ----------

  insertJob(job) {
    this.db
      .prepare(
        `INSERT INTO jobs (id, status, metrics, reference_id, normalization, ffmpeg_threads,
                           fps_override, max_duration_s, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.status,
        job.metrics.join(','),
        job.referenceId ?? null,
        toDbValue(job.normalization ?? null),
        job.ffmpegThreads ?? null,
        job.fpsOverride ?? null,
        job.maxDurationS ?? null,
        job.createdAt,
      );
    return this.getJobRow(job.id);
  }

  getJobRow(id) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  updateJob(id, patch) {
    return this.#updateById('jobs', id, patch);
  }

  listJobs({ limit = 20, offset = 0, status } = {}) {
    if (status) {
      return this.db
        .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(status, limit, offset);
    }
    return this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset);
  }

  /** 取最早一个还有待处理 item 的任务（可排除本进程已在处理的） */
  findNextPendingJobId(excludeIds = []) {
    const ex = excludeIds.filter(Boolean);
    const notIn = ex.length ? `AND j.id NOT IN (${ex.map(() => '?').join(',')})` : '';
    const row = this.db
      .prepare(
        `SELECT DISTINCT j.id, j.created_at
         FROM jobs j JOIN job_items i ON i.job_id = j.id
         WHERE j.status IN ('queued', 'running') AND i.status IN ('queued', 'probing', 'running')
         ${notIn}
         ORDER BY j.created_at ASC LIMIT 1`,
      )
      .get(...ex);
    return row?.id ?? null;
  }

  /** 把任务内仍排队/进行中的 item 标记为 skipped（取消任务时用） */
  skipQueuedItems(jobId, at = new Date().toISOString()) {
    const res = this.db
      .prepare(
        "UPDATE job_items SET status = 'skipped', finished_at = ? WHERE job_id = ? AND status IN ('queued','probing','running')",
      )
      .run(at, jobId);
    return Number(res.changes ?? 0);
  }

  /** 已结束且 finished_at 早于 cutoff 的任务（用于保留期清理） */
  listFinishedJobsBefore(cutoffIso) {
    return this.db
      .prepare(
        `SELECT id FROM jobs
         WHERE status IN ('done','failed','canceled') AND finished_at IS NOT NULL AND finished_at < ?`,
      )
      .all(cutoffIso);
  }

  /** 活跃任务数（排队中 + 运行中），用于队列上限判断 */
  countActiveJobs() {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get();
    return Number(row?.n ?? 0);
  }

  deleteJob(id) {
    // 无外键级联（node:sqlite 下显式删除更可控）
    this.db.prepare('DELETE FROM job_items WHERE job_id = ?').run(id);
    return Number(this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes ?? 0);
  }

  /** 计数：用于 /api/jobs 列表摘要 */
  countItemsByStatus(jobId) {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM job_items WHERE job_id = ? GROUP BY status')
      .all(jobId);
    const out = { queued: 0, probing: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const r of rows) out[r.status] = Number(r.n);
    return out;
  }

  // ---------- 任务明细 ----------

  insertItems(jobId, items) {
    const stmt = this.db.prepare(
      `INSERT INTO job_items (id, job_id, seq, orig_name, stored_path, size_bytes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const it of items) {
      if (!it.id) throw new Error(`insertItems: 缺少 item id（收到: ${Object.keys(it).join(',')}）`);
      if (!it.storedPath) throw new Error(`insertItems: 缺少 storedPath（item ${it.id}）`);
      stmt.run(it.id, jobId, it.seq, it.origName, it.storedPath, it.sizeBytes, it.status);
    }
  }

  getItem(id) {
    return this.db.prepare('SELECT * FROM job_items WHERE id = ?').get(id) ?? null;
  }

  listItems(jobId) {
    return this.db.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY seq ASC').all(jobId);
  }

  updateItem(id, patch) {
    return this.#updateById('job_items', id, patch);
  }

  /** 取任务内下一个 queued item */
  findNextQueuedItem(jobId) {
    return this.db
      .prepare("SELECT * FROM job_items WHERE job_id = ? AND status = 'queued' ORDER BY seq ASC LIMIT 1")
      .get(jobId) ?? null;
  }

  // ---------- 启动恢复 ----------

  /** 进程重启后，把「进行中」状态回退为「排队」，避免任务永久卡住 */
  recoverInterrupted() {
    const a = this.db.prepare("UPDATE job_items SET status = 'queued' WHERE status IN ('probing', 'running')").run();
    const b = this.db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run();
    return { items: Number(a.changes ?? 0), jobs: Number(b.changes ?? 0) };
  }
}

function hydrateReference(row) {
  return {
    id: row.id,
    origName: row.orig_name,
    storedPath: row.stored_path,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    probe: safeJson(row.probe_json),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

function safeJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function safeParseJson(s) {
  return safeJson(s);
}

export function openDb(dbPath) {
  return new Db(dbPath);
}
