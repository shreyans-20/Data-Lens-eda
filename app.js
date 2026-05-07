/* ══════════════════════════════
   STATE
══════════════════════════════ */
let edaData         = null;
let cleanedData     = null;   // working copy for quick-fix / export
let tableMetadata   = null;   // table/dimension metadata
let colChart        = null;
let visChart        = null;
let boxplotChart    = null;
let activeCol       = null;
let activeChartType = 'bar';
let rawDateData     = {};
let columnSortKey   = 'name';
let pbiShowLabels   = false;
let columnSortAsc   = true;
let allColumns      = [];
let activeBoxplotCol = null;
let dataModified    = false;
let fileId          = null;
let appliedFixes    = { drop_duplicates: false, fill_nulls: null };

const VIS_COLORS = ['#1d4ed8','#6d28d9','#15803d','#b45309','#b91c1c','#0e7490','#be185d','#4d7c0f','#c2410c','#5b21b6'];

Chart.register(ChartDataLabels);

/* ══════════════════════════════
   THEME TOGGLE
══════════════════════════════ */
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('theme-toggle').textContent = isDark ? '🌙' : '☀️';
  localStorage.setItem('dl-theme', isDark ? 'light' : 'dark');
}
// Restore saved theme on load
(function() {
  const saved = localStorage.getItem('dl-theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = saved === 'dark' ? '☀️' : '🌙';
  });
})();

