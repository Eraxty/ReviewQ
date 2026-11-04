const DAY = 86400000;
// Plain reviewers can only open this many projects from the top of each queue
// (QUEUE_OPEN_COUNT in Pixl's internal dashboard).
const OPEN_COUNT = 15;
const TIERS = { 1: "T1 Spark", 2: "T2 Signal", 3: "T3 Grid", 4: "T4 Nexus" };
const TYPES = {
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
const $ = (id) => document.getElementById(id);

let data = null;
let queue = new URLSearchParams(location.search).get("queue") === "hardware" ? "hardware" : "software";

function waitDays(row) {
  return row.wait_start ? (Date.now() - Date.parse(row.wait_start)) / DAY : 0;
}

function fmtWait(days) {
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  return `${Math.floor(days)}d`;
}

const waitText = (row) => fmtWait(waitDays(row)) + (row.wait_exact ? "" : "+");
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "-");

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  n.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return n;
}

function lockIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "lock");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5A1 1 0 0 1 13 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h.5zm1.5 0h4V5a2 2 0 1 0-4 0v2z");
  svg.appendChild(path);
  return svg;
}

// `pos` is the queue position, or null for lists without an order that matters.
function itemEl(row, pos, { hit = false, gated = false } = {}) {
  const open = gated && pos <= OPEN_COUNT;
  const thumb = /^https:\/\//.test(row.image_url || "")
    ? el("img", { class: "thumb", src: row.image_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
    : el("div", { class: "thumb" });
  const meta = el(
    "div",
    { class: "meta" },
    el("span", {}, `#${row.id}`),
    TIERS[row.level] ? el("span", { class: "chip tier" }, TIERS[row.level]) : null,
    el("span", { class: "chip" }, TYPES[row.project_type] || row.project_type || "-"),
    row.wait_exact ? null : el("span", { class: "chip resub", title: "Shipped again after \"needs changes\" or after being unshipped" }, "Resubmitted"),
    row.is_peak ? el("span", { class: "chip peak" }, "Beacon pick") : null,
    el("span", {}, row.owner_name ? `@${row.owner_name}` : ""),
  );
  const wait = el(
    "div",
    { class: row.wait_exact ? "wait" : "wait approx" },
    el("b", {}, waitText(row)),
    el("small", {}, `shipped ${fmtDate(row.shipped_at)}`),
  );
  if (!row.wait_exact) wait.title = "At least this long. The first ship date of a resubmitted project isn't public, so this is estimated.";
  const cls = ["item", hit && "hit", gated && (open ? "open" : "locked")].filter(Boolean).join(" ");
  return el(
    "li",
    { class: cls },
    el("span", { class: "pos" }, pos ? String(pos) : "-"),
    thumb,
    el(
      "div",
      { class: "info" },
      el("a", { class: "title", href: `https://pixl.hackclub.com/projects/${encodeURIComponent(row.id)}`, target: "_blank", rel: "noopener" }, row.name),
      meta,
    ),
    wait,
  );
}

function cutoffEl() {
  return el(
    "li",
    { class: "cutoff", "aria-label": `Reviewers can only open the top ${OPEN_COUNT}. Projects below are locked.` },
    el("span", {}, lockIcon(), `Locked below: reviewers can only open the top ${OPEN_COUNT}`),
  );
}

function matches(row, term) {
  if (!term) return true;
  const t = term.toLowerCase().replace(/^@/, "");
  if (/^#\d+$/.test(t)) return String(row.id) === t.slice(1);
  if (/^\d+$/.test(t) && String(row.id) === t) return true;
  return row.name.toLowerCase().includes(t) || (row.owner_name || "").toLowerCase().includes(t);
}

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function fillList(list, rows, term, emptyText, gated, animate) {
  list.classList.remove("enter");
  const shown = rows.map((r, i) => [r, i + 1]).filter(([r]) => matches(r, term));
  if (!shown.length) {
    list.replaceChildren(el("li", { class: "empty" }, term ? "No match here." : emptyText));
    return [];
  }
  const items = [];
  for (const [r, pos] of shown) {
    if (gated && !term && pos === OPEN_COUNT + 1) items.push(cutoffEl());
    items.push(itemEl(r, pos, { hit: !!term, gated }));
  }
  // Stagger the entrance down the first couple dozen rows; the rest arrive together.
  items.forEach((li, i) => li.style.setProperty("--i", Math.min(i, 24)));
  list.replaceChildren(...items);
  if (animate) list.classList.add("enter");
  return shown;
}

// Where a looked-up project sat on an earlier visit. The baseline is read
// once per page load, so "since you last checked" means the last visit, not
// the last two-minute refresh.
const SEEN_KEY = "pq-seen";
const SEEN_DAYS = 30;
const seenBaseline = new Map();

function rememberPosition(id, pos) {
  let all = {};
  try {
    all = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
  } catch {}
  if (!seenBaseline.has(id)) {
    const prev = all[id];
    seenBaseline.set(id, prev && prev.queue === queue ? prev : null);
  }
  all[id] = { pos, queue, at: Date.now() };
  for (const [k, v] of Object.entries(all)) if (Date.now() - v.at > SEEN_DAYS * DAY) delete all[k];
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {}
  return seenBaseline.get(id);
}

function sinceText(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function deltaEl(prev, pos) {
  if (!prev) return null;
  const moved = prev.pos - pos;
  const spots = (n) => `${n} spot${n === 1 ? "" : "s"}`;
  const since = sinceText(prev.at);
  const text =
    moved > 0
      ? `Up ${spots(moved)} since you last checked ${since}.`
      : moved < 0
        ? `Down ${spots(-moved)} since you last checked ${since}. Resubmitted projects that waited longer can move ahead.`
        : `Same spot as when you last checked ${since}.`;
  return el("p", { class: "delta" }, text);
}

function trackEls(pos, total, animate) {
  const at = `${Math.min(100, ((pos - 0.5) / total) * 100)}%`;
  const open = el("div", { class: "track-open" });
  open.style.width = `${(Math.min(OPEN_COUNT, total) / total) * 100}%`;
  if (total > OPEN_COUNT) open.append(el("span", {}, `top ${OPEN_COUNT}`));
  const dot = el("div", { class: "track-dot" });
  if (animate && !reduceMotion) {
    requestAnimationFrame(() => requestAnimationFrame(() => (dot.style.left = at)));
  } else {
    dot.style.transition = "none";
    dot.style.left = at;
  }
  return [
    el("div", { class: "track", "aria-hidden": "true" }, open, dot),
    el("div", { class: "track-labels", "aria-hidden": "true" }, el("span", {}, "#1"), el("span", {}, `#${total}`)),
  ];
}

function copyButton(id) {
  const button = el("button", { type: "button", class: "btn copy" }, "Copy link");
  button.addEventListener("click", async () => {
    const url = `${location.origin}${location.pathname}?q=%23${id}${queue === "hardware" ? "&queue=hardware" : ""}`;
    try {
      await navigator.clipboard.writeText(url);
      button.textContent = "Copied!";
    } catch {
      button.textContent = "Couldn't copy";
    }
    setTimeout(() => (button.textContent = "Copy link"), 1600);
  });
  return button;
}

// `key` identifies what the callout is about; it only pops in again when that changes.
function showCallout({ kind = "", key, title, lines, action = null, extra = [] }) {
  const box = $("callout");
  const fresh = box.hidden || box.dataset.key !== key;
  box.className = `callout ${kind}`;
  box.dataset.key = key;
  const text = el("div", {}, el("strong", {}, title), ...lines.filter(Boolean).map((l) => (typeof l === "string" ? el("p", {}, l) : l)));
  box.replaceChildren(el("div", { class: "callout-head" }, text, action), ...(typeof extra === "function" ? extra(fresh) : extra));
  box.hidden = false;
  if (fresh) {
    box.classList.remove("show");
    void box.offsetWidth; // restart the pop-in
    box.classList.add("show");
  }
}

function renderCallout(term, waitingHits, finalHits) {
  if (!term) {
    $("callout").hidden = true;
    return;
  }
  const total = data.queues[queue].waiting.length;
  if (waitingHits.length === 1) {
    const [row, pos] = waitingHits[0];
    const ahead = pos - 1;
    const aheadText = ahead === 0 ? "Nobody is ahead of you." : `${ahead} project${ahead === 1 ? " is" : "s are"} ahead of you.`;
    const open = pos <= OPEN_COUNT;
    const toGo = pos - OPEN_COUNT;
    showCallout({
      kind: open ? "open" : "locked",
      key: `${queue}:${row.id}`,
      title: `#${pos} of ${total} in the ${queue} queue`,
      lines: [
        open
          ? `You're in the top ${OPEN_COUNT}, so reviewers can open your project right now. Waiting ${waitText(row)}. ${aheadText}`
          : `Locked for now: ${toGo} more project${toGo === 1 ? "" : "s"} need to be reviewed before you reach the top ${OPEN_COUNT} and reviewers can open it. Waiting ${waitText(row)}. ${aheadText}`,
        deltaEl(rememberPosition(row.id, pos), pos),
      ],
      action: copyButton(row.id),
      extra: (fresh) => trackEls(pos, total, fresh),
    });
  } else if (waitingHits.length > 1) {
    showCallout({
      key: `many:${waitingHits.length}`,
      title: `${waitingHits.length} projects match`,
      lines: ["Type more of the name, or search by #id, to narrow it down."],
    });
  } else if (finalHits.length) {
    showCallout({
      kind: "open",
      key: `final:${finalHits[0][0].id}`,
      title: "Passed first review",
      lines: ["It's out of the first-pass queue and waiting on the final fraud check and spot check."],
    });
  } else {
    const other = queue === "software" ? "hardware" : "software";
    const inOther = [...data.queues[other].waiting, ...data.queues[other].final_checks].some((r) => matches(r, term));
    showCallout({
      key: inOther ? `other:${other}` : "none",
      title: inOther ? `It's in the ${other} queue` : "Not in the queue",
      lines: [
        inOther
          ? `Switch to the ${other} tab below.`
          : "If you shipped it, it may have been approved, sent back with \"needs changes\", or still be a draft. Check your project page in Pixl.",
      ],
    });
  }
}

// Numbers tick from their last value to the new one.
function countTo(node, value) {
  const from = Number(node.dataset.value);
  node.dataset.value = value;
  cancelAnimationFrame(node._raf);
  if (reduceMotion || from === value) {
    node.textContent = value;
    return;
  }
  const start = Number.isFinite(from) ? from : 0;
  const began = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - began) / 800);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = Math.round(start + (value - start) * eased);
    if (t < 1) node._raf = requestAnimationFrame(step);
  };
  node._raf = requestAnimationFrame(step);
}

function renderPipeline() {
  const sw = data.queues.software.waiting.length;
  const hw = data.queues.hardware.waiting.length;
  const fin = data.queues.software.final_checks.length + data.queues.hardware.final_checks.length;
  const all = sw + hw + fin || 1;
  $("bar").classList.remove("loading");
  countTo($("total"), sw + hw);
  for (const [id, n] of [["seg-software", sw], ["seg-hardware", hw], ["seg-final", fin]]) {
    const seg = $(id);
    seg.style.width = `${(n / all) * 100}%`;
    seg.firstElementChild.textContent = n / all >= 0.04 ? n : "";
  }
  const r = data.reviewed_24h;
  countTo($("recent"), r.approved + r.needs_changes);
  $("recent-breakdown").textContent = `(${r.approved} approved · ${r.needs_changes} needs changes)`;
}

function render(animate = false) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.queue === queue)));
  if (!data) return;
  const q = data.queues[queue];
  const term = $("search").value.trim();

  renderPipeline();
  countTo($("c-software"), data.queues.software.waiting.length);
  countTo($("c-hardware"), data.queues.hardware.waiting.length);

  const waitingHits = fillList($("waiting"), q.waiting, term, "Nothing waiting. Queue's clear.", true, animate);
  const finalHits = fillList($("final"), q.final_checks, term, "Nothing in final checks.", false, animate);
  renderCallout(term, term ? waitingHits : [], term ? finalHits : []);
}

