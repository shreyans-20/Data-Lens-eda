/* ══════════════════════════════════════════════════════════════
   DataLens EDA Studio — app.js (optimised)
   Key improvements:
   • Chart.js loaded async — guarded by _whenChart()
   • Column table uses documentFragment batching (no innerHTML loop)
   • Debounced column search (200 ms)
   • requestAnimationFrame for quality bar animations
   • API_BASE auto-detects GitHub Pages vs local vs Vercel
   • Deep copies replaced with structuredClone (faster)
   • No redundant DOM queries — cached selectors
══════════════════════════════════════════════════════════════ */

/* ── API base ──────────────────────────────────────────────── */
const IS_GH_PAGES = window.location.hostname.includes("github.io");
// Replace with your actual Vercel URL after first deploy
const VERCEL_URL  = "https://your-project-name.vercel.app";
const API_BASE    = IS_GH_PAGES ? VERCEL_URL : "";

/* ── State ─────────────────────────────────────────────────── */
let edaData         = null;
let cleanedData     = null;
let tableMetadata   = null;
let colChart        = null;
let visChart        = null;
let boxplotChart    = null;
let activeCol       = null;
let activeChartType = "bar";
let activePBIChartType = "bar";
let pbiChartInstance   = null;
let columnSortKey   = "name";
let columnSortAsc   = true;
let allColumns      = [];
let activeBoxplotCol = null;
let dataModified    = false;
let fileId          = null;
let appliedFixes    = { drop_duplicates: false, fill_nulls: null };
let pbiShowLabels   = false;

const VIS_COLORS = [
  "#1d4ed8","#6d28d9","#15803d","#b45309","#b91c1c",
  "#0e7490","#be185d","#4d7c0f","#c2410c","#5b21b6",
];

/* ── Chart.js async guard ──────────────────────────────────── */
// _chartReady and _chartReadyCallbacks are initialised in index.html before this script loads.
// _onChartReady() in index.html registers ChartDataLabels and fires all queued callbacks.
function _whenChart(fn) {
  if (window._chartReady && typeof Chart !== "undefined") {
    fn();
  } else {
    (window._chartReadyCallbacks = window._chartReadyCallbacks || []).push(fn);
  }
}

/* ── Theme ─────────────────────────────────────────────────── */
(function () {
  const saved = localStorage.getItem("dl-theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (btn) btn.textContent = saved === "dark" ? "☀️" : "🌙";
  });
})();

function toggleTheme() {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  const next = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  document.getElementById("theme-toggle").textContent = isDark ? "🌙" : "☀️";
  localStorage.setItem("dl-theme", next);
}

/* ── Toast ─────────────────────────────────────────────────── */
function toast(msg, type = "info", duration = 3500) {
  const icons = { info: "ℹ️", success: "✅", error: "❌", warning: "⚠️" };
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", "alert");
  el.innerHTML = `<span>${icons[type] || ""}</span><span>${escHtml(msg)}</span>`;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 280);
  }, duration);
}

/* ── XSS escape ─────────────────────────────────────────────── */
function escHtml(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

/* ── Debounce helper ────────────────────────────────────────── */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
const debounceFilterColumns = debounce(filterColumns, 200);

/* ── Drag & Drop / File input ───────────────────────────────── */
const uploadBox = document.getElementById("upload-box");
uploadBox.addEventListener("dragover",  e => { e.preventDefault(); uploadBox.classList.add("drag"); });
uploadBox.addEventListener("dragleave", ()  => uploadBox.classList.remove("drag"));
uploadBox.addEventListener("drop", e => {
  e.preventDefault(); uploadBox.classList.remove("drag");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
uploadBox.addEventListener("click", e => {
  if (e.target.tagName !== "BUTTON") document.getElementById("file-input").click();
});
uploadBox.addEventListener("keydown", e => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); document.getElementById("file-input").click(); }
});
document.getElementById("file-input").addEventListener("change", e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

/* ── Scroll to top ──────────────────────────────────────────── */
window.addEventListener("scroll", () => {
  document.getElementById("scroll-top").classList.toggle("show", window.scrollY > 300);
}, { passive: true });

/* ── Keyboard shortcuts ─────────────────────────────────────── */
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { closeVisBuilder(); closeReport(); }
});

/* ── Loader messages ────────────────────────────────────────── */
const LOADER_MSGS = [
  "Reading file structure…",
  "Detecting column types…",
  "Computing distributions…",
  "Running correlation engine…",
  "Detecting outliers (IQR)…",
  "Assembling your dashboard…",
];

function handleFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["csv","xlsx","xls"].includes(ext)) {
    toast("Please upload a CSV or Excel (.xlsx / .xls) file.", "error"); return;
  }
  show("loader");
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  document.getElementById("loader-sub").textContent = `${file.name} · ${sizeMB} MB`;

  let idx = 0;
  const msgEl = document.getElementById("loader-msg");
  const iv = setInterval(() => { msgEl.textContent = LOADER_MSGS[idx++ % LOADER_MSGS.length]; }, 700);

  const fd = new FormData();
  fd.append("file", file);

  fetch(`${API_BASE}/upload`, { method: "POST", body: fd })
    .then(async r => {
      if (!r.ok) {
        let msg = `Server error: ${r.status}`;
        try { const e = await r.json(); if (e.error) msg = e.error; } catch (_) {}
        throw new Error(msg);
      }
      return r.json();
    })
    .then(data => {
      clearInterval(iv);
      if (!data.success) { toast("Error: " + data.error, "error"); show("upload-screen"); return; }
      _init(data, file.name);
      toast("File loaded successfully!", "success");
    })
    .catch(err => {
      clearInterval(iv);
      toast("Upload failed: " + err.message, "error");
      show("upload-screen");
    });
}

/* ── Sample data (static — no server call needed) ───────────── */
function loadSampleData() {
  const rows = 312;
  const data = {
    shape: { rows, cols: 8 },
    duplicate_rows: 4,
    health_score: 88.4,
    columns: [
      { name:"Age",        type:"numeric",     null_count:3,  null_pct:1.0,  unique_count:45,
        stats:{mean:38.2,median:37.0,std:11.4,min:18,max:72,skew:0.32,kurtosis:-0.14,outlier_count:8},
        boxplot:{min:18,q1:29,median:37,q3:47,max:72,outliers:[19,70,72]},
        histogram:{bin_edges:[18,25,32,39,46,53,60,72],counts:[32,58,74,62,45,26,15]},mode:38 },
      { name:"Salary",     type:"numeric",     null_count:5,  null_pct:1.6,  unique_count:289,
        stats:{mean:62400,median:58000,std:22100,min:22000,max:145000,skew:1.12,kurtosis:0.88,outlier_count:14},
        boxplot:{min:22000,q1:44000,median:58000,q3:80000,max:145000,outliers:[135000,140000,145000]},
        histogram:{bin_edges:[22000,38000,54000,70000,86000,102000,118000,145000],counts:[28,62,88,72,34,16,12]},mode:58000 },
      { name:"Experience", type:"numeric",     null_count:0,  null_pct:0.0,  unique_count:22,
        stats:{mean:7.8,median:7.0,std:5.2,min:0,max:25,skew:0.75,kurtosis:0.12,outlier_count:6},
        boxplot:{min:0,q1:3,median:7,q3:12,max:25,outliers:[24,25]},
        histogram:{bin_edges:[0,3,6,9,12,15,18,25],counts:[44,68,72,58,34,22,14]},mode:7 },
      { name:"Score",      type:"numeric",     null_count:12, null_pct:3.8,  unique_count:98,
        stats:{mean:74.6,median:76.0,std:14.2,min:32,max:99,skew:-0.28,kurtosis:-0.34,outlier_count:5},
        boxplot:{min:32,q1:65,median:76,q3:86,max:99,outliers:[32,35]},
        histogram:{bin_edges:[32,45,58,65,72,79,86,99],counts:[8,18,38,62,74,66,46]},mode:76 },
      { name:"Hours/Week", type:"numeric",     null_count:2,  null_pct:0.6,  unique_count:18,
        stats:{mean:41.3,median:40.0,std:8.6,min:20,max:68,skew:0.44,kurtosis:0.22,outlier_count:10},
        boxplot:{min:20,q1:36,median:40,q3:46,max:68,outliers:[20,68]},
        histogram:{bin_edges:[20,28,32,36,40,44,48,68],counts:[12,24,42,76,72,46,40]},mode:40 },
      { name:"Department", type:"categorical", null_count:0,  null_pct:0.0,  unique_count:6,
        bar_chart:{labels:["Engineering","Marketing","Sales","HR","Finance","Operations"],counts:[98,62,54,40,36,22]},mode:"Engineering" },
      { name:"Education",  type:"categorical", null_count:8,  null_pct:2.6,  unique_count:4,
        bar_chart:{labels:["Bachelor's","Master's","PhD","Diploma"],counts:[158,96,34,24]},mode:"Bachelor's" },
      { name:"Status",     type:"categorical", null_count:0,  null_pct:0.0,  unique_count:3,
        bar_chart:{labels:["Active","On Leave","Resigned"],counts:[244,42,26]},mode:"Active" },
    ],
    correlations:[
      {col_a:"Salary",col_b:"Experience",r:0.74},{col_a:"Salary",col_b:"Age",r:0.61},
      {col_a:"Experience",col_b:"Age",r:0.58},{col_a:"Score",col_b:"Salary",r:0.42},
      {col_a:"Hours/Week",col_b:"Score",r:-0.31},
    ],
    scatter:{col_a:"Salary",col_b:"Experience",
      data:Array.from({length:80},()=>[Math.round(Math.random()*24),Math.round(22000+Math.random()*120000)])},
    preview_rows:Array.from({length:10},(_,i)=>({
      Age:22+Math.floor(Math.random()*50),Salary:25000+Math.floor(Math.random()*120000),
      Experience:Math.floor(Math.random()*25),Score:35+Math.floor(Math.random()*64),
      "Hours/Week":22+Math.floor(Math.random()*46),
      Department:["Engineering","Marketing","Sales","HR","Finance"][i%5],
      Education:["Bachelor's","Master's","PhD","Diploma"][i%4],
      Status:["Active","On Leave","Resigned"][i%3],
    })),
    table_metadata:{fact_table:"Employee_Data",dimension_tables:[],
      column_origins:Object.fromEntries(["Age","Salary","Experience","Score","Hours/Week","Department","Education","Status"].map(k=>[k,"Employee_Data"]))}
  };
  _init(data, "sample_employee_data.csv");
  toast("Sample data loaded!", "success");
}

