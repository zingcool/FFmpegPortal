/**
 * 归一化参数决策：把一个参考视频与一个待测视频，转成同一「可比空间」。
 * 权威依据：docs/web-service-design.md §7.1
 *
 * 与 analyze.py 的关键差异：**两路都归一化**（原实现只缩放目标片），
 * 否则用户上传的 VFR / 帧率不一致 / 时长不等视频会导致逐帧对不齐。
 */
export class NormalizeError extends Error {
  constructor(message, code = 'INVALID_PARAM') {
    super(message);
    this.name = 'NormalizeError';
    this.code = code;
  }
}

const round3 = (n) => Math.round(n * 1000) / 1000;
const evenFloor = (n) => {
  const v = Math.trunc(n);
  return v % 2 === 0 ? v : v - 1;
};

/**
 * @param {{width:number,height:number,fps:number,durationS:number}} refProbe
 * @param {{width:number,height:number,fps:number,durationS:number}} tgtProbe
 * @param {{fpsOverride?:number, maxDurationS?:number}} [opts]
 */
export function decideNormalization(refProbe, tgtProbe, opts = {}) {
  const width = evenFloor(refProbe.width);
  const height = evenFloor(refProbe.height);
  if (width < 2 || height < 2) {
    throw new NormalizeError(`参考视频分辨率过小，无法比较 (${refProbe.width}x${refProbe.height})`);
  }

  let fps;
  if (opts.fpsOverride !== undefined && opts.fpsOverride !== null) {
    fps = Number(opts.fpsOverride);
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new NormalizeError(`fpsOverride 非法: ${opts.fpsOverride}`);
    }
  } else {
    // 取两路较小值：阈值更低的一侧决定可比帧率，避免对低帧率片插帧产生伪影
    fps = Math.min(refProbe.fps, tgtProbe.fps);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new NormalizeError('无法确定归一化帧率');
  }
  fps = round3(Math.min(fps, 120));

  let durationS;
  if (opts.maxDurationS !== undefined && opts.maxDurationS !== null) {
    durationS = Number(opts.maxDurationS);
    if (!Number.isFinite(durationS) || durationS <= 0) {
      throw new NormalizeError(`maxDurationS 非法: ${opts.maxDurationS}`);
    }
  } else {
    durationS = Math.min(refProbe.durationS, tgtProbe.durationS);
  }
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new NormalizeError(
      `两路无公共可比时长 (参考 ${refProbe.durationS}s / 待测 ${tgtProbe.durationS}s)`,
      'NO_COMMON_OVERLAP',
    );
  }
  durationS = round3(durationS);

  return {
    width,
    height,
    fps,
    durationS,
    pixFmt: 'yuv420p',
    sar: '1:1',
    comparedFrames: Math.max(1, Math.round(durationS * fps)),
  };
}

/** 人类可读的归一化描述，写进报告与 job 记录 */
export function describeNormalization(norm) {
  return {
    width: norm.width,
    height: norm.height,
    fps: norm.fps,
    durationS: norm.durationS,
    pixFmt: norm.pixFmt,
    sar: norm.sar,
    comparedFrames: norm.comparedFrames,
  };
}
