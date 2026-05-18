/* ══════════════════════════════════════════════════════════════
   Data Lens by Shreyans — app.js
   Upgrades:
   • Apache ECharts replaces Chart.js throughout
   • AG Grid for interactive data table (section 08)
   • AI Insight cards engine (client-side rendering)
   • Cross-filter global state (filterState)
   • Smart Visualization Builder (Power BI style, ECharts)
   • Correlation pairs
   • ECharts box plot
   All original backend logic, session handling, and EDA
   sections preserved.
══════════════════════════════════════════════════════════════ */

/* ── API base ──────────────────────────────────────────────── */
const IS_GH_PAGES = window.location.hostname.includes("github.io");
const VERCEL_URL  = "https://data-lens-eda.vercel.app";
// Use localhost:5000 if running locally on a different port (e.g. Live Server)
const IS_LOCAL_HOST = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
const API_BASE    = IS_GH_PAGES ? VERCEL_URL : (window.location.port !== "5000" && IS_LOCAL_HOST ? "http://127.0.0.1:5000" : "");

/* ── Global State ──────────────────────────────────────────── */
const state = {
  activeFileId: null,
  datasets: {}, // 6c: fid -> { edaData, cleanedData, meta, fname, undoStack: [] }
  edaData: null,
  cleanedData: null,
  tableMetadata: null,
  activeCol: null,
  activeChartType: "bar",
  activePBIChartType: "bar",
  columnSortKey: "name",
  columnSortAsc: true,
  allColumns: [],
  activeBoxplotCol: null,
  dataModified: false,
  fileId: null,
  appliedFixes: { drop_duplicates: false, fill_nulls: null, drop_rows: [], outlier_strategy: null },
  pbiShowLabels: false,
  charts: { col: null, vis: null, boxplot: null, corr: null, pbi: null, graph: null },
  gridInstance: null,
  filterState: {},
  uploadController: null
};

/* ── Utilities ────────────────────────────────────────────── */
function escHtml(str) {
  if (!str) return "";
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

const debounceFilterColumns = debounce((q) => filterColumns(q), 300);

function _initEChart(id, existing) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (existing) { try { existing.dispose(); } catch(e) {} }
  return echarts.init(el);
}

/* ── ECharts Color Palette ─────────────────────────────────── */
const ECHART_COLORS = [
  "#1d4ed8","#6d28d9","#15803d","#b45309","#b91c1c",
  "#0e7490","#be185d","#4d7c0f","#c2410c","#5b21b6",
  "#0284c7","#7c3aed","#16a34a","#ca8a04","#dc2626",
];

function _echartTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const family = "'Inter', sans-serif";
  const labelFamily = "'Cormorant Garamond', 'DM Serif Display', Georgia, serif";
  return {
    bg:      dark ? "#1c1a15" : "#f7f6f2",
    text:    dark ? "#a39e93" : "#6b665e",
    textFull:dark ? "#e2ddd5" : "#181612",
    labelText: dark ? "#f4ead8" : "#3b3126",
    labelGlow: dark ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.78)",
    border:  dark ? "#2c2922" : "#e4dfd7",
    gridLine:dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
    fontFamily: family,
    labelFamily
  };
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
  const next   = isDark ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  document.getElementById("theme-toggle").textContent = isDark ? "🌙" : "☀️";
  localStorage.setItem("dl-theme", next);
  
  Object.values(state.charts).forEach(c => {
    if (c && c.getDom().offsetParent !== null) c.resize();
  });
}

function show(id) {
  const uploadScreen = document.getElementById("upload-screen");
  const loader       = document.getElementById("loader");
  const dashboard    = document.getElementById("dashboard");

  uploadScreen.classList.remove("visible");
  loader.style.display = "none";
  dashboard.classList.remove("visible");
  document.body.classList.remove("dashboard-active");

  if      (id === "upload-screen") uploadScreen.classList.add("visible");
  else if (id === "loader")        loader.style.display = "flex";
  else if (id === "dashboard") {
    dashboard.classList.add("visible");
    document.body.classList.add("dashboard-active");
  }
}

/* ── Drag & Drop / File input ───────────────────────────────── */
function resetToUpload() {
  show("upload-screen");
  document.getElementById("file-input").value = "";
}

function resetApp() {
  state.activeFileId = null;
  state.fileId = null;
  state.datasets = {};
  state.edaData = null;
  state.filterState = {};
  document.getElementById("file-badge").classList.remove("show");
  document.getElementById("dataset-tabs").innerHTML = "";
  document.getElementById("dataset-tabs").style.display = "none";
  resetToUpload();
}

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
  if (e.key === "Escape") { closeReport(); closeVisBuilder(); }
});

function handleFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (!["csv","xlsx","xls","json"].includes(ext)) {
    toast("Please upload a CSV, JSON, or Excel file.", "error"); return;
  }

  if (state.uploadController) state.uploadController.abort();
  state.uploadController = new AbortController();

  show("loader");
  document.getElementById("loader-sub").textContent = `${file.name} · ${(file.size/1024/1024).toFixed(1)} MB`;

  // Fallback for non-secure contexts where crypto.randomUUID is unavailable
  const progressId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
  const pollIv = setInterval(() => {
    if (API_BASE.startsWith("http") || window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      fetch(`${API_BASE}/api/progress/${progressId}`)
        .then(r => r.json())
        .then(d => {
          const msgEl = document.getElementById("loader-msg");
          if (d.progress && msgEl) msgEl.textContent = d.progress;
        })
        .catch(() => {
          if (document.getElementById("loader-msg")) document.getElementById("loader-msg").textContent = "Processing dataset...";
        });
    }
  }, 600);
  
  const fd    = new FormData();
  fd.append("file", file);
  fd.append("progress_id", progressId);

  fetch(`${API_BASE}/upload`, { 
    method: "POST", 
    body: fd,
    signal: state.uploadController.signal
  })
    .then(async r => {
      clearInterval(pollIv);
      if (!r.ok) { let msg = `Server error: ${r.status}`; try { const e = await r.json(); if (e.error) msg = e.error; } catch (_) {} throw new Error(msg); }
      return r.json();
    })
    .then(data => {
      if (data.success) {
        _init(data, file.name);
      } else {
        throw new Error(data.error || "Upload failed");
      }
    })
    .catch(err => { 
      clearInterval(pollIv); 
      toast("Upload failed: " + err.message, "error"); 
      show("upload-screen"); 
    });
}

/* ── Sample data ────────────────────────────────────────────── */
function loadSampleData(datasetType) {
  const rows = 312;
  const data = {
    shape: { rows, cols: 8 }, duplicate_rows: 4, health_score: 88.4,
    columns: [
      { name:"Age",        type:"numeric",     null_count:3,  null_pct:1.0,  unique_count:45, table_origin: "Employee_Data",
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
      Age:22+Math.floor(Math.random()*50), Salary:25000+Math.floor(Math.random()*120000),
      Experience:Math.floor(Math.random()*25), Score:35+Math.floor(Math.random()*64),
      "Hours/Week":22+Math.floor(Math.random()*46),
      Department:["Engineering","Marketing","Sales","HR","Finance"][i%5],
      Education:["Bachelor's","Master's","PhD","Diploma"][i%4],
      Status:["Active","On Leave","Resigned"][i%3],
    })),
    table_metadata:{ fact_table:"Employee_Data", dimension_tables:[],
      column_origins:Object.fromEntries(["Age","Salary","Experience","Score","Hours/Week","Department","Education","Status"].map(k=>[k,"Employee_Data"])) },
    insights:[
      {id:"corr1",type:"success",category:"Correlation",title:"Salary ↔ Experience strongly linked",body:"Pearson r = 0.74 — strong positive correlation. Years of experience is a reliable salary predictor.","action":"View Scatter","action_target":"scatter:Salary:Experience"},
      {id:"skew1",type:"info",category:"Distribution",title:"Salary is right-skewed",body:"Skewness of 1.12 — a few high earners pull the mean above the median. Consider log transform for modeling.","action":"View Distribution","action_target":"col:Salary"},
      {id:"outlier1",type:"warning",category:"Outliers",title:"Salary: 4.5% outlier rows",body:"14 values outside the IQR fence. Review before training models.","action":"View Outliers","action_target":"outliers"},
      {id:"suggest1",type:"info",category:"Chart Suggestion",title:"Bar chart: Salary by Department",body:"Comparing average salaries across departments will surface compensation gaps.","action":"Build Bar Chart","action_target":"visbuilder"},
    ],
  };
  _init(data, `sample_${datasetType}_data.csv`);
  show("dashboard");
  renderDashboard(data, `sample_${datasetType}_data.csv`);
  toast(`${datasetType || 'Sample'} data loaded!`, "success");
}

/* ── Init ───────────────────────────────────────────────────── */
// 6c: Modified init to support multiple datasets
function _init(data, fname) {
  const fid = data.file_id || "sample_" + Date.now();
  
  state.datasets[fid] = {
    edaData: data,
    cleanedData: structuredClone(data),
    meta: data.table_metadata || {},
    fname: fname,
    undoStack: [] // 6d: Initialize undo stack
  };

  switchTab(fid);
}

// 6c: Switch between open datasets
function switchTab(fid) {
  const ds = state.datasets[fid];
  if (!ds) return;

  state.activeFileId = fid;
  state.fileId = fid;
  state.edaData = ds.edaData;
  state.tableMetadata = ds.meta;
  state.appliedFixes  = { drop_duplicates: false, fill_nulls: null, drop_rows: [], outlier_strategy: null };
  state.cleanedData   = ds.cleanedData;
  state.dataModified  = false;
  state.filterState   = {};

  renderDashboard(ds.edaData, ds.fname);
  renderTabs();
  
  // 6d: Sync undo button visibility
  document.getElementById("btn-undo").style.display = ds.undoStack.length > 0 ? "inline-flex" : "none";
}

function renderTabs() {
  const container = document.getElementById("dataset-tabs");
  container.innerHTML = "";
  Object.entries(state.datasets).forEach(([fid, ds]) => {
    const tab = document.createElement("div");
    tab.className = `tab-item ${fid === state.activeFileId ? 'active' : ''}`;
    tab.textContent = ds.fname;
    tab.onclick = () => switchTab(fid);
    container.appendChild(tab);
  });
  container.style.display = "flex";
}

// 6d: Revert last quick fix
function undoFix() {
  const ds = state.datasets[state.activeFileId];
  if (!ds || !ds.undoStack.length) return;
  
  ds.edaData = ds.undoStack.pop();
  ds.cleanedData = structuredClone(ds.edaData);
  switchTab(state.activeFileId);
  toast("Action undone", "info");
}

