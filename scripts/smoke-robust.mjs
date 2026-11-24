#!/usr/bin/env node
/**
 * M4 健壮性验收：用不同配置启动多个服务实例，逐项验证边界与错误处理。
 * 覆盖：超大文件、队列上限、并发提交、超时、鉴权、未就绪、进程泄漏、临时文件。
 *
 * 用法（在 web/ 目录下）： node scripts/smoke-robust.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PROJECT_DIR = path.resolve(import.meta.dirname, '..');
const DATA_ROOT = path.join(PROJECT_DIR, 'tmp', 'robust-data');
const TESTDATA = path.join(PROJECT_DIR, 'tmp', 'testdata');
const REF = path.join(TESTDATA, 'ref720.mp4');
const T_GOOD = path.join(TESTDATA, 't_good.mp4');
const T_BAD = path.join(TESTDATA, 't_bad.mp4');
const REF_LONG = path.join(TESTDATA, 'ref_long.mp4');
const T_LONG = path.join(TESTDATA, 't_long.mp4');

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✅\x1b[0m ${m}`); };
const bad = (m) => { fail++; console.log(`  \x1b[31m❌\x1b[0m ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

const servers = [];

async function startServer(name, { port, env = {} }) {
  const dataDir = path.join(DATA_ROOT, name);
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.mkdir(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      LOG_LEVEL: 'error',
      FFMPEG_PATH: path.join(PROJECT_DIR, 'ffmpeg', 'bin', 'ffmpeg'),
      FFPROBE_PATH: path.join(PROJECT_DIR, 'ffmpeg', 'bin', 'ffprobe'),
      VMAF_MODEL: path.join(PROJECT_DIR, 'model', 'vmaf_v0.6.1.json'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {});
  servers.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    await sleep(120);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { base, dataDir, child };
    } catch { /* 未起 */ }
  }
  throw new Error(`服务 ${name} 启动超时`);
}

async function upFile(url, field, filePath, extraFields = {}) {
  const form = new FormData();
  form.append(field, new Blob([await fsp.readFile(filePath)]), path.basename(filePath));
  for (const [k, v] of Object.entries(extraFields)) form.append(k, v);
  const res = await fetch(url, { method: 'POST', body: form });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

async function createJob(base, { referenceId, targets, metrics = 'psnr,ssim', fields = {} }) {
  const form = new FormData();
  form.append('referenceId', referenceId);
  for (const t of targets) form.append('targets', new Blob([await fsp.readFile(t)]), path.basename(t));
  form.append('metrics', metrics);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', body: form });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

async function waitJob(base, jobId, { maxMs = 120000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await sleep(300);
    const r = await fetch(`${base}/api/jobs/${jobId}`);
    if (!r.ok) continue;
    const d = await r.json();
    if (['done', 'failed', 'canceled'].includes(d.status)) return d;
  }
  return null;
}

/**
 * 统计「命令行里含 jobId 的 ffmpeg 进程」数量。
 * 直接扫 /proc，避免 pgrep -af 把执行它的 shell 自身也算进去（命令串里也含 ffmpeg 字样）。
 */
function countFfmpegFor(jobId) {
  let n = 0;
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes('ffmpeg') && cmd.includes(jobId)) n++;
    } catch {
      /* 进程已退出或无权限 */
    }
  }
  return n;
}

