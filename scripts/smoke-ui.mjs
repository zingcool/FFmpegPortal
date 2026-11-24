#!/usr/bin/env node
/**
 * M3 浏览器级验收：通过 Chrome DevTools Protocol 真实操作页面。
 * 覆盖：页面渲染 → 选择参考/待测文件 → 提交 → 进度可见 → 报告链接出现。
 *
 * 前置：已启动无头 Chrome（--remote-debugging-port=9222），且服务在跑。
 * 用法：
 *   node scripts/smoke-ui.mjs
 *   CDP=http://127.0.0.1:9222 PAGE=http://127.0.0.1:3000/ \
 *     REF=./tmp/testdata/ref720.mp4 TARGETS=./tmp/testdata/t_good.mp4,./tmp/testdata/t_bad.mp4 \
 *     node scripts/smoke-ui.mjs
 */
import path from 'node:path';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9222';
const PAGE = process.env.PAGE ?? 'http://127.0.0.1:3000/';
const REF = process.env.REF ?? './tmp/testdata/ref720.mp4';
const TARGETS = (process.env.TARGETS ?? './tmp/testdata/t_good.mp4,./tmp/testdata/t_bad.mp4')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✅\x1b[0m ${m}`); };
const bad = (m) => { fail++; console.log(`  \x1b[31m❌\x1b[0m ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPageTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* Chrome 还没就绪 */
    }
    await sleep(300);
  }
  throw new Error(`无法连接 Chrome CDP: ${CDP}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

/** 在页面里求值并返回 JSON 值 */
async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(`页面异常: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ''}`);
  return res.result?.value;
}

async function setFiles(send, selector, files) {
  const doc = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!nodeId) throw new Error(`找不到元素 ${selector}`);
  await send('DOM.setFileInputFiles', { nodeId, files: files.map((f) => path.resolve(f)) });
}

async function main() {
  console.log('=== M3 浏览器级验收 ===');
  const target = await findPageTarget();
  const { ready, send, close } = connect(target.webSocketDebuggerUrl);
  await ready;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');

  console.log(`\n1. 打开页面 ${PAGE}`);
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const state = await evaluate(send, 'document.readyState').catch(() => null);
    if (state === 'complete') break;
  }
  await sleep(1500); // 等 loadStatus / loadReferences 的 fetch 完成

  const title = await evaluate(send, 'document.title');
  title.includes('画质') ? ok(`页面已加载（title=${title}）`) : bad(`页面标题异常: ${title}`);

  const statusHtml = await evaluate(send, "document.getElementById('statusLine').innerHTML");
  /就绪/.test(statusHtml) ? ok('状态区显示「就绪」') : bad(`状态区异常: ${statusHtml}`);

  const refCount = await evaluate(send, "document.getElementById('refSelect').options.length");
  refCount > 0 ? ok(`参考下拉已填充（${refCount} 项）`) : bad('参考下拉为空');

  console.log('\n2. 选择文件并提交');
  await setFiles(send, '#refFile', [REF]);
  await setFiles(send, '#targetFiles', TARGETS);
  const filesOk = await evaluate(
    send,
    `({ ref: document.getElementById('refFile').files.length,
        targets: document.getElementById('targetFiles').files.length })`,
  );
  filesOk.ref === 1 && filesOk.targets === TARGETS.length
    ? ok(`文件已设置（参考 ${filesOk.ref}，待测 ${filesOk.targets}）`)
    : bad(`文件设置异常: ${JSON.stringify(filesOk)}`);

  const hint = await evaluate(send, "document.getElementById('targetHint').textContent");
  /已选择/.test(hint) ? ok(`已选文件提示已更新：${hint}`) : bad(`提示未更新: ${hint}`);

  await evaluate(send, "document.getElementById('form').requestSubmit(); 'submitted'");
  ok('已触发表单提交');

  console.log('\n3. 等待任务完成（进度须可见）');
  let sawProgress = false;
  let sawRunning = false;
  let finalTitle = '';
  let lastMeta = '';
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const snap = await evaluate(
      send,
      `({
         hidden: document.getElementById('jobCard').classList.contains('hidden'),
         title: document.getElementById('jobTitle').textContent,
         meta: document.getElementById('jobMeta').textContent,
         bar: document.getElementById('bar').style.width,
         rows: document.getElementById('jobRows').children.length,
         linksHidden: document.getElementById('jobLinks').classList.contains('hidden'),
         htmlHref: document.getElementById('linkHtml').getAttribute('href'),
         err: document.getElementById('globalErr').classList.contains('hidden') ? '' : document.getElementById('globalErr').textContent,
       })`,
    );
    if (snap.err) { bad(`页面报错: ${snap.err}`); break; }
    if (!snap.hidden) sawProgress = true;
    if (/评分中|探测中|排队中/.test(snap.title)) sawRunning = true;
    lastMeta = snap.meta;
    finalTitle = snap.title;
    if (!snap.linksHidden) {
      // 报告链接已出现
      const href = snap.htmlHref;
      const res = await fetch(new URL(href, PAGE)).catch(() => null);
      res && res.ok ? ok(`HTML 报告可访问（${href}）`) : bad(`HTML 报告不可访问: ${href}`);
      const csv = await fetch(new URL(`/api/jobs/${href.split('/')[3]}/report.csv`, PAGE)).catch(() => null);
      csv && csv.ok ? ok('CSV 报告可访问') : bad('CSV 报告不可访问');
      break;
    }
  }

  sawProgress ? ok('进度卡片已显示') : bad('进度卡片未显示');
  sawRunning ? ok('过程中显示过「评分中/排队中」状态') : bad('未观察到进行中状态');
  /已完成|done/.test(finalTitle) ? ok(`任务完成：${finalTitle}`) : bad(`任务未完成：${finalTitle}`);
  /成功/.test(lastMeta) ? ok(`进度统计已渲染：${lastMeta}`) : bad(`进度统计异常：${lastMeta}`);

  const rowsText = await evaluate(send, "document.getElementById('jobRows').textContent");
  const hasVmaf = /\d+\.\d+/.test(rowsText);
  hasVmaf ? ok('结果表已渲染出数值') : bad('结果表无数值');

  close();
  console.log(`\n\x1b[1m结果：通过 ${pass}，失败 ${fail}\x1b[0m`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n验收异常:', err.message);
  process.exit(1);
});
