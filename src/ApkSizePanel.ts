import * as vscode from "vscode";

// ─── Data contract ────────────────────────────────────────────────────────────

export interface ApkTopItem {
  name: string;
  sizeBytes: number;
  category: "Dart" | "Assets" | "Native" | "Other";
}

export interface ApkReportData {
  totalBytes: number;
  dartCodeBytes: number;
  assetsBytes: number;
  nativeBytes: number;
  otherBytes: number;
  topItems: ApkTopItem[];
  jsonPath: string;
  buildDate: string;
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export class ApkSizePanel {
  private static _current: ApkSizePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  // ── Constructor ──────────────────────────────────────────────────────────
  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Open (or reveal) the dashboard and push fresh data into it. */
  public static show(data: ApkReportData): void {
    const column = vscode.ViewColumn.Two;

    if (ApkSizePanel._current) {
      ApkSizePanel._current._panel.reveal(column);
    } else {
      const panel = vscode.window.createWebviewPanel(
        "apkSizeReport",
        "📊 App Size Report",
        column,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );
      ApkSizePanel._current = new ApkSizePanel(panel);
    }

    const instance = ApkSizePanel._current;
    instance._panel.webview.html = instance._buildHtml();

    // Small delay so the page JS has time to register the message listener
    setTimeout(() => {
      instance._panel.webview.postMessage({ command: "setData", data });
    }, 400);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  public dispose(): void {
    ApkSizePanel._current = undefined;
    this._panel.dispose();
    for (const d of this._disposables) { d.dispose(); }
    this._disposables = [];
  }

  // ── HTML ─────────────────────────────────────────────────────────────────

  private _buildHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>App Size Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg:        #0d1117;
    --surface:   #161b22;
    --border:    #30363d;
    --text:      #e6edf3;
    --muted:     #8b949e;
    --accent:    #58a6ff;
    --dart:      #5c9eff;
    --assets:    #3fb950;
    --native:    #f78166;
    --other:     #d2a8ff;
    --radius:    12px;
    --card-pad:  20px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    min-height: 100vh;
    padding: 28px 32px 48px;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 28px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .header-icon { font-size: 32px; line-height: 1; }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -.3px; }
  .header .meta { font-size: 12px; color: var(--muted); margin-top: 3px; }

  /* ── Stat cards ── */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--card-pad);
    position: relative;
    overflow: hidden;
    transition: transform .15s;
  }
  .card:hover { transform: translateY(-2px); }
  .card::before {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    background: var(--stripe, var(--accent));
    border-radius: var(--radius) var(--radius) 0 0;
  }
  .card.total  { --stripe: var(--accent); }
  .card.dart   { --stripe: var(--dart); }
  .card.assets { --stripe: var(--assets); }
  .card.native { --stripe: var(--native); }
  .card.other  { --stripe: var(--other); }

  .card-label  { font-size: 11px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); margin-bottom: 8px; }
  .card-value  { font-size: 26px; font-weight: 700; line-height: 1; }
  .card-sub    { font-size: 11px; color: var(--muted); margin-top: 6px; }

  /* ── Main content: chart + table ── */
  .main {
    display: grid;
    grid-template-columns: 1fr 1.3fr;
    gap: 24px;
    align-items: start;
  }
  @media (max-width: 760px) { .main { grid-template-columns: 1fr; } }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: var(--card-pad);
  }
  .panel-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: .7px;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }

  /* Chart wrapper: keep it square and centered */
  .chart-wrap {
    position: relative;
    width: 100%;
    max-width: 280px;
    margin: 0 auto 16px;
  }

  /* Legend */
  .legend { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; }
  .legend-item { display: flex; align-items: center; gap: 10px; font-size: 13px; }
  .legend-dot { width: 11px; height: 11px; border-radius: 3px; flex-shrink: 0; }

  /* Table */
  table { width: 100%; border-collapse: collapse; }
  thead th {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: .7px;
    color: var(--muted);
    text-align: left;
    padding: 0 0 10px;
    border-bottom: 1px solid var(--border);
  }
  tbody tr { transition: background .1s; }
  tbody tr:hover { background: rgba(255,255,255,.03); }
  tbody td {
    padding: 11px 8px 11px 0;
    border-bottom: 1px solid rgba(48,54,61,.6);
    vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: none; }

  .td-name { font-size: 13px; font-weight: 500; word-break: break-all; }
  .td-size { font-size: 13px; font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
  .td-bar  { width: 120px; }
  .bar-track { background: var(--border); border-radius: 99px; height: 6px; overflow: hidden; }
  .bar-fill  { height: 100%; border-radius: 99px; background: var(--accent); transition: width .4s ease; }

  .badge {
    display: inline-block;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 99px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .4px;
  }
  .badge-dart   { background: rgba(92,158,255,.18); color: var(--dart); }
  .badge-assets { background: rgba(63,185,80,.18);  color: var(--assets); }
  .badge-native { background: rgba(247,129,102,.18); color: var(--native); }
  .badge-other  { background: rgba(210,168,255,.18); color: var(--other); }

  /* Loading state */
  #loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    gap: 16px;
    color: var(--muted);
    font-size: 15px;
  }
  .spinner {
    width: 36px; height: 36px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #report { display: none; }
</style>
</head>
<body>

<!-- Loading state (shown until data arrives) -->
<div id="loading">
  <div class="spinner"></div>
  <span>Waiting for analysis data…</span>
</div>

<!-- Report (hidden until postMessage fires) -->
<div id="report">

  <div class="header">
    <div class="header-icon">📊</div>
    <div>
      <h1>App Size Report</h1>
      <div class="meta" id="meta-line">flutter build apk --analyze-size</div>
    </div>
  </div>

  <!-- Stat cards -->
  <div class="cards">
    <div class="card total">
      <div class="card-label">Total APK Size</div>
      <div class="card-value" id="c-total">—</div>
      <div class="card-sub">compressed download size</div>
    </div>
    <div class="card dart">
      <div class="card-label">Dart Code</div>
      <div class="card-value" id="c-dart">—</div>
      <div class="card-sub" id="c-dart-pct">AOT compiled snapshot</div>
    </div>
    <div class="card assets">
      <div class="card-label">Assets</div>
      <div class="card-value" id="c-assets">—</div>
      <div class="card-sub" id="c-assets-pct">images, fonts &amp; data</div>
    </div>
    <div class="card native">
      <div class="card-label">Native / JVM</div>
      <div class="card-value" id="c-native">—</div>
      <div class="card-sub" id="c-native-pct">.so libs &amp; dex</div>
    </div>
    <div class="card other">
      <div class="card-label">Other</div>
      <div class="card-value" id="c-other">—</div>
      <div class="card-sub" id="c-other-pct">manifest, res, etc.</div>
    </div>
  </div>

  <!-- Chart + table -->
  <div class="main">

    <!-- Pie chart -->
    <div class="panel">
      <div class="panel-title">Size Breakdown</div>
      <div class="chart-wrap">
        <canvas id="pieChart"></canvas>
      </div>
      <div class="legend" id="legend"></div>
    </div>

    <!-- Top 5 table -->
    <div class="panel">
      <div class="panel-title">Heaviest Components</div>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th style="text-align:right">Size</th>
            <th class="td-bar"></th>
          </tr>
        </thead>
        <tbody id="top-table"></tbody>
      </table>
    </div>

  </div>
</div><!-- /report -->

<script>
const vscode = acquireVsCodeApi();

// ── Utilities ────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b >= 1_048_576) return (b / 1_048_576).toFixed(2) + ' MB';
  if (b >= 1_024)     return (b / 1_024).toFixed(1) + ' KB';
  return b + ' B';
}
function pct(part, total) {
  if (!total) return '0.0';
  return ((part / total) * 100).toFixed(1);
}