function renderDashboard(data, fname) {
  show("dashboard");
  document.getElementById("db-fname").textContent  = fname;
  document.getElementById("db-fmeta").textContent  = `${data.shape.rows.toLocaleString()} rows × ${data.shape.cols} columns`;
  document.getElementById("badge-name").textContent = fname;
  document.getElementById("file-badge").classList.add("show");
  ["btn-vis-builder","btn-reset","btn-report"].forEach(id => {
    document.getElementById(id).style.display = "inline-flex";
  });

  state.allColumns = [...data.columns];

  renderOverview(data);
  renderInsights(data.insights || []);
  renderColumnTable(state.allColumns);
  renderColPills(state.allColumns);

  _renderPreviewStatic(data);

  requestAnimationFrame(() => {
    renderQuality(data.columns);
    renderCorrelations(data);
    renderOutlierSection(data.columns);
    setupVisBuilder(data);
    renderAGGrid(data);
    const graphMeta = data.table_metadata || state.tableMetadata;
    renderDependencyGraph(graphMeta);
  });

  const first = data.columns.find(c => c.type === "numeric");
  if (first) selectCol(first.name);
}

function _renderPreviewStatic(data) {
  const thead = document.getElementById("preview-thead");
  const tbody = document.getElementById("preview-tbody");
  const rows = data.preview_rows || [];
  if (!thead || !tbody || !rows.length) return;

  const cols = Object.keys(rows[0]);
  thead.innerHTML = `<tr><th>#</th>${cols.map(c => `<th>${escHtml(c)}</th>`).join("")}</tr>`;
  tbody.innerHTML = rows.map((r, i) => `
    <tr>
      <td>${i + 1}</td>
      ${cols.map(c => `<td>${escHtml(r[c] ?? "—")}</td>`).join("")}
    </tr>`).join("");
}

/* ── Section 1: Overview KPI Cards ─────────────────────────── */
function renderOverview(data) {
  const numC  = data.columns.filter(c => c.type === "numeric").length;
  const catC  = data.columns.filter(c => c.type === "categorical").length;
  const score = data.health_score || 0;
  const dups  = data.duplicate_rows;
  const nullCols = data.columns.filter(c => c.null_count > 0).length;
  const totalOut = data.columns.filter(c=>c.type==="numeric").reduce((s,c)=>s+(c.stats?.outlier_count||0),0);

  const items = [
    {val:data.shape.rows.toLocaleString(), lbl:"Total Rows",     cls:"",                         icon:"📋"},
    {val:data.shape.cols,                  lbl:"Columns",        cls:"",                         icon:"⎕"},
    {val:score+"%",                        lbl:"Health Score",   cls:score>80?"":"warn",         icon:"❤️"},
    {val:numC,                             lbl:"Numeric Cols",   cls:"",                         icon:"#"},
    {val:catC,                             lbl:"Categorical",    cls:"",                         icon:"⊕"},
    {val:dups,                             lbl:"Duplicates",     cls:dups>0?"warn":"",           icon:"⊟"},
    {val:nullCols,                         lbl:"Cols w/ Nulls",  cls:nullCols>0?"warn":"",       icon:"∅"},
    {val:totalOut,                         lbl:"Total Outliers", cls:totalOut>0?"warn":"",       icon:"⚠"},
  ];
  document.getElementById("overview-grid").innerHTML =
    items.map(i => `
      <div class="ov-card ${i.cls}">
        <div class="ov-icon">${i.icon}</div>
        <div class="ov-val">${i.val}</div>
        <div class="ov-label">${i.lbl}</div>
      </div>`).join("");
}

/* ── Section 2: AI Insights ─────────────────────────────────── */
function renderInsights(insights) {
  let strip = document.getElementById("insights-strip");
  
  // Auto-inject the insights container if it's missing from the HTML
  if (!strip) {
    const overview = document.getElementById("overview-grid");
    if (overview) {
      strip = document.createElement("div");
      strip.id = "insights-strip";
      strip.className = "insights-strip";
      overview.parentNode.insertBefore(strip, overview.nextSibling);
    } else {
      return; // Fallback if no container exists
    }
  }
  
  // Guarantee grid layout even if external CSS is missing
  if (strip) {
    strip.style.display = "grid";
    strip.style.gridTemplateColumns = "repeat(auto-fit, minmax(280px, 1fr))";
    strip.style.gap = "14px";
    strip.style.margin = "20px 0";
  }

  if (!insights || !insights.length) {
    strip.innerHTML = `<div class="insight-empty" style="grid-column:1/-1;text-align:center;padding:20px;color:var(--muted);border:1px dashed var(--border);border-radius:8px">No insights generated for this dataset.</div>`;
    return;
  }

  const typeConfig = {
    success:  { cls: "insight-success",  icon: "✓", color: "var(--green, #16a34a)" },
    info:     { cls: "insight-info",     icon: "i", color: "var(--blue, #0284c7)" },
    warning:  { cls: "insight-warning",  icon: "!", color: "var(--amber, #d97706)" },
    critical: { cls: "insight-critical", icon: "✕", color: "var(--red, #dc2626)" },
  };

  strip.innerHTML = insights.map(ins => {
    const cfg    = typeConfig[ins.type] || typeConfig.info;
    const action = ins.action && ins.action_target ? `
      <button class="insight-action-btn" style="margin-top:12px;padding:6px 12px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-size:0.75rem;cursor:pointer;color:var(--ink-full);transition:border-color 0.2s" onclick="handleInsightAction('${escHtml(ins.action_target)}')">${escHtml(ins.action)}</button>` : "";
    return `
      <div class="insight-card ${cfg.cls}" style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ${cfg.color};border-radius:8px;padding:16px;box-shadow:0 2px 8px rgba(0,0,0,0.04);display:flex;flex-direction:column">
        <div class="insight-card-top" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <span class="insight-badge" style="font-size:0.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--muted);font-weight:700">${escHtml(ins.category)}</span>
          <span class="insight-icon" style="font-weight:bold;color:${cfg.color}">${cfg.icon}</span>
        </div>
        <div class="insight-title" style="font-weight:600;font-size:0.95rem;margin-bottom:6px;color:var(--ink-full)">${escHtml(ins.title)}</div>
        <div class="insight-body" style="font-size:0.8rem;color:var(--muted);line-height:1.5;flex:1">${escHtml(ins.body)}</div>
        ${action}
      </div>`;
  }).join("");
}

function handleInsightAction(target) {
  if (target === "quality")        { document.getElementById("quality-section")?.scrollIntoView({behavior:"smooth"}); }
  else if (target === "correlations") { document.getElementById("corr-section")?.scrollIntoView({behavior:"smooth"}); }
  else if (target === "fix_duplicates") { quickFixDropDuplicates(); }
  else if (target.startsWith("outliers")) { 
    document.getElementById("outlier-section")?.scrollIntoView({behavior:"smooth"}); 
    const parts = target.split(":");
    const tabToClick = parts.length > 1 ? document.querySelector(`.outlier-tab[data-col="${parts[1]}"]`) : document.querySelector('.outlier-tab');
    if (tabToClick) tabToClick.click();
  }
  else if (target === "visbuilder") { openVisBuilder(); }
  else if (target.startsWith("scatter:")) {
    const [,ca,cb] = target.split(":");
    openScatterForCorr(ca, cb);
  } else if (target.startsWith("col:")) {
    const colName = target.slice(4);
    selectCol(colName);
    document.getElementById("col-sec-label")?.scrollIntoView({behavior:"smooth"});
  }
}

/* ── Section 4a: Column Table ───────────────────────────────── */
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
    if (col.name === state.activeCol) tr.classList.add("active-row");
    tr.dataset.col = col.name; tr.tabIndex = 0; tr.setAttribute("role","row");
    tr.innerHTML   = `
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
    tr.innerHTML = `<td colspan="7" style="text-align:center;padding:12px;color:var(--muted);font-size:0.8rem">Showing first 50 — use Search to filter.</td>`;
    frag.appendChild(tr);
  }

  tbody.innerHTML = ""; tbody.appendChild(frag);
}

function filterColumns(query) {
  const q        = query.toLowerCase();
  const filtered = state.allColumns.filter(c => c.name.toLowerCase().includes(q));
  renderColumnTable(filtered);
  renderColPills(filtered);
}

function sortColumnTable(key, btn) {
  if (state.columnSortKey === key) state.columnSortAsc = !state.columnSortAsc;
  else { state.columnSortKey = key; state.columnSortAsc = true; }
  document.querySelectorAll("thead th").forEach(t => t.classList.remove("sorted"));
  btn?.classList.add("sorted");
  const sorted = [...state.allColumns].sort((a, b) => {
    const vals = { name:[a.name.toLowerCase(),b.name.toLowerCase()], type:[a.type,b.type], null:[a.null_pct,b.null_pct], unique:[a.unique_count,b.unique_count] };
    const [va, vb] = vals[key] || [0,0];
    return state.columnSortAsc ? (va<vb?-1:va>vb?1:0) : (va>vb?-1:va<vb?1:0);
  });
  renderColumnTable(sorted);
}

/* ── Section 4b: Pills + Stats ──────────────────────────────── */
function renderColPills(columns) {
  const frag = document.createDocumentFragment();
  columns.forEach(col => {
    const btn = document.createElement("button");
    btn.className    = "col-pill-btn" + (col.name === state.activeCol ? " active" : "");
    btn.dataset.name = col.name; 
    btn.textContent = col.name;
    btn.setAttribute("aria-pressed", col.name === state.activeCol);
    btn.addEventListener("click", () => selectCol(col.name));
    frag.appendChild(btn);
  });
  const wrap = document.getElementById("col-pills");
  wrap.innerHTML = ""; wrap.appendChild(frag);
}

function selectCol(name) {
  state.activeCol = name;
  document.querySelectorAll(".col-pill-btn").forEach(p => {
    const active = p.dataset.name === name;
    p.classList.toggle("active", active); p.setAttribute("aria-pressed", active);
  });
  document.querySelectorAll("#col-tbody tr").forEach(r =>
    r.classList.toggle("active-row", r.dataset.col === name));
  const col = state.edaData.columns.find(c => c.name === name);
  if (!col) return;
  if      (col.type === "numeric")     renderNumericStats(col);
  else if (col.type === "categorical") renderCatStats(col);
}

/* ── Helper to copy column stats to clipboard ───────────────── */
function copyColumnStats(columnName) {
  const col = state.edaData.columns.find(c => c.name === columnName);
  if (col && col.stats) {
    const statsJson = JSON.stringify(col.stats, null, 2); // Pretty print for readability
    navigator.clipboard.writeText(statsJson)
      .then(() => toast("Stats copied to clipboard!", "success"))
      .catch(err => toast("Failed to copy stats: " + err, "error"));
  } else {
    toast("No stats available to copy.", "warning");
  }
}

/* ── Numeric column stats + histogram (ECharts) ─────────────── */
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
      <button class="btn btn-sm" onclick="copyColumnStats('${escHtml(col.name)}')">Copy Stats</button>
    </div>
    <div class="stat-grid" style="grid-template-columns:repeat(auto-fill,minmax(100px,1fr))">
      ${statItems.map(i=>`<div class="stat-item"><div class="stat-val">${i.v!=null?escHtml(String(i.v)):"—"}</div><div class="stat-lbl">${i.l}</div></div>`).join("")}
    </div>
    <div class="chart-area" id="col-echart-wrap" style="height:230px"></div>`;

  if (!hd) return;
  const t = _echartTheme();
  state.charts.col = _initEChart("col-echart-wrap", state.charts.col);
  if (!state.charts.col || typeof state.charts.col.setOption !== 'function') return;

  const labels = hd.bin_edges.slice(0,-1).map((v,i)=>v.toFixed(1)+"–"+hd.bin_edges[i+1].toFixed(1));
  state.charts.col.setOption({ // Histogram
    backgroundColor: "transparent",
    tooltip: { trigger:"axis", axisPointer:{type:"shadow"}, textStyle: {fontFamily: t.fontFamily} },
    grid:  { left:"5%", right:"5%", top:"8%", bottom:"15%", containLabel:true },
    xAxis: { type:"category", data:labels, axisLabel:{color:t.text,fontSize:12,rotate:30,fontFamily:t.fontFamily}, axisLine:{lineStyle:{color:t.border}}, splitLine:{show:false} }, // Increased fontSize to 12
    yAxis: { type:"value", axisLabel:{color:t.text,fontSize:12,fontFamily:t.fontFamily}, splitLine:{lineStyle:{color:t.gridLine}} }, // Increased fontSize to 12
    textStyle: { fontFamily: t.fontFamily },
    series:[{ type:"bar", data:hd.counts, itemStyle:{ color:"rgba(29,78,216,0.6)", borderRadius:[3,3,0,0] },
      emphasis:{ itemStyle:{ color:"rgba(29,78,216,0.9)" } } }],
    animation:true, animationDuration:500,
  });
}

