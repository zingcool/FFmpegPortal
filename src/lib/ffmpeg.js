/**
 * 评分命令构造 / 执行 / 解析。
 * 权威依据：docs/web-service-design.md §7.2 §7.3
 *
 * 关键点：
 *  - 一条 filter_complex 跑完所有勾选指标（复用同一次解码，实测比多进程快 6–7 倍）
 *  - 同一路流必须 split=N 才能被多个滤镜消费（直接复用两次会失败）
 *  - 失败必须显式抛出，绝不用 0 / "N/A" 兜底（0 与「画质极差」无法区分）
 */
import fs from 'node:fs';
import { runProcess } from './runner.js';

export class ScoreError extends Error {
  constructor(message, code = 'FFMPEG_FAILED', details = {}) {
    super(message);
    this.name = 'ScoreError';
    this.code = code;
    this.details = details;
  }
}

const SUPPORTED_METRICS = ['psnr', 'ssim', 'vmaf'];

export function parseMetricsParam(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return [...SUPPORTED_METRICS];
  }
  const list = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const unknown = list.filter((m) => !SUPPORTED_METRICS.includes(m));
  if (unknown.length > 0) {
    throw new ScoreError(`不支持的指标: ${unknown.join(', ')}（可选 psnr,ssim,vmaf）`, 'INVALID_METRICS');
  }
  const unique = [...new Set(list)];
  if (unique.length === 0) {
    throw new ScoreError('未选择任何指标', 'INVALID_METRICS');
  }
  return unique;
}

function vmafFilter({ modelPath, jsonPath, threads }) {
  // 本 build 的 libvmaf 把 model 定义为单个字符串选项，model 字典串只能有一个键：
  //   model=path=<file>  或  model=version=vmaf_v0.6.1
  // 写成 model='path=..:version=..' 会报 "Option not found"，实测已确认。
  const opts = [];
  if (modelPath) {
    if (modelPath.includes(':') || modelPath.includes("'")) {
      throw new ScoreError(`VMAF 模型路径含冒号或单引号，无法安全传入 ffmpeg: ${modelPath}`, 'INVALID_PARAM');
    }
    // 含空格时用单引号整体包住，交给 ffmpeg 的 filter 解析器
    opts.push(/[\s]/.test(modelPath) ? `model='path=${modelPath}'` : `model=path=${modelPath}`);
  } else {
    opts.push('model=version=vmaf_v0.6.1');
  }
  opts.push(`n_threads=${threads}`);
  if (jsonPath) {
    opts.push(`log_path=${jsonPath}`, 'log_fmt=json');
  }
  return `libvmaf=${opts.join(':')}`;
}

/**
 * 构造 ffmpeg 参数数组（不含可执行文件本身）。
 * @param {{targetPath:string, referencePath:string, norm:object, metrics:string[],
 *          modelPath:string, threads:number, vmafJsonPath?:string}} p
 */
export function buildComparisonArgs({
  targetPath,
  referencePath,
  norm,
  metrics,
  modelPath,
  threads,
  vmafJsonPath = null,
}) {
  const { width, height, fps, durationS } = norm;
  const pre = [
    `scale=${width}:${height}:flags=bicubic`,
    'setsar=1',
    `fps=${fps}`,
    'format=yuv420p',
    'setpts=PTS-STARTPTS',
    `trim=duration=${durationS}`,
  ].join(',');

  const n = metrics.length;
  const parts = [`[0:v]${pre}[d]`, `[1:v]${pre}[r]`];

  if (n === 1) {
    parts.push(`[d]null[d0]`, `[r]null[r0]`);
  } else {
    parts.push(`[d]split=${n}${Array.from({ length: n }, (_, i) => `[d${i}]`).join('')}`);
    parts.push(`[r]split=${n}${Array.from({ length: n }, (_, i) => `[r${i}]`).join('')}`);
  }

  metrics.forEach((metric, i) => {
    const ref = `[d${i}][r${i}]`;
    if (metric === 'psnr') parts.push(`${ref}psnr`);
    else if (metric === 'ssim') parts.push(`${ref}ssim`);
    else if (metric === 'vmaf') {
      parts.push(`${ref}${vmafFilter({ modelPath, jsonPath: vmafJsonPath, threads })}`);
    } else {
      throw new ScoreError(`内部错误：未知指标 ${metric}`, 'INVALID_METRICS');
    }
  });

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-i', targetPath,
    '-i', referencePath,
    '-filter_complex', parts.join(';'),
    '-f', 'null',
    '-',
  ];
}

