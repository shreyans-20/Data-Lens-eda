"""
app.py  — Data Lens by Shreyans (Flask backend)
Upgraded: AI insight engine endpoint, pivot table API, cross-filter support on chart_data.
Preserves all original EDA logic, session store, vectorised operations.
"""
from __future__ import annotations
import gc
import io
import logging
import time
import tempfile
import uuid
import pickle
from collections import OrderedDict
from threading import Lock

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request, send_file
import os

try:
    from flask_cors import CORS
except ImportError:
    CORS = None

from eda_engine import run_eda
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

base_dir = os.path.abspath(os.path.dirname(__file__))
app = Flask(__name__, template_folder=base_dir, static_folder=base_dir, static_url_path="")

secret = os.environ.get("SECRET_KEY")
app.config["SECRET_KEY"] = secret or "dev-key-placeholder"

VERCEL_PAYLOAD_LIMIT_BYTES = 4_500_000
DEFAULT_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = (
    VERCEL_PAYLOAD_LIMIT_BYTES
    if os.environ.get("VERCEL_ENV")
    else DEFAULT_UPLOAD_LIMIT_BYTES
)

ALLOWED_ORIGINS = [
    "https://data-lens-eda.vercel.app",
    "https://shreyans-20.github.io",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
ALLOWED_ORIGINS.extend(
    origin.strip()
    for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
)

if CORS:
    CORS(app, origins=ALLOWED_ORIGINS)
else:
    @app.after_request
    def _cors(response):
        origin = request.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
        return response

# --- Session Storage: local tempfile only (no Redis on Vercel serverless) ---
SESSION_EXPIRY_SECONDS = 3600
ALLOWED_EXT = {".csv", ".xlsx", ".xls", ".json"}
_STORE_DIR = os.path.join(tempfile.gettempdir(), "datalens_store")
if not os.path.exists(_STORE_DIR):
    os.makedirs(_STORE_DIR, exist_ok=True)
_store: OrderedDict[str, str] = OrderedDict()
_store_lock = Lock()
_STORE_MAX  = 5

# --- Rate Limiting: in-memory only (no Redis) ---
limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["200 per day", "50 per hour"],
    storage_uri="memory://"
)

_progress_store: dict[str, str] = {}

app_handler = app  # Vercel export


# ── Utilities ──────────────────────────────────────────────

def _allowed(filename: str) -> bool:
    return os.path.splitext(filename)[1].lower() in ALLOWED_EXT


def _store_df(df: pd.DataFrame, existing_fid: str = None) -> str:
    """Stores a DataFrame as a tempfile, returning its ID."""
    fid = existing_fid if existing_fid else str(uuid.uuid4())

    with _store_lock:
        # Clean up expired tempfiles
        now = time.time()
        for f_name in list(os.listdir(_STORE_DIR)):
            fpath_full = os.path.join(_STORE_DIR, f_name)
            if os.path.isfile(fpath_full) and (now - os.path.getmtime(fpath_full)) > SESSION_EXPIRY_SECONDS:
                try:
                    os.remove(fpath_full)
                    for k, v in list(_store.items()):
                        if v == fpath_full:
                            _store.pop(k)
                except OSError as e:
                    log.warning(f"Failed to remove old tempfile {fpath_full}: {e}")

        # Ensure _store doesn't exceed max size
        while len(_store) >= _STORE_MAX:
            _, old_path = _store.popitem(last=False)
            if os.path.exists(old_path):
                try:
                    os.remove(old_path)
                except OSError as e:
                    log.warning(f"Failed to remove oldest tempfile {old_path}: {e}")

        fpath = os.path.join(_STORE_DIR, f"{fid}.pkl")
        df.to_pickle(fpath)
        _store[fid] = fpath
    log.debug(f"Stored DataFrame {fid} in tempfile.")
    return fid


