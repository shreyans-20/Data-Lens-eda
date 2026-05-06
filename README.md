# DataLens — EDA Studio

> Upload a CSV or Excel file. Get a full analysis dashboard in seconds.

🔗 **Live Demo:** [[shreyans-20.github.io/datalens-eda](https://data-lens-eda-jt7u.onrender.com)]

---

## What It Does

DataLens is a full-stack EDA tool built with Flask and vanilla JavaScript. You upload a file, and it automatically profiles every column — statistics, distributions, correlations, outliers, and data quality — with no setup required.

---

## Features

- **Auto Column Profiling** — detects Numeric, Categorical, and Datetime columns automatically
- **Descriptive Stats** — mean, median, mode, std dev, skewness, kurtosis per numeric column
- **Outlier Detection** — IQR method (Q1 − 1.5×IQR, Q3 + 1.5×IQR) with box plots
- **Correlation Analysis** — Pearson r for all numeric pairs, with a progress bar view and a full heatmap
- **Date Explorer** — time-series chart with Day / Month / Quarter / Year grouping and date range filter
- **Data Preview** — first 10 rows of your actual file
- **Data Quality** — fill rate per column, with one-click fixes (drop duplicates, fill nulls with mean/median)
- **Visualization Builder** — Bar, Line, Scatter, Pie, Donut, Histogram, Box Plot, Radar — with PNG download
- **ML Prep Export** — drop columns, one-hot encode categoricals, standardize numerics, export clean CSV
- **EDA Report** — auto-generated summary downloadable as a standalone HTML file
- **Dark Mode** — saved to localStorage
- **Handles large files** — up to 5,00,000 rows (sampled above that for performance)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python, Flask |
| Data Processing | Pandas, NumPy |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Charts | Chart.js 4.4 |
| File Support | CSV, XLSX, XLS |

No React. No build step. Just a single `index.html` with all logic inline.

---

## Project Structure

```
datalens-eda/
├── app.py           # Flask routes: /upload, /export, /health, /api/multi_line, /api/ai_summary
├── eda_engine.py    # All EDA logic: column profiling, stats, correlations, outliers
├── index.html       # Entire frontend: layout, styles, Chart.js, JS
└── requirements.txt
```

---

## Running Locally

```bash
git clone https://github.com/shreyans-20/datalens-eda.git
cd datalens-eda

pip install flask pandas numpy openpyxl

python app.py
```

Open `http://localhost:10000`

---

## How It Works (Brief)

1. File uploads to `/upload` via multipart form
2. `eda_engine.py` classifies each column, computes stats, generates histogram bins, box plot values, top correlations, and the first 10 preview rows
3. Everything comes back as a single JSON object
4. The frontend renders the full dashboard from that JSON — no second requests needed for most views
5. Quick fixes (drop duplicates, fill nulls) update an in-memory copy of the data
6. `/export` applies those fixes server-side on the original DataFrame and streams a cleaned CSV

---

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/upload` | POST | Upload file, returns full EDA JSON |
| `/export` | POST | Apply fixes, return cleaned CSV |
| `/api/multi_line` | POST | Multi-series line chart data (grouped averages) |
| `/api/ai_summary` | POST | AI executive summary via Google Gemini |
| `/health` | GET | Status check |

---

## Known Limitations

- **GitHub Pages demo** is frontend-only — CSV export falls back to the 10-row preview (full export needs the Flask backend running)
- **Scatter plots** are only pre-computed for the top correlated pair; other pairs use histogram-bin approximations
- **Session store** is in-memory — resets on server restart, so long-running sessions on free-tier hosting may expire
- **Date slicer export** is not supported — the filter works on aggregated counts, not the raw DataFrame

---

## Author

**Shreyans Jain** — BBA Business Analytics, Ganpat University

- [LinkedIn](https://www.linkedin.com/in/shreyansjainn/)
- [GitHub](https://github.com/shreyans-20)

---

MIT License