async function main() {
  console.log('=== M4 健壮性验收 ===');
  for (const f of [REF, T_GOOD, T_BAD, REF_LONG, T_LONG]) {
    if (!fs.existsSync(f)) throw new Error(`缺少测试素材: ${f}（先跑 smoke-api.sh 生成）`);
  }

  // ============ A. 并发提交 + 取消后无进程泄漏 ============
  head('A. 并发提交与进程清理');
  const A = await startServer('A', { port: 13101, env: { CONCURRENCY: '1' } });
  const refA = await upFile(`${A.base}/api/references`, 'file', REF);
  refA.status === 201 || refA.status === 200 ? ok(`参考上传成功 (HTTP ${refA.status})`) : bad(`参考上传失败 ${refA.status}`);
  const refIdA = refA.body.referenceId;

  // 同时提交 2 个任务
  const [j1, j2] = await Promise.all([
    createJob(A.base, { referenceId: refIdA, targets: [T_GOOD] }),
    createJob(A.base, { referenceId: refIdA, targets: [T_BAD] }),
  ]);
  j1.status === 202 && j2.status === 202
    ? ok('并发提交两个任务均被接受 (202)')
    : bad(`并发提交异常: ${j1.status} / ${j2.status}`);
  const [d1, d2] = await Promise.all([waitJob(A.base, j1.body.jobId), waitJob(A.base, j2.body.jobId)]);
  d1?.status === 'done' && d2?.status === 'done'
    ? ok('并发任务均正确完成（排队而非互相破坏）')
    : bad(`并发任务异常: ${d1?.status} / ${d2?.status}`);

  // 取消长任务后检查 ffmpeg 进程
  const refLongA = await upFile(`${A.base}/api/references`, 'file', REF_LONG);
  const jobLong = await createJob(A.base, { referenceId: refLongA.body.referenceId, targets: [T_LONG], metrics: 'psnr,ssim,vmaf' });
  let sawRunning = false;
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    const d = await (await fetch(`${A.base}/api/jobs/${jobLong.body.jobId}`)).json();
    if (d.status === 'running' && d.items.some((x) => x.status === 'running')) { sawRunning = true; break; }
    if (['done', 'failed'].includes(d.status)) break;
  }
  if (sawRunning) {
    await fetch(`${A.base}/api/jobs/${jobLong.body.jobId}/cancel`, { method: 'POST' });
    await sleep(1500);
    const leaked = countFfmpegFor(jobLong.body.jobId);
    leaked === 0 ? ok('取消后无 ffmpeg 残留进程') : bad(`取消后仍有 ${leaked} 个 ffmpeg 进程`);
  } else {
    bad('未能观测到运行中状态，无法验证取消');
  }

  // ============ B. 超大文件 ============
  head('B. 单文件大小限制 (MAX_FILE_MB=1)');
  const B = await startServer('B', { port: 13102, env: { MAX_FILE_MB: '1' } });
  const bigRef = await upFile(`${B.base}/api/references`, 'file', REF); // 1.7MB > 1MB
  bigRef.status === 413 && bigRef.body?.error?.code === 'FILE_TOO_LARGE'
    ? ok(`超大文件被拒绝 413 / FILE_TOO_LARGE`)
    : bad(`超大文件未被正确拒绝: HTTP ${bigRef.status} ${JSON.stringify(bigRef.body).slice(0, 160)}`);

  // ============ C. 队列上限 ============
  head('C. 队列上限 (MAX_QUEUE=1)');
  const C = await startServer('C', { port: 13103, env: { MAX_QUEUE: '1' } });
  const refC = await upFile(`${C.base}/api/references`, 'file', REF);
  const refLongC = await upFile(`${C.base}/api/references`, 'file', REF_LONG);
  const c1 = await createJob(C.base, { referenceId: refLongC.body.referenceId, targets: [T_LONG], metrics: 'psnr,ssim,vmaf' });
  c1.status === 202 ? ok('第 1 个任务被接受') : bad(`第 1 个任务异常: ${c1.status}`);
  await sleep(400);
  const c2 = await createJob(C.base, { referenceId: refC.body.referenceId, targets: [T_GOOD] });
  c2.status === 429 && c2.body?.error?.code === 'QUEUE_FULL'
    ? ok('队列满时返回 429 / QUEUE_FULL')
    : bad(`队列上限未生效: HTTP ${c2.status} ${JSON.stringify(c2.body).slice(0, 160)}`);
  await fetch(`${C.base}/api/jobs/${c1.body.jobId}/cancel`, { method: 'POST' }).catch(() => {});

  // ============ D. 超时 ============
  head('D. 单视频超时 (TIMEOUT_MS=1000)');
  const D = await startServer('D', { port: 13104, env: { TIMEOUT_MS: '1000' } });
  const refLongD = await upFile(`${D.base}/api/references`, 'file', REF_LONG);
  const dJob = await createJob(D.base, { referenceId: refLongD.body.referenceId, targets: [T_LONG], metrics: 'psnr,ssim,vmaf' });
  const dDone = await waitJob(D.base, dJob.body.jobId, { maxMs: 60000 });
  const itemErr = dDone?.items?.[0]?.error ?? '';
  /TIMEOUT/i.test(itemErr)
    ? ok(`超时被正确标记: ${itemErr.slice(0, 80)}`)
    : bad(`超时未生效，item 错误=${itemErr || '(无)'} status=${dDone?.items?.[0]?.status}`);

  // ============ E. 鉴权 ============
  head('E. 可选鉴权 (AUTH_TOKEN)');
  const E = await startServer('E', { port: 13105, env: { AUTH_TOKEN: 'secret-123' } });
  const noAuth = await fetch(`${E.base}/api/references`);
  noAuth.status === 401 ? ok('无 Token 访问被拒绝 401') : bad(`无 Token 未被拒绝: ${noAuth.status}`);
  const badAuth = await fetch(`${E.base}/api/references`, { headers: { Authorization: 'Bearer wrong' } });
  badAuth.status === 401 ? ok('错误 Token 被拒绝 401') : bad(`错误 Token 未被拒绝: ${badAuth.status}`);
  const goodAuth = await fetch(`${E.base}/api/references`, { headers: { Authorization: 'Bearer secret-123' } });
  goodAuth.status === 200 ? ok('正确 Token 放行 200') : bad(`正确 Token 被拒绝: ${goodAuth.status}`);
  const healthOpen = await fetch(`${E.base}/healthz`);
  healthOpen.status === 200 ? ok('健康探针无需鉴权') : bad(`健康探针被鉴权拦截: ${healthOpen.status}`);

  // ============ F. 未就绪 ============
  head('F. 未就绪时拒绝建任务 (ffmpeg 路径不存在)');
  const F = await startServer('F', { port: 13106, env: { FFMPEG_PATH: '/nonexistent/ffmpeg' } });
  const ready = await (await fetch(`${F.base}/readyz`)).json();
  ready.status === 'not_ready' ? ok('/readyz 返回 not_ready') : bad(`/readyz 未反映故障: ${ready.status}`);
  const fJob = await createJob(F.base, { referenceId: 'ref_x', targets: [T_GOOD] });
  fJob.status === 503 && fJob.body?.error?.code === 'NOT_READY'
    ? ok('未就绪时建任务返回 503 / NOT_READY')
    : bad(`未就绪时建任务未拦截: HTTP ${fJob.status} ${JSON.stringify(fJob.body).slice(0, 160)}`);

  // ============ G. 临时文件不泄漏 ============
  head('G. 临时文件与磁盘占用');
  const aJobsDir = path.join(A.dataDir, 'jobs');
  const jobDirs = await fsp.readdir(aJobsDir).catch(() => []);
  let leftoverFfmpegTmp = 0;
  for (const d of jobDirs) {
    const files = await fsp.readdir(path.join(aJobsDir, d)).catch(() => []);
    leftoverFfmpegTmp += files.filter((f) => /\.(tmp|scaled\.mp4|partial)$/.test(f)).length;
  }
  leftoverFfmpegTmp === 0 ? ok('无 ffmpeg 临时/中间文件残留') : bad(`发现 ${leftoverFfmpegTmp} 个临时文件残留`);

  const doneDir = path.join(aJobsDir, j1.body.jobId);
  const doneFiles = await fsp.readdir(doneDir).catch(() => []);
  const hasReports = ['report.csv', 'report.html', 'result.json'].every((f) => doneFiles.includes(f));
  hasReports ? ok('完成任务的报告文件齐全') : bad(`报告文件缺失: ${doneFiles.join(',')}`);
  !doneFiles.includes('inputs') ? ok('KEEP_INPUTS=false 时待测原文件已清理') : bad('待测原文件未被清理');

  // ============ 收尾 ============
  for (const s of servers) { try { s.kill('SIGTERM'); } catch { /* ignore */ } }
  await sleep(1200);
  console.log(`\n\x1b[1m结果：通过 ${pass}，失败 ${fail}\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\n验收异常:', err.message);
  for (const s of servers) { try { s.kill('SIGKILL'); } catch { /* ignore */ } }
  process.exit(1);
});
