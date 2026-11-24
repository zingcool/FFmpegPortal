/**
 * 启动自检：验证 ffmpeg / ffprobe / VMAF 模型可用。
 * /readyz 依赖本模块；不通过时服务应视为「未就绪」。
 */
import fs from 'node:fs';
import { probeBinaryVersion, listFilters } from './runner.js';

const REQUIRED_FILTERS = ['psnr', 'ssim', 'libvmaf'];

/**
 * @returns {Promise<{ok:boolean, checks:Array<{name:string,ok:boolean,detail:string}>, versions:object}>}
 */
export async function runSelfCheck(cfg) {
  const checks = [];
  const versions = {};
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  // 1. 可执行文件存在
  add('ffmpeg:exists', fs.existsSync(cfg.ffmpegPath), cfg.ffmpegPath);
  add('ffprobe:exists', fs.existsSync(cfg.ffprobePath), cfg.ffprobePath);

  // 2. 可执行 + 版本
  try {
    versions.ffmpeg = await probeBinaryVersion(cfg.ffmpegPath);
    add('ffmpeg:exec', true, versions.ffmpeg);
  } catch (err) {
    add('ffmpeg:exec', false, err.message);
  }
  try {
    versions.ffprobe = await probeBinaryVersion(cfg.ffprobePath);
    add('ffprobe:exec', true, versions.ffprobe);
  } catch (err) {
    add('ffprobe:exec', false, err.message);
  }

  // 3. 关键滤波器
  try {
    const filters = await listFilters(cfg.ffmpegPath);
    for (const f of REQUIRED_FILTERS) {
      add(`filter:${f}`, filters.has(f), filters.has(f) ? 'available' : 'MISSING');
    }
  } catch (err) {
    for (const f of REQUIRED_FILTERS) add(`filter:${f}`, false, err.message);
  }

  // 4. VMAF 模型（存在且是合法 JSON）
  let modelOk = false;
  let modelDetail = cfg.vmafModelPath;
  try {
    if (!fs.existsSync(cfg.vmafModelPath)) {
      modelDetail = `模型文件不存在: ${cfg.vmafModelPath}`;
    } else {
      const json = JSON.parse(fs.readFileSync(cfg.vmafModelPath, 'utf8'));
      modelOk = Boolean(json?.model_dict || json?.param_dict);
      modelDetail = modelOk ? `ok (${fs.statSync(cfg.vmafModelPath).size} bytes)` : '模型 JSON 结构不符合预期';
    }
  } catch (err) {
    modelDetail = `读取模型失败: ${err.message}`;
  }
  add('vmaf:model', modelOk, modelDetail);

  // 5. 数据目录可写
  try {
    fs.accessSync(cfg.dataDir, fs.constants.W_OK);
    add('data:writable', true, cfg.dataDir);
  } catch (err) {
    add('data:writable', false, `${cfg.dataDir}: ${err.message}`);
  }

  return { ok: checks.every((c) => c.ok), checks, versions };
}

/** 缓存自检结果，避免每次 /readyz 都跑 ffmpeg */
export function createSelfCheckCache(cfg, ttlMs = 60_000) {
  let cached = null;
  let inFlight = null;

  const fresh = async (force = false) => {
    if (!force && cached && Date.now() - cached.at < ttlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = runSelfCheck(cfg)
      .then((value) => {
        cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return { fresh };
}
