# DataLens EDA Studio

DataLens EDA Studio is a small Flask app for uploading tabular data and generating an exploratory data analysis dashboard. It profiles numeric, categorical, and datetime columns, reports missing values and duplicate rows, and prepares chart-friendly summaries for the frontend.

## Install

```bash
pip install flask pandas numpy openpyxl pytest
```

## Run

```bash
python app.py
```

Open `http://localhost:5000` in your browser.

## Test

```bash
pytest
```

## Supported Files

The upload endpoint supports:

- CSV files: `.csv`
- Excel workbooks: `.xlsx`
- Legacy Excel files: `.xls`

Uploads are limited to 50 MB.

## Deployment Notes

The frontend uses relative API URLs such as `/upload`, so it works behind the same host as the Flask app without hardcoded backend domains.

For production, run Flask behind a WSGI server such as Gunicorn or Waitress and keep `debug=False`. If you need persistent analysis sessions, store uploaded files or results in temporary files, Redis, or a database rather than process memory.