/* ── Categorical stats + doughnut (ECharts) ─────────────────── */
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
    <div id="col-echart-wrap" style="height:230px;margin:14px 0"></div>
    <div style="font-family:var(--mono);font-size:0.69rem;color:var(--muted);line-height:2">
      ${displayLabels.map((l,i)=>`<span style="display:inline-flex;align-items:center;gap:6px;margin-right:10px"><span style=\"font-family:'DM Serif Display',serif;font-weight:400;color:var(--ink-full)\">${escHtml(l)}</span> — ${displayCounts[i].toLocaleString()} (${((displayCounts[i]/total)*100).toFixed(1)}%)</span>`).join("")}
    </div>`;

  const t = _echartTheme();
  state.charts.col = _initEChart("col-echart-wrap", state.charts.col);
  if (!state.charts.col || typeof state.charts.col.setOption !== 'function') return; // Doughnut/Pie

  state.charts.col.setOption({ 
    backgroundColor:"transparent",
    tooltip:{ trigger:"item", formatter:"{b}: {c} ({d}%)", textStyle: {fontFamily: t.fontFamily} },
    legend:{ orient:"vertical", right:"5%", top:"center", textStyle:{color:t.text,fontSize:12,fontFamily:t.fontFamily} }, // Increased fontSize to 12
    series:[{
      type:"pie", radius:["45%","75%"],
      center:["40%","50%"],
      data: displayLabels.map((l,i)=>({ name:l, value:displayCounts[i], itemStyle:{color:ECHART_COLORS[i%ECHART_COLORS.length]} })),
      label:{ show:false }, // Default label is hidden
      emphasis:{ label:{ show:true, color:t.labelText, fontSize:17, fontWeight:500, fontFamily:t.labelFamily, textShadowColor:t.labelGlow, textShadowBlur:4 } },
    }],
    animation:true, animationDuration:600,
  });
}

function renderDateStats(col) {
  document.getElementById("stats-content").innerHTML = `
    <div class="no-col" style="padding:30px">
      📅 Date column — <strong>${escHtml(col.name)}</strong><br/>
      <span style="color:var(--muted);font-size:0.8rem;font-weight:300">Use the Visualization Builder to analyse time-based columns.</span>
    </div>`;
}

/* ── Section 5: Correlations ────────────────────────────────── */
function renderCorrelations(data) {
  const barsView = document.getElementById("corr-bars-view");
  const grid = document.getElementById("corr-grid");

  if (grid && data.correlations) {
    grid.innerHTML = data.correlations.map(c => {
      const absR = Math.abs(c.r);
      const color = c.r > 0 ? "var(--blue, #1d4ed8)" : "var(--red, #b91c1c)";
      return `
        <div class="corr-item" onclick="openScatterForCorr('${escHtml(c.col_a)}', '${escHtml(c.col_b)}')" style="cursor:pointer;padding:12px;border-bottom:1px solid var(--border);transition:background 0.2s">
          <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:6px">
            <span style="color:var(--ink-full);font-weight:500">${escHtml(c.col_a)} & ${escHtml(c.col_b)}</span>
            <strong style="color:${color}">${c.r > 0 ? "+" : ""}${c.r.toFixed(3)}</strong>
          </div>
          <div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${absR * 100}%;background:${color};opacity:0.8"></div>
          </div>
        </div>`;
    }).join("");
  }
  
  if (barsView) barsView.style.display = "block";
}

function openScatterForCorr(colA, colB) {
  openVisBuilder();
  setTimeout(() => {
    const xSel = document.querySelector(".pbi-select[data-zone='x']");
    const ySel = document.querySelector(".pbi-select[data-zone='y']");
    if (xSel) xSel.value = colA;
    if (ySel) ySel.value = colB;
    const aggSel = document.getElementById("pbi-agg-func");
    if (aggSel) aggSel.value = "none";
    state.activePBIChartType = "scatter";
    document.querySelectorAll(".pbi-icon-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.type === "scatter");
    });
    renderPBIChart();
  }, 150);
}

/* ── Section 6: Outliers + ECharts Box Plot ─────────────────── */
function renderOutlierSection(columns) {
  const numCols = columns.filter(c=>c.type==="numeric"&&c.stats?.outlier_count>0);
  const section = document.getElementById("outlier-section");
  if (!section) return;
  if (!numCols.length) { section.style.display="none"; return; }
  section.style.display = "block";

  const total = numCols.reduce((s,c)=>s+(c.stats?.outlier_count||0),0);
  document.getElementById("outlier-count-badge").textContent = `${total} total outliers detected`;

  const allNum = columns.filter(c=>c.type==="numeric"&&c.stats);
  document.getElementById("outlier-col-tabs").innerHTML = allNum.map((c,i)=>
    `<button class="outlier-tab ${i===0?"active":""}" data-col="${escHtml(c.name)}" onclick="selectOutlierCol(this)">${escHtml(c.name)}</button>`
  ).join("");
  if (allNum.length) { state.activeBoxplotCol=allNum[0].name; renderBoxplot(allNum[0]); }
}

function selectOutlierCol(btn) {
  document.querySelectorAll(".outlier-tab").forEach(t=>t.classList.remove("active"));
  btn.classList.add("active");
  state.activeBoxplotCol = btn.dataset.col;
  const col = state.edaData.columns.find(c=>c.name===state.activeBoxplotCol);
  if (col) renderBoxplot(col);
}

function renderBoxplot(col) {
  const s=col.stats, bp=col.boxplot;
  if(!s||!bp) return;
  const {min,q1,median,q3,max}=bp, iqr=q3-q1;
  const lf=Math.max(min,q1-1.5*iqr), uf=Math.min(max,q3+1.5*iqr);
  const t = _echartTheme();

  state.charts.boxplot = _initEChart("boxplot-echart", state.charts.boxplot);
  if (!state.charts.boxplot) return;

  const outlierData = (bp.outliers||[]).map(v => [0, v]);

  state.charts.boxplot.setOption({
    backgroundColor:"transparent",
    tooltip: { 
      trigger: "item",
      textStyle: {fontFamily: t.fontFamily},
      formatter: p => {
        if (p.componentType === 'series' && p.seriesType === 'boxplot') {
          return `<strong>${escHtml(col.name)}</strong><br/>Upper Fence: ${p.data[5]}<br/>Q3: ${p.data[4]}<br/>Median: <span style="color:#ef4444;font-weight:bold">${p.data[3]}</span><br/>Q1: ${p.data[2]}<br/>Lower Fence: ${p.data[1]}`;
        }
        return `Outlier: ${p.value[1].toLocaleString()}`;
      }
    },
    grid:{ left:"5%", right:"5%", top:"10%", bottom:"10%", containLabel:true }, // Boxplot
    xAxis:{ type:"category", data:[col.name], axisLabel:{color:t.textFull,fontSize:14,fontFamily:t.fontFamily}, axisLine:{lineStyle:{color:t.border}} }, // Increased fontSize to 14
    yAxis:{ type:"value", axisLabel:{color:t.text,fontSize:12,fontFamily:t.fontFamily}, splitLine:{lineStyle:{color:t.gridLine}} }, // Increased fontSize to 12
    series:[
      { type:"boxplot",
        data:[[ lf, q1, median, q3, uf ]],
        itemStyle:{ color:"rgba(29,78,216,0.2)", borderColor:"#1d4ed8", borderWidth:2 },
        boxWidth:["30%","50%"],
        markLine: {
          data: [ { yAxis: median, lineStyle: { color: "#ef4444", width: 2, type: "solid" }, label: { formatter: "Median", color: "#ef4444", position: "middle" } } ]
        }
      },
      { type:"scatter", data:outlierData,
        itemStyle:{ color:"#ef4444" }, symbolSize:8,
      },
    ],
    animation:true,
  });

  document.getElementById("boxplot-stats").innerHTML=[
    {l:"Min",v:min.toLocaleString()},{l:"Q1",v:q1.toFixed(2)},{l:"Median",v:median.toLocaleString()},
    {l:"Mean",v:s.mean!=null?s.mean:"—"},{l:"Q3",v:q3.toFixed(2)},{l:"Max",v:max.toLocaleString()},
    {l:"IQR",v:iqr.toFixed(2)},{l:"Lower fence",v:lf.toFixed(2)},{l:"Upper fence",v:uf.toFixed(2)},
    {l:"Outliers",v:s.outlier_count||0},
  ].map(i=>`<div class="bstat"><strong>${i.l}:</strong> ${i.v}</div>`).join("");
}

/* ── Section 7: Data Quality ─────────────────────────────────── */
function renderQuality(columns) {
  const sorted=[...columns].sort((a,b)=>b.null_pct-a.null_pct);
  
  const hasNulls = sorted.some(c => c.null_count > 0);
  const hasDupes = state.edaData && state.edaData.duplicate_rows > 0;
  
  const btnDupes = document.getElementById("btn-drop-dupes");
  if (btnDupes) btnDupes.style.display = hasDupes ? "inline-flex" : "none";
  
  const btnMean = document.getElementById("btn-fill-mean") || document.getElementById("fill-mean-btn");
  if (btnMean) {
    btnMean.style.display = hasNulls ? "inline-flex" : "none";
    btnMean.innerHTML = `<span>∑</span> Fill Nulls (Mean)`;
  }
  
  const btnMedian = document.getElementById("btn-fill-median") || document.getElementById("fill-median-btn");
  if (btnMedian) {
    btnMedian.style.display = hasNulls ? "inline-flex" : "none";
    btnMedian.innerHTML = `<span>↕</span> Fill Nulls (Median)`;
  }

  const frag=document.createDocumentFragment();
  sorted.forEach(col => {
    const fill  = 100-col.null_pct;
    const color = fill===100?"var(--green)":fill>80?"var(--amber)":"var(--red)";
    const insight = fill===100?"Data is clean":col.null_pct>40?"Critical: High Sparsity":"Action: Imputation suggested";
    const div=document.createElement("div"); div.className="q-item";
    div.innerHTML=`
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="q-name" title="${escHtml(col.name)}">${escHtml(col.name)}</div>
        <div style="font-size:0.7rem;color:var(--muted)">${insight}</div>
      </div>
      <div class="q-bar-wrap" role="progressbar" aria-valuenow="${fill}" aria-valuemin="0" aria-valuemax="100">
        <div class="q-bar" style="width:0%;background:${color}" data-fill="${fill}"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);font-size:0.75rem;color:var(--muted)">
        <span style="color:${fill===100?"var(--green)":"inherit"};font-weight:500">${fill.toFixed(1)}% Fill Rate</span>
        <span>${col.null_count>0?`<strong style="color:${color}">${col.null_count.toLocaleString()} missing</strong>`:"0 missing"}</span>
      </div>`;
    frag.appendChild(div);
  });
  const grid=document.getElementById("quality-grid");
  if (!grid) return;
  grid.innerHTML=""; grid.appendChild(frag);
  requestAnimationFrame(() => {
    document.querySelectorAll(".q-bar").forEach(b => { b.style.width=b.dataset.fill+"%"; });
  });
}

/* ── Section 8: AG Grid Data Table ─────────────────────────── */
function renderAGGrid(data) {
  let section = document.getElementById("ag-section");
  
  if (!section) {
    const dashboard = document.getElementById("dashboard");
    if (dashboard) {
      section = document.createElement("div");
      section.id = "ag-section";
      section.className = "db-section";
      section.style.marginTop = "30px";
      section.innerHTML = `
        <div class="sec-head" style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:15px;flex-wrap:wrap;gap:10px;background:var(--surface);padding:15px;border-radius:8px;border:1px solid var(--border)">
          <div>
            <h2 class="sec-title" id="ag-sec-label" style="margin:0;font-size:1.2rem;color:var(--ink-full)">Interactive Data Table</h2>
            <p class="sec-desc" style="margin:4px 0 0;font-size:0.8rem;color:var(--muted)">Full Dataset Explorer</p>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" style="padding:6px 12px;background:var(--bg);border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--ink-full)" onclick="agGridAutoSize()">⬌ Auto-size</button>
            <button class="btn btn-sm" style="padding:6px 12px;background:var(--bg);border:1px solid var(--border);border-radius:4px;cursor:pointer;color:var(--ink-full)" onclick="agGridResetFilters()">✕ Clear Filters</button>
            <button class="btn btn-sm btn-accent" style="padding:6px 12px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;cursor:pointer" onclick="agGridExport()">⬇ Export CSV</button>
          </div>
        </div>
        <div style="margin-bottom:10px;font-size:0.8rem;color:var(--muted);font-weight:600" id="ag-row-count"></div>
        <div id="ag-grid-container" style="height:500px;width:100%;border-radius:8px;overflow:hidden;border:1px solid var(--border);box-shadow:0 4px 12px rgba(0,0,0,0.05)"></div>
      `;
      dashboard.appendChild(section);
    } else return;
  }

  section.style.display = "block";

  if (state.gridInstance?.destroy) { try { state.gridInstance.destroy(); } catch(e){} state.gridInstance = null; }

  if (state.fileId) {
    fetch(`${API_BASE}/api/table_data?file_id=${state.fileId}`)
      .then(r => r.json())
      .then(res => {
        if (res.rows?.length) {
          _initAGGrid(res.rows, data);
          const previewSection = document.getElementById("preview-section");
          if (previewSection) previewSection.style.display = "none";
        } else {
          _initAGGrid(data.preview_rows || [], data);
        }
      })
      .catch(e => {
        console.error("Table fetch error", e);
        _initAGGrid(data.preview_rows || [], data);
      });
  } else {
    _initAGGrid(data.preview_rows || [], data);
  }
}

function _initAGGrid(rows, data) {
  const container = document.getElementById("ag-grid-container");
  if (!rows || !rows.length) {
    container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted)">No data available for preview.</div>`;
    document.getElementById("ag-row-count").textContent = `0 rows shown`;
    return;
  }
  
  const cols = Object.keys(rows[0]);

  const colDefs = cols.map(c => {
    const colMeta = data.columns.find(m => m.name === c);
    const isNum   = colMeta?.type === "numeric";
    return {
      field: c,
      headerName: c,
      sortable: true,
      filter: isNum ? "agNumberColumnFilter" : "agTextColumnFilter",
      resizable: true,
      minWidth: 100,
      type: isNum ? "numericColumn" : undefined,
      valueFormatter: isNum ? p => (p.value != null ? Number(p.value).toLocaleString() : "—") : undefined,
      cellStyle: params => {
        if (!isNum || params.value == null) return null;
        const colStats = colMeta?.stats;
        if (!colStats) return null;
        if (params.value > colStats.mean + 2 * (colStats.std||0)) return { color:"#b91c1c", fontWeight:"600" };
        if (params.value < colStats.mean - 2 * (colStats.std||0)) return { color:"#b45309", fontWeight:"600" };
        return null;
      },
    };
  });

  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  container.className = isDark ? "ag-theme-quartz-dark ag-grid-wrap" : "ag-theme-quartz ag-grid-wrap";

  const options = {
    columnDefs: colDefs,
    rowData: rows,
    defaultColDef:{ sortable:true, filter:true, resizable:true, minWidth:80, flex:1 },
    pagination: true,
    paginationPageSize: 100,
    rowSelection: "multiple",
    suppressRowClickSelection: true,
    enableCellTextSelection: true,
    animateRows: true,
    onGridReady: p => {
      try { p.api.sizeColumnsToFit(); } catch(e){}
      if(document.getElementById("ag-row-count")) document.getElementById("ag-row-count").textContent = `${rows.length} rows loaded`;
    },
    onFilterChanged: p => {
      const count = p.api.getDisplayedRowCount();
      document.getElementById("ag-row-count").textContent = `${count} / ${rows.length} rows shown`;
    },
  };

  container.innerHTML = "";
  if (window.agGrid?.createGrid) {
    state.gridInstance = window.agGrid.createGrid(container, options);
  } else if (window.agGrid) {
    state.gridInstance = new window.agGrid.Grid(container, options);
  } else {
    const rowsHtml = rows.slice(0, 100).map(r => `<tr>${cols.map(c => `<td style="padding:8px;border-bottom:1px solid var(--border);white-space:nowrap;color:var(--ink-full)">${r[c]??'—'}</td>`).join('')}</tr>`).join('');
    const colsHtml = `<tr>${cols.map(c => `<th style="padding:8px;text-align:left;border-bottom:2px solid var(--border);white-space:nowrap;color:var(--muted);background:var(--surface)">${c}</th>`).join('')}</tr>`;
    container.innerHTML = `<div style="overflow:auto;height:100%;background:var(--surface)"><table style="width:100%;border-collapse:collapse;font-size:0.8rem"><thead>${colsHtml}</thead><tbody>${rowsHtml}</tbody></table></div>`;
    document.getElementById("ag-row-count").textContent = `${Math.min(rows.length, 100)} rows shown (Fallback Table — AG Grid not loaded)`;
  }
}

