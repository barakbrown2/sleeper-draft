// src/ui/dom.js - tiny rendering helpers shared by the screens.

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtDateTime(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return String(ts);
  }
}

export function fmtTime(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  } catch {
    return String(ts);
  }
}

export function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Age of a data file: "35 min old", "6 h old", "3 d old".
export function fmtAge(ts) {
  if (!ts) return 'never';
  const h = (Date.now() - ts) / 3600000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min old`;
  if (h < 48) return `${Math.round(h)} h old`;
  return `${Math.round(h / 24)} d old`;
}

// Green up to 3 days, amber up to 10, red beyond.
export function ageClass(ts) {
  if (!ts) return 'status-bad';
  const d = (Date.now() - ts) / 86400000;
  return d <= 3 ? 'status-ok' : d <= 10 ? 'status-warn' : 'status-bad';
}

export function n1(x) {
  if (x == null || Number.isNaN(x)) return '-';
  return (Math.round(x * 10) / 10).toFixed(1);
}

export function n0(x) {
  if (x == null || Number.isNaN(x)) return '-';
  return String(Math.round(x));
}

export function pct(x) {
  if (x == null || Number.isNaN(x)) return '-';
  return `${Math.round(x * 100)}%`;
}

// Survival color: green >= 70%, amber 40-69%, red < 40% (plan section 11).
export function survClass(x) {
  if (x == null || Number.isNaN(x)) return '';
  return x >= 0.7 ? 'surv-g' : x >= 0.4 ? 'surv-a' : 'surv-r';
}

export function posClass(pos) {
  return `pos pos-${String(pos || '').replace(/[^A-Z]/g, '')}`;
}

export function $(id) {
  return document.getElementById(id);
}
