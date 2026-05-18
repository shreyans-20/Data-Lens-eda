<div align="center">

<img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=flat&logo=python&logoColor=white"/>
<img src="https://img.shields.io/badge/Flask-2.x-000000?style=flat&logo=flask"/>
<img src="https://img.shields.io/badge/Pandas-NumPy-150458?style=flat&logo=pandas"/>
<img src="https://img.shields.io/badge/Deployed-Vercel-000000?style=flat&logo=vercel"/>
<img src="https://img.shields.io/badge/License-MIT-green?style=flat"/>

# Data Lens — EDA Studio

**Upload any CSV or Excel file. Get a full analysis dashboard in seconds. No setup. No code.**

🔗 **[data-lens-eda.vercel.app](https://data-lens-eda.vercel.app)** &nbsp;·&nbsp; 📱 **Mobile friendly** &nbsp;·&nbsp; 🌙 **Dark mode**

</div>

---

## What It Does

DataLens is a full-stack **Exploratory Data Analysis (EDA)** tool. Upload a file and it automatically profiles every column — statistics, distributions, correlations, outliers, and data quality — all in one dashboard, with zero setup required.

Built with **Flask + vanilla JavaScript**. No React. No bundler. No build step.

---

## Features

| Category | What you get |
|---|---|
| **Column Profiling** | Auto-detects Numeric, Categorical, and Datetime columns |
| **Descriptive Stats** | Mean, median, mode, std dev, skewness, kurtosis per numeric column |
| **Outlier Detection** | IQR method with interactive box plots |
| **Correlation Analysis** | Pearson r for all numeric pairs — progress bar view + full heatmap |
| **Data Preview** | First 10 rows of your actual file |
| **Data Quality** | Fill rate per column + one-click fixes (drop duplicates, fill nulls) |
| **Visualization Builder** | Bar, Line, Scatter, Pie, Donut, Histogram, Box Plot, Radar — with PNG export |
| **Star Schema Support** | Auto-detects and joins fact + dimension tables from multi-sheet Excel files |
| **ML Prep Export** | Drop columns, one-hot encode, standardize numerics, export clean CSV |
| **EDA Report** | Auto-generated summary downloadable as a standalone HTML file |
| **AI Insights** | Automated narrative insights — quality issues, correlations, chart suggestions |
| **Large File Support** | Up to 2,00,000 rows (sampled above that for performance) |

---

## Screenshots

> Upload screen → instant dashboard

| Landing | Dashboard |
|---|---|
| Upload CSV/Excel, choose sample data, or drag-and-drop | Full column profiles, correlations, charts, and AI insights |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.10+, Flask |
| Data Processing | Pandas, NumPy |
| Frontend | Vanilla HTML, CSS, JavaScript (ES Modules) |
| Charts | Apache ECharts 5.4 |
| Table Engine | AG Grid Community |
| File Support | CSV, XLSX, XLS, JSON |
| Deployment | Vercel (backend + frontend) + GitHub Pages (frontend mirror) |

---

## Project Structure

```
datalens-eda/
├── app.py            # Flask routes: /upload, /export, /api/chart_data, /api/pivot, etc.
├── eda_engine.py     # EDA logic: column profiling, stats, correlations, outlier detection
├── index.html        # Full frontend layout
├── style.css         # All styles — dark mode, responsive, mobile-first
├── app.js            # Frontend logic: rendering, charts, export, vis builder
├── state.js          # Shared frontend state
├── utils.js          # Toast, debounce, color constants
├── requirements.txt  # Python dependencies
├── vercel.json       # Vercel routing config (static + Python)
└── README.md
```

---

## Running Locally

```bash
git clone https://github.com/shreyans-20/datalens-eda.git
cd datalens-eda
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000`

---

## How It Works

```
File upload (multipart)
        │
        ▼
  eda_engine.py
  ─ classifies each column (numeric / categorical / datetime)
  ─ computes stats, histograms, box plot values, correlations
  ─ detects outliers via IQR
  ─ scores data health
        │
        ▼
  Single JSON response → frontend renders full dashboard instantly
        │
  User applies fixes (drop duplicates, fill nulls, encode, scale)
        │
        ▼
  /export → Flask applies fixes server-side → streams cleaned CSV
```

For multi-sheet Excel files, `_auto_join()` identifies the largest sheet as the fact table and left-joins dimension tables on shared columns automatically.

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/upload` | POST | Upload file, returns full EDA JSON + AI insights |
| `/export` | POST | Apply fixes server-side, return cleaned CSV |
| `/api/chart_data` | POST | Aggregated chart data for Visualization Builder |
| `/api/multi_line` | POST | Multi-series line chart data |
| `/api/pivot` | POST | Pivot table with custom row/col/value/aggregation |
| `/api/apply_fixes` | POST | Apply data cleaning fixes, returns updated EDA |
| `/api/insights` | POST | Re-generate AI insights for current dataset |
| `/api/table_data` | POST | Raw table data (first 1000 rows) |
| `/health` | GET | Status check |

---

## Deployment

The app runs on two platforms simultaneously:

- **Vercel** — full app (upload, export, all API routes, frontend)
- **GitHub Pages** — frontend mirror (sample data works; file upload requires Vercel backend)

The frontend auto-detects the environment and points API calls to the right base URL.

**Environment variables for production:**

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Flask session secret (required in prod) |
| `ALLOWED_ORIGINS` | Comma-separated extra CORS origins |

---

## Known Limitations

- **GitHub Pages** is frontend-only — full CSV export needs the Vercel backend
- **Session store** is in-memory — expires on server restart (free-tier Vercel serverless resets between invocations)
- **Scatter plots** in the correlation section are pre-computed for the top correlated pair only
- **Vercel free tier** has a 10-second function timeout — very large files may time out

---

## Author

**Shreyans Jain**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-shreyansjainn-0077B5?style=flat&logo=linkedin)](https://www.linkedin.com/in/shreyansjainn/)
[![GitHub](https://img.shields.io/badge/GitHub-shreyans--20-181717?style=flat&logo=github)](https://github.com/shreyans-20)

---

## License

MIT — free to use, modify, and distribute.