/* ── Init helper ────────────────────────────────────────────── */
function _init(data, fname) {
  edaData       = data;
  fileId        = data.file_id || "sample";
  tableMetadata = data.table_metadata || {};
  appliedFixes  = { drop_duplicates: false, fill_nulls: null };
  cleanedData   = structuredClone(data);   // faster than JSON parse/stringify
  dataModified  = false;
  renderDashboard(data, fname);
}

/* ── Show/hide screens ──────────────────────────────────────── */
function show(id) {
  const ids = ["upload-screen","loader","dashboard"];
  ids.forEach(s => {
    const el = document.getElementById(s);
    el.style.display = s === id ? (id === "dashboard" ? "block" : "flex") : "none";
  });
}

function resetApp() {
  edaData = cleanedData = activeCol = tableMetadata = null;
  fileId = null;
  appliedFixes = { drop_duplicates: false, fill_nulls: null };
  allColumns = []; dataModified = false;
  [colChart, visChart, boxplotChart, pbiChartInstance].forEach(c => c?.destroy());
  colChart = visChart = boxplotChart = pbiChartInstance = null;
  document.getElementById("file-input").value = "";
  ["btn-vis-builder","btn-reset","btn-report"].forEach(id => {
    document.getElementById(id).style.display = "none";
  });
  document.getElementById("file-badge").classList.remove("show");
  document.getElementById("export-banner").classList.remove("show");
  show("upload-screen");
}

/* ── Dashboard ──────────────────────────────────────────────── */
function renderDashboard(data, fname) {
  show("dashboard");
  document.getElementById("db-fname").textContent  = fname;
  document.getElementById("db-fmeta").textContent  =
    `${data.shape.rows.toLocaleString()} rows × ${data.shape.cols} columns`;
  document.getElementById("badge-name").textContent = fname;
  document.getElementById("file-badge").classList.add("show");
  ["btn-vis-builder","btn-reset","btn-report"].forEach(id => {
    document.getElementById(id).style.display = "inline-flex";
  });

  allColumns = [...data.columns];

  // Render sections — heavier ones deferred with rAF to keep first paint fast
  renderOverview(data);
  renderPreview(data);
  renderColumnTable(allColumns);
  renderColPills(allColumns);
  updateQuickFixButtons(data);

  // Defer heavy renders
  requestAnimationFrame(() => {
    renderQuality(data.columns);
    renderCorrelations(data);
    renderOutlierSection(data.columns);
    setupVisBuilder(data);
  });

  const first = data.columns.find(c => c.type === "numeric");
  if (first) selectCol(first.name);
}

/* ── Section 1: Overview ────────────────────────────────────── */
function renderOverview(data) {
  const numC  = data.columns.filter(c => c.type === "numeric").length;
  const catC  = data.columns.filter(c => c.type === "categorical").length;
  const score = data.health_score || 0;
  const dups  = data.duplicate_rows;

  const items = [
    {val:data.shape.rows.toLocaleString(), lbl:"Rows",         cls:""},
    {val:data.shape.cols,                  lbl:"Columns",      cls:""},
    {val:score+"%",                        lbl:"Health Score", cls:score>80?"":"warn"},
    {val:numC,                             lbl:"Numeric Cols", cls:""},
    {val:catC,                             lbl:"Categorical",  cls:""},
    {val:dups,                             lbl:"Duplicates",   cls:dups>0?"warn":""},
  ];
  document.getElementById("overview-grid").innerHTML =
    items.map(i => `<div class="ov-card ${i.cls}"><div class="ov-val">${i.val}</div><div class="ov-label">${i.lbl}</div></div>`).join("");
}