// Snapshots older than this mean the updater has stopped running.
const STALE_MINUTES = 45;

function minutesAgo(iso) {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
}

async function refresh() {
  const first = data === null;
  try {
    const res = await fetch("queue.json", { cache: "no-store" });
    data = await res.json();
    const mins = minutesAgo(data.generated_at);
    const stale = mins > STALE_MINUTES;
    if (data.crawling) {
      $("updated").textContent = `First scan of Pixl's projects is still running (${data.probed} of ~${data.top_id} checked). The list fills in as it goes.`;
    } else {
      const when = mins < 1 ? "just now" : `${mins} min ago`;
      $("updated").textContent = `Updated ${when}. The queue is re-checked about every 10 minutes and this page reloads the data every 2.`;
    }
    const locked = data.api_locked_since;
    $("banner").hidden = !locked;
    if (locked) {
      $("banner").textContent = `Pixl stopped showing unreviewed projects publicly on ${new Date(locked).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. This is the queue as it was then, and it'll update again once they're public.`;
    }
    $("live").classList.toggle("on", !stale && !data.crawling && !locked);
    $("live-text").textContent = locked ? "Paused" : data.crawling ? "Scanning" : stale ? `Updated ${Math.round(mins / 60)}h ago` : "Live";
    render(first);
  } catch {
    $("updated").textContent = "Couldn't load the queue. Try refreshing.";
    $("live").classList.remove("on");
    $("live-text").textContent = "Offline";
  }
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
}

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(location.search);
  if (params.get("q")) $("search").value = params.get("q");

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

  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      if (queue === b.dataset.queue) return;
      queue = b.dataset.queue;
      render(true);
    }),
  );
  $("search").addEventListener("input", () => render(false));
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("search").value = "";
      render(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
    if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      $("search").focus();
    }
  });

  render();
  refresh();
  setInterval(refresh, 2 * 60 * 1000);
});