/* ══════════════════════════════
   TOAST SYSTEM
══════════════════════════════ */
function toast(msg, type = 'info', duration = 3500) {
  const icons = { info:'ℹ️', success:'✅', error:'❌', warning:'⚠️' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `<span aria-hidden="true">${icons[type]||''}</span><span>${escHtml(msg)}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 280);
  }, duration);
}

/* ══════════════════════════════
   HTML ESCAPING (XSS safe)
══════════════════════════════ */
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ══════════════════════════════
   DRAG & DROP + FILE INPUT
══════════════════════════════ */
const uploadBox = document.getElementById('upload-box');
uploadBox.addEventListener('dragover',  e => { e.preventDefault(); uploadBox.classList.add('drag'); });
uploadBox.addEventListener('dragleave', () => uploadBox.classList.remove('drag'));
uploadBox.addEventListener('drop', e => {
  e.preventDefault();
  uploadBox.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
uploadBox.addEventListener('click', e => {
  if (e.target.tagName !== 'BUTTON') document.getElementById('file-input').click();
});
uploadBox.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById('file-input').click(); }
});
document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

/* ══════════════════════════════
   SCROLL TO TOP
══════════════════════════════ */
window.addEventListener('scroll', () => {
  document.getElementById('scroll-top').classList.toggle('show', window.scrollY > 300);
});

/* ══════════════════════════════
   KEYBOARD SHORTCUTS
══════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeVisBuilder(); closeReport(); }
});

/* ══════════════════════════════
   FILE HANDLING — large file support
══════════════════════════════ */
const LOADER_MSGS = [
  'Reading file structure…',
  'Detecting column types…',
  'Computing distributions…',
  'Running correlation engine…',
  'Detecting outliers (IQR)…',
  'Assembling your dashboard…',
];

function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv','xlsx','xls'].includes(ext)) {
    toast('Please upload a CSV or Excel (.xlsx / .xls) file.', 'error');
    return;
  }

  show('loader');
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  document.getElementById('loader-sub').textContent = `${file.name} · ${sizeMB} MB`;

  let idx = 0;
  const msgEl = document.getElementById('loader-msg');
  const interval = setInterval(() => {
    msgEl.textContent = LOADER_MSGS[idx++ % LOADER_MSGS.length];
  }, 600);

  const fd = new FormData();
  fd.append('file', file);

  fetch('/upload', { method: 'POST', body: fd })
    .then(r => {
      if (!r.ok) throw new Error(`Server error: ${r.status}`);
      return r.json();
    })
    .then(data => {
      clearInterval(interval);
      if (data.error) {
        toast('Error: ' + data.error, 'error');
        show('upload-screen');
        return;
      }
      edaData = data;
      fileId = data.file_id;
      tableMetadata = data.table_metadata || {};
      appliedFixes = { drop_duplicates: false, fill_nulls: null };
      cleanedData = JSON.parse(JSON.stringify(data)); // deep copy
      dataModified = false;
      renderDashboard(data, file.name);
      toast('File loaded successfully!', 'success');
    })
    .catch(err => {
      clearInterval(interval);
      toast('Upload failed: ' + err.message + '. Is the server running?', 'error');
      show('upload-screen');
    });
}

/* ══════════════════════════════
   SAMPLE DATA
══════════════════════════════ */
function loadSampleData() {
  const rows = 312;
  const mockData = {
    shape: { rows, cols: 8 },
    duplicate_rows: 4,
    columns: [
      { name:'Age',        type:'numeric',     null_count:3,  null_pct:1.0,  unique_count:45,
        stats:{ mean:'38.2',median:'37.0',std:'11.4',min:'18',max:'72',skew:'0.32',kurtosis:'-0.14',outlier_count:8 },
        boxplot:{ min:18, q1:29, median:37, q3:47, max:72, outliers:[19,70,72] },
        histogram:{ bin_edges:[18,25,32,39,46,53,60,72], counts:[32,58,74,62,45,26,15] } },
      { name:'Salary',     type:'numeric',     null_count:5,  null_pct:1.6,  unique_count:289,
        stats:{ mean:'62400',median:'58000',std:'22100',min:'22000',max:'145000',skew:'1.12',kurtosis:'0.88',outlier_count:14 },
        boxplot:{ min:22000, q1:44000, median:58000, q3:80000, max:145000, outliers:[135000,140000,145000] },
        histogram:{ bin_edges:[22000,38000,54000,70000,86000,102000,118000,145000], counts:[28,62,88,72,34,16,12] } },
      { name:'Experience', type:'numeric',     null_count:0,  null_pct:0.0,  unique_count:22,
        stats:{ mean:'7.8',median:'7.0',std:'5.2',min:'0',max:'25',skew:'0.75',kurtosis:'0.12',outlier_count:6 },
        boxplot:{ min:0, q1:3, median:7.0, q3:12, max:25, outliers:[24,25] },
        histogram:{ bin_edges:[0,3,6,9,12,15,18,25], counts:[44,68,72,58,34,22,14] } },
      { name:'Score',      type:'numeric',     null_count:12, null_pct:3.8,  unique_count:98,
        stats:{ mean:'74.6',median:'76.0',std:'14.2',min:'32',max:'99',skew:'-0.28',kurtosis:'-0.34',outlier_count:5 },
        boxplot:{ min:32, q1:65, median:76, q3:86, max:99, outliers:[32,35] },
        histogram:{ bin_edges:[32,45,58,65,72,79,86,99], counts:[8,18,38,62,74,66,46] } },
      { name:'Hours/Week', type:'numeric',     null_count:2,  null_pct:0.6,  unique_count:18,
        stats:{ mean:'41.3',median:'40.0',std:'8.6',min:'20',max:'68',skew:'0.44',kurtosis:'0.22',outlier_count:10 },
        boxplot:{ min:20, q1:36, median:40, q3:46, max:68, outliers:[20,68] },
        histogram:{ bin_edges:[20,28,32,36,40,44,48,68], counts:[12,24,42,76,72,46,40] } },
      { name:'Department', type:'categorical', null_count:0,  null_pct:0.0,  unique_count:6,
        bar_chart:{ labels:['Engineering','Marketing','Sales','HR','Finance','Operations'], counts:[98,62,54,40,36,22] } },
      { name:'Education',  type:'categorical', null_count:8,  null_pct:2.6,  unique_count:4,
        bar_chart:{ labels:["Bachelor's","Master's","PhD","Diploma"], counts:[158,96,34,24] } },
      { name:'Status',     type:'categorical', null_count:0,  null_pct:0.0,  unique_count:3,
        bar_chart:{ labels:['Active','On Leave','Resigned'], counts:[244,42,26] } },
    ],
    correlations:[
      {col_a:'Salary',     col_b:'Experience', r:0.74},
      {col_a:'Salary',     col_b:'Age',        r:0.61},
      {col_a:'Experience', col_b:'Age',         r:0.58},
      {col_a:'Score',      col_b:'Salary',      r:0.42},
      {col_a:'Hours/Week', col_b:'Score',        r:-0.31},
      {col_a:'Experience', col_b:'Score',        r:0.28},
      {col_a:'Age',        col_b:'Score',        r:0.19},
      {col_a:'Hours/Week', col_b:'Salary',       r:0.22},
    ],
    scatter:{ col_a:'Salary', col_b:'Experience',
      data: Array.from({length:80},()=>[Math.round(Math.random()*24), Math.round(22000+Math.random()*120000)]) },
    preview_rows: Array.from({length:10},(_,i)=>({
      Age: 22+Math.floor(Math.random()*50),
      Salary: 25000+Math.floor(Math.random()*120000),
      Experience: Math.floor(Math.random()*25),
      Score: 35+Math.floor(Math.random()*64),
      'Hours/Week': 22+Math.floor(Math.random()*46),
      Department: ['Engineering','Marketing','Sales','HR','Finance'][Math.floor(Math.random()*5)],
      Education: ["Bachelor's","Master's","PhD","Diploma"][Math.floor(Math.random()*4)],
      Status: ['Active','On Leave','Resigned'][Math.floor(Math.random()*3)],
    })),
    table_metadata: {
      fact_table: 'Employee_Data',
      dimension_tables: [],
      column_origins: {
        'Age':'Employee_Data','Salary':'Employee_Data','Experience':'Employee_Data','Score':'Employee_Data',
        'Hours/Week':'Employee_Data','Department':'Employee_Data','Education':'Employee_Data','Status':'Employee_Data'
      }
    }
  };

  edaData = mockData;
  fileId = 'sample';
  tableMetadata = mockData.table_metadata;
  appliedFixes = { drop_duplicates: false, fill_nulls: null };
  cleanedData = JSON.parse(JSON.stringify(mockData));
  dataModified = false;
  renderDashboard(mockData, 'sample_employee_data.csv');
  toast('Sample data loaded!', 'success');
}

/* ══════════════════════════════
   SHOW / HIDE SCREENS
══════════════════════════════ */
function show(id) {
  ['upload-screen','loader','dashboard'].forEach(s => {
    const el = document.getElementById(s);
    el.style.display = s === id ? (id === 'dashboard' ? 'block' : 'flex') : 'none';
  });
}

function resetApp() {
  edaData = null; cleanedData = null; activeCol = null; tableMetadata = null;
  fileId = null;
  appliedFixes = { drop_duplicates: false, fill_nulls: null };
  allColumns = []; dataModified = false;
  [colChart, visChart, boxplotChart].forEach(c => c && c.destroy());
  colChart = visChart = boxplotChart = null;
  document.getElementById('file-input').value = '';
  document.getElementById('btn-vis-builder').style.display = 'none';
  document.getElementById('btn-reset').style.display = 'none';
  document.getElementById('btn-report').style.display = 'none';
  document.getElementById('file-badge').classList.remove('show');
  document.getElementById('export-banner').classList.remove('show');
  show('upload-screen');
}

/* ══════════════════════════════
   RENDER DASHBOARD
══════════════════════════════ */
function renderDashboard(data, fname) {
  show('dashboard');
  document.getElementById('db-fname').textContent = fname;
  document.getElementById('db-fmeta').textContent =
    data.shape.rows.toLocaleString() + ' rows × ' + data.shape.cols + ' columns';
  document.getElementById('badge-name').textContent = fname;
  document.getElementById('btn-vis-builder').style.display = 'inline-flex';
  document.getElementById('btn-reset').style.display = 'inline-flex';
  document.getElementById('btn-report').style.display = 'inline-flex';

  allColumns = [...data.columns];

  renderOverview(data);
  renderPreview(data);
  renderColumnTable(data.columns);
  renderColPills(data.columns);
  renderQuality(data.columns);
  renderCorrelations(data);
  renderOutlierSection(data.columns);
  setupVisBuilder(data);
  updateSectionNumbers(data);
  updateQuickFixButtons(data);

  const first = data.columns.find(c => c.type === 'numeric');
  if (first) selectCol(first.name);
}

/* ══════════════════════════════
   SECTION NUMBERING
══════════════════════════════ */
function updateSectionNumbers(data) {
  let n = 3;
  document.getElementById('col-sec-label').textContent = `0${n++} — Column Explorer & Statistics`;
  document.getElementById('quality-sec-label').textContent = `0${n++} — Data Health & Completeness`;
  document.getElementById('corr-sec-label').textContent  = `0${n++} — Correlations`;
  document.getElementById('outlier-sec-label').textContent = `0${n++} — Outlier Explorer`;
}

/* ══════════════════════════════
   SECTION 1: OVERVIEW
══════════════════════════════ */
function renderOverview(data) {
  const numC  = data.columns.filter(c => c.type === 'numeric').length;
  const catC  = data.columns.filter(c => c.type === 'categorical').length;
  const nullC = data.columns.filter(c => c.null_count > 0).length;
  const dups  = data.duplicate_rows;
  const totalNulls = data.columns.reduce((s,c) => s + c.null_count, 0);

  const items = [
    { val: data.shape.rows.toLocaleString(), lbl: 'Rows',           cls: '' },
    { val: data.shape.cols,                  lbl: 'Columns',        cls: '' },
    { val: numC,                             lbl: 'Numeric Cols',   cls: '' },
    { val: catC,                             lbl: 'Categorical',    cls: '' },
    { val: dups,                             lbl: 'Duplicates',     cls: dups > 0 ? 'warn' : '' },
    { val: nullC,                            lbl: 'Cols w/ Nulls',  cls: nullC > 0 ? 'warn' : '' },
  ];

  document.getElementById('overview-grid').innerHTML = items.map(i =>
    `<div class="ov-card ${i.cls}" role="listitem">
      <div class="ov-val">${i.val}</div>
      <div class="ov-label">${i.lbl}</div>
    </div>`
  ).join('');
}

/* ══════════════════════════════
   SECTION 2: DATA PREVIEW
══════════════════════════════ */
function renderPreview(data) {
  const rows = data.preview_rows;
  if (!rows || rows.length === 0) { document.getElementById('preview-section').style.display = 'none'; return; }
  document.getElementById('preview-section').style.display = 'block';
  const cols = Object.keys(rows[0]);

  document.getElementById('preview-thead').innerHTML =
    `<tr><th scope="col">#</th>${cols.map(c => `<th scope="col">${escHtml(c)}</th>`).join('')}</tr>`;

  document.getElementById('preview-tbody').innerHTML = rows.map((row, i) =>
    `<tr>
      <td class="row-num">${i+1}</td>
      ${cols.map(c => `<td>${escHtml(String(row[c] ?? ''))}</td>`).join('')}
    </tr>`
  ).join('');
}

/* ══════════════════════════════
   SECTION 3a: COLUMN TABLE
══════════════════════════════ */
function renderColumnTable(columns) {
  document.getElementById('col-tbody').innerHTML = columns.map(col => {
    const s   = col.stats || {};
    const bc  = col.type === 'numeric' ? 'type-num' : col.type === 'categorical' ? 'type-cat' : 'type-dt';
    const mode = col.bar_chart ? escHtml(col.bar_chart.labels[0]) : '—';
    const isActive = col.name === activeCol ? 'active-row' : '';
    return `<tr class="${isActive}" data-col="${escHtml(col.name)}" onclick="selectColFromTable(this)" role="row" tabindex="0" aria-label="Column: ${escHtml(col.name)}">
      <td>${escHtml(col.name)}</td>
      <td><span class="type-badge ${bc}">${col.type}</span></td>
      <td>${col.null_pct}%</td>
      <td>${col.unique_count.toLocaleString()}</td>
      <td>${s.mean   !== undefined ? s.mean   : '—'}</td>
      <td>${s.median !== undefined ? s.median : '—'}</td>
      <td style="max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${mode}</td>
    </tr>`;
  }).join('');
}

function selectColFromTable(row) { selectCol(row.getAttribute('data-col')); }

function filterColumns(query) {
  const q = query.toLowerCase();
  const filtered = allColumns.filter(c => c.name.toLowerCase().includes(q));
  renderColumnTable(filtered);
  renderColPills(filtered);
}

function sortColumnTable(key, btn) {
  if (columnSortKey === key) { columnSortAsc = !columnSortAsc; }
  else { columnSortKey = key; columnSortAsc = true; }
  document.querySelectorAll('thead th').forEach(t => t.classList.remove('sorted'));
  if (btn) btn.classList.add('sorted');

  const sorted = [...allColumns].sort((a,b) => {
    let va, vb;
    if      (key === 'name')   { va = a.name.toLowerCase(); vb = b.name.toLowerCase(); }
    else if (key === 'type')   { va = a.type; vb = b.type; }
    else if (key === 'null')   { va = a.null_pct; vb = b.null_pct; }
    else if (key === 'unique') { va = a.unique_count; vb = b.unique_count; }
    if (va < vb) return columnSortAsc ? -1 : 1;
    if (va > vb) return columnSortAsc ? 1  : -1;
    return 0;
  });
  renderColumnTable(sorted);
}

/* ══════════════════════════════
   SECTION 3b: COL PILLS + STATS
══════════════════════════════ */
function renderColPills(columns) {
  const wrap = document.getElementById('col-pills');
  wrap.innerHTML = columns.map(col => {
    const isActive = col.name === activeCol ? 'active' : '';
    return `<button class="col-pill-btn ${isActive}" data-name="${escHtml(col.name)}"
      onclick="selectColFromPill(this)" aria-pressed="${col.name === activeCol}">${escHtml(col.name)}</button>`;
  }).join('');
}

function selectColFromPill(btn) { selectCol(btn.getAttribute('data-name')); }

function selectCol(name) {
  activeCol = name;
  document.querySelectorAll('.col-pill-btn').forEach(p => {
    p.classList.toggle('active', p.getAttribute('data-name') === name);
    p.setAttribute('aria-pressed', p.getAttribute('data-name') === name);
  });
  document.querySelectorAll('#col-tbody tr').forEach(r =>
    r.classList.toggle('active-row', r.getAttribute('data-col') === name));

  const col = edaData.columns.find(c => c.name === name);
  if (!col) return;
  if (col.type === 'numeric')      renderNumericStats(col);
  else if (col.type === 'categorical') renderCatStats(col);
  else                             renderDateStats(col);
}

function renderNumericStats(col) {
  const s = col.stats;
  const content = document.getElementById('stats-content');
  const hd = col.histogram;
  let modeVal = '—';
  if (hd) {
    const maxIdx = hd.counts.indexOf(Math.max(...hd.counts));
    modeVal = hd.bin_edges[maxIdx] !== undefined ? Number(hd.bin_edges[maxIdx]).toFixed(2) : '—';
  }

  const statItems = [
    {v:s.mean,l:'Mean'},{v:s.median,l:'Median'},{v:modeVal,l:'Mode'},
    {v:s.std,l:'Std Dev'},{v:s.min,l:'Min'},{v:s.max,l:'Max'},
    {v:s.skew,l:'Skewness'},{v:s.kurtosis,l:'Kurtosis'},{v:s.outlier_count,l:'Outliers'},
  ];

  content.innerHTML = `
    <div class="stat-grid">
      ${statItems.map(i => `
        <div class="stat-item">
          <div class="stat-val">${i.v !== undefined && i.v !== null ? escHtml(String(i.v)) : '—'}</div>
          <div class="stat-lbl">${i.l}</div>
        </div>`).join('')}
    </div>
    <div class="chart-area" role="img" aria-label="Distribution histogram for ${escHtml(col.name)}">
      <canvas id="col-chart-canvas"></canvas>
    </div>`;

  colChart && colChart.destroy();
  const labels = hd ? hd.bin_edges.slice(0,-1).map((v,i2) => v.toFixed(1)+'–'+hd.bin_edges[i2+1].toFixed(1)) : [];
  colChart = new Chart(document.getElementById('col-chart-canvas'), {
    type: 'bar',
    data: { labels, datasets: [{ data: hd ? hd.counts : [], backgroundColor: 'rgba(29,78,216,0.22)', borderColor: 'rgba(29,78,216,0.8)', borderWidth: 1.5, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { font:{family:'Roboto Mono',size:11}, color:'gray', maxRotation:45 }, grid: { color: 'rgba(128,128,128,0.15)' } },
        y: { ticks: { font:{family:'Roboto Mono',size:11}, color:'gray' }, grid: { color: 'rgba(128,128,128,0.15)' } }
      }
    }
  });
}

function renderCatStats(col) {
  const content = document.getElementById('stats-content');
  const bc = col.bar_chart;
  const total = bc ? bc.counts.reduce((a,b) => a+b, 0) : 0;
  const mode = bc ? escHtml(bc.labels[0]) : '—';
  const displayLabels = bc ? bc.labels.slice(0,10) : [];
  const displayCounts = bc ? bc.counts.slice(0,10) : [];

  content.innerHTML = `
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat-item"><div class="stat-val">${col.unique_count.toLocaleString()}</div><div class="stat-lbl">Unique</div></div>
      <div class="stat-item"><div class="stat-val" style="font-size:0.95rem;word-break:break-word">${mode}</div><div class="stat-lbl">Mode (Top)</div></div>
      <div class="stat-item"><div class="stat-val">${col.null_pct}%</div><div class="stat-lbl">Null %</div></div>
    </div>
    <div class="chart-area" style="margin:14px 0" role="img" aria-label="Category distribution for ${escHtml(col.name)}">
      <canvas id="col-chart-canvas"></canvas>
    </div>
    <div style="font-family:var(--mono);font-size:0.69rem;color:var(--muted);line-height:2">
      ${displayLabels.map((l,i) => `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:10px"><strong>${escHtml(l)}</strong> — ${displayCounts[i].toLocaleString()} (${((displayCounts[i]/total)*100).toFixed(1)}%)</span>`).join('')}
      ${bc && bc.labels.length > 10 ? `<span style="color:var(--accent);font-size:0.65rem">+${bc.labels.length - 10} more</span>` : ''}
    </div>`;

  colChart && colChart.destroy();
  colChart = new Chart(document.getElementById('col-chart-canvas'), {
    type: 'doughnut',
    data: {
      labels: displayLabels,
      datasets: [{ data: displayCounts, backgroundColor: VIS_COLORS.slice(0,displayLabels.length).map(c=>c+'cc'), borderColor: VIS_COLORS.slice(0,displayLabels.length), borderWidth: 2, hoverOffset: 6 }]
    },
    options: {
      responsive: true, cutout: '60%',
      plugins: {
        legend: { position:'right', labels:{ font:{family:'Roboto Mono',size:11}, color:'gray', boxWidth:10, padding:8 } },
        tooltip: { callbacks: { label: ctx => { const pct = ((ctx.parsed/total)*100).toFixed(1); return ` ${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct}%)`; } } }
      }
    }
  });
}

function renderDateStats(col) {
  document.getElementById('stats-content').innerHTML = `
    <div class="no-col" style="padding:30px">
      📅 Date column — <strong>${escHtml(col.name)}</strong><br/>
      <span style="color:var(--muted);font-size:0.8rem;font-weight:300">Use the Visualization Builder to analyse time-based columns with clearer charts.</span>
    </div>`;
}

/* ══════════════════════════════
   SECTION 4: CORRELATIONS
══════════════════════════════ */
function renderCorrelations(data) {
  const grid = document.getElementById('corr-grid');
  const corrs = data.correlations;
  if (!corrs || corrs.length === 0) {
    grid.innerHTML = `<div class="corr-empty">No numeric correlations found in this dataset.</div>`;
    return;
  }

  const sorted = [...corrs].sort((a,b) => Math.abs(b.r) - Math.abs(a.r));

  grid.innerHTML = sorted.map(c => {
    const r = Number(c.r);
    const abs = Math.abs(r);
    const pct = (abs * 100).toFixed(0);
    const color = r > 0 ? '#1d4ed8' : '#b91c1c';
    const strength = abs >= 0.7 ? 'Strong' : abs >= 0.4 ? 'Moderate' : 'Weak';
    return `<div class="corr-item" onclick="openScatterForCorr('${escHtml(c.col_a)}','${escHtml(c.col_b)}')" title="Click to view scatter plot" role="listitem" tabindex="0" aria-label="${escHtml(c.col_a)} vs ${escHtml(c.col_b)}: r=${r.toFixed(3)}, ${strength}">
      <div class="corr-pair">${escHtml(c.col_a)} × ${escHtml(c.col_b)}</div>
      <div class="corr-bar-wrap"><div class="corr-bar" style="width:${pct}%;background:${color}"></div></div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="corr-val" style="color:${color}">${r > 0 ? '+' : ''}${r.toFixed(3)}</div>
        <div style="font-family:var(--mono);font-size:0.62rem;color:var(--muted)">${strength}</div>
      </div>
    </div>`;
  }).join('');

  // Build heatmap
  buildHeatmap(data);
}

function switchCorrView(view, btn) {
  document.getElementById('corr-bars-view').style.display   = view === 'bars'    ? 'block' : 'none';
  document.getElementById('corr-heatmap-view').style.display = view === 'heatmap' ? 'block' : 'none';
  document.querySelectorAll('.corr-view-tab').forEach(t => {
    t.classList.toggle('active', t === btn);
    t.setAttribute('aria-selected', t === btn);
  });
}

function buildHeatmap(data) {
  const numCols = data.columns.filter(c => c.type === 'numeric').map(c => c.name);
  if (numCols.length < 2) {
    document.getElementById('heatmap-wrap').innerHTML = '<p style="padding:30px;text-align:center;color:var(--muted);font-size:0.82rem">Need at least 2 numeric columns for heatmap.</p>';
    return;
  }

  const matrix = {};
  numCols.forEach(a => {
    matrix[a] = {};
    numCols.forEach(b => { matrix[a][b] = a === b ? 1 : null; });
  });
  (data.correlations || []).forEach(c => {
    if (matrix[c.col_a]) matrix[c.col_a][c.col_b] = Number(c.r);
    if (matrix[c.col_b]) matrix[c.col_b][c.col_a] = Number(c.r);
  });

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  function heatColor(v) {
    if (v === null) return 'var(--bg)';
    const t = Math.abs(v);
    if (isDark) {
      if (v > 0) {
        return `rgb(${Math.round(17 + 74 * t)},${Math.round(16 + 122 * t)},${Math.round(9 + 231 * t)})`;
      } else {
        return `rgb(${Math.round(17 + 231 * t)},${Math.round(16 + 97 * t)},${Math.round(9 + 104 * t)})`;
      }
    } else {
      if (v > 0) {
        return `rgb(${Math.round(245 - 216 * t)},${Math.round(244 - 166 * t)},${Math.round(240 - 24 * t)})`;
      } else {
        return `rgb(${Math.round(245 - 60 * t)},${Math.round(244 - 216 * t)},${Math.round(240 - 212 * t)})`;
      }
    }
  }

  let html = '<table class="heatmap-table" role="table" aria-label="Correlation heatmap"><thead><tr><th scope="col"></th>';
  numCols.forEach(c => { html += `<th scope="col" title="${escHtml(c)}">${escHtml(c.length > 8 ? c.slice(0,7)+'…' : c)}</th>`; });
  html += '</tr></thead><tbody>';
  numCols.forEach(rowName => {
    html += `<tr><th scope="row" style="text-align:left;padding:6px 8px;background:var(--bg);color:var(--muted);font-weight:500;white-space:nowrap">${escHtml(rowName.length > 8 ? rowName.slice(0,7)+'…' : rowName)}</th>`;
    numCols.forEach(colName => {
      const v = matrix[rowName][colName];
      const bg = heatColor(v);
      const textColor = isDark ? '#ffffff' : (Math.abs(v) > 0.5 ? '#ffffff' : '#181612');
      const display = v !== null ? (v === 1 ? '1.00' : v.toFixed(2)) : '—';
      const label = `${escHtml(rowName)} vs ${escHtml(colName)}: ${display}`;
      html += `<td style="background:${bg}; color:${textColor};" title="${label}" aria-label="${label}" onclick="openScatterForCorr('${escHtml(rowName)}','${escHtml(colName)}')">${display}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('heatmap-wrap').innerHTML = html;
}