def _get_df(fid: str) -> pd.DataFrame | None:
    """Retrieves a DataFrame from tempfile storage."""
    fpath = None
    with _store_lock:
        fpath = _store.get(fid)

    if fpath and os.path.exists(fpath):
        try:
            return pd.read_pickle(fpath)
        except Exception as e:
            log.error(f"Failed to load stored data from tempfile {fpath}: {e}")
    log.debug(f"DataFrame {fid} not found in tempfile.")
    return None


def _set_progress(pid: str, message: str):
    _progress_store[pid] = message

def _get_progress(pid: str) -> str:
    return _progress_store.get(pid, "Initializing...")

def _clear_progress(pid: str):
    _progress_store.pop(pid, None)


def _convert(obj):
    if isinstance(obj, dict):   return {k: _convert(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)): return [_convert(i) for i in obj]
    if isinstance(obj, np.ndarray): return obj.tolist()
    if isinstance(obj, np.integer): return int(obj)
    if isinstance(obj, np.floating):
        v = float(obj)
        return None if (np.isnan(v) or np.isinf(v)) else v
    if isinstance(obj, (pd.Timestamp, np.datetime64)): return str(obj)
    if isinstance(obj, float) and (np.isnan(obj) or np.isinf(obj)): return None
    try:
        if pd.isna(obj): return None
    except Exception:
        pass
    return obj


def _auto_join(sheets: dict[str, pd.DataFrame]):
    if len(sheets) == 1:
        name, df = next(iter(sheets.items()))
        return df, {"fact_table": name, "dimension_tables": [], "column_origins": {c: name for c in df.columns}}

    main_name = max(sheets, key=lambda k: len(sheets[k]))
    main_df   = sheets[main_name].copy()
    origins   = {c: main_name for c in main_df.columns}
    dims      = []

    def _key_score(col: str) -> tuple[int, int]:
        cleaned = col.lower().replace(" ", "").replace("_", "")
        key_like = cleaned == "id" or cleaned.endswith("id") or cleaned.endswith("key")
        return (1 if key_like else 0, -len(cleaned))

    for name, dim in sheets.items():
        if name == main_name: continue
        common = [c for c in main_df.columns if c in dim.columns]
        unique_keys = [
            c for c in common
            if dim[c].notna().any() and not dim.duplicated(subset=[c]).any()
        ]
        join_keys = [max(unique_keys, key=_key_score)] if unique_keys else []
        if not join_keys and common and not dim.duplicated(subset=common).any():
            join_keys = common

        if join_keys:
            suffix = f"_{name}"
            for c in dim.columns:
                if c in join_keys:
                    continue
                origins[c if c not in main_df.columns else f"{c}{suffix}"] = name
            dims.append({"name": name, "join_keys": join_keys, "columns": list(dim.columns)})
            main_df = main_df.merge(dim, on=join_keys, how="left", suffixes=("", suffix))

    return main_df, {"fact_table": main_name, "dimension_tables": dims, "column_origins": origins}


def _read_file(file) -> tuple[pd.DataFrame, dict]:
    fname = getattr(file, "filename", "")
    ext   = os.path.splitext(fname)[1].lower()
    if ext == ".csv":
        try:
            return pd.read_csv(file, low_memory=False, engine='c'), {}
        except UnicodeDecodeError:
            file.seek(0)
            return pd.read_csv(file, low_memory=False, encoding="latin1", engine='c'), {}
    if ext in (".xlsx", ".xls"):
        engine = "openpyxl" if ext == ".xlsx" else None
        return _auto_join(pd.read_excel(file, sheet_name=None, engine=engine))
    if ext == ".json":
        data = pd.read_json(file)
        if isinstance(data, pd.Series): data = data.to_frame()
        return data, {}
    raise ValueError(f"Unsupported extension: {ext}")


# ── AI Insight Engine ───────────────────────────────────────

