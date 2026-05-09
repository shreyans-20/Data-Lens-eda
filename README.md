# DataLens — EDA Studio

> Upload a CSV or Excel file. Get a full analysis dashboard in seconds.

🔗 **Live Demo:** [data-lens-eda.vercel.app](https://data-lens-eda.vercel.app)

---

## What It Does

DataLens is a full-stack EDA (Exploratory Data Analysis) tool built with Flask and vanilla JavaScript. Upload any CSV or Excel file and it automatically profiles every column — statistics, distributions, correlations, outliers, and data quality — with zero setup required.

---

## Features

- **Auto Column Profiling** — detects Numeric, Categorical, and Datetime columns automatically
- **Descriptive Stats** — mean, median, mode, std dev, skewness, kurtosis per numeric column
- **Outlier Detection** — IQR method (Q1 − 1.5×IQR, Q3 + 1.5×IQR) with interactive box plots
- **Correlation Analysis** — Pearson r for all numeric pairs, progress bar view + full heatmap
- **Data Preview** — first 10 rows of your actual file
- **Data Quality** — fill rate per column with one-click fixes (drop duplicates, fill nulls with mean/median)
- **Visualization Builder** — Bar, Line, Scatter, Pie, Donut, Histogram, Box Plot, Radar — with PNG export
- **Star Schema Support** — auto-detects and joins fact + dimension tables from multi-sheet Excel files
- **ML Prep Export** — drop columns, one-hot encode categoricals, standardize numerics, export clean CSV
- **EDA Report** — auto-generated summary downloadable as a standalone HTML file
- **Dark Mode** — persisted to localStorage
- **Large File Support** — up to 1,00,000 rows (sampled above that for performance)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, Flask |
| Data Processing | Pandas, NumPy |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Charts | Chart.js 4.4 + chartjs-plugin-datalabels |
| File Support | CSV, XLSX, XLS |
| Deployment | Vercel (backend) + GitHub Pages (frontend) |

No React. No build step. No bundler.

---

## Project Structure

```
datalens-eda/
├── app.py            # Flask routes: /upload, /export, /health, /api/chart_data, /api/multi_line
├── eda_engine.py     # All EDA logic: column profiling, stats, correlations, outliers
├── index.html        # Full frontend: layout, Chart.js, all JavaScript
├── style.css         # All styles, dark mode, responsive layout
├── app.js            # Frontend logic: rendering, charts, export, vis builder
├── requirements.txt  # Python dependencies
├── Procfile          # Gunicorn config for deployment
└── vercel.json       # Vercel routing config
```

---

## Running Locally

```bash
git clone https://github.com/shreyans-20/datalens-eda.git
cd datalens-eda
pip install flask flask-cors pandas numpy openpyxl gunicorn
python app.py
```

Open `http://localhost:5000`

---

## How It Works

1. File uploads to `/upload` via multipart form data
2. `eda_engine.py` classifies each column, computes stats, generates histogram bins, box plot values, top correlations, and the first 10 preview rows — all in a single pass
3. Everything comes back as one JSON object — no second requests needed for most views
4. The frontend renders the full dashboard from that JSON instantly
5. Quick fixes (drop duplicates, fill nulls) update an in-memory copy client-side
6. `/export` applies those fixes server-side on the original DataFrame and streams a cleaned CSV back
7. For multi-sheet Excel files, `auto_join_sheets` identifies the largest sheet as the fact table and left-joins dimension tables on common columns automatically

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/upload` | POST | Upload file, returns full EDA JSON |
| `/export` | POST | Apply fixes server-side, return cleaned CSV |
| `/api/chart_data` | POST | Aggregated chart data for Visualization Builder |
| `/api/multi_line` | POST | Multi-series line chart data (grouped averages) |
| `/health` | GET | Status check |

---

## Deployment

The app runs on two platforms simultaneously:

- **Vercel** → full app (file upload, export, all API routes)
- **GitHub Pages** → frontend only (sample data works, file upload requires backend)

The frontend auto-detects which environment it's running in and points API calls to the correct base URL.

---

## Known Limitations

- **GitHub Pages** is frontend-only — CSV export falls back to the 10-row preview (full export needs the Flask backend on Vercel)
- **Session store** is in-memory — resets on server restart, so sessions on free-tier hosting may expire after inactivity
- **Scatter plots** in the correlation section are pre-computed for the top correlated pair only
- **Vercel free tier** has a 10-second function timeout — very large files (>50MB) may time out on upload

---

## Author

**Shreyans Jain** — BBA Business Analytics, Ganpat University

[![LinkedIn](https://img.shields.io/badge/LinkedIn-shreyansjainn-0077B5?style=flat&logo=linkedin)](https://www.linkedin.com/in/shreyansjainn/)
[![GitHub](https://img.shields.io/badge/GitHub-shreyans--20-181717?style=flat&logo=github)](https://github.com/shreyans-20)

---

## License

MIT — free to use, modify, and distribute.