function agGridAutoSize() {
  if (!state.gridInstance) return;
  const api = state.gridInstance.api || state.gridInstance;
  try { api.autoSizeAllColumns?.(); } catch(e) { try { api.sizeColumnsToFit?.(); } catch(e2){} }
}

function agGridResetFilters() {
  if (!state.gridInstance) return;
  const api = state.gridInstance.api || state.gridInstance;
  try { api.setFilterModel?.(null); api.onFilterChanged?.(); } catch(e) {}
  toast("Filters cleared.", "info");
}

function agGridExport() {
  if (!state.gridInstance) { exportCleanedCSV(); return; }
  const api = state.gridInstance.api || state.gridInstance;
  try { api.exportDataAsCsv?.({ fileName:"datalens_export.csv" }); toast("CSV exported!","success"); } catch(e) { exportCleanedCSV(); }
}

/* ── Export ─────────────────────────────────────────────────── */
function quickFixDropDuplicates() {
  _applyFixesNow({ drop_duplicates: true }, "Duplicate rows dropped!");
}

function quickFixFillNulls(method) {
  _applyFixesNow({ fill_nulls: method }, `Null values filled with ${method}!`);
}

function _setQuickFixButtonsDisabled(disabled) {
  ["btn-drop-dupes", "btn-fill-mean", "btn-fill-median"].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = disabled;
  });
}

function _applySampleFixes(fixes, successMsg) {
  const ds = state.datasets[state.activeFileId];
  if (!ds || !state.edaData) return false;

  ds.undoStack.push(structuredClone(state.edaData));
  const data = structuredClone(state.edaData);

  if (fixes.drop_duplicates) {
    const dupes = Number(data.duplicate_rows || 0);
    data.duplicate_rows = 0;
    if (data.shape?.rows) data.shape.rows = Math.max(0, data.shape.rows - dupes);
  }

  if (fixes.fill_nulls) {
    (data.columns || []).forEach(col => {
      col.null_count = 0;
      col.null_pct = 0;
    });
  }

  const hasNulls = (data.columns || []).some(c => Number(c.null_count || 0) > 0);
  const hasDupes = Number(data.duplicate_rows || 0) > 0;
  if (!hasNulls && !hasDupes) data.health_score = 100;

  ds.edaData = data;
  ds.cleanedData = structuredClone(data);
  state.edaData = data;
  state.cleanedData = structuredClone(data);
  renderDashboard(data, ds.fname);
  document.getElementById("btn-undo").style.display = ds.undoStack.length > 0 ? "inline-flex" : "none";
  toast(successMsg, "success");
  return true;
}