def _generate_insights(df: pd.DataFrame, eda: dict) -> list[dict]:
    insights = []
    cols    = eda.get("columns", [])
    corrs   = eda.get("correlations", [])
    shape   = eda.get("shape", {})
    dups    = eda.get("duplicate_rows", 0)
    health  = eda.get("health_score", 100)
    total_r = max(shape.get("rows", 1), 1)

    num_cols = [c for c in cols if c["type"] == "numeric"]
    cat_cols = [c for c in cols if c["type"] == "categorical"]
    dt_cols  = [c for c in cols if c["type"] == "datetime"]

    # Data quality
    total_nulls = sum(c.get("null_count", 0) for c in cols)
    if total_nulls > 0:
        null_pct = round(total_nulls / (total_r * max(len(cols), 1)) * 100, 1)
        sev = "critical" if null_pct > 20 else "warning" if null_pct > 5 else "info"
        insights.append({
            "id": "null_overview", "type": sev, "category": "Data Quality",
            "title": f"{null_pct}% data is missing",
            "body": f"{total_nulls:,} missing values across {sum(1 for c in cols if c.get('null_count',0)>0)} columns. Consider imputation before analysis.",
            "action": "View Health", "action_target": "quality",
        })

    if dups > 0:
        dup_pct = round(dups / total_r * 100, 1)
        insights.append({
            "id": "duplicates", "type": "warning", "category": "Data Quality",
            "title": f"{dups:,} duplicate rows detected ({dup_pct}%)",
            "body": "Duplicates skew aggregations and model training. Remove them before analysis.",
            "action": "Drop Duplicates", "action_target": "fix_duplicates",
        })

    if health < 70:
        insights.append({
            "id": "health_low", "type": "critical", "category": "Data Quality",
            "title": f"Data health score is low ({health}%)",
            "body": "Significant quality issues detected. Address nulls, outliers, and duplicates first.",
            "action": "Open ML Prep", "action_target": "mlprep",
        })

    # Correlations
    strong_corrs = [c for c in corrs if abs(c.get("r", 0)) >= 0.7]
    mod_corrs    = [c for c in corrs if 0.4 <= abs(c.get("r", 0)) < 0.7]

    for c in strong_corrs[:3]:
        r = c["r"]
        sign = "positively" if r > 0 else "negatively"
        insights.append({
            "id": f"corr_strong_{c['col_a']}_{c['col_b']}", "type": "success", "category": "Correlation",
            "title": f"Strong link: {c['col_a']} ↔ {c['col_b']}",
            "body": f"Strongly {sign} correlated (r = {r:.3f}). Changes in one reliably predict changes in the other.",
            "action": "View Scatter", "action_target": f"scatter:{c['col_a']}:{c['col_b']}",
        })

    if mod_corrs:
        names = ", ".join(f"{c['col_a']}↔{c['col_b']}" for c in mod_corrs[:2])
        insights.append({
            "id": "corr_moderate", "type": "info", "category": "Correlation",
            "title": f"{len(mod_corrs)} moderate correlation(s) found",
            "body": f"Moderate relationships: {names}. Useful as model features.",
            "action": "View Pairs", "action_target": "correlations",
        })

    # Distributions
    for col in num_cols:
        s   = col.get("stats") or {}
        skew = s.get("skew")
        out  = s.get("outlier_count", 0)

        if skew is not None and abs(skew) > 1.5:
            direction = "right (positive)" if skew > 0 else "left (negative)"
            insights.append({
                "id": f"skew_{col['name']}", "type": "info", "category": "Distribution",
                "title": f"{col['name']} is heavily {direction.split()[0]}-skewed",
                "body": f"Skewness {skew:.2f} — consider log transform for modeling.",
                "action": "View Distribution", "action_target": f"col:{col['name']}",
            })

        if out > 0:
            out_pct = round(out / total_r * 100, 1)
            if out_pct > 5:
                insights.append({
                    "id": f"outliers_{col['name']}", "type": "warning" if out_pct > 15 else "info", "category": "Outliers",
                    "title": f"{col['name']}: {out_pct}% outlier rows",
                    "body": f"{out:,} values outside the IQR fence. May be errors or genuine extremes.",
                    "action": "View Outliers", "action_target": f"outliers:{col['name']}",
                })

    # Cardinality
    for col in cat_cols:
        if col.get("unique_count", 0) > 50:
            insights.append({
                "id": f"high_card_{col['name']}", "type": "info", "category": "Cardinality",
                "title": f"{col['name']} has high cardinality ({col['unique_count']} values)",
                "body": "Consider grouping rare categories into 'Other' before encoding.",
                "action": None, "action_target": None,
            })

    # Chart & KPI suggestions
    if dt_cols and num_cols:
        insights.append({
            "id": "suggest_timeseries", "type": "success", "category": "Chart Suggestion",
            "title": "Time-series analysis possible",
            "body": f"Date column '{dt_cols[0]['name']}' detected. Build a line chart to reveal trends over time.",
            "action": "Build Line Chart", "action_target": "visbuilder",
        })

    if cat_cols and num_cols:
        insights.append({
            "id": "suggest_bar", "type": "info", "category": "Chart Suggestion",
            "title": f"Compare {num_cols[0]['name']} by {cat_cols[0]['name']}",
            "body": f"A bar chart will surface performance differences across {cat_cols[0]['name']} categories.",
            "action": "Build Bar Chart", "action_target": "visbuilder",
        })

    if num_cols:
        s = (num_cols[0].get("stats") or {})
        mean = s.get("mean")
        if mean is not None:
            insights.append({
                "id": "kpi_suggestion", "type": "success", "category": "Business Intelligence",
                "title": f"Suggested KPI: Avg {num_cols[0]['name']}",
                "body": f"Average {num_cols[0]['name']} is {mean:,.2f}." +
                        (f" Std deviation: {s.get('std',0):,.2f}." if s.get("std") is not None else ""),
                "action": "Build Chart", "action_target": "visbuilder",
            })

    return insights[:12]


