from typing import List, Dict, Any

def classify_column(series) -> str:
    """Classify a column as numeric, categorical, or datetime."""
    import pandas as pd
    # Numeric
    if pd.api.types.is_numeric_dtype(series):
        return "numeric"

    # Datetime
    if pd.api.types.is_datetime64_any_dtype(series):
        return "datetime"

    if series.dtype == "object":
        sample = series.dropna().head(100)
        try:
            parsed = pd.to_datetime(sample, errors="coerce")
            if parsed.notna().mean() >= 0.9:
                return "datetime"
        except Exception:
            pass

    return "categorical"

def get_outlier_count(series) -> int:
    """Count outliers using IQR method."""
    import pandas as pd
    if series.empty:
        return 0
    q1 = series.quantile(0.25)
    q3 = series.quantile(0.75)
    iqr = q3 - q1
    return int(((series < (q1 - 1.5 * iqr)) | (series > (q3 + 1.5 * iqr))).sum())

def run_eda(df) -> Dict[str, Any]:
    import pandas as pd
    import numpy as np
    # Guard against None or empty input
    if df is None:
        df = pd.DataFrame()

    # Cap rows for performance (Increased to 500,000 rows / 5 Lakh)
    if len(df) > 500000:
        df = df.sample(n=500000, random_state=42)

    total_rows, total_cols = df.shape

    # Early return for empty input
    if total_rows == 0 or total_cols == 0:
        return {
            "shape": {"rows": total_rows, "cols": total_cols},
            "duplicate_rows": 0,
            "columns": [],
            "datetime_columns": [],
            "correlations": [],
            "scatter": {"col_a": None, "col_b": None, "data": []},
            "preview_rows": [],
        }

    duplicate_rows = int(df.duplicated().sum())
    
    # Extract the first 10 rows for the frontend data preview
    preview_rows = df.head(10).where(pd.notnull(df), None).to_dict(orient="records")

    column_profiles: List[Dict[str, Any]] = []
    datetime_columns: List[str] = []

    for col in df.columns:
        series = df[col].copy()
        col_type = classify_column(series)
        null_count = int(series.isnull().sum())
        null_pct = round(null_count / total_rows * 100, 2) if total_rows > 0 else 0.0

        profile: Dict[str, Any] = {
            "name": col,
            "type": col_type,
            "null_count": null_count,
            "null_pct": null_pct,
            "unique_count": int(series.nunique()),
        }

        if col_type == "numeric":
            clean = series.dropna()
            if len(clean) == 0:
                column_profiles.append(profile)
                continue

            profile["stats"] = {
                "mean": round(float(clean.mean()), 4),
                "median": round(float(clean.median()), 4),
                "std": round(float(clean.std()), 4),
                "min": round(float(clean.min()), 4),
                "max": round(float(clean.max()), 4),
                "skew": round(float(clean.skew()), 4),
                "kurtosis": round(float(clean.kurtosis()), 4),
                "outlier_count": get_outlier_count(clean),
            }

            profile["series"] = list(clean.tolist())

            # Histogram
            counts, bin_edges = np.histogram(clean, bins=20)
            profile["histogram"] = {
                "counts": counts.tolist(),
                "bin_edges": [round(x, 4) for x in bin_edges.tolist()],
            }

            # Box plot
            q1 = float(clean.quantile(0.25))
            q3 = float(clean.quantile(0.75))
            iqr = q3 - q1
            lower_fence = q1 - 1.5 * iqr
            upper_fence = q3 + 1.5 * iqr
            outliers = clean[(clean < lower_fence) | (clean > upper_fence)].tolist()
            profile["boxplot"] = {
                "min":     round(float(clean.min()), 4),
                "q1":      round(q1, 4),
                "median":  round(float(clean.median()), 4),
                "q3":      round(q3, 4),
                "max":     round(float(clean.max()), 4),
                "outliers": [round(x, 4) for x in outliers[:50]],
            }

            # mode
            try:
                mode_val = clean.mode().iloc[0] if len(clean) > 0 else None
                profile["mode"] = mode_val
            except Exception:
                profile["mode"] = None

        elif col_type == "categorical":
            top_values = series.value_counts().head(10)
            profile["bar_chart"] = {
                "labels": [str(v) for v in top_values.index.tolist()],
                "counts": top_values.values.tolist(),
            }
            try:
                mode_vals = series.mode()
                profile["mode"] = mode_vals.iloc[0] if not mode_vals.empty else None
            except Exception:
                profile["mode"] = None

        elif col_type == "datetime":
            try:
                dates = pd.to_datetime(series.dropna())
                if not dates.empty:
                    date_vals = dates.dt.date
                    date_counts = date_vals.value_counts().sort_index()
                    profile["date_counts"] = [
                        {"date": str(d), "count": int(date_counts[d])} for d in date_counts.index
                    ]
                    profile["date_min"] = str(date_counts.index.min())
                    profile["date_max"] = str(date_counts.index.max())
                    datetime_columns.append(col)
            except Exception:
                profile["date_counts"] = []
                profile["date_min"] = None
                profile["date_max"] = None

        column_profiles.append(profile)

    # Correlations — numeric columns only
    numeric_cols = [c["name"] for c in column_profiles if c["type"] == "numeric"]
    correlations: List[Dict[str, Any]] = []
    if len(numeric_cols) >= 2:
        # Sample for correlation to ensure blazing fast execution on large datasets
        if len(df) > 50000:
            corr_df = df[numeric_cols].sample(n=50000, random_state=42)
        else:
            corr_df = df[numeric_cols]
            
        corr_matrix = corr_df.corr()
        pairs: List[tuple[str, str, float]] = []
        for i in range(len(numeric_cols)):
            for j in range(i + 1, len(numeric_cols)):
                a = numeric_cols[i]
                b = numeric_cols[j]
                r = corr_matrix.loc[a, b]
                if not np.isnan(r):
                    pairs.append((a, b, float(r)))
        pairs.sort(key=lambda x: abs(x[2]), reverse=True)
        correlations = [{"col_a": a, "col_b": b, "r": r} for a, b, r in pairs[:10]]

    # Scatter data for top correlated pair
    scatter_data = []
    scatter_col_a = None
    scatter_col_b = None
    if correlations:
        top = correlations[0]
        scatter_col_a = top["col_a"]
        scatter_col_b = top["col_b"]
        scatter_df = df[[scatter_col_a, scatter_col_b]].dropna().head(500)
        scatter_data = scatter_df.values.tolist()

    return {
        "shape": {"rows": total_rows, "cols": total_cols},
        "duplicate_rows": duplicate_rows,
        "columns": column_profiles,
        "datetime_columns": datetime_columns,
        "correlations": correlations,
        "scatter": {
            "col_a": scatter_col_a,
            "col_b": scatter_col_b,
            "data": scatter_data,
        },
        "preview_rows": preview_rows,
    }
