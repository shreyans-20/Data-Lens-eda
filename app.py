from flask import Flask, request, jsonify, render_template, send_file
try:
    from flask_cors import CORS
except ImportError:
    CORS = None
import traceback
import os
import io
import uuid
import gc

app = Flask(__name__)
if CORS:
    CORS(app)
else:
    @app.after_request
    def add_cors_headers(response):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
        return response

# Optional: limit upload size (uncomment if needed)
# app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50 MB

ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xls"}

# Global store to hold DataFrames temporarily for export processing
data_store = {}


# -------------------------------
# Utility Functions
# -------------------------------

def allowed_file(filename):
    """Check if file extension is allowed."""
    return os.path.splitext(filename)[1].lower() in ALLOWED_EXTENSIONS


def auto_join_sheets(sheets_dict):
    """Automatically join dimension tables to the main fact table. Returns (merged_df, table_metadata)."""
    import pandas as pd
    if not sheets_dict:
        return pd.DataFrame(), {}
    if len(sheets_dict) == 1:
        sheet_name = list(sheets_dict.keys())[0]
        df = list(sheets_dict.values())[0]
        metadata = {
            "fact_table": sheet_name,
            "dimension_tables": [],
            "column_origins": {col: sheet_name for col in df.columns}
        }
        return df, metadata

    # Identify the main table (fact table) by the highest number of rows
    main_sheet_name = max(sheets_dict.keys(), key=lambda k: len(sheets_dict[k]))
    main_df = sheets_dict[main_sheet_name].copy()
    column_origins = {col: main_sheet_name for col in main_df.columns}
    dimension_tables = []

    # Iterate over the rest of the sheets (potential dimension tables)
    for sheet_name, dim_df in sheets_dict.items():
        if sheet_name == main_sheet_name:
            continue

        # Find common columns for joining
        common_cols = list(set(main_df.columns).intersection(set(dim_df.columns)))

        if common_cols:
            # To be safe, only auto-join if the dimension table's join keys are unique
            if not dim_df.duplicated(subset=common_cols).any():
                # Track new columns from dimension table
                new_cols = set(dim_df.columns) - set(main_df.columns)
                for col in new_cols:
                    column_origins[col] = sheet_name
                
                dimension_tables.append({
                    "name": sheet_name,
                    "join_keys": common_cols,
                    "columns": list(dim_df.columns)
                })
                
                # Perform a left join
                main_df = main_df.merge(dim_df, on=common_cols, how="left", suffixes=("", f"_{sheet_name}"))

    metadata = {
        "fact_table": main_sheet_name,
        "dimension_tables": dimension_tables,
        "column_origins": column_origins
    }
    return main_df, metadata


def read_file(file):
    """Read uploaded file into a DataFrame and extract table metadata."""
    import pandas as pd
    filename = getattr(file, "filename", "")
    if not filename:
        raise ValueError("Empty filename")

    ext = os.path.splitext(filename)[1].lower()
    metadata = {}

    if ext == ".csv":
        return pd.read_csv(file), metadata
    elif ext == ".xlsx":
        sheets = pd.read_excel(file, sheet_name=None, engine="openpyxl")
        df, metadata = auto_join_sheets(sheets)
        return df, metadata
    elif ext == ".xls":
        sheets = pd.read_excel(file, sheet_name=None)
        df, metadata = auto_join_sheets(sheets)
        return df, metadata
    else:
        raise ValueError("Unsupported file type.")


def convert_types(obj):
    """Convert NumPy/Pandas types to native Python types for JSON."""
    import pandas as pd
    import numpy as np
    if isinstance(obj, dict):
        return {k: convert_types(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [convert_types(i) for i in obj]
    elif isinstance(obj, (np.integer, np.int64, np.int32)):
        return int(obj)
    elif isinstance(obj, (np.floating, np.float64, np.float32)):
        return float(obj)
    elif isinstance(obj, (np.ndarray, pd.Series)):
        return obj.tolist()
    elif obj is None or (pd.api.types.is_scalar(obj) and pd.isna(obj)):
        return None
    else:
        return obj


# -------------------------------
# Routes
# -------------------------------

@app.route("/")
def index():
    # Standardizing for GitHub Pages & Vercel: Let Flask handle static assets natively
    # This prevents 'cooking' the UI by hardcoding style/script injections
    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "message": "API is running"
    })


