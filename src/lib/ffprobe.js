/**
 * ffprobe 封装：提取归一化与报告所需的视频元信息。
 * 权威依据：docs/web-service-design.md §7.1
 */
import { runProcess } from './runner.js';

export class ProbeError extends Error {
  constructor(message, code = 'PROBE_FAILED') {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
  }
}

function parseFps(stream) {
  const candidates = [stream.avg_frame_rate, stream.r_frame_rate];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    const [num, den] = c.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) {
      return num / den;
    }
  }
  return null;
}

function parseSar(stream) {
  const sar = stream.sample_aspect_ratio;
  if (!sar || sar === '0:1' || sar === '1:1' || sar === 'N/A') return '1:1';
  return sar;
}

/** 读取旋转角（displaymatrix side_data 或 tags.rotate） */
function parseRotation(stream) {
  for (const sd of stream.side_data_list ?? []) {
    if (typeof sd.rotation === 'number') return Math.abs(Math.round(sd.rotation)) % 360;
  }
  const tag = stream.tags?.rotate;
  if (tag !== undefined && Number.isFinite(Number(tag))) {
    return Math.abs(Math.round(Number(tag))) % 360;
  }
  return 0;
}

/**
 * 探测视频文件。
 * @returns {Promise<{width:number,height:number,fps:number,durationS:number,
 *   videoCodec:string,pixFmt:string,sar:string,rotation:number,hasAudio:boolean}>}
 */
export async function probeVideo(ffprobePath, filePath, { timeoutMs = 60000 } = {}) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];

  let res;
  try {
    res = await runProcess(ffprobePath, args, { timeoutMs });
  } catch (err) {
    throw new ProbeError(`无法执行 ffprobe: ${err.message}`);
  }
  if (res.code !== 0) {
    throw new ProbeError(`ffprobe 解析失败: ${res.stderr.trim().slice(0, 800)} || ${res.stdout.trim().slice(0, 400)}`);
  }

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    throw new ProbeError('ffprobe 输出不是合法 JSON');
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video) {
    throw new ProbeError('文件中没有视频流（纯音频或损坏文件）', 'UNSUPPORTED_MEDIA');
  }

  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new ProbeError(`无法获取视频分辨率 (width=${video.width}, height=${video.height})`);
  }

  const fps = parseFps(video);
  if (!fps || !Number.isFinite(fps) || fps <= 0) {
    throw new ProbeError(`无法获取视频帧率 (avg=${video.avg_frame_rate}, r=${video.r_frame_rate})`);
  }

  const durationS = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new ProbeError('无法获取视频时长');
  }

  return {
    width,
    height,
    fps,
    durationS,
    videoCodec: video.codec_name ?? 'unknown',
    pixFmt: video.pix_fmt ?? 'unknown',
    sar: parseSar(video),
    rotation: parseRotation(video),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}