const COLORS = {
  Dart:   '#5c9eff',
  Assets: '#3fb950',
  Native: '#f78166',
  Other:  '#d2a8ff',
};

let chartInstance = null;

// ── Render ───────────────────────────────────────────────────────────────────
function render(data) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('report').style.display  = 'block';

  const { totalBytes, dartCodeBytes, assetsBytes, nativeBytes, otherBytes, topItems, jsonPath, buildDate } = data;

  // Header meta
  document.getElementById('meta-line').textContent =
    buildDate + '  ·  ' + jsonPath.split(/[\\/]/).pop();

  // Cards
  document.getElementById('c-total').textContent  = fmtBytes(totalBytes);
  document.getElementById('c-dart').textContent   = fmtBytes(dartCodeBytes);
  document.getElementById('c-assets').textContent = fmtBytes(assetsBytes);
  document.getElementById('c-native').textContent = fmtBytes(nativeBytes);
  document.getElementById('c-other').textContent  = fmtBytes(otherBytes);
  document.getElementById('c-dart-pct').textContent   = pct(dartCodeBytes, totalBytes) + '% of total';
  document.getElementById('c-assets-pct').textContent = pct(assetsBytes,   totalBytes) + '% of total';
  document.getElementById('c-native-pct').textContent = pct(nativeBytes,   totalBytes) + '% of total';
  document.getElementById('c-other-pct').textContent  = pct(otherBytes,    totalBytes) + '% of total';

  // ── Pie chart ──
  const segments = [
    { label: 'Dart Code', value: dartCodeBytes, color: COLORS.Dart },
    { label: 'Assets',    value: assetsBytes,   color: COLORS.Assets },
    { label: 'Native',    value: nativeBytes,   color: COLORS.Native },
    { label: 'Other',     value: otherBytes,    color: COLORS.Other },
  ].filter(s => s.value > 0);

  if (chartInstance) { chartInstance.destroy(); }
  chartInstance = new Chart(document.getElementById('pieChart'), {
    type: 'doughnut',
    data: {
      labels: segments.map(s => s.label),
      datasets: [{
        data:            segments.map(s => s.value),
        backgroundColor: segments.map(s => s.color),
        borderColor:     '#161b22',
        borderWidth:     3,
        hoverOffset:     8,
      }],
    },
    options: {
      cutout: '62%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ' ' + fmtBytes(ctx.parsed) +
              '  (' + pct(ctx.parsed, totalBytes) + '%)',
          },
        },
      },
    },
  });

  // Legend
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  segments.forEach(s => {
    const el = document.createElement('div');
    el.className = 'legend-item';
    el.innerHTML =
      '<div class="legend-dot" style="background:' + s.color + '"></div>' +
      '<span style="flex:1">' + s.label + '</span>' +
      '<span style="color:#8b949e;font-variant-numeric:tabular-nums">' +
        fmtBytes(s.value) + ' (' + pct(s.value, totalBytes) + '%)' +
      '</span>';
    legend.appendChild(el);
  });

  // ── Top items table ──
  const tbody = document.getElementById('top-table');
  tbody.innerHTML = '';
  const maxBytes = topItems.length ? topItems[0].sizeBytes : 1;

  topItems.forEach(item => {
    const cat   = item.category || 'Other';
    const color = COLORS[cat] || COLORS.Other;
    const barW  = Math.round((item.sizeBytes / maxBytes) * 100);
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td class="td-name">' + escHtml(item.name) + '</td>' +
      '<td><span class="badge badge-' + cat.toLowerCase() + '">' + cat + '</span></td>' +
      '<td class="td-size" style="text-align:right">' + fmtBytes(item.sizeBytes) + '</td>' +
      '<td class="td-bar">' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + barW +
        '%;background:' + color + '"></div></div>' +
      '</td>';
    tbody.appendChild(tr);
  });
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Message listener ─────────────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.command === 'setData') { render(msg.data); }
});
</script>
</body>
</html>`;
  }
}