@app.route("/upload", methods=["POST"])
def upload():
    try:
        from eda_engine import run_eda
        # Check file presence
        if "file" not in request.files:
            return jsonify({
                "success": False,
                "error": "No file uploaded"
            }), 400

        file = request.files["file"]

        # Validate filename
        if file.filename == "":
            return jsonify({
                "success": False,
                "error": "Empty filename"
            }), 400

        # Validate extension
        if not allowed_file(file.filename):
            return jsonify({
                "success": False,
                "error": "Only CSV and Excel (.xlsx, .xls) files are supported"
            }), 400

        # Read file
        df, table_metadata = read_file(file)

        # Check empty
        if df.empty:
            return jsonify({
                "success": False,
                "error": "Uploaded file is empty"
            }), 400

        # Run EDA
        result = run_eda(df)

        # Save DataFrame to session store for later exports
        file_id = str(uuid.uuid4())

        # Aggressive memory cleanup for Vercel (Stateless environments)
        keys = list(data_store.keys())
        if len(keys) >= 1: 
            for k in keys:
                del data_store[k]
        gc.collect()

        data_store[file_id] = df.copy()

        # Convert NumPy → Python types
        result = convert_types(result)

        # -------------------------------
        # FINAL RESPONSE (FRONTEND SAFE)
        # -------------------------------
        response = {
            "success": True,
            "file_id": file_id,
            "table_metadata": table_metadata,

            # REQUIRED BY YOUR FRONTEND
            "shape": {
                "rows": int(len(df)),
                "cols": int(len(df.columns))
            },

            # MAIN DATA
            "columns": result.get("columns", []),
            "duplicate_rows": result.get("duplicate_rows", 0),
            "correlations": result.get("correlations", []),
            "scatter": result.get("scatter", {}),

            # INCLUDE ALL OTHER EDA DATA
            **{k: v for k, v in result.items() if k not in ["columns"]}
        }

        return jsonify(response)

    except Exception as e:
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route("/export", methods=["POST"])
def export_data():
    try:
        import pandas as pd
        import numpy as np
        req_data = request.get_json(silent=True) or {}
        file_id = req_data.get("file_id")
        fixes = req_data.get("fixes", {})

        if not file_id or file_id not in data_store:
            return jsonify({"success": False, "error": "File session expired or invalid"}), 400

        df = data_store[file_id].copy()

        # Apply backend Quick Fixes
        if fixes.get("drop_duplicates"):
            df = df.drop_duplicates()

        fill_method = fixes.get("fill_nulls")
        if fill_method in ["mean", "median"]:
            num_cols = df.select_dtypes(include=np.number).columns
            for col in num_cols:
                if fill_method == "mean":
                    df[col] = df[col].fillna(df[col].mean())
                elif fill_method == "median":
                    df[col] = df[col].fillna(df[col].median())

        # Advanced: Drop Columns
        drop_cols = fixes.get("drop_columns", [])
        if drop_cols:
            valid_drops = [c for c in drop_cols if c in df.columns]
            df = df.drop(columns=valid_drops)

        # ML Prep: Encode Categorical (One-Hot Encoding)
        if fixes.get("encode_categorical"):
            cat_cols = df.select_dtypes(include=['object', 'category']).columns
            df = pd.get_dummies(df, columns=cat_cols, drop_first=True, dtype=int)

        # ML Prep: Scale Numeric (Standardization)
        if fixes.get("scale_numeric"):
            # Re-fetch numeric columns in case encoding added new ones, 
            # but we usually only want to scale continuous variables.
            num_cols = df.select_dtypes(include=np.number).columns
            for col in num_cols:
                # Skip scaling for binary/dummy columns
                if df[col].nunique() > 2:
                    std = df[col].std()
                    if pd.notna(std) and std != 0:
                        df[col] = (df[col] - df[col].mean()) / std

        # Convert to CSV in memory
        output = io.BytesIO()
        df.to_csv(output, index=False, encoding='utf-8')
        output.seek(0)

        return send_file(
            output,
            mimetype="text/csv",
            as_attachment=True,
            download_name="cleaned_data.csv"
        )
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500


