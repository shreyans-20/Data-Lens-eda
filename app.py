"""
app.py  — DataLens EDA Studio (Flask backend)
Optimised: vectorised type conversion, bounded in-memory store, streaming responses.
"""
from __future__ import annotations
import gc
import io
import logging
import os
import traceback
import uuid
from collections import OrderedDict
from threading import Lock

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request, send_file

try:
    from flask_cors import CORS
except ImportError:
    CORS = None

from eda_engine import run_eda

# ── Logging ────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger(__name__)

# ── App setup ──────────────────────────────────────────────
base_dir = os.path.abspath(os.path.dirname(__file__))
app = Flask(
    __name__,
    template_folder=base_dir,
    static_folder=base_dir,
    static_url_path="",
)
app.config["SECRET_KEY"]         = os.environ.get("SECRET_KEY", "dev-key-placeholder")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024   # 50 MB

if CORS:
    CORS(app)
else:
    @app.after_request
    def _cors(response):
        response.headers["Access-Control-Allow-Origin"]  = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
        return response

ALLOWED_EXT = {".csv", ".xlsx", ".xls"}

# ── In-memory store (LRU, max 5 sessions) ──────────────────
_store: OrderedDict[str, pd.DataFrame] = OrderedDict()
_store_lock = Lock()
_STORE_MAX = 5

# Export for Vercel
app_handler = app


# ── Utilities ──────────────────────────────────────────────

def _allowed(filename: str) -> bool:
    return os.path.splitext(filename)[1].lower() in ALLOWED_EXT


def _store_df(df: pd.DataFrame) -> str:
    fid = str(uuid.uuid4())
    with _store_lock:
        if len(_store) >= _STORE_MAX:
            _store.popitem(last=False)   # evict oldest
        _store[fid] = df.copy()
    return fid


def _get_df(fid: str) -> pd.DataFrame | None:
    with _store_lock:
        return _store.get(fid)


