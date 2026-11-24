/**
 * 报告生成：CSV（utf-8-sig，Excel 友好）+ 自包含 HTML（内联样式，无 CDN）。
 * 权威依据：docs/web-service-design.md §10
 */

const METRIC_LABELS = { psnr: 'PSNR (dB)', ssim: 'SSIM', vmaf: 'VMAF' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmt(n, digits = 3) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '';
  return Number(n).toFixed(digits);
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 主指标：优先 VMAF，其次 PSNR */
function primaryMetric(metrics) {
  if (metrics.includes('vmaf')) return 'vmaf';
  if (metrics.includes('psnr')) return 'psnr';
  return metrics[0] ?? 'psnr';
}

/** 指标色阶（越大越好） */
function tone(metric, value) {
  if (value === null || value === undefined) return 'na';
  const v = Number(value);
  if (metric === 'vmaf') return v >= 90 ? 'good' : v >= 80 ? 'ok' : v >= 60 ? 'warn' : v >= 40 ? 'bad' : 'awful';
  if (metric === 'psnr') return v >= 40 ? 'good' : v >= 30 ? 'ok' : v >= 25 ? 'warn' : 'bad';
  if (metric === 'ssim') return v >= 0.98 ? 'good' : v >= 0.95 ? 'ok' : v >= 0.9 ? 'warn' : 'bad';
  return 'na';
}

/** 生成 CSV 文本（调用方负责加 BOM 与落盘） */
export function buildCsv(job, items) {
  const header = [
    'item_seq', 'file_name', 'status', 'size_mb', 'width', 'height', 'fps', 'duration_s',
    'compared_seconds', 'compared_frames', 'psnr', 'ssim', 'vmaf', 'vmaf_min', 'vmaf_harmonic',
    'elapsed_ms', 'error',
  ];
  const lines = [header.join(',')];
  for (const it of items) {
    const p = it.probe_json ? JSON.parse(it.probe_json) : {};
    lines.push(
      [
        it.seq,
        it.orig_name,
        it.status,
        fmt(it.size_bytes / 1024 / 1024, 2),
        p.width ?? '',
        p.height ?? '',
        p.fps ? fmt(p.fps, 3) : '',
        p.durationS ? fmt(p.durationS, 3) : '',
        fmt(it.compared_seconds, 3),
        it.compared_frames ?? '',
        fmt(it.psnr, 6),
        fmt(it.ssim, 6),
        fmt(it.vmaf, 6),
        fmt(it.vmaf_min, 6),
        fmt(it.vmaf_harmonic, 6),
        it.elapsed_ms ?? '',
        it.error ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** 生成自包含 HTML 报告 */
export function buildHtml(job, items, { ffmpegVersion = '', generatedAt = new Date().toISOString() } = {}) {
  const metrics = String(job.metrics).split(',').filter(Boolean);
  const primary = primaryMetric(metrics);
  const norm = job.normalization ? JSON.parse(job.normalization) : null;
  const refProbe = norm?.reference ?? null;

  const doneItems = items.filter((i) => i.status === 'done');
  const rows = items
    .map((it) => {
      const p = it.probe_json ? JSON.parse(it.probe_json) : {};
      const cells = metrics
        .map((m) => {
          const v = it[m];
          const sub =
            m === 'vmaf' && it.vmaf_min != null
              ? `<span class="sub">min ${fmt(it.vmaf_min, 2)} · hm ${fmt(it.vmaf_harmonic, 2)}</span>`
              : m === 'psnr' && it.psnr_min != null
                ? `<span class="sub">min ${fmt(it.psnr_min, 2)}</span>`
                : '';
          return `<td class="num ${tone(m, v)}">${fmt(v, m === 'ssim' ? 4 : 2) || '—'}${sub}</td>`;
        })
        .join('');
      const statusCell =
        it.status === 'done'
          ? '<span class="badge good">完成</span>'
          : it.status === 'failed'
            ? `<span class="badge awful" title="${esc(it.error ?? '')}">失败</span>`
            : `<span class="badge">${esc(it.status)}</span>`;
      return `<tr>
      <td>${it.seq}</td>
      <td class="name" title="${esc(it.orig_name)}">${esc(it.orig_name)}</td>
      <td>${p.width && p.height ? `${p.width}×${p.height}` : '—'}</td>
      <td>${statusCell}</td>
      ${cells}
    </tr>`;
    })
    .join('\n');

  // 主指标条形图
  const maxV = Math.max(1, ...doneItems.map((i) => Number(i[primary] ?? 0)));
  const bars = doneItems
    .map((it) => {
      const v = Number(it[primary] ?? 0);
      const pct = Math.max(1, Math.round((v / maxV) * 100));
      return `<div class="bar-row">
        <div class="bar-name" title="${esc(it.orig_name)}">${esc(it.orig_name)}</div>
        <div class="bar-track"><div class="bar-fill ${tone(primary, v)}" style="width:${pct}%"></div></div>
        <div class="bar-val">${fmt(v, 2)}</div>
      </div>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>画质评分报告 · ${esc(job.id)}</title>
<style>
  :root { color-scheme: light dark; --line: rgba(128,128,128,.28); }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0; padding: 32px 20px 60px; line-height: 1.6; max-width: 1100px; margin-inline: auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .2rem; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .6rem; padding-bottom: .3rem; border-bottom: 1px solid var(--line); }
  .muted { opacity: .68; font-size: .9rem; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin: 1rem 0 0; }
  .meta div { border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font-size: .88rem; }
  .meta b { display: block; font-weight: 600; opacity: .6; font-size: .78rem; text-transform: uppercase; letter-spacing: .03em; }
  table { border-collapse: collapse; width: 100%; font-size: .9rem; }
  th, td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { font-weight: 600; font-size: .82rem; opacity: .75; white-space: nowrap; }
  td.num { font-variant-numeric: tabular-nums; font-weight: 600; }
  td.name { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { display: block; font-weight: 400; font-size: .74rem; opacity: .6; white-space: nowrap; }
  .good { color: #15803d; } .ok { color: #4d7c0f; } .warn { color: #b45309; } .bad { color: #c2410c; } .awful { color: #b91c1c; }
  .na { opacity: .45; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: .76rem;
           border: 1px solid var(--line); white-space: nowrap; }
  .bar-row { display: grid; grid-template-columns: 220px 1fr 70px; gap: 10px; align-items: center; margin: 5px 0; font-size: .85rem; }
  .bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
  .bar-track { background: rgba(128,128,128,.16); border-radius: 4px; height: 16px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 4px; background: currentColor; opacity: .75; }
  .bar-val { text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid var(--line); font-size: .82rem; opacity: .75; }
  footer li { margin: .25rem 0; }
</style>
</head>
<body>
<h1>视频画质评分报告</h1>
<p class="muted">任务 <code>${esc(job.id)}</code> · 指标 ${metrics.map((m) => esc(METRIC_LABELS[m] ?? m)).join(' / ')}</p>

<div class="meta">
  <div><b>创建时间</b>${esc(job.created_at)}</div>
  <div><b>完成时间</b>${esc(job.finished_at ?? '—')}</div>
  <div><b>待测视频</b>${items.length} 个（成功 ${doneItems.length}）</div>
  <div><b>参考分辨率</b>${refProbe ? `${refProbe.width}×${refProbe.height}` : '—'}</div>
  <div><b>比较基准</b>${norm ? `${norm.width}×${norm.height} @ ${fmt(norm.fps, 3)}fps` : '—'}</div>
  <div><b>像素格式</b>${norm ? esc(norm.pixFmt ?? 'yuv420p') : '—'}</div>
</div>

<h2>评分明细</h2>
<table>
  <thead><tr>
    <th>#</th><th>文件</th><th>分辨率</th><th>状态</th>
    ${metrics.map((m) => `<th>${esc(METRIC_LABELS[m] ?? m)}</th>`).join('')}
  </tr></thead>
  <tbody>
${rows || '<tr><td colspan="8">无数据</td></tr>'}
  </tbody>
</table>

${doneItems.length ? `<h2>${esc(METRIC_LABELS[primary] ?? primary)} 对比</h2>\n${bars}` : ''}

<footer>
  <strong>指标说明与已知局限</strong>
  <ul>
    <li>PSNR / SSIM / VMAF 均要求<b>逐帧空间对应</b>。本服务已对齐分辨率、帧率、时长与起始时间点，但<b>不做内容级时间轴纠偏</b>；若待测视频相对参考片存在片头偏移、变速或剪切，分数会显著失真且不可信。</li>
    <li>帧率取两路较小值：待测片帧率更低时参考片会被抽帧，反之待测片会被插帧，均会影响分数。</li>
    <li>VMAF 为空间域指标，不反映音频质量、卡顿或主观色彩偏好。VMAF 的 min 表示最差单帧分数，harmonic mean 对低分帧更敏感。</li>
    <li>报告只展示池化值（均值 / 最差帧 / 谐波均值），不包含逐帧曲线。</li>
  </ul>
  <p>ffmpeg：${esc(ffmpegVersion || 'unknown')}<br />生成时间：${esc(generatedAt)}</p>
</footer>
</body>
</html>
`;
}

/** 机器可读结果 */
export function buildResultJson(job, items) {
  const metrics = String(job.metrics).split(',').filter(Boolean);
  return {
    jobId: job.id,
    status: job.status,
    metrics,
    normalization: job.normalization ? JSON.parse(job.normalization) : null,
    createdAt: job.created_at,
    finishedAt: job.finished_at,
    error: job.error ?? null,
    items: items.map((it) => {
      const probe = it.probe_json ? JSON.parse(it.probe_json) : null;
      const m = {};
      for (const name of metrics) {
        if (it[name] === null || it[name] === undefined) continue;
        m[name] = { mean: it[name] };
        if (name === 'psnr' && it.psnr_min != null) m[name].min = it.psnr_min;
        if (name === 'vmaf') {
          if (it.vmaf_min != null) m[name].min = it.vmaf_min;
          if (it.vmaf_harmonic != null) m[name].harmonicMean = it.vmaf_harmonic;
        }
      }
      return {
        itemId: it.id,
        seq: it.seq,
        name: it.orig_name,
        status: it.status,
        probe,
        compared: {
          frames: it.compared_frames ?? null,
          seconds: it.compared_seconds ?? null,
        },
        metrics: m,
        elapsedMs: it.elapsed_ms ?? null,
        error: it.error ?? null,
      };
    }),
  };
}