function openScatterForCorr(colA, colB) {
  openVisBuilder();
  setTimeout(() => {
    document.getElementById('vis-x').value = colA;
    document.getElementById('vis-y').value = colB;
    selectChartType(document.querySelector('.ct-btn[data-chart="scatter"]'), 'scatter');
    renderVisChart();
  }, 100);
}

/* ══════════════════════════════
   SECTION 6: OUTLIER EXPLORER + BOX PLOTS
══════════════════════════════ */
function renderOutlierSection(columns) {
  const numCols = columns.filter(c => c.type === 'numeric' && c.stats && c.stats.outlier_count > 0);
  const section = document.getElementById('outlier-section');
  if (numCols.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const totalOutliers = numCols.reduce((sum,c) => sum + (c.stats?.outlier_count||0), 0);
  document.getElementById('outlier-count-badge').textContent = totalOutliers + ' total outliers detected';

  const tabs = document.getElementById('outlier-col-tabs');
  tabs.innerHTML = numCols.map((c, i) =>
    `<button class="outlier-tab ${i===0?'active':''}" data-col="${escHtml(c.name)}"
      onclick="selectOutlierCol(this)" role="tab" aria-selected="${i===0}">${escHtml(c.name)} (${c.stats.outlier_count})</button>`
  ).join('');

  if (numCols.length > 0) showOutlierTable(numCols[0].name);

  // Build box plot tabs for ALL numeric columns (not just outlier ones)
  const allNum = columns.filter(c => c.type === 'numeric' && c.stats);
  const bpTabs = document.getElementById('boxplot-col-tabs');
  bpTabs.innerHTML = allNum.map((c,i) =>
    `<button class="boxplot-tab ${i===0?'active':''}" data-col="${escHtml(c.name)}"
      onclick="selectBoxplotCol(this)" role="tab" aria-selected="${i===0}">${escHtml(c.name)}</button>`
  ).join('');
  if (allNum.length > 0) { activeBoxplotCol = allNum[0].name; renderBoxplot(allNum[0]); }
}

function selectOutlierCol(btn) {
  document.querySelectorAll('.outlier-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
  btn.classList.add('active'); btn.setAttribute('aria-selected','true');
  showOutlierTable(btn.getAttribute('data-col'));
}

function showOutlierTable(colName) {
  const col = edaData.columns.find(c => c.name === colName);
  const content = document.getElementById('outlier-content');
  const s = col?.stats;
  const bp = col?.boxplot;
  if (!s) { content.innerHTML = '<div class="outlier-empty">No outlier data available.</div>'; return; }

  const q1 = bp ? bp.q1 : s.q1;
  const q3 = bp ? bp.q3 : s.q3;
  const iqr = q3 && q1 !== undefined ? q3 - q1 : null;
  const lower = iqr !== null ? (q1 - 1.5 * iqr) : null;
  const upper = iqr !== null ? (q3 + 1.5 * iqr) : null;

  content.innerHTML = `
    <div style="padding:12px 18px;background:var(--red-l);border-bottom:1px solid var(--border);font-family:var(--mono);font-size:0.72rem;color:var(--red)" role="alert">
      IQR method: outliers are values < <strong>${lower !== null ? lower.toFixed(2) : 'N/A'}</strong>
      or > <strong>${upper !== null ? upper.toFixed(2) : 'N/A'}</strong> &nbsp;·&nbsp;
      <strong>${s.outlier_count}</strong> outlier${s.outlier_count !== 1 ? 's' : ''} found in <strong>${escHtml(colName)}</strong>
    </div>
    <div style="padding:14px 18px;font-family:var(--mono);font-size:0.72rem;color:var(--muted)">
      Outlier detection uses the IQR method (Q1 − 1.5×IQR, Q3 + 1.5×IQR). 
      Click <strong>📦 Box Plots</strong> above to visualise the distribution.
    </div>`;
}

function toggleBoxPlot() {
  const panel = document.getElementById('boxplot-panel');
  const btn   = document.getElementById('btn-boxplot');
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  btn.setAttribute('aria-expanded', !isOpen);
  btn.textContent = isOpen ? '📦 Box Plots' : '📦 Hide Box Plots';
}

function selectBoxplotCol(btn) {
  document.querySelectorAll('.boxplot-tab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
  btn.classList.add('active'); btn.setAttribute('aria-selected','true');
  activeBoxplotCol = btn.getAttribute('data-col');
  const col = edaData.columns.find(c => c.name === activeBoxplotCol);
  if (col) renderBoxplot(col);
}

function renderBoxplot(col) {
  const s = col.stats;
  const bp = col.boxplot;
  if (!s || !bp) return;

  boxplotChart && boxplotChart.destroy();

  const min = bp.min, q1 = bp.q1, median = bp.median, q3 = bp.q3, max = bp.max;
  const iqr = q3 - q1;
  const lowerFence = Math.max(min, q1 - 1.5 * iqr);
  const upperFence = Math.min(max, q3 + 1.5 * iqr);

  boxplotChart = new Chart(document.getElementById('boxplot-canvas'), {
    type: 'bar',
    data: {
      labels: [col.name],
      datasets: [
        { label: 'Min→Q1', data: [{ x: col.name, y: q1 - lowerFence }], backgroundColor: 'transparent', borderColor: 'transparent', base: lowerFence, barThickness: 2 },
        { label: 'IQR Box (Q1→Q3)', data: [{ x: col.name, y: q3 - q1 }], backgroundColor: 'rgba(29,78,216,0.25)', borderColor: '#1d4ed8', borderWidth: 2, base: q1, barThickness: 60 },
        { label: 'Median', data: [{ x: col.name, y: 0.5 }], backgroundColor: '#1d4ed8', borderColor: '#1d4ed8', borderWidth: 0, base: median - 0.25, barThickness: 60 },
        { label: 'Q3→Max', data: [{ x: col.name, y: upperFence - q3 }], backgroundColor: 'transparent', borderColor: 'transparent', base: q3, barThickness: 2 },
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { font:{family:'Roboto Mono',size:11}, color:'gray', boxWidth:10 } },
        tooltip: {
          callbacks: {
            title: () => col.name,
            label: ctx => {
              const labels = ['Lower whisker → Q1','Q1 → Q3 (IQR)','Median','Q3 → Upper whisker'];
              return labels[ctx.datasetIndex] || '';
            }
          }
        }
      },
      scales: {
        x: { ticks: { font:{family:'Roboto Mono',size:11}, color:'gray' }, grid:{color:'rgba(128,128,128,0.15)'} },
        y: { ticks: { font:{family:'Roboto Mono',size:11}, color:'gray' }, grid:{color:'rgba(128,128,128,0.15)'} }
      }
    }
  });

  document.getElementById('boxplot-stats').innerHTML = [
    { l: 'Min',   v: min.toLocaleString() },
    { l: 'Q1',    v: q1.toFixed(2) },
    { l: 'Median',v: median.toLocaleString() },
    { l: 'Mean',  v: s.mean.toLocaleString() },
    { l: 'Q3',    v: q3.toFixed(2) },
    { l: 'Max',   v: max.toLocaleString() },
    { l: 'IQR',   v: iqr.toFixed(2) },
    { l: 'Lower fence', v: lowerFence.toFixed(2) },
    { l: 'Upper fence', v: upperFence.toFixed(2) },
    { l: 'Outliers', v: s.outlier_count || 0 },
  ].map(i => `<div class="bstat"><strong>${i.l}:</strong> ${i.v}</div>`).join('');
}

/* ══════════════════════════════
   SECTION 7: DATA QUALITY
══════════════════════════════ */
function renderQuality(columns) {
  const grid = document.getElementById('quality-grid');
  const sortedCols = [...columns].sort((a, b) => b.null_pct - a.null_pct);
  
  grid.innerHTML = sortedCols.map(col => {
    const fill  = 100 - col.null_pct;
    const isPerfect = fill === 100;
    
    const color = isPerfect ? 'var(--green)' : fill > 80 ? 'var(--amber)' : 'var(--red)';
    const icon = isPerfect ? '✨' : fill > 80 ? '⚠️' : '🚨';
    
    return `<div class="q-item" role="listitem" style="display:flex; flex-direction:column; gap:10px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div class="q-name" title="${escHtml(col.name)}" style="margin:0;">${escHtml(col.name)}</div>
        <div style="font-size:0.9rem; filter: grayscale(${isPerfect ? '0' : '0.2'});" title="${isPerfect ? 'Perfect completeness' : 'Missing values detected'}">${icon}</div>
      </div>
      
      <div class="q-bar-wrap" role="progressbar" aria-valuenow="${fill}" aria-valuemin="0" aria-valuemax="100" aria-label="${escHtml(col.name)} fill rate: ${fill.toFixed(1)}%">
        <div class="q-bar" style="width:0%;background:${color};transition: width 1s cubic-bezier(0.4, 0, 0.2, 1);" data-fill="${fill}"></div>
      </div>
      
      <div style="display:flex; justify-content:space-between; align-items:center; font-family:var(--mono); font-size:0.75rem; color:var(--muted);">
        <span style="color:${isPerfect ? 'var(--green)' : 'inherit'}; font-weight:500;">${fill.toFixed(1)}% Completeness</span>
        <span>${col.null_count > 0 ? `<strong style="color:${color}">${col.null_count.toLocaleString()} missing</strong>` : '0 missing'}</span>
      </div>
    </div>`;
  }).join('');

  setTimeout(() => {
    document.querySelectorAll('.q-bar').forEach(bar => {
      bar.style.width = bar.getAttribute('data-fill') + '%';
    });
  }, 100);
}

function updateQuickFixButtons(data) {
  const hasNulls = data.columns.some(c => c.null_count > 0);
  const hasNumNulls = data.columns.some(c => c.type === 'numeric' && c.null_count > 0);
  document.getElementById('btn-drop-dupes').style.display = data.duplicate_rows > 0 ? 'inline-flex' : 'none';
  document.getElementById('btn-fill-mean').style.display   = hasNumNulls ? 'inline-flex' : 'none';
  document.getElementById('btn-fill-median').style.display = hasNumNulls ? 'inline-flex' : 'none';
}

/* ── QUICK FIX: Drop Duplicates ── */
function quickFixDropDuplicates() {
  if (!cleanedData) return;
  const before = cleanedData.duplicate_rows;
  if (before === 0) { toast('No duplicate rows to remove.', 'info'); return; }
  cleanedData.shape.rows = Math.max(0, cleanedData.shape.rows - before);
  cleanedData.duplicate_rows = 0;
  appliedFixes.drop_duplicates = true;
  document.getElementById('btn-drop-dupes').style.display = 'none';
  dataModified = true;
  renderOverview(cleanedData);
  showExportBanner(`${before} duplicate rows dropped. Dataset now has ${cleanedData.shape.rows.toLocaleString()} rows.`);
  toast(`Dropped ${before} duplicate rows.`, 'success');
}

/* ── QUICK FIX: Fill Nulls ── */
function quickFixFillNulls(method) {
  if (!cleanedData) return;
  let filled = 0;
  cleanedData.columns.forEach(col => {
    if (col.type === 'numeric' && col.null_count > 0) {
      filled += col.null_count;
      col.null_count = 0;
      col.null_pct   = 0;
    }
  });
  if (filled === 0) { toast('No numeric nulls to fill.', 'info'); return; }
  appliedFixes.fill_nulls = method;
  dataModified = true;
  renderQuality(cleanedData.columns);
  updateQuickFixButtons(cleanedData);
  showExportBanner(`${filled} null values filled with ${method}. Export the cleaned dataset below.`);
  toast(`Filled ${filled} null values using ${method}.`, 'success');
}

/* ── ML PREP MODAL LOGIC ── */
function openMlPrep() {
  if (!edaData) return;
  const grid = document.getElementById('ml-drop-grid');
  grid.innerHTML = edaData.columns.map(c => `
    <label class="checkbox-group" style="margin-bottom:4px">
      <input type="checkbox" value="${escHtml(c.name)}" class="ml-drop-chk" />
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
    </label>
  `).join('');
  
  document.getElementById('ml-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeMlPrep() {
  document.getElementById('ml-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function applyAndExportMlPrep() {
  const dropCols = Array.from(document.querySelectorAll('.ml-drop-chk:checked')).map(chk => chk.value);
  const encodeCat = document.getElementById('ml-encode-cat').checked;
  const scaleNum = document.getElementById('ml-scale-num').checked;
  
  appliedFixes.drop_columns = dropCols;
  appliedFixes.encode_categorical = encodeCat;
  appliedFixes.scale_numeric = scaleNum;
  
  closeMlPrep();
  exportCleanedCSV();
}

/* ── EXPORT CLEANED CSV ── */
function exportCleanedCSV() {
  if (fileId === 'sample') {
    const data = cleanedData || edaData;
    const rows = data.preview_rows;
    if (!rows || rows.length === 0) { toast('No data loaded.', 'error'); return; }
    const cols = Object.keys(rows[0]);
    const csv  = [
      cols.map(c => `"${String(c).replace(/"/g,'""')}"`).join(','),
      ...rows.map(row => cols.map(c => {
        const v = row[c] ?? '';
        return typeof v === 'string' ? `"${v.replace(/"/g,'""')}"` : v;
      }).join(','))
    ].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sample_cleaned.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Sample CSV exported!', 'success');
    return;
  }

  const data = cleanedData || edaData;
  if (!data) { toast('No data loaded.', 'error'); return; }
  if (!data || !fileId) { toast('No data loaded.', 'error'); return; }

  const fname = document.getElementById('db-fname').textContent.replace(/[^a-z0-9._-]/gi,'_');
  const dlName = `cleaned_${fname}.csv`;

  if (!data.preview_rows || data.preview_rows.length === 0) {
    toast('No preview data available. Please reload the file and try again.', 'warning', 5000);
    return;
  }

  toast('Generating export on server...', 'info');
  fetch('/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId, fixes: appliedFixes })
  })
  .then(res => {
    if (!res.ok) throw new Error('Export failed on server. Session may have expired.');
    return res.blob();
  })
  .then(blob => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = dlName;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('Cleaned CSV exported successfully!', 'success');
  })
  .catch(err => {
    toast(err.message, 'error');
  });
}

function showExportBanner(msg) {
  const banner = document.getElementById('export-banner');
  document.getElementById('export-banner-msg').innerHTML = `<strong>Dataset modified.</strong> ${escHtml(msg)}`;
  banner.classList.add('show');
  banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ══════════════════════════════
   POWER BI STYLE VIS BUILDER
══════════════════════════════ */
let activePBIChartType = 'bar';
let pbiChartInstance = null;

function setupVisBuilder(data) {
  // Setup is handled lazily in openVisBuilder to dynamically inject layout
}

function openVisBuilder() {
  if (!edaData) return;
  
  let pbiModal = document.getElementById('pbi-modal');
  if (!pbiModal) {
     pbiModal = document.createElement('div');
     pbiModal.id = 'pbi-modal';
     pbiModal.style.cssText = 'position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.8); z-index:9999; display:flex; justify-content:center; align-items:center;';
     pbiModal.innerHTML = `
        <div style="background:var(--bg, #fff); width:95%; height:90%; border-radius:8px; display:flex; flex-direction:column; overflow:hidden; font-family:sans-serif; box-shadow:0 10px 40px rgba(0,0,0,0.4);">
           <div style="padding:15px; border-bottom:1px solid var(--border, #eee); display:flex; justify-content:space-between; align-items:center; background:var(--bg, #fff);">
               <h2 style="margin:0; font-size:1.2rem; color:var(--ink-full, #333);">Visualization Builder (Power BI Style)</h2>
               <button onclick="closeVisBuilder()" style="border:none; background:transparent; font-size:1.5rem; cursor:pointer; color:var(--ink-full, #333);">&times;</button>
           </div>
           <div style="display:flex; flex:1; overflow:hidden;">
               <!-- Left Sidebar: Columns -->
               <div style="width:240px; border-right:1px solid var(--border, #eee); padding:10px; overflow-y:auto; background:var(--bg, #fff);">
                   <h4 style="margin-top:0; color:var(--ink-full, #333);">Data Fields</h4>
                   <div style="font-size: 0.65rem; color: var(--muted); margin-bottom: 8px;">(N) Numeric · (C) Categorical</div>
                   
                   <!-- Table Metadata Info -->
                   <div id="pbi-table-info" style="background:#f0f7ff;padding:8px;margin-bottom:10px;border-radius:4px;border-left:3px solid #0078d4;font-size:0.75rem;display:none;">
                     <strong style="color:#0078d4;display:block;margin-bottom:4px;">📊 Table Structure</strong>
                     <div id="pbi-table-info-content"></div>
                   </div>
                   
                   <div id="pbi-fields" style="display:flex; flex-direction:column; gap:8px;"></div>
               </div>
               
               <!-- Main Canvas -->
               <div style="flex:1; padding:20px; display:flex; flex-direction:column; background:var(--bg, #f9f9f9); position:relative;">
                   <div id="pbi-empty" style="flex:1; display:flex; align-items:center; justify-content:center; color:var(--muted, gray); border:2px dashed var(--border, #ccc); border-radius:8px; text-align: center; padding: 20px;">
                        Select fields and click "Generate Visual" to render chart
                   </div>
                   <div style="flex:1; position:relative;"><canvas id="pbi-canvas" style="display:none;"></canvas></div>
                   <div id="pbi-table-container" style="display:none; flex:1; overflow:auto; background:var(--bg, #fff); border:1px solid var(--border, #eee);"></div>
                   <div style="padding-top: 10px; display: flex; align-items: center; justify-content: flex-end; gap: 20px;">
                        <label style="font-size: 0.8rem; cursor: pointer; color: var(--ink-full); display: flex; align-items: center; gap: 5px;"><input type="checkbox" id="pbi-show-labels"> Show Data Labels</label>
                        <button id="pbi-export-btn" style="padding: 8px 16px; background: #15803d; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; display:none;">Export PNG</button>
                        <button id="pbi-generate-btn" style="padding: 8px 16px; background: var(--accent, #0078d4); color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Generate Visual</button>
                   </div>
               </div>
               
               <!-- Right Sidebar: Visuals & Properties -->
               <div style="width:280px; border-left:1px solid var(--border, #eee); padding:15px; overflow-y:auto; background:var(--bg, #fff);">
                   <h4 style="margin-top:0; color:var(--ink-full, #333);">Visualizations</h4>
                   <div id="pbi-chart-icons-grid" style="display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; margin-bottom:20px;"></div>
                   
                   <h4 style="border-bottom:1px solid var(--border, #eee); padding-bottom:5px; color:var(--ink-full, #333);">Build Visual</h4>
                   <div class="pbi-zones" style="display:flex; flex-direction:column; gap:15px;">
                       <div class="pbi-zone">
                           <div class="pbi-zone-label" style="font-size:0.8rem; margin-bottom:4px; font-weight:bold; color:var(--ink-full, #333);">X-axis / Category</div>
                           <select class="pbi-select" data-zone="x" style="width:100%; padding:6px; border:1px solid var(--border); border-radius:4px; background: var(--bg); color: var(--ink-full); font-size: 0.8rem;"></select>
                           <div class="pbi-drop" data-zone="x" style="display:none;">Drop Field Here</div>
                       </div>
                       <div class="pbi-zone">
                           <div class="pbi-zone-label" style="font-size:0.8rem; margin-bottom:4px; font-weight:bold; color:var(--ink-full, #333);">Y-axis / Values</div>
                           <select class="pbi-select" data-zone="y" style="width:100%; padding:6px; border:1px solid var(--border); border-radius:4px; background: var(--bg); color: var(--ink-full); font-size: 0.8rem;"></select>
                           <div class="pbi-drop" data-zone="y" style="display:none;">Drop Field Here</div>
                       </div>
                       <div class="pbi-zone">
                           <div class="pbi-zone-label" style="font-size:0.8rem; margin-bottom:4px; font-weight:bold; color:var(--ink-full, #333);">Legend / Breakdown</div>
                           <select class="pbi-select" data-zone="group" style="width:100%; padding:6px; border:1px solid var(--border); border-radius:4px; background: var(--bg); color: var(--ink-full); font-size: 0.8rem;"></select>
                           <div class="pbi-drop" data-zone="group" style="display:none;">Drop Field Here</div>
                       </div>
                   </div>
               </div>
           </div>
        </div>
     `;
     document.body.appendChild(pbiModal);
     
     const style = document.createElement('style');
     style.innerHTML = `
        .pbi-icon-btn { background:transparent; border:1px solid var(--border, #ccc); border-radius:4px; transition:all 0.2s; font-size:1.4rem; padding:8px; cursor:pointer; color:var(--ink-full, #333); }
        .pbi-icon-wrapper { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .pbi-icon-name { font-size: 0.65rem; color: var(--muted); text-align: center; }
        .pbi-icon-btn:hover { background:var(--accent, #0078d4); border-color:#0078d4; color:#fff; }
        .pbi-icon-btn.active { background:#cce4f7; border-color:#005a9e; }
        .pbi-field { padding:8px 10px; background:var(--bg, #fff); border:1px solid var(--border, #eee); border-radius:4px; font-size:0.85rem; cursor:grab; user-select:none; color:var(--ink-full, #333); transition:background 0.2s; }
        .pbi-field:hover { background:#f0f8ff; }
        .pbi-field:active { cursor:grabbing; }
        .pbi-drop { border:1px dashed #aaa; border-radius:4px; min-height:35px; display:flex; align-items:center; justify-content:center; font-size:0.8rem; color:var(--muted, #888); background:var(--bg, #fafafa); transition:0.2s; }
        .pbi-drop.dragover { background:#e1f0fa !important; border-color:#0078d4 !important; }
        .pbi-dropped { display:flex; justify-content:space-between; width:100%; padding:0 8px; background:#0078d4; color:#fff; border-radius:2px; line-height:33px; font-size:0.8rem; }
        .pbi-dropped span.del { cursor:pointer; font-weight:bold; font-size:1.1rem; }
        #pbi-table-container table { width:100%; border-collapse:collapse; text-align:left; color:var(--ink-full, #333); }
        #pbi-table-container th { background:var(--bg, #f4f4f4); padding:10px; border-bottom:2px solid var(--border, #ddd); font-size:0.85rem; font-weight:bold; position:sticky; top:0; }
        #pbi-table-container td { padding:8px 10px; border-bottom:1px solid var(--border, #eee); font-size:0.8rem; }
     `;
     document.head.appendChild(style);

     setupPBIEvents();
  } else {
     pbiModal.style.display = 'flex';
  }
  
  // Populate chart icons
  const iconsGrid = document.getElementById('pbi-chart-icons-grid');
  const chartTypes = [
    { id: 'bar', icon: '📊', name: 'Column' },
    { id: 'horizontal-bar', icon: '⎯', name: 'Bar' },
    { id: 'line', icon: '📈', name: 'Line' },
    { id: 'area', icon: '◢', name: 'Area' },
    { id: 'pie', icon: '🥧', name: 'Pie' },
    { id: 'doughnut', icon: '🍩', name: 'Donut' },
    { id: 'scatter', icon: '⚄', name: 'Scatter' },
    { id: 'table', icon: '🗄️', name: 'Table' },
    { id: 'matrix', icon: '🧮', name: 'Matrix' },
    { id: 'forecast', icon: '🔮', name: 'Forecast' },
    { id: 'timeline', icon: '📅', name: 'Timeline' },
    { id: 'pareto', icon: '📉', name: 'Pareto' },
    { id: 'heatmap', icon: '🔥', name: 'Heatmap' },
    { id: 'histogram', icon: '📶', name: 'Hist' }
  ];
  iconsGrid.innerHTML = chartTypes.map(c => `
    <div class="pbi-icon-wrapper">
        <button class="pbi-icon-btn ${activePBIChartType === c.id ? 'active' : ''}" data-type="${c.id}" title="${c.name}">${c.icon}</button>
        <span class="pbi-icon-name">${c.name}</span>
    </div>`).join('');

  // Populate Field List
  const fieldsContainer = document.getElementById('pbi-fields');
  fieldsContainer.innerHTML = '';
  edaData.columns.forEach(col => {
      const f = document.createElement('div');
      f.className = 'pbi-field';
      f.draggable = true;
      f.dataset.col = col.name;
      f.innerHTML = `<b style="color:#0078d4; font-family:monospace;">${col.type === 'numeric' ? '(N)' : '(C)'}</b> &nbsp;${escHtml(col.name)}`;
      f.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', col.name);
      });
      fieldsContainer.appendChild(f);
  });

  // Populate Table Metadata Info
  if (tableMetadata && (tableMetadata.fact_table || tableMetadata.dimension_tables?.length > 0)) {
      const tableInfoEl = document.getElementById('pbi-table-info');
      const tableInfoContent = document.getElementById('pbi-table-info-content');
      tableInfoEl.style.display = 'block';
      let infoHtml = '';
      if (tableMetadata.fact_table) {
          infoHtml += `<strong style="color:#0078d4;">Fact:</strong> ${escHtml(tableMetadata.fact_table)}<br/>`;
      }
      if (tableMetadata.dimension_tables && tableMetadata.dimension_tables.length > 0) {
          infoHtml += `<strong style="color:#9ca3af;">Dims:</strong><br/>`;
          tableMetadata.dimension_tables.forEach(dim => {
              infoHtml += `&nbsp;• ${escHtml(dim.name)}<br/>`;
          });
      }
      tableInfoContent.innerHTML = infoHtml;
  }

  // Populate Selects
  const selects = document.querySelectorAll('.pbi-select');
  selects.forEach(sel => {
      sel.innerHTML = '<option value="">None / Auto</option>' + edaData.columns.map(c => 
          `<option value="${escHtml(c.name)}">${c.type === 'numeric' ? '(N)' : '(C)'} ${escHtml(c.name)}</option>`).join('');
  });
  
  // Auto-select defaults
  if (!document.querySelector('.pbi-select[data-zone="x"]').value) {
      const cat = edaData.columns.find(c => c.type === 'categorical');
      if (cat) document.querySelector('.pbi-select[data-zone="x"]').value = cat.name;
  }
  if (!document.querySelector('.pbi-select[data-zone="y"]').value) {
      const num = edaData.columns.find(c => c.type === 'numeric');
      if (num) document.querySelector('.pbi-select[data-zone="y"]').value = num.name;
  }

  setupPBIEvents();
}

function closeVisBuilder() {
  const pbiModal = document.getElementById('pbi-modal');
  if (pbiModal) pbiModal.style.display = 'none';
  const oldModal = document.getElementById('vis-modal');
  if (oldModal) oldModal.classList.remove('open');
  document.body.style.overflow = '';
}

function setupPBIEvents() {
   document.querySelectorAll('.pbi-icon-btn').forEach(btn => {
       btn.addEventListener('click', e => {
           activePBIChartType = btn.dataset.type;
           document.querySelectorAll('.pbi-icon-btn').forEach(b => b.classList.remove('active'));
           btn.classList.add('active');
           const labels = document.querySelectorAll('.pbi-zone-label');
           if (activePBIChartType === 'pie' || activePBIChartType === 'doughnut') {
               labels[0].textContent = 'Legend / Category';
               labels[1].textContent = 'Values';
           } else {
               labels[0].textContent = 'X-axis / Category';
               labels[1].textContent = 'Y-axis / Values';
           }
       });
   });
   
   document.getElementById('pbi-generate-btn').onclick = renderPBIChart;
   document.getElementById('pbi-show-labels').onchange = e => {
       pbiShowLabels = e.target.checked;
   };
   document.getElementById('pbi-export-btn').onclick = exportPBIVisual;

   document.querySelectorAll('.pbi-drop').forEach(zone => {
       zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
       zone.addEventListener('dragleave', e => { zone.classList.remove('dragover'); });
       zone.addEventListener('drop', e => {
           e.preventDefault();
           zone.classList.remove('dragover');
           const col = e.dataTransfer.getData('text/plain');
           if (col) {
               zone.dataset.val = col;
               zone.innerHTML = `<div class="pbi-dropped">${escHtml(col)} <span class="del" onclick="removePBIField(event, this)">×</span></div>`;
           }
       });
   });
}

function removePBIField(e, el) {
    e.stopPropagation();
    const zone = el.closest('.pbi-drop');
    zone.dataset.val = '';
    zone.innerHTML = 'Drop Field Here';
}

function renderPBIChart() {
    const xCol = document.querySelector('.pbi-select[data-zone="x"]').value;
    const yCol = document.querySelector('.pbi-select[data-zone="y"]').value;
    const groupCol = document.querySelector('.pbi-select[data-zone="group"]').value;
    
    if (!xCol && activePBIChartType !== 'table' && activePBIChartType !== 'matrix') {
        showPBIEmpty('Please drop a field into the X-axis / Category zone.');
        return;
    }
    
    if (fileId === 'sample') {
        showPBIEmpty('Advanced aggregations require a real file upload. Sample data operates strictly locally.');
        return;
    }
    
    document.getElementById('pbi-empty').style.display = 'none';
    document.getElementById('pbi-canvas').style.display = 'none';
    document.getElementById('pbi-table-container').style.display = 'none';
    document.getElementById('pbi-export-btn').style.display = 'none';
    
    fetch('/api/chart_data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId, x_col: xCol, y_col: yCol, group_col: groupCol, agg: 'sum', type: activePBIChartType })
    })
    .then(r => r.json())
    .then(data => {
        if (data.error) { showPBIEmpty(data.error); return; }
        drawPBIChart(data, xCol, yCol, groupCol);
    })
    .catch(e => showPBIEmpty('Failed to load chart data. Ensure backend is running.'));
}