# ── Routes ─────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health_check():
    return jsonify({"status": "ok"})


@app.route("/api/progress/<fid>")
def get_progress(fid):
    return jsonify({"progress": _get_progress(fid)})


@app.route("/upload", methods=["POST"])
@limiter.limit("5 per minute")
def upload():
    pid = None
    try:
        if "file" not in request.files:
            return jsonify({"success": False, "error": "No file uploaded"}), 400
        file = request.files["file"]
        pid  = request.form.get("progress_id")

        if not file.filename:
            return jsonify({"success": False, "error": "Empty filename"}), 400
        if not _allowed(file.filename):
            return jsonify({"success": False, "error": "Only CSV / XLSX / XLS / JSON supported"}), 400

        if pid: _set_progress(pid, "Reading file from disk...")
        df, meta = _read_file(file)

        if df.empty:
            return jsonify({"success": False, "error": "File is empty"}), 400

        def update_p(m):
            if pid: _set_progress(pid, m)

        result   = run_eda(df, progress_callback=update_p)
        fid      = _store_df(df)

        origin_map = meta.get("column_origins", {})
        for col in result.get("columns", []):
            if col["name"] not in df.columns: continue
            col["table_origin"] = origin_map.get(col["name"], "Main Dataset")

        insights = _generate_insights(df, result)
        if pid: _clear_progress(pid)

        insights = _convert(insights)
        result   = _convert(result)
        gc.collect()

        return jsonify({
            "success": True, "file_id": fid,
            "table_metadata": meta, "insights": insights,
            "shape": {"rows": int(len(df)), "cols": int(len(df.columns))},
            **result,
        })

    except Exception:
        log.error("Upload error", exc_info=True)
        if pid: _clear_progress(pid)
        return jsonify({"success": False, "error": "Server error during processing."}), 500


