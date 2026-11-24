/**
 * 配置与环境变量解析（含容器 CPU 配额探测）。
 * 权威依据：docs/web-service-design.md §8.1
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 读取 cgroup v2/v1 的 CPU 配额（核数，可能是小数）；无限制返回 null */
function readCgroupCpuQuota() {
  // cgroup v2: /sys/fs/cgroup/cpu.max -> "400000 100000" | "max 100000"
  try {
    const raw = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim();
    const [quota, period] = raw.split(/\s+/);
    if (quota !== 'max') {
      const q = Number(quota);
      const p = Number(period);
      if (q > 0 && p > 0) return q / p;
    }
    return null;
  } catch {
    /* 落到 v1 */
  }
  // cgroup v1
  try {
    const q = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8').trim());
    const p = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8').trim());
    if (q > 0 && p > 0) return q / p;
  } catch {
    /* ignore */
  }
  return null;
}

/** 容器内可用 CPU 核数：优先 cgroup 配额，否则 os.availableParallelism() */
export function detectCpuCores() {
  const quota = readCgroupCpuQuota();
  if (quota) return Math.max(1, Math.floor(quota));
  return os.availableParallelism?.() ?? os.cpus().length ?? 1;
}

function envNum(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 非法（不是数字）: ${raw}`);
  return n;
}

function envInt(name, def, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Math.trunc(envNum(name, def));
  if (n < min || n > max) throw new Error(`环境变量 ${name} 超出范围 [${min}, ${max}]: ${n}`);
  return n;
}

function envBool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`环境变量 ${name} 非法（布尔）: ${raw}`);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** 项目根（src/..）：默认资产路径以此为基准，避免受 process.cwd() 影响 */
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** 相对路径按仓库根解析；绝对路径原样使用 */
function resolveAssetPath(value, fallbackRelative) {
  const p = value ?? fallbackRelative;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_ROOT, p);
}

const cpuCores = detectCpuCores();
const concurrency = envInt('CONCURRENCY', 1, { min: 1, max: 16 });
const ffmpegThreads = envInt('FFMPEG_THREADS', clamp(Math.floor(cpuCores / concurrency), 1, 16), {
  min: 1,
  max: 64,
});

// 默认 ./data：本地 npm start 开箱可用；容器内由 Dockerfile 的 ENV DATA_DIR=/data 覆盖
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'data');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: envInt('PORT', 3000, { min: 1, max: 65535 }),
  host: process.env.HOST ?? '0.0.0.0',

  // 可执行文件与模型
  ffmpegPath: resolveAssetPath(process.env.FFMPEG_PATH, 'ffmpeg/bin/ffmpeg'),
  ffprobePath: resolveAssetPath(process.env.FFPROBE_PATH, 'ffmpeg/bin/ffprobe'),
  vmafModelPath: resolveAssetPath(process.env.VMAF_MODEL, 'model/vmaf_v0.6.1.json'),

  // 存储
  dataDir,
  refsDir: path.join(dataDir, 'refs'),
  jobsDir: path.join(dataDir, 'jobs'),
  dbPath: path.join(dataDir, 'db.sqlite'),

  // 资源
  cpuCores,
  concurrency,
  ffmpegThreads,
  timeoutMs: envInt('TIMEOUT_MS', 30 * 60 * 1000, { min: 1000 }),

  // 限制
  maxFileMb: envInt('MAX_FILE_MB', 2048, { min: 1 }),
  maxJobMb: envInt('MAX_JOB_MB', 5120, { min: 1 }),
  maxQueue: envInt('MAX_QUEUE', 20, { min: 1 }),
  retentionDays: envInt('RETENTION_DAYS', 7, { min: 1 }),
  keepInputs: envBool('KEEP_INPUTS', false),

  // 鉴权（可选）
  authToken: process.env.AUTH_TOKEN?.trim() || null,
};

/** 启动前准备目录（失败应直接退出，属于配置错误） */
export function ensureDataDirs(cfg = config) {
  for (const dir of [cfg.dataDir, cfg.refsDir, cfg.jobsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function describeConfig(cfg = config) {
  return {
    env: cfg.env,
    cpuCores: cfg.cpuCores,
    concurrency: cfg.concurrency,
    ffmpegThreads: cfg.ffmpegThreads,
    dataDir: cfg.dataDir,
    ffmpegPath: cfg.ffmpegPath,
    ffprobePath: cfg.ffprobePath,
    vmafModelPath: cfg.vmafModelPath,
    maxFileMb: cfg.maxFileMb,
    maxJobMb: cfg.maxJobMb,
    keepInputs: cfg.keepInputs,
    auth: cfg.authToken ? 'enabled' : 'disabled',
  };
}
