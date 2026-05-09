"""
eda_engine.py  — DataLens EDA Studio
Optimised for speed: bulk vectorised ops, lazy kurtosis, capped samples.
"""
from __future__ import annotations
from typing import Any
import math
import pandas as pd
import numpy as np


# ──────────────────────────────────────────────
# HELPERS
# ──────────────────────────────────────────────

def _classify(series: pd.Series) -> str:
    if pd.api.types.is_numeric_dtype(series):
        return "numeric"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "datetime"
    if series.dtype == object:
        sample = series.dropna().iloc[:50]
        if len(sample) and pd.to_datetime(sample, errors="coerce", cache=True).notna().mean() >= 0.8:
            return "datetime"
    return "categorical"


def _safe_float(v) -> float | None:
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else round(f, 4)
    except Exception:
        return None


def _outlier_mask(clean: pd.Series, q1: float, q3: float) -> pd.Series:
    iqr = q3 - q1
    return (clean < q1 - 1.5 * iqr) | (clean > q3 + 1.5 * iqr)


# ──────────────────────────────────────────────
# MAIN
# ──────────────────────────────────────────────

def run_eda(df: pd.DataFrame) -> dict[str, Any]:
    if df is None or df.empty:
        return _empty_result()

    # Cap rows — Vercel 512 MB RAM limit
    if len(df) > 100_000:
        df = df.sample(n=100_000, random_state=42)

    total_rows, total_cols = df.shape

    # ── Bulk pre-computation (single pass) ──────────────────
    null_counts   = df.isnull().sum()
    unique_counts = df.nunique()
    dup_rows      = int(df.duplicated().sum())
    preview       = df.head(10).where(pd.notnull(df), None).to_dict(orient="records")

    # Numeric sub-frame
    num_df = df.select_dtypes(include=[np.number])
    bulk_stats = skewness = kurtosis_s = pd.Series(dtype=float)
    if not num_df.empty:
        bulk_stats  = num_df.describe(percentiles=[.25, .5, .75]).T
        skewness    = num_df.skew()
        # Kurtosis is expensive — only compute if ≤ 50 cols or ≤ 20 k rows
        if len(num_df.columns) <= 50 or total_rows <= 20_000:
            kurtosis_s = num_df.kurtosis()

    col_types: dict[str, str] = {}
    for col in df.columns:
        col_types[col] = _classify(df[col])

    # ── Per-column profiles ──────────────────────────────────
    profiles = []
    datetime_cols = []

    for col in df.columns:
        ctype      = col_types[col]
        null_count = int(null_counts[col])
        null_pct   = round(null_count / total_rows * 100, 2)
        unique_cnt = int(unique_counts[col])

        profile: dict[str, Any] = {
            "name":         col,
            "type":         ctype,
            "null_count":   null_count,
            "null_pct":     null_pct,
            "unique_count": unique_cnt,
        }

        if ctype == "numeric" and col in bulk_stats.index:
            s     = bulk_stats.loc[col]
            clean = num_df[col].dropna()
            q1, q3 = float(s["25%"]), float(s["75%"])
            omask  = _outlier_mask(clean, q1, q3)

            profile["stats"] = {
                "mean":          _safe_float(s["mean"]),
                "median":        _safe_float(s["50%"]),
                "std":           _safe_float(s["std"]),
                "min":           _safe_float(s["min"]),
                "max":           _safe_float(s["max"]),
                "skew":          _safe_float(skewness.get(col, 0)),
                "kurtosis":      _safe_float(kurtosis_s.get(col, 0)) if len(kurtosis_s) else None,
                "outlier_count": int(omask.sum()),
            }

            counts, edges = np.histogram(clean, bins=20)
            profile["histogram"] = {
                "counts":    counts.tolist(),
                "bin_edges": [round(x, 4) for x in edges.tolist()],
            }
            profile["boxplot"] = {
                "min":      _safe_float(s["min"]),
                "q1":       round(q1, 4),
                "median":   _safe_float(s["50%"]),
                "q3":       round(q3, 4),
                "max":      _safe_float(s["max"]),
                "outliers": [_safe_float(x) for x in clean[omask].head(50)],
            }
            mode_v = clean.mode()
            profile["mode"] = _safe_float(mode_v.iloc[0]) if not mode_v.empty else None

        elif ctype == "categorical":
            vc = df[col].value_counts().head(10)
            profile["bar_chart"] = {
                "labels": [str(v) for v in vc.index],
                "counts": vc.values.tolist(),
            }
            mv = df[col].mode()
            profile["mode"] = str(mv.iloc[0]) if not mv.empty else None

        elif ctype == "datetime":
            try:
                dates = pd.to_datetime(df[col], errors="coerce").dropna()
                if not dates.empty:
                    profile["date_min"] = str(dates.min())
                    profile["date_max"] = str(dates.max())
                    datetime_cols.append(col)
            except Exception:
                pass

        profiles.append(profile)

    # ── Correlations (sample large datasets) ────────────────
    num_names = [p["name"] for p in profiles if p["type"] == "numeric"]
    correlations = []
    scatter = {"col_a": None, "col_b": None, "data": []}

    if len(num_names) >= 2:
        corr_df = (
            df[num_names].sample(n=50_000, random_state=42)
            if total_rows > 50_000 else df[num_names]
        )
        corr_mat = corr_df.corr()
        pairs = []
        for i in range(len(num_names)):
            for j in range(i + 1, len(num_names)):
                a, b = num_names[i], num_names[j]
                r = corr_mat.loc[a, b]
                if pd.notna(r):
                    pairs.append((a, b, round(float(r), 4)))
        pairs.sort(key=lambda x: abs(x[2]), reverse=True)
        correlations = [{"col_a": a, "col_b": b, "r": r} for a, b, r in pairs[:10]]

        if correlations:
            top = correlations[0]
            sdf = df[[top["col_a"], top["col_b"]]].dropna().head(500)
            scatter = {
                "col_a": top["col_a"],
                "col_b": top["col_b"],
                "data":  sdf.values.tolist(),
            }

    # ── Health score ─────────────────────────────────────────
    null_impact = (df.isnull().sum().sum() / (total_rows * total_cols)) * 100
    dup_impact  = (dup_rows / total_rows) * 100
    health      = max(0.0, min(100.0, 100 - null_impact * 1.5 - dup_impact * 2))

    return {
        "shape":           {"rows": total_rows, "cols": total_cols},
        "duplicate_rows":  dup_rows,
        "health_score":    round(health, 1),
        "columns":         profiles,
        "datetime_columns": datetime_cols,
        "correlations":    correlations,
        "scatter":         scatter,
        "preview_rows":    preview,
    }


def _empty_result() -> dict[str, Any]:
    return {
        "shape":            {"rows": 0, "cols": 0},
        "duplicate_rows":   0,
        "health_score":     0,
        "columns":          [],
        "datetime_columns": [],
        "correlations":     [],
        "scatter":          {"col_a": None, "col_b": None, "data": []},
        "preview_rows":     [],
    }
