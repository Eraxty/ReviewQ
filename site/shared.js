// Helpers shared by the queue page and the review page.

export const DAY = 86400000;
// Plain reviewers can only open this many projects from the top of each queue
// (QUEUE_OPEN_COUNT in Pixl's internal dashboard).
export const OPEN_COUNT = 15;
export const TIERS = { 1: "T1 Spark", 2: "T2 Signal", 3: "T3 Grid", 4: "T4 Nexus" };
export const TYPES = {
  web: "Web playable",
  other: "Other / not sure",
  python: "Python",
  windows: "Windows",
  mac: "Mac",
  linux: "Linux",
  android: "Android",
  cross_platform: "Cross platform",
  hardware: "Hardware",
  cad: "CAD",
};

export const $ = (id) => document.getElementById(id);
export const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// `on<event>` attributes given a function become listeners.
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  n.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return n;
}

export function svgIcon(d, { viewBox = "0 0 16 16", cls = "icon" } = {}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  for (const path of [d].flat()) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
  }
  return svg;
}

export const ICONS = {
  lock: "M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5A1 1 0 0 1 13 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h.5zm1.5 0h4V5a2 2 0 1 0-4 0v2z",
  chat: "M2.5 2h11A1.5 1.5 0 0 1 15 3.5v7a1.5 1.5 0 0 1-1.5 1.5H8l-3.6 2.7a.5.5 0 0 1-.8-.4V12H2.5A1.5 1.5 0 0 1 1 10.5v-7A1.5 1.5 0 0 1 2.5 2z",
  copy: "M5 1.5h6.5A1.5 1.5 0 0 1 13 3v8h-1.5V3H5zM3 4.5h6.5A1.5 1.5 0 0 1 11 6v7.5A1.5 1.5 0 0 1 9.5 15H3a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 3 4.5zm0 1.5v7.5h6.5V6z",
  out: "M9 2h5v5h-1.5V4.6L7.3 9.8 6.2 8.7l5.2-5.2H9zM2 4.5A1.5 1.5 0 0 1 3.5 3H7v1.5H3.5v8h8V9H13v3.5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 12.5z",
};

export function waitDays(row) {
  return row.wait_start ? (Date.now() - Date.parse(row.wait_start)) / DAY : 0;
}

export function fmtWait(days) {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.floor(days)}d`;
}

export const waitText = (row) => fmtWait(waitDays(row)) + (row.wait_exact ? "" : "+");
export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "-";

export function timeAgo(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const round1 = (n) => Math.round(n * 10) / 10;

// A small button that copies `text()` and says so for a moment.
export function copyButton(label, text, { cls = "btn copy" } = {}) {
  const button = el("button", { type: "button", class: cls }, svgIcon(ICONS.copy), el("span", {}, label));
  const span = button.lastChild;
  button.addEventListener("click", async () => {
    const value = text();
    if (!value) {
      span.textContent = "Nothing to copy";
    } else {
      try {
        await navigator.clipboard.writeText(value);
        span.textContent = "Copied!";
        button.classList.add("done");
      } catch {
        span.textContent = "Couldn't copy";
      }
    }
    setTimeout(() => {
      span.textContent = label;
      button.classList.remove("done");
    }, 1500);
  });
  return button;
}

function applyThemeLabel() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("theme").setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  $("theme").title = dark ? "Light mode" : "Dark mode";
}

let themeTimer = 0;
function setTheme(theme, save) {
  const root = document.documentElement;
  root.classList.add("theming");
  root.dataset.theme = theme;
  if (save) {
    try {
      localStorage.setItem("pq-theme", theme);
    } catch {}
  }
  applyThemeLabel();
  clearTimeout(themeTimer);
  themeTimer = setTimeout(() => root.classList.remove("theming"), 400);
  document.dispatchEvent(new CustomEvent("themechange"));
}

export function setupTheme() {
  applyThemeLabel();
  $("theme").addEventListener("click", () =>
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true),
  );
  // Follow the system theme until the visitor picks one.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let saved = null;
    try {
      saved = localStorage.getItem("pq-theme");
    } catch {}
    if (!saved) setTheme(e.matches ? "dark" : "light", false);
  });
}

export async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