function drawPBIChart(data, xCol, yCol, groupCol) {
    if (pbiChartInstance) { pbiChartInstance.destroy(); pbiChartInstance = null; }
    
    let type = activePBIChartType;
    
    if (type === 'table' || type === 'matrix') {
        const tCont = document.getElementById('pbi-table-container');
        tCont.style.display = 'block';
        
        // Build table metadata info panel
        let metaHtml = '';
        if (tableMetadata && (tableMetadata.fact_table || tableMetadata.dimension_tables)) {
            metaHtml = '<div style="background:#f0f0f0;padding:12px;margin-bottom:12px;border-radius:6px;font-size:0.85rem;border-left:4px solid #0078d4;">';
            if (tableMetadata.fact_table) {
                metaHtml += `<strong>📊 Fact Table:</strong> <span style="color:#0078d4;font-family:monospace;">${escHtml(tableMetadata.fact_table)}</span><br/>`;
            }
            if (tableMetadata.dimension_tables && tableMetadata.dimension_tables.length > 0) {
                metaHtml += '<strong>🔑 Dimension Tables:</strong><br/>';
                tableMetadata.dimension_tables.forEach(dim => {
                    metaHtml += `&nbsp;&nbsp;• <span style="color:#6b7280;font-family:monospace;">${escHtml(dim.name)}</span> `;
                    metaHtml += `<span style="font-size:0.75rem;color:#9ca3af;">(join: ${dim.join_keys.map(jk => escHtml(jk)).join(', ')})</span><br/>`;
                });
            }
            metaHtml += '</div>';
        }
        
        let html = metaHtml + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;"><thead><tr style="background:#f5f5f5;border-bottom:2px solid #ddd;"><th style="padding:8px;text-align:left;border-right:1px solid #eee;">' + escHtml(xCol||'Category') + '</th>';
        
        if (data.series) {
            Object.keys(data.series).forEach(k => {
                const origin = tableMetadata?.column_origins?.[k] || 'fact';
                const originLabel = origin === tableMetadata?.fact_table ? '📊' : '🔑';
                html += '<th style="padding:8px;text-align:left;border-right:1px solid #eee;"><span title="Table: ' + escHtml(origin) + '">' + originLabel + ' ' + escHtml(k) + '</span></th>';
            });
            html += '</tr></thead><tbody>';
            data.x.forEach((xV, i) => {
                html += '<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;border-right:1px solid #eee;">' + escHtml(xV) + '</td>';
                Object.keys(data.series).forEach(k => {
                    const val = data.series[k][i];
                    html += '<td style="padding:8px;border-right:1px solid #eee;">' + (typeof val === 'number' ? val.toLocaleString() : escHtml(String(val))) + '</td>';
                });
                html += '</tr>';
            });
        } else {
            const originLabel = tableMetadata?.column_origins?.[yCol] ? (tableMetadata.column_origins[yCol] === tableMetadata.fact_table ? '📊' : '🔑') : '📊';
            html += '<th style="padding:8px;text-align:left;border-right:1px solid #eee;"><span title="' + (tableMetadata?.column_origins?.[yCol] ? 'Table: ' + escHtml(tableMetadata.column_origins[yCol]) : '') + '">' + originLabel + ' ' + escHtml(yCol||'Value Count') + '</span></th></tr></thead><tbody>';
            data.x.forEach((xV, i) => {
                const val = data.y[i];
                html += '<tr style="border-bottom:1px solid #eee;"><td style="padding:8px;border-right:1px solid #eee;">' + escHtml(xV) + '</td><td style="padding:8px;border-right:1px solid #eee;">' + (typeof val === 'number' ? val.toLocaleString() : escHtml(String(val))) + '</td></tr>';
            });
        }
        html += '</tbody></table>';
        tCont.innerHTML = html;
        return;
    }
    
    document.getElementById('pbi-canvas').style.display = 'block';
    document.getElementById('pbi-export-btn').style.display = 'inline-block';
    const ctx = document.getElementById('pbi-canvas');
    
    let indexAxis = 'x';
    if (type === 'horizontal-bar') {
        type = 'bar';
        indexAxis = 'y';
    }

    let datasets = [];
    if (data.series) {
        let cIdx = 0;
        for (const [key, vals] of Object.entries(data.series)) {
            const color = VIS_COLORS[cIdx % VIS_COLORS.length];
            datasets.push({
                label: key,
                data: vals,
                backgroundColor: type === 'line' ? 'transparent' : color + 'cc',
                borderColor: type === 'heatmap' ? 'transparent' : color,
                borderWidth: 2,
                fill: (type === 'area' || type === 'forecast') ? true : false,
                tension: 0.3
            });
            cIdx++;
        }
    } else {
        const cLen = data.y ? data.y.length : 0;
        datasets = [{
            label: yCol || 'Count',
            data: data.y || [],
            backgroundColor: VIS_COLORS.slice(0, cLen).map(c => c + 'cc'),
            borderColor: VIS_COLORS.slice(0, cLen),
            borderWidth: (type === 'line' || type === 'area') ? 2 : 1,
            fill: type === 'area',
            tension: 0.3
        }];
        
        if (type === 'pareto') {
            const total = data.y.reduce((a, b) => a + b, 0);
            let running = 0;
            const cumulative = data.y.map(v => {
                running += v;
                return (running / total) * 100;
            });
            datasets.push({
                label: 'Cumulative %',
                data: cumulative,
                type: 'line',
                borderColor: '#ef4444',
                yAxisID: 'y1',
                fill: false,
                tension: 0
            });
        }
    }
    
    const isStacked = type === 'stacked-bar';
    const chartType = (isStacked || type === 'pareto' || type === 'forecast' || type === 'area' || type === 'timeline') ? (isStacked ? 'bar' : (['area', 'forecast', 'timeline'].includes(type) ? 'line' : (type === 'pareto' ? 'bar' : type))) : type;
    
    const options = {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: indexAxis,
        plugins: { 
            legend: { display: true, position: 'right', labels: { font: { family: 'Roboto Mono', size: 11 }, color: 'gray'} },
            datalabels: { display: pbiShowLabels, color: 'gray', anchor: 'end', align: 'top', font: { size: 10 } }
        }
    };
    
    if (['bar', 'line', 'scatter', 'forecast', 'area', 'timeline'].includes(chartType) || type === 'pareto') {
        options.scales = {
            y1: (type === 'pareto') ? { position: 'right', min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { drawOnChartArea: false } } : undefined,
            x: { stacked: isStacked, ticks: { color: 'gray', font: { family: 'Roboto Mono', size: 11 } }, grid: { color: 'rgba(128,128,128,0.15)' } },
            y: { stacked: isStacked, beginAtZero: true, ticks: { color: 'gray', font: { family: 'Roboto Mono', size: 11 } }, grid: { color: 'rgba(128,128,128,0.15)' } }
        };
    }
    
    pbiChartInstance = new Chart(ctx, {
        type: chartType,
        data: { labels: data.x || [], datasets },
        options: options
    });
}