@app.route("/api/insights", methods=["POST"])
def get_insights():
    try:
        body = request.get_json(silent=True) or {}
        df   = _get_df(body.get("file_id"))
        if df is None:
            return jsonify({"error": "Session expired — please re-upload"}), 400
        result   = run_eda(df)
        insights = _generate_insights(df, result)
        insights = _convert(insights)
        return jsonify({"insights": insights})
    except Exception:
        log.error("insights error", exc_info=True)
        return jsonify({"error": "Failed to generate insights"}), 500


@app.route("/api/apply_fixes", methods=["POST"])
@app.route("/api/clean", methods=["POST"])
def apply_fixes_api():
    try:
        body = request.get_json(silent=True) or {}
        fid = body.get("file_id")
        fixes = body.get("fixes", {})

        df = _get_df(fid)
        if df is None:
            return jsonify({"error": "Session expired — please re-upload"}), 400

        df = _apply_fixes(df.copy(), fixes)
        _store_df(df, existing_fid=fid)

        result = run_eda(df)
        insights = _generate_insights(df, result)
        return jsonify({
            "success": True, "file_id": fid,
            "insights": _convert(insights),
            "shape": {"rows": int(len(df)), "cols": int(len(df.columns))},
            **_convert(result)
        })
    except Exception:
        log.error("apply_fixes error", exc_info=True)
        return jsonify({"error": "Failed to apply fixes"}), 500


@app.route("/api/pivot", methods=["POST"])
def pivot_table():
    try:
        body     = request.get_json(silent=True) or {}
        fid      = body.get("file_id")
        rows_g   = body.get("rows", [])
        cols_g   = body.get("cols", [])
        values   = body.get("values", [])
        agg_func = body.get("agg", "sum")

        df = _get_df(fid)
        if df is None:
            return jsonify({"error": "Session expired — please re-upload"}), 400
        if not rows_g or not values:
            return jsonify({"error": "rows and values are required"}), 400

        missing = [c for c in rows_g + cols_g + values if c not in df.columns]
        if missing:
            return jsonify({"error": f"Columns not found: {', '.join(missing)}"}), 400

        val_col  = values[0]
        if not pd.api.types.is_numeric_dtype(df[val_col]): agg_func = "count"
        safe_agg = {"sum":"sum","mean":"mean","count":"count","min":"min","max":"max"}.get(agg_func,"sum")

        if cols_g:
            piv = pd.pivot_table(df, values=val_col, index=rows_g, columns=cols_g, aggfunc=safe_agg, fill_value=0)
            if isinstance(piv.columns, pd.MultiIndex):
                piv.columns = [" / ".join(str(s) for s in c).strip() for c in piv.columns]
            piv = piv.reset_index()
        else:
            piv = df.groupby(rows_g, dropna=False)[val_col].agg(safe_agg).reset_index()
            piv = piv.rename(columns={val_col: f"{safe_agg}({val_col})"})

        piv  = piv.head(200)
        data = _convert(piv.where(pd.notnull(piv), None).to_dict(orient="records"))
        return jsonify({"columns": list(piv.columns), "rows": data, "count": len(data)})

    except Exception:
        log.error("pivot error", exc_info=True)
        return jsonify({"error": "Failed to generate pivot table."}), 500


