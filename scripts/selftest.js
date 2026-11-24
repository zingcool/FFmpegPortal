#!/usr/bin/env node
/**
 * M0 验收脚本：在容器（或宿主机）内端到端验证「探测 → 归一化 → 三指标评分 → 解析」。
 * 不依赖外部素材：用 ffmpeg lavfi 现场合成参考片与待测片。
 *
 * 用法：
 *   node scripts/selftest.js            # 使用环境变量配置
 *   docker run --rm <image> node scripts/selftest.js
 */
import fs from 'node:fs';
import path from 'node:path';

import { config, ensureDataDirs } from '../src/config.js';
import { runProcess } from '../src/lib/runner.js';
import { runSelfCheck } from '../src/lib/selfcheck.js';
import { probeVideo } from '../src/lib/ffprobe.js';
import { decideNormalization } from '../src/lib/normalize.js';
import { runComparison, parseMetricsParam } from '../src/lib/ffmpeg.js';

const log = (...a) => console.log(...a);
const fail = (msg) => {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exitCode = 1;
};

function assertRange(name, value, min, max) {
  const ok = Number.isFinite(value) && value >= min && value <= max;
  log(`   ${ok ? '✅' : '❌'} ${name} = ${value}  (期望 ${min} ~ ${max})`);
  if (!ok) fail(`${name} 超出预期范围`);
  return ok;
}

async function makeClips(dir) {
  const ref = path.join(dir, 'ref.mp4');
  const target = path.join(dir, 'target.mp4');

  log('① 合成参考片 (testsrc2 640x360@25fps, 2s, crf12) ...');
  let res = await runProcess(
    config.ffmpegPath,
    ['-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2',
      '-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
      ref],
    { timeoutMs: 120000 },
  );
  if (res.code !== 0) throw new Error(`生成参考片失败: ${res.stderr.slice(-1500)}`);

  log('② 合成待测片 (缩到 320x180 + crf32 劣化) ...');
  res = await runProcess(
    config.ffmpegPath,
    ['-hide_banner', '-nostdin', '-y', '-i', ref,
      '-vf', 'scale=320:180', '-c:v', 'libx264', '-crf', '32', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an',
      target],
    { timeoutMs: 120000 },
  );
  if (res.code !== 0) throw new Error(`生成待测片失败: ${res.stderr.slice(-1500)}`);

  return { ref, target };
}

async function main() {
  log('=== 画质评分服务 M0 自检 ===');
  ensureDataDirs(config); // 首次运行自动创建 DATA_DIR，避免因目录缺失而误判环境不可用
  log(`ffmpeg : ${config.ffmpegPath}`);
  log(`ffprobe: ${config.ffprobePath}`);
  log(`model  : ${config.vmafModelPath}`);
  log(`dataDir: ${config.dataDir}`);
  log(`CPU 核数 ${config.cpuCores} / 线程 ${config.ffmpegThreads} / 并发 ${config.concurrency}\n`);

  log('【1/4】环境自检');
  const self = await runSelfCheck(config);
  for (const c of self.checks) log(`   ${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`);
  if (!self.ok) {
    fail('环境自检未通过，后续步骤中止');
    return;
  }

  const workDir = fs.mkdtempSync(path.join(config.dataDir, 'selftest-'));
  log(`\n临时目录: ${workDir}`);

  try {
    log('\n【2/4】生成测试素材');
    const { ref, target } = await makeClips(workDir);
    for (const f of [ref, target]) {
      log(`   ${path.basename(f)}: ${(fs.statSync(f).size / 1024).toFixed(1)} KB`);
    }

    log('\n【3/4】探测与归一化');
    const refProbe = await probeVideo(config.ffprobePath, ref);
    const tgtProbe = await probeVideo(config.ffprobePath, target);
    log(`   参考: ${refProbe.width}x${refProbe.height} @${refProbe.fps}fps ${refProbe.durationS}s ${refProbe.pixFmt}`);
    log(`   待测: ${tgtProbe.width}x${tgtProbe.height} @${tgtProbe.fps}fps ${tgtProbe.durationS}s ${tgtProbe.pixFmt}`);

    const norm = decideNormalization(refProbe, tgtProbe);
    log(`   归一化 -> ${norm.width}x${norm.height} @${norm.fps}fps, 比较 ${norm.durationS}s / ${norm.comparedFrames} 帧`);

    log('\n【4/4】三指标评分');
    const metricsList = parseMetricsParam('psnr,ssim,vmaf');
    const vmafJsonPath = path.join(workDir, 'vmaf.json');
    const started = Date.now();
    const result = await runComparison({
      ffmpegPath: config.ffmpegPath,
      targetPath: target,
      referencePath: ref,
      norm,
      metrics: metricsList,
      modelPath: config.vmafModelPath,
      threads: config.ffmpegThreads,
      vmafJsonPath,
      timeoutMs: 300000,
    });
    log(`   耗时 ${Date.now() - started} ms, 解析帧数 ${result.frames}`);

    log('\n解析结果:');
    assertRange('PSNR mean', result.metrics.psnr?.mean, 10, 60);
    assertRange('SSIM mean', result.metrics.ssim?.mean, 0, 1);
    assertRange('VMAF mean', result.metrics.vmaf?.mean, 0, 100);
    if (result.metrics.vmaf?.harmonicMean != null) {
      assertRange('VMAF harmonic_mean', result.metrics.vmaf.harmonicMean, 0, 100);
    }

    // 劣化素材应当「明显有损但内容仍在」：VMAF 通常 20~80
    const vmaf = result.metrics.vmaf?.mean;
    if (Number.isFinite(vmaf) && (vmaf < 5 || vmaf > 95)) {
      log(`   ⚠️  提醒：VMAF=${vmaf} 不在常见范围（劣化素材预期 20~80），请确认素材生成是否正常`);
    }

    log('\n复现命令（可复制到 shell 直接跑）:');
    log(`   ${config.ffmpegPath} ${result.args.map((a) => (a.includes(' ') || a.includes(';') ? `'${a}'` : a)).join(' ')}`);
  } finally {
    if (process.env.KEEP_SELFTEST !== '1') {
      fs.rmSync(workDir, { recursive: true, force: true });
      log(`\n已清理临时目录`);
    } else {
      log(`\n保留临时目录（KEEP_SELFTEST=1）: ${workDir}`);
    }
  }

  log(process.exitCode ? '\n=== 自检未通过 ===' : '\n=== 自检全部通过 ✅ ===');
}

main().catch((err) => {
  console.error('\n自检异常:', err);
  process.exit(1);
});
