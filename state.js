export const state = {
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
  filterState: {},
  uploadController: null,
  charts: {
    col: null,
    vis: null,
    boxplot: null,
    corr: null,
    pbi: null
  }
};