def _apply_fixes(df: pd.DataFrame, fixes: dict) -> pd.DataFrame:
    drop_rows = fixes.get("drop_rows", [])
    if drop_rows:
        df = df.drop(index=[int(i) for i in drop_rows if int(i) in df.index], errors='ignore')

    out_strat = fixes.get("outlier_strategy")
    if out_strat in ("cap", "drop"):
        for c in df.select_dtypes(include=np.number).columns:
            q1, q3 = df[c].quantile(0.25), df[c].quantile(0.75)
            iqr    = q3 - q1
            low, high = q1 - 1.5 * iqr, q3 + 1.5 * iqr
            if out_strat == "cap":    df[c] = df[c].clip(lower=low, upper=high)
            elif out_strat == "drop": df = df[(df[c] >= low) & (df[c] <= high)]

    if str(fixes.get("drop_duplicates", "")).lower() in ("true", "1", "yes", "t"):
        df = df.drop_duplicates()

    fill_method = fixes.get("fill_nulls")
    if isinstance(fill_method, str):
        fill_method = fill_method.lower()
        if fill_method in ("mean", "median"):
            fill_vals = {}
            for c in df.columns:
                if df[c].isnull().any():
                    series_num = pd.to_numeric(df[c], errors='coerce')
                    if series_num.notna().any():
                        val = series_num.mean() if fill_method == "mean" else series_num.median()
                        if pd.notna(val) and np.isfinite(val):
                            fill_vals[c] = val
                            df[c] = series_num

            if fill_vals:
                df = df.fillna(value=fill_vals)

    drop_cols = [c for c in fixes.get("drop_columns", []) if c in df.columns]
    if drop_cols: df = df.drop(columns=drop_cols)

    if str(fixes.get("encode_categorical", "")).lower() in ("true", "1", "yes", "t"):
        cats = df.select_dtypes(include=["object", "category"]).columns
        if len(cats) > 0:
            df = pd.get_dummies(df, columns=cats, drop_first=True, dtype=int)

    if str(fixes.get("scale_numeric", "")).lower() in ("true", "1", "yes", "t"):
        for c in df.select_dtypes(include=np.number).columns:
            if df[c].nunique() > 2:
                std = df[c].std()
                if pd.notna(std) and std != 0:
                    df[c] = (df[c] - df[c].mean()) / std
    return df


@app.route("/export", methods=["POST"])
def export_data():
    try:
        body = request.get_json(silent=True)
        if not body:
            body = request.form.to_dict()
            if 'fixes' in body and isinstance(body['fixes'], str):
                import json
                try: body['fixes'] = json.loads(body['fixes'])
                except Exception: body['fixes'] = {}
            if not body and request.data:
                import json
                try: body = json.loads(request.data)
                except Exception: pass
        body = body or {}
        fid   = body.get("file_id")
        fixes = body.get("fixes", {})

        df    = _get_df(fid)
        if df is None:
            return jsonify({"success": False, "error": "Session expired — please re-upload"}), 400
        df  = _apply_fixes(df.copy(), fixes)
        buf = io.BytesIO()
        buf.write("\ufeff".encode("utf-8"))
        buf.write(df.to_csv(index=False).encode("utf-8"))
        buf.seek(0)
        return send_file(buf, mimetype="text/csv", as_attachment=True, download_name="cleaned_data.csv")
    except Exception:
        log.error("Export failed. Session may have expired.")
        return jsonify({"success": False, "error": "Export failed. Session may have expired."}), 500