/* ── Section 2: Data Preview ────────────────────────────────── */
function renderPreview(data) {
  const rows = data.preview_rows;
  if (!rows?.length) { document.getElementById("preview-section").style.display="none"; return; }
  document.getElementById("preview-section").style.display = "block";
  const cols = Object.keys(rows[0]);
  document.getElementById("preview-thead").innerHTML =
    `<tr><th>#</th>${cols.map(c=>`<th>${escHtml(c)}</th>`).join("")}</tr>`;

  // Build tbody with fragment for speed
  const frag = document.createDocumentFragment();
  rows.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="row-num">${i+1}</td>${cols.map(c=>`<td>${escHtml(String(row[c]??``))}</td>`).join("")}`;
    frag.appendChild(tr);
  });
  const tbody = document.getElementById("preview-tbody");
  tbody.innerHTML = "";
  tbody.appendChild(frag);
}

/* ── Section 3a: Column Table ───────────────────────────────── */
function renderColumnTable(columns) {
  const tbody = document.getElementById("col-tbody");
  const frag  = document.createDocumentFragment();
  const limit = Math.min(columns.length, 50);

  for (let i = 0; i < limit; i++) {
    const col  = columns[i];
    const s    = col.stats || {};
    const bc   = col.type === "numeric" ? "type-num" : col.type === "categorical" ? "type-cat" : "type-dt";
    const mode = col.mode != null ? escHtml(String(col.mode)) : "—";
    const tr   = document.createElement("tr");
    if (col.name === activeCol) tr.classList.add("active-row");
    tr.dataset.col = col.name;
    tr.tabIndex = 0;
    tr.setAttribute("role", "row");
    tr.innerHTML = `
      <td>${escHtml(col.name)}</td>
      <td><span class="type-badge ${bc}">${col.type}</span></td>
      <td>${col.null_pct}%</td>
      <td>${col.unique_count.toLocaleString()}</td>
      <td>${s.mean   != null ? s.mean   : "—"}</td>
      <td>${s.median != null ? s.median : "—"}</td>
      <td style="max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${mode}</td>`;
    tr.addEventListener("click", () => selectCol(col.name));
    frag.appendChild(tr);
  }

  if (columns.length > 50) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="7" style="text-align:center;padding:12px;color:var(--muted);font-size:0.8rem">Showing first 50 columns — use Search to filter.</td>`;
    frag.appendChild(tr);
  }

  tbody.innerHTML = "";
  tbody.appendChild(frag);
}

function filterColumns(query) {
  const q = query.toLowerCase();
  const filtered = allColumns.filter(c => c.name.toLowerCase().includes(q));
  renderColumnTable(filtered);
  renderColPills(filtered);
}

function sortColumnTable(key, btn) {
  if (columnSortKey === key) columnSortAsc = !columnSortAsc;
  else { columnSortKey = key; columnSortAsc = true; }
  document.querySelectorAll("thead th").forEach(t => t.classList.remove("sorted"));
  btn?.classList.add("sorted");
  const sorted = [...allColumns].sort((a, b) => {
    const vals = { name:[a.name.toLowerCase(),b.name.toLowerCase()], type:[a.type,b.type], null:[a.null_pct,b.null_pct], unique:[a.unique_count,b.unique_count] };
    const [va, vb] = vals[key] || [0,0];
    return columnSortAsc ? (va<vb?-1:va>vb?1:0) : (va>vb?-1:va<vb?1:0);
  });
  renderColumnTable(sorted);
}

/* ── Section 3b: Pills + Stats ──────────────────────────────── */
function renderColPills(columns) {
  const frag = document.createDocumentFragment();
  columns.forEach(col => {
    const btn = document.createElement("button");
    btn.className = "col-pill-btn" + (col.name === activeCol ? " active" : "");
    btn.dataset.name = col.name;
    btn.textContent  = col.name;
    btn.setAttribute("aria-pressed", col.name === activeCol);
    btn.addEventListener("click", () => selectCol(col.name));
    frag.appendChild(btn);
  });
  const wrap = document.getElementById("col-pills");
  wrap.innerHTML = "";
  wrap.appendChild(frag);
}

function selectCol(name) {
  activeCol = name;
  document.querySelectorAll(".col-pill-btn").forEach(p => {
    const active = p.dataset.name === name;
    p.classList.toggle("active", active);
    p.setAttribute("aria-pressed", active);
  });
  document.querySelectorAll("#col-tbody tr").forEach(r =>
    r.classList.toggle("active-row", r.dataset.col === name));
  const col = edaData.columns.find(c => c.name === name);
  if (!col) return;
  if (col.type === "numeric") renderNumericStats(col);
  else if (col.type === "categorical") renderCatStats(col);
  else renderDateStats(col);
}

function renderNumericStats(col) {
  const s  = col.stats || {};
  const hd = col.histogram;
  const range = (s.max != null && s.min != null) ? (s.max - s.min).toFixed(2) : "—";
  const iqr   = col.boxplot ? (col.boxplot.q3 - col.boxplot.q1).toFixed(2) : "—";

  const statItems = [
    {v:s.mean,l:"Mean"},{v:s.median,l:"Median"},{v:col.mode,l:"Mode"},
    {v:s.std,l:"Std Dev"},{v:s.min,l:"Min"},{v:s.max,l:"Max"},
    {v:range,l:"Range"},{v:iqr,l:"IQR"},{v:s.outlier_count,l:"Outliers"},
  ];

  document.getElementById("stats-content").innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px">
      <h4 style="margin:0;font-size:0.9rem">Statistical Distribution</h4>
      <button class="btn btn-sm" onclick="navigator.clipboard.writeText('${escHtml(JSON.stringify(s))}')">Copy Stats</button>
    </div>
    <div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(100px,1fr))">
      ${statItems.map(i=>`<div class="stat-item"><div class="stat-val">${i.v!=null?escHtml(String(i.v)):"—"}</div><div class="stat-lbl">${i.l}</div></div>`).join("")}
    </div>
    <div class="chart-area"><canvas id="col-chart-canvas"></canvas></div>`;

  _whenChart(() => {
    colChart?.destroy();
    const labels = hd ? hd.bin_edges.slice(0,-1).map((v,i)=>v.toFixed(1)+"–"+hd.bin_edges[i+1].toFixed(1)) : [];
    colChart = new Chart(document.getElementById("col-chart-canvas"), {
      type:"bar",
      data:{ labels, datasets:[{data:hd?hd.counts:[],backgroundColor:"rgba(29,78,216,0.22)",borderColor:"rgba(29,78,216,0.8)",borderWidth:1.5,borderRadius:4}] },
      options:{
        responsive:true,maintainAspectRatio:true,
        plugins:{legend:{display:false},datalabels:{display:false}},
        scales:{
          x:{ticks:{font:{family:"Roboto Mono",size:11},color:"gray",maxRotation:45},grid:{color:"rgba(128,128,128,0.15)"}},
          y:{ticks:{font:{family:"Roboto Mono",size:11},color:"gray"},grid:{color:"rgba(128,128,128,0.15)"}}
        }
      }
    });
  });
}

function renderCatStats(col) {
  const bc    = col.bar_chart;
  const total = bc ? bc.counts.reduce((a,b)=>a+b,0) : 0;
  const displayLabels = bc ? bc.labels.slice(0,10) : [];
  const displayCounts = bc ? bc.counts.slice(0,10) : [];

  document.getElementById("stats-content").innerHTML = `
    <div class="stat-grid" style="grid-template-columns:repeat(3,1fr)">
      <div class="stat-item"><div class="stat-val">${col.unique_count.toLocaleString()}</div><div class="stat-lbl">Unique</div></div>
      <div class="stat-item"><div class="stat-val" style="font-size:0.95rem;word-break:break-word">${col.mode?escHtml(col.mode):"—"}</div><div class="stat-lbl">Mode</div></div>
      <div class="stat-item"><div class="stat-val">${col.null_pct}%</div><div class="stat-lbl">Null %</div></div>
    </div>
    <div class="chart-area" style="margin:14px 0"><canvas id="col-chart-canvas"></canvas></div>
    <div style="font-family:var(--mono);font-size:0.69rem;color:var(--muted);line-height:2">
      ${displayLabels.map((l,i)=>`<span style="display:inline-flex;align-items:center;gap:6px;margin-right:10px"><strong>${escHtml(l)}</strong> — ${displayCounts[i].toLocaleString()} (${((displayCounts[i]/total)*100).toFixed(1)}%)</span>`).join("")}
      ${bc&&bc.labels.length>10?`<span style="color:var(--accent);font-size:0.65rem">+${bc.labels.length-10} more</span>`:""}
    </div>`;

  _whenChart(() => {
    colChart?.destroy();
    colChart = new Chart(document.getElementById("col-chart-canvas"), {
      type:"doughnut",
      data:{
        labels:displayLabels,
        datasets:[{data:displayCounts,backgroundColor:VIS_COLORS.slice(0,displayLabels.length).map(c=>c+"cc"),borderColor:VIS_COLORS.slice(0,displayLabels.length),borderWidth:2,hoverOffset:6}]
      },
      options:{
        responsive:true,cutout:"60%",
        plugins:{
          legend:{position:"right",labels:{font:{family:"Roboto Mono",size:11},color:"gray",boxWidth:10,padding:8}},
          datalabels:{display:false},
          tooltip:{callbacks:{label:ctx=>{const pct=((ctx.parsed/total)*100).toFixed(1);return ` ${ctx.label}: ${ctx.parsed.toLocaleString()} (${pct}%)`;}}},
        }
      }
    });
  });
}

function renderDateStats(col) {
  document.getElementById("stats-content").innerHTML = `
    <div class="no-col" style="padding:30px">
      📅 Date column — <strong>${escHtml(col.name)}</strong><br/>
      <span style="color:var(--muted);font-size:0.8rem;font-weight:300">Use the Visualization Builder to analyse time-based columns.</span>
    </div>`;
}

/* ── Section 4: Correlations ────────────────────────────────── */
function renderCorrelations(data) {
  const grid  = document.getElementById("corr-grid");
  const corrs = data.correlations;
  if (!corrs?.length) {
    grid.innerHTML = `<div class="corr-empty">No numeric correlations found.</div>`; return;
  }
  const sorted = [...corrs].sort((a,b)=>Math.abs(b.r)-Math.abs(a.r));
  grid.innerHTML = sorted.map(c => {
    const r=Number(c.r), abs=Math.abs(r), pct=(abs*100).toFixed(0);
    const color=r>0?"#1d4ed8":"#b91c1c";
    const strength=abs>=0.7?"Strong":abs>=0.4?"Moderate":"Weak";
    return `<div class="corr-item" onclick="openScatterForCorr('${escHtml(c.col_a)}','${escHtml(c.col_b)}')" title="Click to view scatter">
      <div class="corr-pair">${escHtml(c.col_a)} × ${escHtml(c.col_b)}</div>
      <div class="corr-bar-wrap"><div class="corr-bar" style="width:${pct}%;background:${color}"></div></div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="corr-val" style="color:${color}">${r>0?"+":""}${r.toFixed(3)}</div>
        <div style="font-family:var(--mono);font-size:0.62rem;color:var(--muted)">${strength}</div>
      </div>
    </div>`;
  }).join("");
  buildHeatmap(data);
}

function switchCorrView(view, btn) {
  document.getElementById("corr-bars-view").style.display   = view==="bars"    ? "block" : "none";
  document.getElementById("corr-heatmap-view").style.display = view==="heatmap" ? "block" : "none";
  document.querySelectorAll(".corr-view-tab").forEach(t => t.classList.toggle("active", t===btn));
}