function exportPBIVisual() {
    if (!pbiChartInstance) return;
    const canvas = document.getElementById('pbi-canvas');
    const link = document.createElement('a');
    link.download = `datalens_visual_${activePBIChartType}.png`;

    // Create a temporary canvas to ensure white background (avoids transparency issues)
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const tCtx = tmp.getContext('2d');
    tCtx.fillStyle = '#ffffff';
    tCtx.fillRect(0, 0, tmp.width, tmp.height);
    tCtx.drawImage(canvas, 0, 0);

    link.href = tmp.toDataURL('image/png');
    link.click();
    toast('Visual exported as PNG!', 'success');
}

function showPBIEmpty(msg) {
    document.getElementById('pbi-canvas').style.display = 'none';
    document.getElementById('pbi-table-container').style.display = 'none';
    document.getElementById('pbi-export-btn').style.display = 'none';
    const empty = document.getElementById('pbi-empty');
    empty.style.display = 'flex';
    empty.innerText = msg;
}

/* ══════════════════════════════
   REPORT GENERATOR
══════════════════════════════ */
function openReport() {
  if (!edaData) return;
  document.getElementById('report-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  generateReport();
}

function closeReport() {
  document.getElementById('report-modal').classList.remove('open');
  document.body.style.overflow = '';
}

function generateReport() {
  const data = edaData;
  const fname = document.getElementById('db-fname').textContent;
  document.getElementById('report-subtitle').textContent = fname;

  const numCols    = data.columns.filter(c => c.type === 'numeric');
  const catCols    = data.columns.filter(c => c.type === 'categorical');
  const nullCols   = data.columns.filter(c => c.null_count > 0);
  const totalNulls = data.columns.reduce((s,c) => s + c.null_count, 0);
  const totalOutliers = numCols.reduce((s,c) => s + (c.stats?.outlier_count||0), 0);
  const topCorr = data.correlations ? [...data.correlations].sort((a,b) => Math.abs(b.r)-Math.abs(a.r))[0] : null;

  const content = document.getElementById('report-content');
  content.innerHTML = `
    <h3>📋 Summary</h3>
    <p>Dataset <strong>${escHtml(fname)}</strong> contains <strong>${data.shape.rows.toLocaleString()} rows</strong> and <strong>${data.shape.cols} columns</strong>
    (${numCols.length} numeric, ${catCols.length} categorical).
    ${data.duplicate_rows > 0 ? `<strong style="color:var(--amber)">${data.duplicate_rows} duplicate rows</strong> were detected.` : 'No duplicate rows found.'}</p>

    <div class="report-kv">
      <div class="report-kv-item"><div class="report-kv-val">${data.shape.rows.toLocaleString()}</div><div class="report-kv-lbl">Total Rows</div></div>
      <div class="report-kv-item"><div class="report-kv-val">${data.shape.cols}</div><div class="report-kv-lbl">Columns</div></div>
      <div class="report-kv-item"><div class="report-kv-val">${data.duplicate_rows}</div><div class="report-kv-lbl">Duplicates</div></div>
      <div class="report-kv-item"><div class="report-kv-val">${totalNulls.toLocaleString()}</div><div class="report-kv-lbl">Total Nulls</div></div>
      <div class="report-kv-item"><div class="report-kv-val">${nullCols.length}</div><div class="report-kv-lbl">Cols w/ Nulls</div></div>
      <div class="report-kv-item"><div class="report-kv-val">${totalOutliers}</div><div class="report-kv-lbl">Outliers (IQR)</div></div>
    </div>

    <h3>🔢 Numeric Columns</h3>
    ${numCols.length === 0 ? '<p>No numeric columns found.</p>' :
      numCols.map(c => `<p><strong>${escHtml(c.name)}</strong> — Mean: ${c.stats?.mean}, Median: ${c.stats?.median}, Std Dev: ${c.stats?.std}, Outliers: ${c.stats?.outlier_count}, Null%: ${c.null_pct}%</p>`).join('')}

    <h3>📝 Categorical Columns</h3>
    ${catCols.length === 0 ? '<p>No categorical columns found.</p>' :
      catCols.map(c => {
        const top = c.bar_chart ? `Top value: <strong>${escHtml(c.bar_chart.labels[0])}</strong> (${c.bar_chart.counts[0].toLocaleString()})` : '';
        return `<p><strong>${escHtml(c.name)}</strong> — ${c.unique_count} unique values. ${top}. Null%: ${c.null_pct}%</p>`;
      }).join('')}

    ${topCorr ? `
    <h3>📊 Top Correlation</h3>
    <p>Strongest pair: <strong>${escHtml(topCorr.col_a)}</strong> and <strong>${escHtml(topCorr.col_b)}</strong>
    with Pearson r = <strong>${Number(topCorr.r).toFixed(3)}</strong>
    (${Math.abs(topCorr.r) >= 0.7 ? 'strong' : Math.abs(topCorr.r) >= 0.4 ? 'moderate' : 'weak'}
    ${topCorr.r > 0 ? 'positive' : 'negative'} correlation).</p>` : ''}

    <h3>⚠️ Data Quality Notes</h3>
    ${nullCols.length === 0
      ? '<p style="color:var(--green)">✅ No missing values detected across all columns.</p>'
      : `<p>${nullCols.map(c => `<strong>${escHtml(c.name)}</strong> (${c.null_pct}% missing)`).join(', ')} have missing values. Consider imputation or removal before modeling.</p>`}
    ${data.duplicate_rows > 0 ? `<p><strong>${data.duplicate_rows} duplicate rows</strong> found. Deduplicate before analysis.</p>` : ''}
    ${totalOutliers > 0 ? `<p><strong>${totalOutliers} outliers</strong> detected via IQR across ${numCols.filter(c=>c.stats?.outlier_count>0).length} columns. Review before statistical modeling.</p>` : ''}

    <p style="margin-top:20px;font-size:0.75rem;color:var(--muted);border-top:1px solid var(--border);padding-top:12px">
      Generated by DataLens EDA Studio · ${new Date().toLocaleDateString('en-IN', {year:'numeric',month:'long',day:'numeric'})}
    </p>`;
}

function downloadReport() {
  const fname   = document.getElementById('db-fname').textContent.replace(/[^a-z0-9]/gi,'_');
  const content = document.getElementById('report-content').innerHTML;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>EDA Report — ${escHtml(fname)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>
    body{font-family:'Roboto',sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#181612;background:#f5f4f0;font-weight:300}
    h1{font-family:'Playfair Display',serif;font-size:2rem;margin-bottom:8px}
    h3{font-family:'Playfair Display',serif;font-size:1.1rem;margin:24px 0 10px}
    p{line-height:1.8;margin-bottom:10px;color:#44403a}
    .report-kv{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}
    .report-kv-item{background:#fff;border:1px solid #e2ddd6;border-radius:8px;padding:12px}
    .report-kv-val{font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:600}
    .report-kv-lbl{font-size:0.65rem;color:#8a857c;text-transform:uppercase;letter-spacing:1px}
  </style></head><body>
  <h1>EDA Report</h1>
  <p style="color:#8a857c;font-size:0.85rem">${escHtml(fname)}</p>
  ${content}
  </body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `EDA_Report_${fname}.html`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('Report downloaded!', 'success');
}

document.getElementById('report-modal').addEventListener('click', function(e) {
  if (e.target === this) closeReport();
});