@app.route("/api/multi_line", methods=["POST"])
def multi_line():
    """Endpoint to fetch grouped data for Multi-Series Line Charts."""
    try:
        req = request.get_json(silent=True) or {}
        file_id = req.get("file_id")
        x_col = req.get("x_col")
        y1_col = req.get("y1_col")
        y2_col = req.get("y2_col")
        
        if not file_id or file_id not in data_store:
            return jsonify({"error": "File session expired. Please re-upload."}), 400
            
        df = data_store[file_id]
        if x_col not in df.columns or y1_col not in df.columns or y2_col not in df.columns:
            return jsonify({"error": "Selected columns not found in data."}), 400

        # Group by the X category/date, and calculate the mean for both Y numeric columns
        grouped = df.groupby(x_col)[[y1_col, y2_col]].mean().reset_index().dropna()
        # Sort by X and limit to 100 points to keep the chart readable
        grouped = grouped.sort_values(by=x_col).head(100) 

        return jsonify({
            "x": grouped[x_col].astype(str).tolist(),
            "y1": grouped[y1_col].tolist(),
            "y2": grouped[y2_col].tolist()
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/chart_data", methods=["POST"])
def chart_data():
    try:
        import pandas as pd
        import numpy as np
        req = request.get_json(silent=True) or {}
        file_id = req.get("file_id")
        x_col = req.get("x_col")
        y_col = req.get("y_col")
        group_col = req.get("group_col")
        agg_func = req.get("agg", "sum")
        chart_type = req.get("type")

        if not file_id or file_id not in data_store:
            return jsonify({"error": "File session expired. Please re-upload."}), 400

        df = data_store[file_id]

        if not x_col or x_col not in df.columns:
            return jsonify({"error": "Invalid or missing X column."}), 400

        # Specialized logic for Histogram
        if chart_type == "histogram":
            if pd.api.types.is_numeric_dtype(df[x_col]):
                counts, bins = np.histogram(df[x_col].dropna(), bins=15)
                return jsonify({
                    "x": [f"{round(bins[i],1)}-{round(bins[i+1],1)}" for i in range(len(counts))],
                    "y": counts.tolist()
                })

        # If only X is provided, return value counts
        if not y_col:
            counts = df[x_col].value_counts(dropna=False).head(100)
            return jsonify({
                "x": counts.index.astype(str).tolist(),
                "y": counts.values.tolist()
            })

        if y_col not in df.columns:
            return jsonify({"error": "Invalid Y column."}), 400
            
        # For Pareto: sort descending by values
        if chart_type == "pareto":
             grouped = df.groupby(x_col, dropna=False)[y_col].agg(agg_func).reset_index()
             grouped = grouped.sort_values(by=y_col, ascending=False).head(20)
             return jsonify({ "x": grouped[x_col].astype(str).tolist(), "y": grouped[y_col].tolist() })

        # Handle 'None' aggregation for Raw Data / Scatter plots
        if agg_func == 'none':
            subset = df[[x_col, y_col]].dropna().head(200)
            return jsonify({ "x": subset[x_col].astype(str).tolist(), "y": subset[y_col].tolist() })

        if not pd.api.types.is_numeric_dtype(df[y_col]) and agg_func not in ["count"]:
            agg_func = "count" 

        if group_col and group_col in df.columns:
            # Measure-style aggregation for grouped data
            actual_agg = agg_func if agg_func != 'none' else 'first'
            grouped = df.groupby([x_col, group_col], dropna=False)[y_col].agg(actual_agg).reset_index()
            pivot = grouped.pivot(index=x_col, columns=group_col, values=y_col).fillna(0).head(100)
            return jsonify({
                "x": [str(val) for val in pivot.index.tolist()],
                "series": {str(c): pivot[c].tolist() for c in pivot.columns}
            })
        else:
            # Standard Measure aggregation
            grouped = df.groupby(x_col, dropna=False)[y_col].agg(agg_func).reset_index().head(100)
            return jsonify({
                "x": grouped[x_col].astype(str).tolist(),
                "y": grouped[y_col].tolist()
            })

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# -------------------------------
# Run Server
# -------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