@app.route("/api/table_data", methods=["POST", "GET"])
@app.route("/api/data", methods=["POST", "GET"])
def get_table_data():
    try:
        body = request.get_json(silent=True)
        if not body:
            body = request.form.to_dict()
            if not body and request.data:
                import json
                try: body = json.loads(request.data)
                except Exception: pass
        body = body or {}

        fid = body.get("file_id") or request.args.get("file_id")
        df = _get_df(fid)
        if df is None:
            return jsonify({"error": "Session expired."}), 400

        data = _convert(df.head(1000).where(pd.notnull(df), None).to_dict(orient="records"))
        return jsonify({"columns": list(df.columns), "rows": data})
    except Exception:
        log.error("table_data error", exc_info=True)
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/chart_data", methods=["POST"])
def chart_data():
    try:
        body       = request.get_json(silent=True) or {}
        fid        = body.get("file_id")
        x_col      = body.get("x_col")
        y_col      = body.get("y_col")
        group_col  = body.get("group_col")
        agg_func   = body.get("agg", "sum")
        chart_type = body.get("type")
        filters    = body.get("filters", {})

        df = _get_df(fid)
        if df is None:
            return jsonify({"error": "Session expired — please re-upload."}), 400
        if not x_col or x_col not in df.columns:
            return jsonify({"error": "Invalid X column."}), 400

        for fcol, fvals in filters.items():
            if fcol in df.columns and fvals and isinstance(fvals, list):
                df = df[df[fcol].astype(str).isin([str(v) for v in fvals])]

        if not y_col:
            y_col = "_count"; df = df.copy(); df["_count"] = 1; agg_func = "count"

        if chart_type == "histogram" and pd.api.types.is_numeric_dtype(df[x_col]):
            counts, edges = np.histogram(df[x_col].dropna(), bins=15)
            return jsonify(_convert({"x": [f"{round(edges[i],1)}-{round(edges[i+1],1)}" for i in range(len(counts))], "y": counts.tolist()}))

        if y_col not in df.columns and y_col != "_count":
            return jsonify({"error": "Invalid Y column."}), 400

        if chart_type in ("pie","doughnut","pareto") and agg_func == "none":
            agg_func = "sum" if pd.api.types.is_numeric_dtype(df[y_col]) else "count"

        if chart_type == "scatter":
            sub = df[[x_col, y_col]].dropna().head(500)
            return jsonify(_convert({"scatter_data": sub.values.tolist(), "x_col": x_col, "y_col": y_col}))

        if agg_func == "none":
            sub = df[[x_col, y_col]].dropna().head(500)
            return jsonify(_convert({"x": sub[x_col].astype(str).tolist(), "y": sub[y_col].tolist()}))

        if not pd.api.types.is_numeric_dtype(df[y_col]) and agg_func != "count":
            agg_func = "count"

        if group_col and group_col in df.columns:
            grp = df.groupby([x_col, group_col], dropna=False)[y_col].agg(agg_func).reset_index()
            piv = grp.pivot(index=x_col, columns=group_col, values=y_col).fillna(0).head(100)
            return jsonify(_convert({"x": [str(v) for v in piv.index], "series": {str(c): piv[c].tolist() for c in piv.columns}}))

        grp = df.groupby(x_col, dropna=False)[y_col].agg(agg_func).reset_index()

        if chart_type in ("pie","doughnut"):
            grp = grp.sort_values(by=y_col, ascending=False)
            if len(grp) > 10:
                top  = grp.head(10).copy()
                rest = pd.DataFrame({x_col:["Others"], y_col:[grp.iloc[10:][y_col].sum()]})
                grp  = pd.concat([top, rest], ignore_index=True)
            return jsonify(_convert({"x": grp[x_col].astype(str).tolist(), "y": grp[y_col].tolist()}))

        if chart_type == "pareto":
            grp = grp.sort_values(by=y_col, ascending=False).head(20)
            return jsonify(_convert({"x": grp[x_col].astype(str).tolist(), "y": grp[y_col].tolist()}))

        grp = grp.head(100)
        return jsonify(_convert({"x": grp[x_col].astype(str).tolist(), "y": grp[y_col].tolist()}))

    except Exception:
        log.error("chart_data error", exc_info=True)
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/multi_line", methods=["POST"])
def multi_line():
    try:
        body = request.get_json(silent=True) or {}
        fid, x_col, y1, y2 = body.get("file_id"), body.get("x_col"), body.get("y1_col"), body.get("y2_col")
        df = _get_df(fid)
        if df is None: return jsonify({"error": "Session expired."}), 400
        for c in (x_col, y1, y2):
            if c not in df.columns: return jsonify({"error": f"Column not found: {c}"}), 400
        grp = df.groupby(x_col)[[y1, y2]].mean().reset_index().dropna().sort_values(by=x_col).head(100)
        return jsonify(_convert({"x": grp[x_col].astype(str).tolist(), "y1": grp[y1].tolist(), "y2": grp[y2].tolist()}))
    except Exception:
        log.error("multi_line error", exc_info=True)
        return jsonify({"error": "Failed to process chart data."}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