def _convert(obj):
    """Recursively convert NumPy/Pandas scalars to JSON-safe Python types."""
    if isinstance(obj, dict):
        return {k: _convert(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_convert(i) for i in obj]
    if isinstance(obj, np.ndarray):
        return obj.tolist()           # fast batch conversion
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        v = float(obj)
        return None if (np.isnan(v) or np.isinf(v)) else v
    if isinstance(obj, (pd.Timestamp, np.datetime64)):
        return str(obj)
    if isinstance(obj, float) and (np.isnan(obj) or np.isinf(obj)):
        return None
    try:
        if pd.isna(obj):
            return None
    except Exception:
        pass
    return obj


def _auto_join(sheets: dict[str, pd.DataFrame]):
    """Join dimension tables onto the largest (fact) table. Returns (df, metadata)."""
    if len(sheets) == 1:
        name, df = next(iter(sheets.items()))
        return df, {
            "fact_table": name,
            "dimension_tables": [],
            "column_origins": {c: name for c in df.columns},
        }

    main_name = max(sheets, key=lambda k: len(sheets[k]))
    main_df   = sheets[main_name].copy()
    origins   = {c: main_name for c in main_df.columns}
    dims      = []

    for name, dim in sheets.items():
        if name == main_name:
            continue
        common = list(set(main_df.columns) & set(dim.columns))
        if common and not dim.duplicated(subset=common).any():
            for c in set(dim.columns) - set(main_df.columns):
                origins[c] = name
            dims.append({"name": name, "join_keys": common, "columns": list(dim.columns)})
            main_df = main_df.merge(dim, on=common, how="left", suffixes=("", f"_{name}"))

    return main_df, {
        "fact_table": main_name,
        "dimension_tables": dims,
        "column_origins": origins,
    }


def _read_file(file) -> tuple[pd.DataFrame, dict]:
    fname = getattr(file, "filename", "")
    ext   = os.path.splitext(fname)[1].lower()
    if ext == ".csv":
        # Use C engine and explicit dtypes where possible for speed
        return pd.read_csv(file, low_memory=False), {}
    if ext in (".xlsx", ".xls"):
        engine = "openpyxl" if ext == ".xlsx" else None
        sheets = pd.read_excel(file, sheet_name=None, engine=engine)
        return _auto_join(sheets)
    raise ValueError(f"Unsupported extension: {ext}")


# ── Routes ─────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/upload", methods=["POST"])
def upload():
    try:
        if "file" not in request.files:
            return jsonify({"success": False, "error": "No file uploaded"}), 400
        file = request.files["file"]
        if not file.filename:
            return jsonify({"success": False, "error": "Empty filename"}), 400
        if not _allowed(file.filename):
            return jsonify({"success": False, "error": "Only CSV / XLSX / XLS supported"}), 400

        df, meta = _read_file(file)
        if df.empty:
            return jsonify({"success": False, "error": "File is empty"}), 400

        result = run_eda(df)
        fid    = _store_df(df)
        gc.collect()

        # Enrich column profiles with table origin
        origin_map = meta.get("column_origins", {})
        for col in result.get("columns", []):
            col["table_origin"] = origin_map.get(col["name"], "Main Dataset")

        result = _convert(result)

        return jsonify({
            "success":        True,
            "file_id":        fid,
            "table_metadata": meta,
            "shape": {
                "rows": int(len(df)),
                "cols": int(len(df.columns)),
            },
            **result,
        })

    except Exception:
        log.error("Upload error", exc_info=True)
        return jsonify({"success": False, "error": "Server error during processing."}), 500


@app.route("/export", methods=["POST"])
def export_data():
    try:
        body    = request.get_json(silent=True) or {}
        fid     = body.get("file_id")
        fixes   = body.get("fixes", {})

        df = _get_df(fid)
        if df is None:
            return jsonify({"success": False, "error": "Session expired — please re-upload"}), 400

        df = df.copy()

        if fixes.get("drop_duplicates"):
            df = df.drop_duplicates()

        fill = fixes.get("fill_nulls")
        if fill in ("mean", "median"):
            num_cols = df.select_dtypes(include=np.number).columns
            for c in num_cols:
                fv = df[c].mean() if fill == "mean" else df[c].median()
                df[c] = df[c].fillna(fv)

        drop_cols = [c for c in fixes.get("drop_columns", []) if c in df.columns]
        if drop_cols:
            df = df.drop(columns=drop_cols)

        if fixes.get("encode_categorical"):
            cats = df.select_dtypes(include=["object", "category"]).columns
            df = pd.get_dummies(df, columns=cats, drop_first=True, dtype=int)

        if fixes.get("scale_numeric"):
            for c in df.select_dtypes(include=np.number).columns:
                if df[c].nunique() > 2:
                    std = df[c].std()
                    if pd.notna(std) and std != 0:
                        df[c] = (df[c] - df[c].mean()) / std

        buf = io.BytesIO()
        buf.write("\ufeff".encode("utf-8"))              # BOM for Excel
        buf.write(df.to_csv(index=False).encode("utf-8"))
        buf.seek(0)
        return send_file(buf, mimetype="text/csv", as_attachment=True,
                         download_name="cleaned_data.csv")

    except Exception:
        log.error("Export error", exc_info=True)
        return jsonify({"success": False, "error": traceback.format_exc()}), 500


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

        df = _get_df(fid)
        if df is None:
            return jsonify({"error": "Session expired — please re-upload."}), 400
        if not x_col or x_col not in df.columns:
            return jsonify({"error": "Invalid X column."}), 400

        # If Y column is missing, default to a count aggregation
        if not y_col:
            y_col = "_count"
            df = df.copy()
            df["_count"] = 1
            agg_func = "count"

        # Histogram
        if chart_type == "histogram" and pd.api.types.is_numeric_dtype(df[x_col]):
            counts, edges = np.histogram(df[x_col].dropna(), bins=15)
            return jsonify({
                "x": [f"{round(edges[i],1)}-{round(edges[i+1],1)}" for i in range(len(counts))],
                "y": counts.tolist(),
            })

        if y_col not in df.columns and y_col != "_count":
            return jsonify({"error": "Invalid Y column."}), 400

        # Force aggregation for Pie/Doughnut/Pareto even if 'none' was selected in UI
        if chart_type in ("pie", "doughnut", "pareto") and agg_func == "none":
            agg_func = "sum" if pd.api.types.is_numeric_dtype(df[y_col]) else "count"

        # Raw points
        if agg_func == "none":
            sub = df[[x_col, y_col]].dropna().head(500)
            return jsonify({"x": sub[x_col].astype(str).tolist(), "y": sub[y_col].tolist()})

        if not pd.api.types.is_numeric_dtype(df[y_col]) and agg_func != "count":
            agg_func = "count"

        if group_col and group_col in df.columns:
            grp = df.groupby([x_col, group_col], dropna=False)[y_col].agg(agg_func).reset_index()
            piv = grp.pivot(index=x_col, columns=group_col, values=y_col).fillna(0).head(100)
            return jsonify({
                "x":      [str(v) for v in piv.index],
                "series": {str(c): piv[c].tolist() for c in piv.columns},
            })

        # Single series aggregation
        grp = df.groupby(x_col, dropna=False)[y_col].agg(agg_func).reset_index()

        # Specific logic for Pie/Doughnut: Sort descending, limit to Top 10 + "Others"
        if chart_type in ("pie", "doughnut"):
            grp = grp.sort_values(by=y_col, ascending=False)
            if len(grp) > 10:
                top = grp.head(10).copy()
                others_val = grp.iloc[10:][y_col].sum()
                others_row = pd.DataFrame({x_col: ["Others"], y_col: [others_val]})
                grp = pd.concat([top, others_row], axis=0, ignore_index=True)
            return jsonify({
                "x": grp[x_col].astype(str).tolist(), 
                "y": grp[y_col].tolist()
            })

        # Pareto logic: Sort and take top 20
        if chart_type == "pareto":
            grp = grp.sort_values(by=y_col, ascending=False).head(20)
            return jsonify({"x": grp[x_col].astype(str).tolist(), "y": grp[y_col].tolist()})

        grp = grp.head(100)
        return jsonify({"x": grp[x_col].astype(str).tolist(), "y": grp[y_col].tolist()})

    except Exception:
        log.error("chart_data error", exc_info=True)
        return jsonify({"error": "Internal server error"}), 500


@app.route("/api/multi_line", methods=["POST"])
def multi_line():
    try:
        body  = request.get_json(silent=True) or {}
        fid   = body.get("file_id")
        x_col = body.get("x_col")
        y1    = body.get("y1_col")
        y2    = body.get("y2_col")

        df = _get_df(fid)
        if df is None:
            return jsonify({"error": "Session expired."}), 400
        for c in (x_col, y1, y2):
            if c not in df.columns:
                return jsonify({"error": f"Column not found: {c}"}), 400

        grp = df.groupby(x_col)[[y1, y2]].mean().reset_index().dropna()
        grp = grp.sort_values(by=x_col).head(100)
        return jsonify({
            "x":  grp[x_col].astype(str).tolist(),
            "y1": grp[y1].tolist(),
            "y2": grp[y2].tolist(),
        })
    except Exception:
        log.error("multi_line error", exc_info=True)
        return jsonify({"error": "Failed to process chart data."}), 500


# ── Dev server ────────────────────────────────────────────

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