/** 从 stderr 中提取最后一个 frame= 计数 */
function extractLastFrameCount(stderr) {
  let last = null;
  const re = /frame=\s*(\d+)/g;
  let m;
  while ((m = re.exec(stderr)) !== null) last = Number(m[1]);
  return last;
}

function readVmafJson(jsonPath) {
  if (!jsonPath || !fs.existsSync(jsonPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const pooled = data?.pooled_metrics?.vmaf;
    if (!pooled) return null;
    return {
      mean: Number(pooled.mean),
      min: Number(pooled.min),
      max: Number(pooled.max),
      harmonicMean: Number(pooled.harmonic_mean),
      frameCount: Array.isArray(data.frames) ? data.frames.length : null,
    };
  } catch {
    return null;
  }
}

/**
 * 解析 ffmpeg 输出为指标结果。缺项即抛错。
 * @returns {{psnr?:{mean:number,min:number}, ssim?:{mean:number}, vmaf?:{mean:number,min:number,harmonicMean:number}, frames:number|null}}
 */
export function parseMetrics(stderr, { metrics, vmafJsonPath = null }) {
  const out = {};

  if (metrics.includes('psnr')) {
    const m = /PSNR.*?average:([\d.]+)/.exec(stderr);
    if (!m) throw new ScoreError('ffmpeg 已结束但未能解析出 PSNR', 'PARSE_FAILED');
    const minM = /PSNR.*?min:([\d.]+)/.exec(stderr);
    out.psnr = { mean: Number(m[1]), min: minM ? Number(minM[1]) : null };
  }

  if (metrics.includes('ssim')) {
    const m = /SSIM.*?All:([\d.]+)/.exec(stderr);
    if (!m) throw new ScoreError('ffmpeg 已结束但未能解析出 SSIM', 'PARSE_FAILED');
    out.ssim = { mean: Number(m[1]) };
  }

  if (metrics.includes('vmaf')) {
    const json = readVmafJson(vmafJsonPath);
    if (json && Number.isFinite(json.mean)) {
      out.vmaf = json;
    } else {
      // 兜底：仅当 JSON 不可用时读 stderr 的池化分数（此时没有 min/harmonic）
      const m = /VMAF score:\s*([\d.]+)/.exec(stderr);
      if (!m) throw new ScoreError('ffmpeg 已结束但未能解析出 VMAF', 'PARSE_FAILED');
      out.vmaf = { mean: Number(m[1]), min: null, max: null, harmonicMean: null, frameCount: null };
    }
  }

  out.frames = extractLastFrameCount(stderr);
  return out;
}

/**
 * 执行一次「目标 vs 参考」评分。
 * @returns {Promise<{metrics:object, frames:number|null, elapsedMs:number, args:string[], stderr:string}>}
 */
export async function runComparison({
  ffmpegPath,
  targetPath,
  referencePath,
  norm,
  metrics,
  modelPath,
  threads,
  vmafJsonPath = null,
  timeoutMs = 30 * 60 * 1000,
  onChild = null,
}) {
  const args = buildComparisonArgs({
    targetPath,
    referencePath,
    norm,
    metrics,
    modelPath,
    threads,
    vmafJsonPath,
  });

  const res = await runProcess(ffmpegPath, args, { timeoutMs, onChild });

  if (res.timedOut) {
    throw new ScoreError(`ffmpeg 超时（>${Math.round(timeoutMs / 1000)}s）`, 'TIMEOUT', {
      stderrTail: res.stderr.slice(-4000),
    });
  }
  if (res.code !== 0) {
    throw new ScoreError(`ffmpeg 退出码 ${res.code}`, 'FFMPEG_FAILED', {
      stderrTail: res.stderr.slice(-4000),
    });
  }

  const parsed = parseMetrics(res.stderr, { metrics, vmafJsonPath });
  return {
    metrics: parsed,
    frames: parsed.frames,
    elapsedMs: res.elapsedMs,
    args,
    stderr: res.stderr,
  };
}