function buildHeatmap(data) {
  const numCols = data.columns.filter(c=>c.type==="numeric").map(c=>c.name);
  if (numCols.length < 2) {
    document.getElementById("heatmap-wrap").innerHTML = "<p style='padding:30px;text-align:center;color:var(--muted)'>Need at least 2 numeric columns.</p>";
    return;
  }
  const matrix = {};
  numCols.forEach(a => { matrix[a]={}; numCols.forEach(b => { matrix[a][b]= a===b?1:null; }); });
  (data.correlations||[]).forEach(c => {
    if(matrix[c.col_a]) matrix[c.col_a][c.col_b]=Number(c.r);
    if(matrix[c.col_b]) matrix[c.col_b][c.col_a]=Number(c.r);
  });
  const isDark = document.documentElement.getAttribute("data-theme")==="dark";
  function heatColor(v) {
    if(v===null) return "var(--bg)";
    const t=Math.abs(v);
    if(isDark) return v>0 ? `rgb(${Math.round(17+74*t)},${Math.round(16+122*t)},${Math.round(9+231*t)})` : `rgb(${Math.round(17+231*t)},${Math.round(16+97*t)},${Math.round(9+104*t)})`;
    return v>0 ? `rgb(${Math.round(245-216*t)},${Math.round(244-166*t)},${Math.round(240-24*t)})` : `rgb(${Math.round(245-60*t)},${Math.round(244-216*t)},${Math.round(240-212*t)})`;
  }
  let html=`<table class="heatmap-table"><thead><tr><th></th>${numCols.map(c=>`<th title="${escHtml(c)}">${escHtml(c.length>8?c.slice(0,7)+"…":c)}</th>`).join("")}</tr></thead><tbody>`;
  numCols.forEach(row => {
    html+=`<tr><th style="text-align:left;padding:6px 8px;background:var(--bg);color:var(--muted);font-weight:500;white-space:nowrap">${escHtml(row.length>8?row.slice(0,7)+"…":row)}</th>`;
    numCols.forEach(col => {
      const v=matrix[row][col];
      const bg=heatColor(v);
      const tc=isDark?"#ffffff":Math.abs(v||0)>0.5?"#ffffff":"#181612";
      const d=v!==null?(v===1?"1.00":v.toFixed(2)):"—";
      html+=`<td style="background:${bg};color:${tc}" title="${escHtml(row)} vs ${escHtml(col)}: ${d}" onclick="openScatterForCorr('${escHtml(row)}','${escHtml(col)}')">${d}</td>`;
    });
    html+="</tr>";
  });
  html+="</tbody></table>";
  document.getElementById("heatmap-wrap").innerHTML = html;
}

function openScatterForCorr(colA, colB) {
  // Opens the PBI-style builder and pre-selects the correlated pair as a scatter chart
  openVisBuilder();
  setTimeout(() => {
    // Set PBI modal selects (x = colA, y = colB)
    const xSel = document.querySelector(".pbi-select[data-zone='x']");
    const ySel = document.querySelector(".pbi-select[data-zone='y']");
    if (xSel) xSel.value = colA;
    if (ySel) ySel.value = colB;
    // Set aggregation to none (raw scatter points)
    const aggSel = document.getElementById("pbi-agg-func");
    if (aggSel) aggSel.value = "none";
    // Activate scatter chart type icon
    activePBIChartType = "scatter";
    document.querySelectorAll(".pbi-icon-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.type === "scatter");
    });
    // Auto-render
    renderPBIChart();
  }, 150);
}

/* ── Section 5: Outlier explorer + box plots ────────────────── */
function renderOutlierSection(columns) {
  const numCols = columns.filter(c=>c.type==="numeric"&&c.stats?.outlier_count>0);
  const section = document.getElementById("outlier-section");
  if (!numCols.length) { section.style.display="none"; return; }
  section.style.display="block";

  const total = numCols.reduce((s,c)=>s+(c.stats?.outlier_count||0),0);
  document.getElementById("outlier-count-badge").textContent = `${total} total outliers detected`;

  document.getElementById("outlier-col-tabs").innerHTML = numCols.map((c,i)=>
    `<button class="outlier-tab ${i===0?"active":""}" data-col="${escHtml(c.name)}" onclick="selectOutlierCol(this)">${escHtml(c.name)} (${c.stats.outlier_count})</button>`
  ).join("");
  if (numCols.length) showOutlierTable(numCols[0].name);

  const allNum = columns.filter(c=>c.type==="numeric"&&c.stats);
  document.getElementById("boxplot-col-tabs").innerHTML = allNum.map((c,i)=>
    `<button class="boxplot-tab ${i===0?"active":""}" data-col="${escHtml(c.name)}" onclick="selectBoxplotCol(this)">${escHtml(c.name)}</button>`
  ).join("");
  if (allNum.length) { activeBoxplotCol=allNum[0].name; renderBoxplot(allNum[0]); }
}

function selectOutlierCol(btn) {
  document.querySelectorAll(".outlier-tab").forEach(t=>t.classList.remove("active"));
  btn.classList.add("active");
  showOutlierTable(btn.dataset.col);
}

function showOutlierTable(colName) {
  const col=edaData.columns.find(c=>c.name===colName);
  const content=document.getElementById("outlier-content");
  const s=col?.stats, bp=col?.boxplot;
  if(!s){content.innerHTML="<div class='outlier-empty'>No data.</div>";return;}
  const q1=bp?bp.q1:0, q3=bp?bp.q3:0, iqr=q3-q1;
  const lower=(q1-1.5*iqr).toFixed(2), upper=(q3+1.5*iqr).toFixed(2);
  content.innerHTML=`
    <div style="padding:12px 18px;background:var(--red-l);border-bottom:1px solid var(--border);font-family:var(--mono);font-size:0.72rem;color:var(--red)">
      IQR: outliers &lt; <strong>${lower}</strong> or &gt; <strong>${upper}</strong> &nbsp;·&nbsp; <strong>${s.outlier_count}</strong> found
    </div>
    <div style="padding:14px 18px;font-family:var(--mono);font-size:0.72rem;color:var(--muted)">
      Click <strong>📦 Box Plots</strong> above to visualise the distribution.
    </div>`;
}

function toggleBoxPlot() {
  const panel=document.getElementById("boxplot-panel");
  const btn=document.getElementById("btn-boxplot");
  const open=panel.style.display!=="none"&&panel.style.display!=="";
  panel.style.display=open?"none":"block";
  btn.setAttribute("aria-expanded",!open);
  btn.textContent=open?"📦 Box Plots":"📦 Hide Box Plots";
}

function selectBoxplotCol(btn) {
  document.querySelectorAll(".boxplot-tab").forEach(t=>t.classList.remove("active"));
  btn.classList.add("active");
  activeBoxplotCol=btn.dataset.col;
  const col=edaData.columns.find(c=>c.name===activeBoxplotCol);
  if(col) renderBoxplot(col);
}

function renderBoxplot(col) {
  const s=col.stats, bp=col.boxplot;
  if(!s||!bp) return;
  _whenChart(() => {
    boxplotChart?.destroy();
    const {min,q1,median,q3,max}=bp, iqr=q3-q1;
    const lf=Math.max(min,q1-1.5*iqr), uf=Math.min(max,q3+1.5*iqr);
    boxplotChart=new Chart(document.getElementById("boxplot-canvas"),{
      type:"bar",
      data:{
        labels:[col.name],
        datasets:[
          {label:"Min→Q1",data:[{x:col.name,y:q1-lf}],backgroundColor:"transparent",borderColor:"transparent",base:lf,barThickness:2},
          {label:"IQR Box",data:[{x:col.name,y:q3-q1}],backgroundColor:"rgba(29,78,216,0.25)",borderColor:"#1d4ed8",borderWidth:2,base:q1,barThickness:60},
          {label:"Median",data:[{x:col.name,y:0.5}],backgroundColor:"#1d4ed8",borderColor:"#1d4ed8",borderWidth:0,base:median-0.25,barThickness:60},
          {label:"Q3→Max",data:[{x:col.name,y:uf-q3}],backgroundColor:"transparent",borderColor:"transparent",base:q3,barThickness:2},
        ]
      },
      options:{
        indexAxis:"y",responsive:true,maintainAspectRatio:false,
        plugins:{
          legend:{display:true,position:"bottom",labels:{font:{family:"Roboto Mono",size:11},color:"gray",boxWidth:10}},
          datalabels:{display:false},
        },
        scales:{
          x:{ticks:{font:{family:"Roboto Mono",size:11},color:"gray"},grid:{color:"rgba(128,128,128,0.15)"}},
          y:{ticks:{font:{family:"Roboto Mono",size:11},color:"gray"},grid:{color:"rgba(128,128,128,0.15)"}},
        }
      }
    });
    document.getElementById("boxplot-stats").innerHTML=[
      {l:"Min",v:min.toLocaleString()},{l:"Q1",v:q1.toFixed(2)},{l:"Median",v:median.toLocaleString()},
      {l:"Mean",v:s.mean!=null?s.mean:"—"},{l:"Q3",v:q3.toFixed(2)},{l:"Max",v:max.toLocaleString()},
      {l:"IQR",v:iqr.toFixed(2)},{l:"Lower fence",v:lf.toFixed(2)},{l:"Upper fence",v:uf.toFixed(2)},
      {l:"Outliers",v:s.outlier_count||0},
    ].map(i=>`<div class="bstat"><strong>${i.l}:</strong> ${i.v}</div>`).join("");
  });
}

