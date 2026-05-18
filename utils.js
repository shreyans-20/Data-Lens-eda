export function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function toast(msg, type = "info", duration = 3500) {
  const icons = { info: "ℹ️", success: "✅", error: "❌", warning: "⚠️" };
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.setAttribute("role", "alert");
  el.innerHTML = `<span>${icons[type] || ""}</span><span>${escHtml(msg)}</span>`;
  document.getElementById("toast-container").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 280);
  }, duration);
}

export const ECHART_COLORS = ["#1d4ed8", "#6d28d9", "#15803d", "#b45309", "#b91c1c", "#0e7490", "#be185d", "#4d7c0f", "#c2410c", "#5b21b6"];
export const LOADER_MSGS = ["Reading file structure…", "Detecting column types…", "Computing distributions…", "Running correlation engine…", "Assembling your dashboard…"];