function _applyFixesNow(fixes, successMsg) {
  if (!state.fileId) {
    toast("Please upload or load data first.", "warning");
    return;
  }

  if (state.fileId && state.fileId.startsWith("sample")) {
    _applySampleFixes(fixes, successMsg);
    return;
  }

  // 6d: Deep copy current state to undo stack before applying new fixes
  const ds = state.datasets[state.activeFileId];
  if (ds) ds.undoStack.push(structuredClone(state.edaData));

  _setQuickFixButtonsDisabled(true);
  toast("Applying fixes...", "info");
  fetch(`${API_BASE}/api/apply_fixes`, {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ file_id: state.fileId, fixes })
  })
  .then(async r => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Server error: ${r.status}`);
    return data;
  })
  .then(data => {
    if(data.error) { if(ds) ds.undoStack.pop(); toast(data.error, "error"); return; }
    state.edaData = data;
    if(ds) {
        ds.edaData = data;
        ds.cleanedData = structuredClone(data);
    }
    
    state.appliedFixes = { drop_duplicates: false, fill_nulls: null, drop_rows: [], outlier_strategy: null };
    toast(successMsg, "success");
    renderDashboard(data, ds ? ds.fname : document.getElementById("db-fname").textContent);
  })
  .catch(e => {
    if(ds) ds.undoStack.pop();
    toast(`Failed to apply fixes: ${e.message}`, "error");
  })
  .finally(() => _setQuickFixButtonsDisabled(false));
}

/* 6e: Interactive Relationship Graph */
function renderDependencyGraph(meta) {
  const container = document.getElementById("graph-section");
  if (!meta || !meta.fact_table || !meta.dimension_tables?.length) {
    if (container) container.style.display = "none";
    return;
  }
  container.style.display = "block";
  
  const chart = _initEChart("graph-echart", state.charts.graph);
  state.charts.graph = chart;
  if (!chart) return;

  const t = _echartTheme();
  const dims = meta.dimension_tables || [];
  const cx = 360;
  const cy = 200;
  const radius = Math.max(130, Math.min(190, 80 + dims.length * 22));
  const nodes = [{
    name: meta.fact_table,
    value: "Fact table",
    x: cx,
    y: cy,
    symbolSize: 88,
    itemStyle: { color: '#1d4ed8' },
    label: { show: true, fontWeight: 600, fontSize: 14, color: t.textFull }
  }];
  const links = [];

  dims.forEach((dim, i) => {
    const angle = (-Math.PI / 2) + (2 * Math.PI * i / Math.max(dims.length, 1));
    const joinKeys = (dim.join_keys || []).join(", ");
    nodes.push({
      name: dim.name,
      value: `${(dim.columns || []).length} columns`,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      symbolSize: 64,
      itemStyle: { color: '#059669' },
      label: { show: true, fontWeight: 500, fontSize: 12, color: t.textFull }
    });
    links.push({
      source: meta.fact_table,
      target: dim.name,
      value: joinKeys ? `join: ${joinKeys}` : "join",
      lineStyle: { color: t.border, width: 2, curveness: 0.12 }
    });
  });

  chart.setOption({
    backgroundColor: "transparent",
    tooltip: {
      trigger: 'item',
      formatter: p => {
        if (p.dataType === "edge") return escHtml(p.data.value || "");
        return `<b>${escHtml(p.name)}</b><br/>${escHtml(p.data.value || "")}`;
      }
    },
    series: [{
      type: 'graph',
      layout: 'none',
      data: nodes,
      links: links,
      roam: true,
      draggable: true,
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: 8,
      edgeLabel: {
        show: true,
        formatter: p => p.data.value || "",
        color: t.text,
        fontSize: 11,
        fontFamily: t.fontFamily
      },
      lineStyle: { color: t.border, width: 2, curveness: 0.1 },
      emphasis: { focus: 'adjacency', lineStyle: { width: 4, color: '#1d4ed8' } }
    }]
  });
}

function openMlPrep() {
  document.getElementById("ml-modal")?.classList.add("open");
  const grid = document.getElementById("ml-drop-grid");
  if (grid && state.edaData) {
    grid.innerHTML = state.edaData.columns.map(c => `
      <label style="display:flex;align-items:center;gap:6px;font-size:0.75rem;cursor:pointer;padding:4px">
        <input type="checkbox" class="ml-drop-cb" value="${escHtml(c.name)}"/> ${escHtml(c.name)}
      </label>
    `).join("");
  }
}

function closeMlPrep() {
  document.getElementById("ml-modal")?.classList.remove("open");
}

function applyAndExportMlPrep() {
  state.appliedFixes.fill_nulls = document.getElementById("ml-fill-mean")?.checked ? "mean" : null;
  state.appliedFixes.encode_categorical = document.getElementById("ml-encode-cat")?.checked;
  state.appliedFixes.scale_numeric = document.getElementById("ml-scale-num")?.checked;
  const dropCols = [];
  document.querySelectorAll(".ml-drop-cb:checked").forEach(cb => dropCols.push(cb.value));
  state.appliedFixes.drop_columns = dropCols;
  closeMlPrep();
  exportCleanedCSV();
}

function exportCleanedCSV() {
  if(!state.fileId){toast("No data loaded.","error");return;}
  toast("Generating export…","info");
  fetch(`${API_BASE}/export`,{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({file_id:state.fileId,fixes:state.appliedFixes}),
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
   SMART VISUALIZATION BUILDER (Power BI Style — ECharts)
══════════════════════════════════════════════════════════════ */
function setupVisBuilder(data) { /* populated lazily on openVisBuilder */ }

function openVisBuilder() {
  if(!state.edaData) return;
  document.body.style.overflow="hidden";
  let pbi=document.getElementById("pbi-modal");

  if(!pbi){
    pbi=document.createElement("div");
    pbi.id="pbi-modal";
    pbi.style.cssText="position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:9999;display:flex;justify-content:center;align-items:center;backdrop-filter:blur(4px)";
    pbi.innerHTML=`
      <div class="pbi-inner">
        <div class="pbi-head">
          <div>
            <h2 style="margin:0;font-family:var(--serif);font-size:1.15rem;color:var(--ink-full)">Visualization Builder</h2>
            <p style="margin:2px 0 0;font-size:0.73rem;color:var(--muted);font-family:var(--mono)">Smart chart recommendations · ECharts engine · Cross-filter ready</p>
          </div>
          <button onclick="closeVisBuilder()" class="btn-ghost" style="font-size:1.4rem">&times;</button>
        </div>
        <div class="pbi-body">

          <!-- Left: Fields -->
          <div class="pbi-fields-pane">
            <div style="font-family:var(--mono);font-size:0.65rem;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-bottom:10px">Data Fields</div>
            <div id="pbi-table-info" style="display:none;background:var(--accent-l);border:1px solid var(--accent);border-radius:8px;padding:10px;margin-bottom:10px;font-size:0.75rem;color:var(--accent-d)">
              <strong>Table:</strong> <span id="pbi-table-info-content"></span>
            </div>
            <div id="pbi-fields"></div>
          </div>

          <!-- Centre: Canvas -->
          <div class="pbi-canvas-pane">
            <div id="pbi-smart-hint" class="pbi-smart-hint" style="display:none"></div>
            <div id="pbi-empty" class="pbi-empty-state">
              <span style="font-size:2.2rem">📊</span>
              <span>Select fields and click <strong>Generate Visual</strong></span>
            </div>
            <div id="pbi-echart-wrap" style="display:none;flex:1;min-height:360px;width:100%"></div>
            <div class="pbi-footer">
              <label style="font-size:0.78rem;cursor:pointer;color:var(--ink2);display:flex;align-items:center;gap:6px">
                <input type="checkbox" id="pbi-show-labels"/> Show Labels
              </label>
              <div style="display:flex;gap:8px">
                <button id="pbi-export-btn" class="btn btn-sm" style="display:none" onclick="exportPBIVisual()">⬇ PNG</button>
                <button id="pbi-generate-btn" class="btn btn-accent btn-sm" onclick="renderPBIChart()">▶ Generate Visual</button>
              </div>
            </div>
          </div>

          <!-- Right: Config -->
          <div class="pbi-config-pane">
            <div style="font-family:var(--mono);font-size:0.65rem;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-bottom:10px">Visualizations</div>
            <div id="pbi-chart-icons-grid" class="pbi-icons-grid"></div>

            <div style="font-family:var(--mono);font-size:0.65rem;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin:16px 0 10px;border-top:1px solid var(--border);padding-top:14px">Build Visual</div>

            <div class="pbi-control-group">
              <label>X-axis / Category</label>
              <select class="pbi-select" data-zone="x"></select>
            </div>
            <div class="pbi-control-group">
              <label>Y-axis / Values</label>
              <select class="pbi-select" data-zone="y"></select>
            </div>
            <div class="pbi-control-group">
              <label>Legend / Breakdown</label>
              <select class="pbi-select" data-zone="group"></select>
            </div>
            <div class="pbi-control-group">
              <label>Aggregation</label>
              <select id="pbi-agg-func">
                <option value="none">None (Raw)</option>
                <option value="sum" selected>Sum</option>
                <option value="mean">Average</option>
                <option value="count">Count</option>
                <option value="min">Min</option>
                <option value="max">Max</option>
              </select>
            </div>

            <!-- Smart Suggestions -->
            <div style="font-family:var(--mono);font-size:0.65rem;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin:14px 0 8px;border-top:1px solid var(--border);padding-top:12px">Smart Suggestions</div>
            <div id="pbi-suggestions"></div>
          </div>
        </div>
      </div>`;

    // Inject PBI styles
    const s = document.createElement("style");
    s.textContent = `
      .pbi-inner{background:var(--surface);width:96vw;max-width:1400px;height:88vh;border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 32px 100px rgba(0,0,0,0.35)}
      .pbi-head{padding:16px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:var(--surface);flex-shrink:0}
      .pbi-body{display:grid;grid-template-columns:360px 1fr 240px;flex:1;overflow:hidden}
      .pbi-fields-pane{border-right:1px solid var(--border);padding:14px;overflow-y:auto;background:var(--bg)}
      .pbi-canvas-pane{display:flex;flex-direction:column;padding:16px;overflow:hidden;background:var(--bg)}
      .pbi-config-pane{border-left:1px solid var(--border);padding:14px;overflow-y:auto;background:var(--surface)}
      .pbi-footer{display:flex;align-items:center;justify-content:space-between;padding-top:12px;border-top:1px solid var(--border);margin-top:10px;flex-shrink:0}
      .pbi-field{padding:7px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:0.8rem;cursor:grab;user-select:none;color:var(--ink-full);transition:all 0.15s;margin-bottom:6px;display:flex;align-items:center;gap:6px}
      .pbi-field:hover{border-color:var(--accent);background:var(--accent-l)}
      .pbi-field-type{font-family:var(--mono);font-size:0.65rem;font-weight:700;color:var(--accent)}
      .pbi-icons-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:6px}
      .pbi-icon-btn{background:transparent;border:1px solid var(--border);border-radius:6px;padding:7px 4px;cursor:pointer;color:var(--ink-full);transition:all 0.15s;font-size:1.1rem;display:flex;flex-direction:column;align-items:center;gap:2px}
      .pbi-icon-name{font-size:0.55rem;color:var(--muted);text-align:center}
      .pbi-icon-btn:hover{background:var(--accent-l);border-color:var(--accent)}
      .pbi-icon-btn.active{background:var(--ink-full);color:var(--bg);border-color:var(--ink-full)}
      .pbi-icon-btn.active .pbi-icon-name{color:var(--bg);opacity:0.7}
      .pbi-control-group{margin-bottom:12px}
      .pbi-control-group label{display:block;font-family:var(--mono);font-size:0.65rem;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--muted);margin-bottom:5px}
      .pbi-select{width:100%;padding:7px 10px;border:1px solid var(--border2);border-radius:6px;font-size:0.8rem;background:var(--bg);color:var(--ink-full);cursor:pointer;outline:none;transition:border-color 0.15s}
      .pbi-select:focus{border-color:var(--accent)}
      .pbi-empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--muted);border:2px dashed var(--border);border-radius:12px;text-align:center;padding:20px;gap:10px;font-size:0.85rem}
      .pbi-smart-hint{background:var(--accent-l);border:1px solid var(--accent);border-radius:8px;padding:10px 14px;font-size:0.78rem;color:var(--accent-d);margin-bottom:10px;line-height:1.5;flex-shrink:0}
      .pbi-suggest-btn{width:100%;text-align:left;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:0.75rem;cursor:pointer;color:var(--ink-full);margin-bottom:6px;transition:all 0.15s;display:flex;align-items:center;gap:8px}
      .pbi-suggest-btn:hover{border-color:var(--accent);background:var(--accent-l)}
    `;
    document.head.appendChild(s);
    document.body.appendChild(pbi);

  } else {
    pbi.style.display = "flex";
  }

  // Populate chart type grid
  const chartTypes=[
    {id:"bar",icon:"📊",name:"Column"},{id:"horizontal-bar",icon:"⎯",name:"Bar"},
    {id:"line",icon:"📈",name:"Line"},{id:"area",icon:"◢",name:"Area"},
    {id:"pie",icon:"🥧",name:"Pie"},{id:"doughnut",icon:"🍩",name:"Donut"},
    {id:"scatter",icon:"⚄",name:"Scatter"},{id:"forecast",icon:"🔮",name:"Forecast"},
    {id:"timeline",icon:"📅",name:"Timeline"},{id:"pareto",icon:"📉",name:"Pareto"},
    {id:"heatmap",icon:"🔥",name:"Heatmap"},{id:"histogram",icon:"📶",name:"Hist"},
  ];
  document.getElementById("pbi-chart-icons-grid").innerHTML=chartTypes.map(c=>
    `<div><button class="pbi-icon-btn ${state.activePBIChartType===c.id?"active":""}" data-type="${c.id}" title="${c.name}">${c.icon}</button><div class="pbi-icon-name">${c.name}</div></div>`
  ).join("");

  // Populate fields panel
  const fieldsEl=document.getElementById("pbi-fields");
  fieldsEl.innerHTML="";
  const frag=document.createDocumentFragment();
  state.edaData.columns.forEach(col => {
    const f=document.createElement("div");
    f.className="pbi-field"; f.draggable=true; f.dataset.col=col.name;
    f.innerHTML=`<span class="pbi-field-type">${col.type==="numeric"?"N":"C"}</span>${escHtml(col.name)}`;
    f.addEventListener("dragstart",e=>e.dataTransfer.setData("text/plain",col.name));
    frag.appendChild(f);
  });
  fieldsEl.appendChild(frag);

  // Table info
  if(state.tableMetadata?.fact_table){
    document.getElementById("pbi-table-info").style.display="block";
    let html=`<strong>${escHtml(state.tableMetadata.fact_table)}</strong>`;
    (state.tableMetadata.dimension_tables||[]).forEach(d=>{html+=` + ${escHtml(d.name)}`;});
    document.getElementById("pbi-table-info-content").innerHTML=html;
  }

  // Populate selects
  const opts="<option value=''>None / Auto</option>"+
    state.edaData.columns.map(c=>`<option value="${escHtml(c.name)}">${c.type==="numeric"?"(N)":"(C)"} ${escHtml(c.name)}</option>`).join("");
  document.querySelectorAll(".pbi-select").forEach(s=>{s.innerHTML=opts;});

  const xSel=document.querySelector(".pbi-select[data-zone='x']");
  const ySel=document.querySelector(".pbi-select[data-zone='y']");
  if(!xSel.value){const cat=state.edaData.columns.find(c=>c.type==="categorical");if(cat)xSel.value=cat.name;}
  if(!ySel.value){const num=state.edaData.columns.find(c=>c.type==="numeric");if(num)ySel.value=num.name;}

  // Smart suggestions
  _buildSmartSuggestions();

  // Wire events
  document.querySelectorAll(".pbi-icon-btn").forEach(btn => {
    btn.onclick=()=>{
      state.activePBIChartType=btn.dataset.type;
      document.querySelectorAll(".pbi-icon-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      _updateSmartHint();
    };
  });

  document.querySelectorAll(".pbi-select").forEach(s => { s.onchange = _updateSmartHint; });
  document.getElementById("pbi-generate-btn").onclick = renderPBIChart;
  document.getElementById("pbi-show-labels").onchange = e => { state.pbiShowLabels=e.target.checked; };

  // Close on backdrop
  pbi.onclick = function(e) { if (e.target === this) closeVisBuilder(); };

  _updateSmartHint();
}

function closeVisBuilder() {
  const pbi=document.getElementById("pbi-modal");
  if(pbi) pbi.style.display="none";
  document.body.style.overflow="";
}

/* ── Smart chart suggestion engine ─────────────────────────── */
function _getChartSuggestion(xCol, yCol) {
  if (!state.edaData || !xCol) return null;
  const xMeta = state.edaData.columns.find(c=>c.name===xCol);
  const yMeta = yCol ? state.edaData.columns.find(c=>c.name===yCol) : null;
  const xType = xMeta?.type;
  const yType = yMeta?.type;
  const xCard = xMeta?.unique_count || 0;
  const hasDate = xType === "datetime";

  if (hasDate && yType === "numeric") return { type:"line", reason:"Date × Numeric → Line chart shows trends over time" };
  if (xType === "categorical" && yType === "numeric" && xCard <= 10) return { type:"bar", reason:"Category × Numeric → Bar chart compares values across groups" };
  if (xType === "categorical" && yType === "numeric" && xCard > 10) return { type:"horizontal-bar", reason:"Many categories → Horizontal bar chart is more readable" };
  if (xType === "numeric" && yType === "numeric") return { type:"scatter", reason:"Two numerics → Scatter plot reveals correlation" };
  if (xType === "categorical" && !yCol) return { type:"pie", reason:"Single categorical → Pie chart shows proportions" };
  if (xType === "numeric" && !yCol) return { type:"histogram", reason:"Single numeric → Histogram shows distribution" };
  return null;
}

function _updateSmartHint() {
  const xCol = document.querySelector(".pbi-select[data-zone='x']")?.value;
  const yCol = document.querySelector(".pbi-select[data-zone='y']")?.value;
  const hint = document.getElementById("pbi-smart-hint");
  if (!hint) return;
  const sug = _getChartSuggestion(xCol, yCol);
  if (sug) {
    hint.style.display = "block";
    hint.innerHTML = `💡 <strong>Suggested:</strong> ${escHtml(sug.reason)}
      <button onclick="state.activePBIChartType='${sug.type}';document.querySelectorAll('.pbi-icon-btn').forEach(b=>b.classList.toggle('active',b.dataset.type==='${sug.type}'));renderPBIChart()"
        style="margin-left:10px;padding:3px 10px;background:var(--accent);color:var(--bg);border:none;border-radius:4px;font-size:0.73rem;cursor:pointer">
        Use ${sug.type.charAt(0).toUpperCase()+sug.type.slice(1)} Chart
      </button>`;
  } else {
    hint.style.display = "none";
  }
}

function _buildSmartSuggestions() {
  const el = document.getElementById("pbi-suggestions");
  if (!el || !state.edaData) return;
  const suggestions = [];
  const dt  = state.edaData.columns.find(c=>c.type==="datetime");
  const num = state.edaData.columns.find(c=>c.type==="numeric");
  const cat = state.edaData.columns.find(c=>c.type==="categorical");
  const topCorr = state.edaData.correlations?.[0];

  if (dt && num) suggestions.push({icon:"📈",label:`Trend: ${num.name} over ${dt.name}`,x:dt.name,y:num.name,type:"line"});
  if (cat && num) suggestions.push({icon:"📊",label:`${num.name} by ${cat.name}`,x:cat.name,y:num.name,type:"bar"});
  if (topCorr) suggestions.push({icon:"⚄",label:`Scatter: ${topCorr.col_a} vs ${topCorr.col_b}`,x:topCorr.col_a,y:topCorr.col_b,type:"scatter"});
  if (cat) suggestions.push({icon:"🥧",label:`Distribution of ${cat.name}`,x:cat.name,y:"",type:"pie"});

  el.innerHTML = suggestions.map(s=>`
    <button class="pbi-suggest-btn" onclick="
      document.querySelector('.pbi-select[data-zone=\\'x\\']').value='${escHtml(s.x)}';
      document.querySelector('.pbi-select[data-zone=\\'y\\']').value='${escHtml(s.y)}';
      state.activePBIChartType='${s.type}';
      document.querySelectorAll('.pbi-icon-btn').forEach(b=>b.classList.toggle('active',b.dataset.type==='${s.type}'));
      renderPBIChart()">
      <span>${s.icon}</span><span>${escHtml(s.label)}</span>
    </button>`).join("");
}

/* ── PBI chart render (ECharts) ─────────────────────────────── */
function renderPBIChart() {
  const xCol    = document.querySelector(".pbi-select[data-zone='x']")?.value;
  const yCol    = document.querySelector(".pbi-select[data-zone='y']")?.value;
  const groupCol= document.querySelector(".pbi-select[data-zone='group']")?.value;
  const aggFunc = document.getElementById("pbi-agg-func")?.value || "sum";

  if(!xCol){
    _showPBIEmpty("Please select an X-axis field."); return;
  }

  document.getElementById("pbi-empty").style.display="none";
  document.getElementById("pbi-echart-wrap").style.display="none";
  document.getElementById("pbi-export-btn").style.display="none";

  if(state.fileId && state.fileId.startsWith("sample")){
    const rows = state.edaData.preview_rows || [];
    if (!rows.length) { _showPBIEmpty("No sample data available."); return; }
    
    let resultData = { x_col: xCol, y_col: yCol || "_count" };
    if (state.activePBIChartType === "scatter") {
      resultData.scatter_data = rows.map(r => [r[xCol], r[yCol]]).filter(v => v[0] != null && v[1] != null);
    } else if (groupCol) {
      const grouped = {};
      rows.forEach(r => {
        let k1 = String(r[xCol] ?? "");
        let k2 = String(r[groupCol] ?? "");
        if (!grouped[k1]) grouped[k1] = {};
        if (!grouped[k1][k2]) grouped[k1][k2] = [];
        grouped[k1][k2].push(yCol ? r[yCol] : 1);
      });
      resultData.x = Object.keys(grouped);
      resultData.series = {};
      const allGroups = new Set();
      resultData.x.forEach(k => Object.keys(grouped[k]).forEach(g => allGroups.add(g)));
      allGroups.forEach(g => {
        resultData.series[g] = resultData.x.map(k => {
          const vals = (grouped[k] && grouped[k][g]) || [];
          const validVals = vals.filter(v => v != null && !isNaN(v));
          if (!validVals.length) return 0;
          if (aggFunc === "mean") return validVals.reduce((a,b)=>a+b,0) / validVals.length;
          if (aggFunc === "count") return validVals.length;
          if (aggFunc === "min") return Math.min(...validVals);
          if (aggFunc === "max") return Math.max(...validVals);
          return validVals.reduce((a,b)=>a+b,0);
        });
      });
    } else {
      const grouped = {};
      rows.forEach(r => {
        let key = String(r[xCol] ?? "");
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(yCol ? r[yCol] : 1);
      });
      resultData.x = Object.keys(grouped);
      resultData.y = resultData.x.map(k => {
        const vals = grouped[k];
        const validVals = vals.filter(v => v != null && !isNaN(v));
        if (!validVals.length) return 0;
        if (aggFunc === "mean") return validVals.reduce((a,b)=>a+b,0) / validVals.length;
        if (aggFunc === "count") return validVals.length;
        if (aggFunc === "min") return Math.min(...validVals);
        if (aggFunc === "max") return Math.max(...validVals);
        return validVals.reduce((a,b)=>a+b,0);
      });
      if (["pie", "doughnut", "pareto"].includes(state.activePBIChartType)) {
        const combined = resultData.x.map((xVal, i) => ({x: xVal, y: resultData.y[i]}));
        combined.sort((a, b) => b.y - a.y);
        resultData.x = combined.map(c => c.x);
        resultData.y = combined.map(c => c.y);
      }
    }
    _drawPBIChart(resultData, xCol, yCol);
    return;
  }

  fetch(`${API_BASE}/api/chart_data`,{
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({file_id:state.fileId,x_col:xCol,y_col:yCol,group_col:groupCol,agg:aggFunc,type:state.activePBIChartType,filters:state.filterState}),
  })
  .then(r=>r.json())
  .then(data=>{ if(data.error){_showPBIEmpty(data.error);return;} _drawPBIChart(data,xCol,yCol); })
  .catch(()=>_showPBIEmpty("Failed to load chart data. Is the backend running?"));
}

function _drawPBIChart(data, xCol, yCol) {
  state.charts.pbi?.dispose(); state.charts.pbi=null;
  let type=state.activePBIChartType;

  // ECharts render
  const wrap=document.getElementById("pbi-echart-wrap");
  wrap.style.display="block";
  document.getElementById("pbi-export-btn").style.display="inline-flex";

  const t=_echartTheme();
  state.charts.pbi=echarts.init(wrap, null, {renderer:"canvas"});

  const xData = data.x || [];
  const yData = data.y || [];

  let isHBar=false;
  if(type==="horizontal-bar"){type="bar";isHBar=true;}

  // Build series
  let series=[];
  const isPieLike=["pie","doughnut"].includes(type);

  if(isPieLike){
    series=[{
      type:"pie",
      radius:type==="doughnut"?["40%","72%"]:"60%",
      data:xData.map((l,i)=>({name:l,value:yData[i],itemStyle:{color:ECHART_COLORS[i%ECHART_COLORS.length]}})), // Pie/Doughnut
      label:{ show:state.pbiShowLabels, formatter:"{b}: {d}%", fontSize:14, fontFamily:t.labelFamily, color:t.labelText, fontWeight:500, textShadowColor:t.labelGlow, textShadowBlur:4 },
      emphasis:{ label:{show:true,color:t.labelText,fontSize:17,fontFamily:t.labelFamily,fontWeight:500,textShadowColor:t.labelGlow,textShadowBlur:5} },
    }];
  } else if (type === "scatter" && data.scatter_data) { // Scatter
    series=[{
      name: `${data.x_col} vs ${data.y_col}`,
      type:"scatter", 
      data:data.scatter_data, 
      symbolSize:8, 
      itemStyle:{color:ECHART_COLORS[0], opacity:0.7}
    }];
  } else if(data.series){
    let ci=0;
    for(const[key,vals] of Object.entries(data.series)){
      const col=ECHART_COLORS[ci%ECHART_COLORS.length];
      const st=type==="area"?"line":type==="forecast"?"line":type; // Grouped Bar/Line/Area
      series.push({ name:key, type:st, data:vals, smooth:true,
        areaStyle:type==="area"||type==="forecast"?{opacity:0.2}:undefined,
        itemStyle:{color:col}, lineStyle:{color:col,width:2},
        label:{show:state.pbiShowLabels,position:"top",fontSize:13,fontFamily:t.labelFamily,fontWeight:500,color:t.labelText,textShadowColor:t.labelGlow,textShadowBlur:3},
      });
      ci++;
    }
  } else if(type==="pareto"){
    const total=yData.reduce((a,b)=>a+b,0); let run=0; // Pareto
    const cumPct=yData.map(v=>{run+=v;return+(run/total*100).toFixed(1);});
    series=[
      { type:"bar", data:yData, itemStyle:{color:ECHART_COLORS[0]}, label:{show:state.pbiShowLabels,position:"top",fontSize:13,fontFamily:t.labelFamily,fontWeight:500,color:t.labelText,textShadowColor:t.labelGlow,textShadowBlur:3} },
      { type:"line", data:cumPct, yAxisIndex:1, smooth:false,
        itemStyle:{color:"#ef4444"}, lineStyle:{color:"#ef4444",width:2},
        symbol:"circle", symbolSize:5,
      },
    ];
  } else {
    const st=type==="area"?"line":type==="forecast"?"line":type==="timeline"?"line":type; // Single Bar/Line/Area
    series=[{ type:st, data:yData, smooth:true,
      areaStyle:type==="area"||type==="forecast"?{opacity:0.2}:undefined,
      itemStyle:{ color: isPieLike ? xData.map((_,i)=>ECHART_COLORS[i%ECHART_COLORS.length]) : ECHART_COLORS[0] },
      lineStyle:{ width:2 },
      label:{ show:state.pbiShowLabels, position:"top", fontSize:13, fontFamily:t.labelFamily, fontWeight:500, color:t.labelText, textShadowColor:t.labelGlow, textShadowBlur:3 },
      barMaxWidth:60,
    }];
  }

  const baseOpts={
    backgroundColor:"transparent",
    color:ECHART_COLORS,
    tooltip:{ trigger:isPieLike?"item":"axis", axisPointer:{type:"shadow"}, textStyle: {fontFamily: t.fontFamily} },
    legend:{ show:!!data.series||isPieLike, right:"2%", textStyle:{color:t.text,fontSize:12,fontFamily:t.fontFamily} },
    animation:true, animationDuration:600,
    series,
  };

  if(!isPieLike && type!=="scatter" && type!=="pareto"){
    if(isHBar){
      baseOpts.xAxis={type:"value",axisLabel:{color:t.text,fontSize:12,fontFamily:t.fontFamily},splitLine:{lineStyle:{color:t.gridLine}}}; // Increased fontSize to 12
      baseOpts.yAxis={type:"category",data:xData,axisLabel:{color:t.text,fontSize:12,width:90,overflow:"truncate",interval:0,hideOverlap:true,fontFamily:t.fontFamily},axisLine:{lineStyle:{color:t.border}}}; // Increased fontSize to 12
    } else {
      baseOpts.xAxis={type:"category",data:xData,axisLabel:{color:t.text,fontSize:12,rotate:0,interval:0,overflow:"truncate",width:90,hideOverlap:true,fontFamily:t.fontFamily},axisLine:{lineStyle:{color:t.border}},splitLine:{show:false}}; // Increased fontSize to 12
      baseOpts.yAxis={type:"value",axisLabel:{color:t.text,fontSize:12,fontFamily:t.fontFamily},splitLine:{lineStyle:{color:t.gridLine}}}; // Increased fontSize to 12
    }
    baseOpts.grid={left:"3%",right:"4%",bottom:"15%",top:"10%",containLabel:true};
  } else if (type === "scatter") {
    baseOpts.xAxis={type:"value", name:data.x_col, nameLocation:"middle", nameGap:25, axisLabel:{color:t.text,fontSize:12,fontFamily:t.fontFamily}, splitLine:{show:false}, axisLine:{lineStyle:{color:t.border}}}; // Increased fontSize to 12
    baseOpts.yAxis={type:"value", name:data.y_col, nameLocation:"middle", nameGap:35, axisLabel:{color:t.text,fontSize:12,fontFamily:t.fontFamily}, splitLine:{lineStyle:{color:t.gridLine}}, axisLine:{lineStyle:{color:t.border}}}; // Increased fontSize to 12
    baseOpts.grid={left:"5%",right:"5%",bottom:"12%",top:"10%",containLabel:true};
    baseOpts.tooltip={trigger:"item", textStyle:{fontFamily:t.fontFamily}, formatter: p => `<b>${data.x_col}:</b> ${p.value[0]}<br/><b>${data.y_col}:</b> ${p.value[1]}`};
  } else if(type==="pareto"){
    baseOpts.xAxis={type:"category",data:xData,axisLabel:{color:t.text,fontSize:12,rotate:30,fontFamily:t.fontFamily},axisLine:{lineStyle:{color:t.border}}}; // Increased fontSize to 12
    baseOpts.yAxis=[
      {type:"value",axisLabel:{color:t.text,fontSize:12,fontFamily:t.fontFamily},splitLine:{lineStyle:{color:t.gridLine}}}, // Increased fontSize to 12
      {type:"value",min:0,max:100,axisLabel:{color:t.text,fontSize:12,formatter:"{value}%",fontFamily:t.fontFamily},splitLine:{show:false}}, // Increased fontSize to 12
    ];
    baseOpts.grid={left:"3%",right:"5%",bottom:"12%",top:"10%",containLabel:true};
  }

  state.charts.pbi.setOption(baseOpts);

  // Cross-filter: clicking a bar updates filterState
  state.charts.pbi.on("click", params => {
    if (params.componentType !== "series") return;
    const xCol2 = document.querySelector(".pbi-select[data-zone='x']")?.value;
    if (!xCol2) return;
    const val = params.name || params.value?.[0];
    if (!val) return;
    if (!state.filterState[xCol2]) state.filterState[xCol2] = [];
    const idx = state.filterState[xCol2].indexOf(val);
    if (idx > -1) { state.filterState[xCol2].splice(idx,1); if(!state.filterState[xCol2].length) delete state.filterState[xCol2]; }
    else          { state.filterState[xCol2].push(val); }
    _showFilterBadge();
  });
}

function _showFilterBadge() {
  const count = Object.values(state.filterState).reduce((s,v)=>s+v.length,0);
  if (count === 0) { toast("Filter cleared","info",1500); return; }
  toast(`Cross-filter active: ${count} value(s) selected. Re-generate to apply.`, "info", 3000);
}

function exportPBIVisual() {
  if(!state.charts.pbi) return;
  const url=state.charts.pbi.getDataURL({type:"png",backgroundColor:_echartTheme().bg,pixelRatio:2});
  const a=document.createElement("a");
  a.download=`datalens_visual_${state.activePBIChartType}.png`; a.href=url; a.click();
  toast("Visual exported as PNG!","success");
}

function _showPBIEmpty(msg) {
  const e=document.getElementById("pbi-empty");
  const w=document.getElementById("pbi-echart-wrap");
  if(w) w.style.display="none";
  if(e){ e.style.display="flex"; e.innerHTML=`<span style="font-size:1.8rem">⚠️</span><span>${escHtml(msg)}</span>`; }
}

function openReport() {
  if(!state.edaData) return;
  document.getElementById("report-modal").classList.add("open");
  document.body.style.overflow="hidden";
  generateReport();
}
function closeReport() { document.getElementById("report-modal").classList.remove("open"); document.body.style.overflow=""; }

function generateReport() {
  const data=state.edaData, fname=document.getElementById("db-fname").textContent;
  document.getElementById("report-subtitle").textContent=fname;
  const numCols  =data.columns.filter(c=>c.type==="numeric");
  const catCols  =data.columns.filter(c=>c.type==="categorical");
  const nullCols =data.columns.filter(c=>c.null_count>0);
  const totalNulls=data.columns.reduce((s,c)=>s+c.null_count,0);
  const totalOut =numCols.reduce((s,c)=>s+(c.stats?.outlier_count||0),0);
  const topCorr  =data.correlations?[...data.correlations].sort((a,b)=>Math.abs(b.r)-Math.abs(a.r))[0]:null;

  // Capture images from ECharts instances
  const getImg = (chart) => {
    if (!chart) return "";
    try {
      return `<div class="report-chart-container"><img src="${chart.getDataURL({type: 'png', pixelRatio: 2, backgroundColor: '#fff'})}" style="max-width:100%; border:1px solid #eee; border-radius:8px; margin: 10px 0;"/></div>`;
    } catch(e) { return ""; }
  };

  const corrImg = getImg(state.charts.corr);
  const boxImg  = getImg(state.charts.boxplot);
  const colImg  = getImg(state.charts.col);
  const pbiImg  = getImg(state.charts.pbi);

  const insightsHtml = (data.insights||[]).map(i=>
    `<li><strong>${escHtml(i.category)}:</strong> ${escHtml(i.title)} — ${escHtml(i.body)}</li>`
  ).join("");

  document.getElementById("report-content").innerHTML=`
    <h3>📋 Summary</h3>
    <p>Dataset <strong>${escHtml(fname)}</strong> contains <strong>${data.shape.rows.toLocaleString()} rows</strong> and <strong>${data.shape.cols} columns</strong> 
    (${numCols.length} numeric, ${catCols.length} categorical).
    ${data.duplicate_rows>0?`<strong style="color:var(--amber)">${data.duplicate_rows} duplicate rows</strong> detected.`:"No duplicate rows found."}</p>
    <div class="report-kv">
      ${[["Rows",data.shape.rows.toLocaleString()],["Columns",data.shape.cols],["Duplicates",data.duplicate_rows],["Total Nulls",totalNulls.toLocaleString()],["Cols w/ Nulls",nullCols.length],["Outliers",totalOut]].map(([l,v])=>
        `<div class="report-kv-item"><div class="report-kv-val">${v}</div><div class="report-kv-lbl">${l}</div></div>`).join("")}
    </div>
    
    ${insightsHtml?`<h3>🤖 AI Insights</h3><ul style="padding-left:16px;line-height:2">${insightsHtml}</ul>`:""}
    
    <h3>🔢 Numeric Columns</h3>
    ${colImg ? `<h4>Distribution: ${escHtml(state.activeCol || "")}</h4>${colImg}` : ""}
    ${numCols.length===0?"<p>None found.</p>":numCols.map(c=>`<p><strong>${escHtml(c.name)}</strong> — Mean: ${c.stats?.mean}, Median: ${c.stats?.median}, Std: ${c.stats?.std}, Outliers: ${c.stats?.outlier_count}, Null%: ${c.null_pct}%</p>`).join("")}
    
    <h3>📝 Categorical Columns</h3>
    ${catCols.length===0?"<p>None found.</p>":catCols.map(c=>{const top=c.bar_chart?`Top: <strong>${escHtml(c.bar_chart.labels[0])}</strong> (${c.bar_chart.counts[0].toLocaleString()})`:"";return`<p><strong>${escHtml(c.name)}</strong> — ${c.unique_count} unique. ${top} Null%: ${c.null_pct}%</p>`;}).join("")}
    
    ${topCorr || corrImg ? `<h3>📊 Correlations & Heatmap</h3>` : ""}
    ${corrImg ? corrImg : ""}
    ${topCorr?`<p><strong>${escHtml(topCorr.col_a)}</strong> × <strong>${escHtml(topCorr.col_b)}</strong> r = <strong>${Number(topCorr.r).toFixed(3)}</strong> (${Math.abs(topCorr.r)>=0.7?"strong":Math.abs(topCorr.r)>=0.4?"moderate":"weak"} ${topCorr.r>0?"positive":"negative"}).</p>`:""}
    
    ${boxImg ? `<h3>📦 Outlier Analysis</h3><h4>Box Plot: ${escHtml(state.activeBoxplotCol)}</h4>${boxImg}` : ""}
    
    ${pbiImg ? `<h3>🎨 Custom Visualization</h3>${pbiImg}` : ""}

    <h3>⚠️ Data Quality Notes</h3>
    ${nullCols.length===0?"<p style='color:var(--green)'>✅ No missing values detected.</p>":
      `<p>${nullCols.map(c=>`<strong>${escHtml(c.name)}</strong> (${c.null_pct}% missing)`).join(", ")} have missing values.</p>`}
    ${data.duplicate_rows>0?`<p><strong>${data.duplicate_rows} duplicate rows</strong> found. Deduplicate before analysis.</p>`:""}
    ${totalOut>0?`<p><strong>${totalOut} outliers</strong> via IQR. Review before modeling.</p>`:""}
    <p style="margin-top:20px;font-size:0.75rem;color:var(--muted);border-top:1px solid var(--border);padding-top:12px">Generated by Data Lens by Shreyans · ${new Date().toLocaleDateString("en-IN",{year:"numeric",month:"long",day:"numeric"})}</p>`;
}

function downloadReport() {
  const fname=document.getElementById("db-fname").textContent.replace(/[^a-z0-9]/gi,"_");
  const content=document.getElementById("report-content").innerHTML;
      const html=`<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>EDA Report — ${escHtml(fname)}</title>\n  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet"/>
  <style>
    body{font-family:"Inter",sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#181612;font-weight:300;background-color:#fff;}
    h1{font-family:"DM Serif Display",serif;font-size:2.4rem;margin-bottom:5px;}
    h2{font-family:"DM Serif Display",serif;font-size:1.4rem;color:#8a857c;margin-top:0;margin-bottom:30px;}
    h3{font-family:"DM Serif Display",serif;font-size:1.6rem;margin:40px 0 15px;border-bottom:2px solid #eee;padding-bottom:10px;}
    h4{font-family:"DM Sans",sans-serif;font-size:1.1rem;margin:20px 0 10px;color:#555;}
    p{line-height:1.8;color:#44403a}
    .report-kv{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin:24px 0}
    .report-kv-item{background:#f9f8f6;border:1px solid #e2ddd6;border-radius:12px;padding:16px;text-align:center;}
    .report-kv-val{font-family:"DM Serif Display",serif;font-size:1.6rem;font-weight:400;color:#1d4ed8;}
    .report-kv-lbl{font-size:0.7rem;color:#8a857c;text-transform:uppercase;letter-spacing:1.5px;margin-top:4px;}
    .report-chart-container{margin:25px 0;text-align:center;}
    img{max-width:100%;height:auto;border-radius:8px;box-shadow:0 4px 15px rgba(0,0,0,0.08);}
    ul{padding-left:20px;}
    li{margin-bottom:8px;}
  </style>
  </head><body><h1>EDA Report</h1><h2>${escHtml(fname)}</h2>${content}</body></html>`;
  const a=document.createElement("a");
  a.href=URL.createObjectURL(new Blob([html],{type:"text/html"}));
  a.download=`EDA_Report_${fname}.html`; a.click(); URL.revokeObjectURL(a.href);
  toast("Report downloaded!","success");
}

document.getElementById("report-modal").addEventListener("click",function(e){if(e.target===this)closeReport();});

window.addEventListener("resize", debounce(() => {
  Object.values(state.charts).forEach(c => {
    try {
      if (c && c.getDom().offsetParent !== null) c.resize();
    } catch (e) {}
  });
  if(state.gridInstance){ try{ const api=state.gridInstance.api||state.gridInstance; api.sizeColumnsToFit?.(); }catch(e){} }
}, 150));

document.addEventListener("DOMContentLoaded", () => { show("upload-screen"); });