/* ── Section 6: Data Quality ────────────────────────────────── */
function renderQuality(columns) {
  const sorted=[...columns].sort((a,b)=>b.null_pct-a.null_pct);
  const frag=document.createDocumentFragment();
  sorted.forEach(col => {
    const fill=100-col.null_pct;
    const color=fill===100?"var(--green)":fill>80?"var(--amber)":"var(--red)";
    const insight=fill===100?"Data is clean":col.null_pct>40?"Critical: High Sparsity":"Action: Imputation suggested";
    const div=document.createElement("div");
    div.className="q-item";
    div.innerHTML=`
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="q-name" title="${escHtml(col.name)}">${escHtml(col.name)}</div>
        <div style="font-size:0.7rem;color:var(--muted)">${insight}</div>
      </div>
      <div class="q-bar-wrap" role="progressbar" aria-valuenow="${fill}" aria-valuemin="0" aria-valuemax="100">
        <div class="q-bar" style="width:0%;background:${color}" data-fill="${fill}"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:0.75rem;color:var(--muted)">
        <span style="color:${fill===100?"var(--green)":"inherit"};font-weight:500">${fill.toFixed(1)}% Completeness</span>
        <span>${col.null_count>0?`<strong style="color:${color}">${col.null_count.toLocaleString()} missing</strong>`:"0 missing"}</span>
      </div>`;
    frag.appendChild(div);
  });
  const grid=document.getElementById("quality-grid");
  grid.innerHTML="";
  grid.appendChild(frag);

  // Animate bars in next frame
  requestAnimationFrame(() => {
    document.querySelectorAll(".q-bar").forEach(b => { b.style.width=b.dataset.fill+"%"; });
  });
}

function updateQuickFixButtons(data) {
  const hasNulls    = data.columns.some(c=>c.null_count>0);
  const hasNumNulls = data.columns.some(c=>c.type==="numeric"&&c.null_count>0);
  document.getElementById("btn-drop-dupes").style.display = data.duplicate_rows>0 ? "inline-flex" : "none";
  document.getElementById("btn-fill-mean").style.display  = hasNumNulls ? "inline-flex" : "none";
  document.getElementById("btn-fill-median").style.display= hasNumNulls ? "inline-flex" : "none";
}

function quickFixDropDuplicates() {
  if(!cleanedData) return;
  const before=cleanedData.duplicate_rows;
  if(!before){toast("No duplicate rows to remove.","info");return;}
  cleanedData.shape.rows=Math.max(0,cleanedData.shape.rows-before);
  cleanedData.duplicate_rows=0;
  appliedFixes.drop_duplicates=true;
  document.getElementById("btn-drop-dupes").style.display="none";
  dataModified=true;
  renderOverview(cleanedData);
  showExportBanner(`${before} duplicate rows dropped.`);
  toast(`Dropped ${before} duplicate rows.`,"success");
}

function quickFixFillNulls(method) {
  if(!cleanedData) return;
  let filled=0;
  cleanedData.columns.forEach(col => {
    if(col.type==="numeric"&&col.null_count>0){filled+=col.null_count;col.null_count=0;col.null_pct=0;}
  });
  if(!filled){toast("No numeric nulls to fill.","info");return;}
  appliedFixes.fill_nulls=method;
  dataModified=true;
  renderQuality(cleanedData.columns);
  updateQuickFixButtons(cleanedData);
  showExportBanner(`${filled} null values filled with ${method}.`);
  toast(`Filled ${filled} null values using ${method}.`,"success");
}

/* ── ML Prep ────────────────────────────────────────────────── */
function openMlPrep() {
  if(!edaData) return;
  document.getElementById("ml-drop-grid").innerHTML=edaData.columns.map(c=>`
    <label class="checkbox-group" style="margin-bottom:4px">
      <input type="checkbox" value="${escHtml(c.name)}" class="ml-drop-chk"/>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(c.name)}">${escHtml(c.name)}</span>
    </label>`).join("");
  document.getElementById("ml-modal").classList.add("open");
  document.body.style.overflow="hidden";
}
function closeMlPrep() { document.getElementById("ml-modal").classList.remove("open"); document.body.style.overflow=""; }
function applyAndExportMlPrep() {
  appliedFixes.drop_columns=[...document.querySelectorAll(".ml-drop-chk:checked")].map(c=>c.value);
  appliedFixes.encode_categorical=document.getElementById("ml-encode-cat").checked;
  appliedFixes.scale_numeric=document.getElementById("ml-scale-num").checked;
  closeMlPrep(); exportCleanedCSV();
}

/* ── Export ─────────────────────────────────────────────────── */
function exportCleanedCSV() {
  if(fileId==="sample"){
    const rows=(cleanedData||edaData).preview_rows||[];
    if(!rows.length){toast("No data.","error");return;}
    const cols=Object.keys(rows[0]);
    const csv=[cols.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(","),
      ...rows.map(r=>cols.map(c=>{const v=r[c]??"";return typeof v==="string"?`"${v.replace(/"/g,'""')}"`:`${v}`;}).join(","))].join("\n");
    const link=document.createElement("a");
    link.href=URL.createObjectURL(new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"}));
    link.download="sample_cleaned.csv"; link.click(); URL.revokeObjectURL(link.href);
    toast("Sample CSV exported!","success"); return;
  }
  if(!fileId){toast("No data loaded.","error");return;}
  toast("Generating export…","info");
  fetch(`${API_BASE}/export`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({file_id:fileId,fixes:appliedFixes}),
  })
  .then(r=>{if(!r.ok)throw new Error("Export failed — session may have expired.");return r.blob();})
  .then(blob=>{
    const fname=document.getElementById("db-fname").textContent.replace(/[^a-z0-9._-]/gi,"_");
    const link=document.createElement("a");
    link.href=URL.createObjectURL(blob); link.download=`cleaned_${fname}.csv`;
    link.click(); URL.revokeObjectURL(link.href);
    toast("Cleaned CSV exported!","success");
  })
  .catch(e=>toast(e.message,"error"));
}

function showExportBanner(msg) {
  document.getElementById("export-banner-msg").innerHTML=`<strong>Dataset modified.</strong> ${escHtml(msg)}`;
  document.getElementById("export-banner").classList.add("show");
}

/* ══════════════════════════════════════════════════════════════
   VISUALIZATION BUILDER (Power BI style)
══════════════════════════════════════════════════════════════ */
function setupVisBuilder(data) { /* populated lazily on openVisBuilder */ }

function openVisBuilder() {
  if(!edaData) return;
  document.body.style.overflow="hidden";
  let pbi=document.getElementById("pbi-modal");
  if(!pbi){
    pbi=document.createElement("div");
    pbi.id="pbi-modal";
    pbi.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.8);z-index:9999;display:flex;justify-content:center;align-items:center;";
    pbi.innerHTML=`
      <div style="background:var(--bg,#fff);width:95%;height:90%;border-radius:8px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,0.4);">
        <div style="padding:15px;border-bottom:1px solid var(--border,#eee);display:flex;justify-content:space-between;align-items:center;background:var(--bg);">
          <h2 style="margin:0;font-size:1.2rem;color:var(--ink-full);">Visualization Builder</h2>
          <button onclick="closeVisBuilder()" style="border:none;background:transparent;font-size:1.5rem;cursor:pointer;color:var(--ink-full);">&times;</button>
        </div>
        <div style="display:flex;flex:1;overflow:hidden;">
          <div style="width:220px;border-right:1px solid var(--border);padding:10px;overflow-y:auto;background:var(--bg);">
            <h4 style="margin-top:0;color:var(--ink-full);">Data Fields</h4>
            <div style="font-size:0.65rem;color:var(--muted);margin-bottom:8px;">(N) Numeric · (C) Categorical</div>
            <div id="pbi-table-info" style="background:#f0f7ff;padding:8px;margin-bottom:10px;border-radius:4px;border-left:3px solid #0078d4;font-size:0.75rem;display:none;">
              <strong style="color:#0078d4;display:block;margin-bottom:4px;">📊 Table Structure</strong>
              <div id="pbi-table-info-content"></div>
            </div>
            <div id="pbi-fields" style="display:flex;flex-direction:column;gap:6px;"></div>
          </div>
          <div style="flex:1;padding:16px;display:flex;flex-direction:column;background:var(--bg);position:relative;">
            <div id="pbi-empty" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--muted);border:2px dashed var(--border);border-radius:8px;text-align:center;padding:20px;">
              Select fields and click "Generate Visual" to render chart
            </div>
            <div style="flex:1;position:relative;"><canvas id="pbi-canvas" style="display:none;"></canvas></div>
            <div id="pbi-table-container" style="display:none;flex:1;overflow:auto;background:var(--bg);border:1px solid var(--border);border-radius:4px;"></div>
            <div style="padding-top:10px;display:flex;align-items:center;justify-content:flex-end;gap:16px;">
              <label style="font-size:0.8rem;cursor:pointer;color:var(--ink-full);display:flex;align-items:center;gap:5px;"><input type="checkbox" id="pbi-show-labels"/> Show Labels</label>
              <button id="pbi-export-btn" style="padding:7px 14px;background:#15803d;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;display:none;">Export PNG</button>
              <button id="pbi-generate-btn" style="padding:7px 14px;background:var(--accent,#0078d4);color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">Generate Visual</button>
            </div>
          </div>
          <div style="width:260px;border-left:1px solid var(--border);padding:14px;overflow-y:auto;background:var(--bg);">
            <h4 style="margin-top:0;color:var(--ink-full);">Visualizations</h4>
            <div id="pbi-chart-icons-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:18px;"></div>
            <h4 style="border-bottom:1px solid var(--border);padding-bottom:5px;color:var(--ink-full);">Build Visual</h4>
            <div style="display:flex;flex-direction:column;gap:12px;">
              <div><div style="font-size:0.8rem;margin-bottom:4px;font-weight:bold;color:var(--ink-full);">X-axis / Category</div>
                <select class="pbi-select" data-zone="x" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--ink-full);font-size:0.8rem;"></select></div>
              <div><div style="font-size:0.8rem;margin-bottom:4px;font-weight:bold;color:var(--ink-full);">Y-axis / Values</div>
                <select class="pbi-select" data-zone="y" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--ink-full);font-size:0.8rem;"></select></div>
              <div><div style="font-size:0.8rem;margin-bottom:4px;font-weight:bold;color:var(--ink-full);">Legend / Breakdown</div>
                <select class="pbi-select" data-zone="group" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--ink-full);font-size:0.8rem;"></select></div>
              <select id="pbi-agg-func" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--ink-full);font-size:0.8rem;">
                <option value="none">None (Raw)</option>
                <option value="sum">Sum</option>
                <option value="mean">Average</option>
                <option value="count">Count</option>
                <option value="min">Min</option>
                <option value="max">Max</option>
              </select>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(pbi);
    const style=document.createElement("style");
    style.innerHTML=`.pbi-icon-btn{background:transparent;border:1px solid var(--border,#ccc);border-radius:4px;transition:all 0.2s;font-size:1.3rem;padding:6px;cursor:pointer;color:var(--ink-full,#333)}.pbi-icon-wrapper{display:flex;flex-direction:column;align-items:center;gap:3px}.pbi-icon-name{font-size:0.6rem;color:var(--muted);text-align:center}.pbi-icon-btn:hover{background:var(--accent,#0078d4);border-color:#0078d4;color:#fff}.pbi-icon-btn.active{background:#cce4f7;border-color:#005a9e}.pbi-field{padding:7px 9px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:0.82rem;cursor:grab;user-select:none;color:var(--ink-full);transition:background 0.2s}.pbi-field:hover{background:#f0f8ff}#pbi-table-container table{width:100%;border-collapse:collapse;color:var(--ink-full)}#pbi-table-container th{background:var(--bg);padding:8px;border-bottom:2px solid var(--border);font-size:0.82rem;font-weight:bold;position:sticky;top:0}#pbi-table-container td{padding:7px 9px;border-bottom:1px solid var(--border);font-size:0.78rem}`;
    document.head.appendChild(style);
    _setupPBIEvents();
  } else { pbi.style.display="flex"; }

  // Populate chart icons
  const chartTypes=[
    {id:"bar",icon:"📊",name:"Column"},{id:"horizontal-bar",icon:"⎯",name:"Bar"},
    {id:"line",icon:"📈",name:"Line"},{id:"area",icon:"◢",name:"Area"},
    {id:"pie",icon:"🥧",name:"Pie"},{id:"doughnut",icon:"🍩",name:"Donut"},
    {id:"scatter",icon:"⚄",name:"Scatter"},{id:"table",icon:"🗄️",name:"Table"},
    {id:"matrix",icon:"🧮",name:"Matrix"},{id:"forecast",icon:"🔮",name:"Forecast"},
    {id:"timeline",icon:"📅",name:"Timeline"},{id:"pareto",icon:"📉",name:"Pareto"},
    {id:"heatmap",icon:"🔥",name:"Heatmap"},{id:"histogram",icon:"📶",name:"Hist"},
  ];
  document.getElementById("pbi-chart-icons-grid").innerHTML=chartTypes.map(c=>
    `<div class="pbi-icon-wrapper"><button class="pbi-icon-btn ${activePBIChartType===c.id?"active":""}" data-type="${c.id}" title="${c.name}">${c.icon}</button><span class="pbi-icon-name">${c.name}</span></div>`
  ).join("");

  // Populate fields list
  const fieldsEl=document.getElementById("pbi-fields");
  fieldsEl.innerHTML="";
  const frag=document.createDocumentFragment();
  edaData.columns.forEach(col => {
    const f=document.createElement("div");
    f.className="pbi-field"; f.draggable=true; f.dataset.col=col.name;
    f.innerHTML=`<b style="color:#0078d4;font-family:monospace;">${col.type==="numeric"?"(N)":"(C)"}</b> &nbsp;${escHtml(col.name)}`;
    f.addEventListener("dragstart",e=>e.dataTransfer.setData("text/plain",col.name));
    frag.appendChild(f);
  });
  fieldsEl.appendChild(frag);

  // Table metadata info
  if(tableMetadata?.fact_table){
    const el=document.getElementById("pbi-table-info");
    el.style.display="block";
    let html=`<strong style="color:#0078d4;">Fact:</strong> ${escHtml(tableMetadata.fact_table)}<br/>`;
    (tableMetadata.dimension_tables||[]).forEach(d=>{html+=`&nbsp;• ${escHtml(d.name)}<br/>`;});
    document.getElementById("pbi-table-info-content").innerHTML=html;
  }

  // Populate selects
  const opts="<option value=''>None / Auto</option>"+
    edaData.columns.map(c=>`<option value="${escHtml(c.name)}">${c.type==="numeric"?"(N)":"(C)"} ${escHtml(c.name)}</option>`).join("");
  document.querySelectorAll(".pbi-select").forEach(s=>{s.innerHTML=opts;});

  // Auto-select defaults
  const xSel=document.querySelector(".pbi-select[data-zone='x']");
  const ySel=document.querySelector(".pbi-select[data-zone='y']");
  if(!xSel.value){const cat=edaData.columns.find(c=>c.type==="categorical");if(cat)xSel.value=cat.name;}
  if(!ySel.value){const num=edaData.columns.find(c=>c.type==="numeric");if(num)ySel.value=num.name;}

  _setupPBIEvents();
}

function closeVisBuilder() {
  const pbi=document.getElementById("pbi-modal");
  if(pbi) pbi.style.display="none";
  document.body.style.overflow="";
}

function _setupPBIEvents() {
  document.querySelectorAll(".pbi-icon-btn").forEach(btn => {
    btn.onclick=()=>{
      activePBIChartType=btn.dataset.type;
      document.querySelectorAll(".pbi-icon-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
    };
  });
  const genBtn=document.getElementById("pbi-generate-btn");
  if(genBtn) genBtn.onclick=renderPBIChart;
  const expBtn=document.getElementById("pbi-export-btn");
  if(expBtn) expBtn.onclick=exportPBIVisual;
  const labChk=document.getElementById("pbi-show-labels");
  if(labChk) labChk.onchange=e=>{pbiShowLabels=e.target.checked;};
}

function renderPBIChart() {
  const xCol=document.querySelector(".pbi-select[data-zone='x']").value;
  const yCol=document.querySelector(".pbi-select[data-zone='y']").value;
  const groupCol=document.querySelector(".pbi-select[data-zone='group']").value;
  const aggFunc=document.getElementById("pbi-agg-func").value;
  if(!xCol&&activePBIChartType!=="table"&&activePBIChartType!=="matrix"){
    _showPBIEmpty("Please select an X-axis field."); return;
  }
  if(fileId==="sample"){
    _showPBIEmpty("Live aggregations require a real file upload. Sample data is local-only."); return;
  }
  document.getElementById("pbi-empty").style.display="none";
  document.getElementById("pbi-canvas").style.display="none";
  document.getElementById("pbi-table-container").style.display="none";
  document.getElementById("pbi-export-btn").style.display="none";

  fetch(`${API_BASE}/api/chart_data`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({file_id:fileId,x_col:xCol,y_col:yCol,group_col:groupCol,agg:aggFunc,type:activePBIChartType}),
  })
  .then(r=>r.json())
  .then(data=>{if(data.error){_showPBIEmpty(data.error);return;}_drawPBIChart(data,xCol,yCol,groupCol);})
  .catch(()=>_showPBIEmpty("Failed to load chart data. Is the backend running?"));
}

function _drawPBIChart(data,xCol,yCol) {
  pbiChartInstance?.destroy(); pbiChartInstance=null;
  let type=activePBIChartType;

  // Table/Matrix view
  if(type==="table"||type==="matrix"){
    const tc=document.getElementById("pbi-table-container");
    tc.style.display="block";
    let html="<table><thead><tr><th>"+escHtml(xCol||"Category")+"</th>";
    if(data.series){
      Object.keys(data.series).forEach(k=>{html+=`<th>${escHtml(k)}</th>`;});
      html+="</tr></thead><tbody>";
      data.x.forEach((x,i)=>{
        html+=`<tr><td>${escHtml(x)}</td>`;
        Object.keys(data.series).forEach(k=>{const v=data.series[k][i];html+=`<td>${typeof v==="number"?v.toLocaleString():escHtml(String(v))}</td>`;});
        html+="</tr>";
      });
    } else {
      html+=`<th>${escHtml(yCol||"Count")}</th></tr></thead><tbody>`;
      data.x.forEach((x,i)=>{html+=`<tr><td>${escHtml(x)}</td><td>${typeof data.y[i]==="number"?data.y[i].toLocaleString():escHtml(String(data.y[i]))}</td></tr>`;});
    }
    tc.innerHTML=html+"</tbody></table>"; return;
  }

  document.getElementById("pbi-canvas").style.display="block";
  document.getElementById("pbi-export-btn").style.display="inline-block";
  const ctx=document.getElementById("pbi-canvas");

  let indexAxis="x";
  if(type==="horizontal-bar"){type="bar";indexAxis="y";}

  let datasets=[];
  if(data.series){
    let ci=0;
    for(const[key,vals] of Object.entries(data.series)){
      const col=VIS_COLORS[ci%VIS_COLORS.length];
      datasets.push({label:key,data:vals,backgroundColor:type==="line"?"transparent":col+"cc",borderColor:col,borderWidth:2,fill:type==="area",tension:0.3});
      ci++;
    }
  } else {
    const isPieLike = ["pie", "doughnut"].includes(type);
    datasets=[{
      label:yCol||"Count",data:data.y||[],
      // Use data.x to check for "Others" bucket and apply gray theme
      backgroundColor: data.x?.map((lbl, i) => {
        if (isPieLike && lbl === "Others") return "#808080cc"; 
        return VIS_COLORS[i % VIS_COLORS.length] + (isPieLike ? "cc" : "44");
      }) || [],
      borderColor: data.x?.map((lbl, i) => {
        if (isPieLike && lbl === "Others") return "#808080";
        return VIS_COLORS[i % VIS_COLORS.length];
      }) || [],
      borderWidth:(type==="line"||type==="area")?2:1,fill:type==="area",tension:0.3,
    }];
    if(type==="pareto"){
      const total=data.y.reduce((a,b)=>a+b,0); let run=0;
      datasets.push({label:"Cumulative %",data:data.y.map(v=>{run+=v;return+(run/total*100).toFixed(1);}),type:"line",borderColor:"#ef4444",yAxisID:"y1",fill:false,tension:0});
    }
  }

  const isPieLike = ["pie", "doughnut"].includes(type);
  const chartType=type==="area"||type==="forecast"||type==="timeline"?"line":type==="pareto"?"bar":type;
  const opts={
    responsive:true,maintainAspectRatio:false,indexAxis,
    plugins:{
      legend:{display:true,position:"right",labels:{font:{family:"Roboto Mono",size:11},color:"gray"}},
      datalabels:{
        display:pbiShowLabels,
        color:"black", // Set data labels to black for better visibility
        anchor:isPieLike ? "center" : "end",
        align:isPieLike ? "center" : "top",
        font:{size:10, weight: "bold"},
        formatter: (v) => typeof v === 'number' ? v.toLocaleString() : v
      },
    },
  };
  if(!["pie","doughnut"].includes(chartType)){
    opts.scales={
      x:{ticks:{color:"gray",font:{family:"Roboto Mono",size:11}},grid:{color:"rgba(128,128,128,0.15)"}},
      y:{beginAtZero:true,ticks:{color:"gray",font:{family:"Roboto Mono",size:11}},grid:{color:"rgba(128,128,128,0.15)"}},
      ...(type==="pareto"?{y1:{position:"right",min:0,max:100,ticks:{callback:v=>v+"%"},grid:{drawOnChartArea:false}}}:{})
    };
  }

  _whenChart(()=>{
    pbiChartInstance=new Chart(ctx,{type:chartType,data:{labels:data.x||[],datasets},options:opts});
  });
}

function exportPBIVisual() {
  if(!pbiChartInstance) return;
  const canvas=document.getElementById("pbi-canvas");
  const tmp=document.createElement("canvas");
  tmp.width=canvas.width; tmp.height=canvas.height;
  const tc=tmp.getContext("2d");
  tc.fillStyle="#ffffff"; tc.fillRect(0,0,tmp.width,tmp.height); tc.drawImage(canvas,0,0);
  const a=document.createElement("a");
  a.download=`datalens_visual_${activePBIChartType}.png`;
  a.href=tmp.toDataURL("image/png"); a.click();
  toast("Visual exported as PNG!","success");
}

function _showPBIEmpty(msg) {
  document.getElementById("pbi-canvas").style.display="none";
  document.getElementById("pbi-table-container").style.display="none";
  document.getElementById("pbi-export-btn").style.display="none";
  const e=document.getElementById("pbi-empty");
  e.style.display="flex"; e.textContent=msg;
}

/* ══════════════════════════════════════════════════════════════
   OLD VIS MODAL (kept for compatibility — uses same chart types)
══════════════════════════════════════════════════════════════ */
let _oldVisChartType="bar";

function selectChartType(btn, type) {
  _oldVisChartType=type; activeChartType=type;
  document.querySelectorAll(".ct-btn").forEach(b=>b.classList.remove("active"));
  btn?.classList.add("active");
}

function autoRenderVis() { /* no-op — user clicks Render */ }

function renderVisChart() {
  const x=document.getElementById("vis-x").value;
  const y=document.getElementById("vis-y").value;
  if(!x){toast("Select an X axis column.","warning");return;}
  if(fileId==="sample"){
    toast("Live charts need a real upload. Use Power BI-style builder instead.","info"); return;
  }
  fetch(`${API_BASE}/api/chart_data`,{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({file_id:fileId,x_col:x,y_col:y,agg:"sum",type:activeChartType}),
  })
  .then(r=>r.json())
  .then(data=>{
    if(data.error){toast(data.error,"error");return;}
    _whenChart(()=>{
      visChart?.destroy();
      const canvas=document.getElementById("vis-canvas");
      canvas.style.display="block";
      document.getElementById("vis-empty").style.display="none";
      document.getElementById("vis-chart-actions").style.display="flex";
      const showLabels=document.getElementById("vis-show-labels").checked;
      const isPieLike = ["pie", "doughnut"].includes(activeChartType);
      visChart=new Chart(canvas,{
        type:isPieLike?activeChartType:"bar",
        data:{
          labels:data.x||[],
          datasets:[{
            label:y||"Count",data:data.y||[],
            backgroundColor: data.x?.map((lbl, i) => {
              if (isPieLike && lbl === "Others") return "#808080cc";
              return VIS_COLORS[i % VIS_COLORS.length] + "cc";
            }) || [],
            borderColor: data.x?.map((lbl, i) => {
              if (isPieLike && lbl === "Others") return "#808080";
              return VIS_COLORS[i % VIS_COLORS.length];
            }) || [],
            borderWidth:1.5}],
        },
        options:{
          responsive:true,maintainAspectRatio:false,
          plugins:{
            legend:{display:true,position:"top"},
            datalabels:{
              display:showLabels,
              color:"black",
              anchor:isPieLike ? "center" : "end",
              align:isPieLike ? "center" : "top",
              font:{size:10, weight:"bold"},
              formatter: (v) => typeof v === 'number' ? v.toLocaleString() : v
            },
          },
          scales:["pie","doughnut"].includes(activeChartType)?{}:{
            x:{ticks:{color:"gray",font:{family:"Roboto Mono",size:11}},grid:{color:"rgba(128,128,128,0.15)"}},
            y:{beginAtZero:true,ticks:{color:"gray"},grid:{color:"rgba(128,128,128,0.15)"}},
          },
        },
      });
    });
  })
  .catch(()=>toast("Chart failed. Is the backend running?","error"));
}

function downloadChart() {
  if(!visChart) return;
  const canvas=document.getElementById("vis-canvas");
  const tmp=document.createElement("canvas");
  tmp.width=canvas.width; tmp.height=canvas.height;
  const tc=tmp.getContext("2d");
  tc.fillStyle="#ffffff"; tc.fillRect(0,0,tmp.width,tmp.height); tc.drawImage(canvas,0,0);
  const a=document.createElement("a");
  a.download="datalens_chart.png"; a.href=tmp.toDataURL("image/png"); a.click();
}

/* ── Old vis modal open/close ───────────────────────────────── */
function _openOldVisBuilder() {
  if (!edaData) return;
  document.getElementById("vis-modal").classList.add("open");
  document.body.style.overflow = "hidden";
  const opts = edaData.columns.map(c => `<option value="${escHtml(c.name)}">${escHtml(c.name)}</option>`).join("");
  const blank = "<option value=''>— Select —</option>";
  document.getElementById("vis-x").innerHTML = blank + opts;
  document.getElementById("vis-y").innerHTML = blank + opts;
  document.getElementById("vis-y2").innerHTML = blank + opts;
  // Auto-select first categorical for X, first numeric for Y
  const cat = edaData.columns.find(c => c.type === "categorical");
  const num = edaData.columns.find(c => c.type === "numeric");
  if (cat) document.getElementById("vis-x").value = cat.name;
  if (num) document.getElementById("vis-y").value = num.name;
}
function closeOldVisBuilder() {
  document.getElementById("vis-modal").classList.remove("open");
  document.body.style.overflow = "";
}
document.getElementById("vis-modal")?.addEventListener("click", function(e) { if (e.target === this) closeOldVisBuilder(); });

/* ── Report ─────────────────────────────────────────────────── */
function openReport() {
  if(!edaData) return;
  document.getElementById("report-modal").classList.add("open");
  document.body.style.overflow="hidden";
  generateReport();
}
function closeReport() { document.getElementById("report-modal").classList.remove("open"); document.body.style.overflow=""; }

function generateReport() {
  const data=edaData, fname=document.getElementById("db-fname").textContent;
  document.getElementById("report-subtitle").textContent=fname;
  const numCols=data.columns.filter(c=>c.type==="numeric");
  const catCols=data.columns.filter(c=>c.type==="categorical");
  const nullCols=data.columns.filter(c=>c.null_count>0);
  const totalNulls=data.columns.reduce((s,c)=>s+c.null_count,0);
  const totalOut=numCols.reduce((s,c)=>s+(c.stats?.outlier_count||0),0);
  const topCorr=data.correlations?[...data.correlations].sort((a,b)=>Math.abs(b.r)-Math.abs(a.r))[0]:null;

  document.getElementById("report-content").innerHTML=`
    <h3>📋 Summary</h3>
    <p>Dataset <strong>${escHtml(fname)}</strong> contains <strong>${data.shape.rows.toLocaleString()} rows</strong> and <strong>${data.shape.cols} columns</strong>
    (${numCols.length} numeric, ${catCols.length} categorical).
    ${data.duplicate_rows>0?`<strong style="color:var(--amber)">${data.duplicate_rows} duplicate rows</strong> detected.`:"No duplicate rows found."}</p>
    <div class="report-kv">
      ${[["Rows",data.shape.rows.toLocaleString()],["Columns",data.shape.cols],["Duplicates",data.duplicate_rows],["Total Nulls",totalNulls.toLocaleString()],["Cols w/ Nulls",nullCols.length],["Outliers",totalOut]].map(([l,v])=>
        `<div class="report-kv-item"><div class="report-kv-val">${v}</div><div class="report-kv-lbl">${l}</div></div>`).join("")}
    </div>
    <h3>🔢 Numeric Columns</h3>
    ${numCols.length===0?"<p>None found.</p>":numCols.map(c=>`<p><strong>${escHtml(c.name)}</strong> — Mean: ${c.stats?.mean}, Median: ${c.stats?.median}, Std: ${c.stats?.std}, Outliers: ${c.stats?.outlier_count}, Null%: ${c.null_pct}%</p>`).join("")}
    <h3>📝 Categorical Columns</h3>
    ${catCols.length===0?"<p>None found.</p>":catCols.map(c=>{const top=c.bar_chart?`Top: <strong>${escHtml(c.bar_chart.labels[0])}</strong> (${c.bar_chart.counts[0].toLocaleString()})`:"";return`<p><strong>${escHtml(c.name)}</strong> — ${c.unique_count} unique. ${top} Null%: ${c.null_pct}%</p>`;}).join("")}
    ${topCorr?`<h3>📊 Top Correlation</h3><p><strong>${escHtml(topCorr.col_a)}</strong> × <strong>${escHtml(topCorr.col_b)}</strong> r = <strong>${Number(topCorr.r).toFixed(3)}</strong> (${Math.abs(topCorr.r)>=0.7?"strong":Math.abs(topCorr.r)>=0.4?"moderate":"weak"} ${topCorr.r>0?"positive":"negative"}).</p>`:""}
    <h3>⚠️ Data Quality Notes</h3>
    ${nullCols.length===0?"<p style='color:var(--green)'>✅ No missing values detected.</p>":
      `<p>${nullCols.map(c=>`<strong>${escHtml(c.name)}</strong> (${c.null_pct}% missing)`).join(", ")} have missing values.</p>`}
    ${data.duplicate_rows>0?`<p><strong>${data.duplicate_rows} duplicate rows</strong> found. Deduplicate before analysis.</p>`:""}
    ${totalOut>0?`<p><strong>${totalOut} outliers</strong> via IQR. Review before modeling.</p>`:""}
    <p style="margin-top:20px;font-size:0.75rem;color:var(--muted);border-top:1px solid var(--border);padding-top:12px">Generated by DataLens · ${new Date().toLocaleDateString("en-IN",{year:"numeric",month:"long",day:"numeric"})}</p>`;
}

function downloadReport() {
  const fname=document.getElementById("db-fname").textContent.replace(/[^a-z0-9]/gi,"_");
  const content=document.getElementById("report-content").innerHTML;
  const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>EDA Report — ${escHtml(fname)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Roboto:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>body{font-family:Roboto,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#181612;font-weight:300}h1{font-family:"Playfair Display",serif;font-size:2rem}h3{font-family:"Playfair Display",serif;font-size:1.1rem;margin:24px 0 10px}p{line-height:1.8;color:#44403a}.report-kv{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}.report-kv-item{background:#f5f5f5;border:1px solid #e2ddd6;border-radius:8px;padding:12px}.report-kv-val{font-family:"Playfair Display",serif;font-size:1.3rem;font-weight:600}.report-kv-lbl{font-size:0.65rem;color:#8a857c;text-transform:uppercase;letter-spacing:1px}</style>
  </head><body><h1>EDA Report</h1><p style="color:#8a857c;font-size:0.85rem">${escHtml(fname)}</p>${content}</body></html>`;
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([html],{type:"text/html"}));
  a.download=`EDA_Report_${fname}.html`; a.click();
  URL.revokeObjectURL(a.href);
  toast("Report downloaded!","success");
}

document.getElementById("report-modal").addEventListener("click",function(e){if(e.target===this)closeReport();});
