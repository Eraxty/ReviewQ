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

function fillList(list, rows, term, emptyText, gated) {
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
  list.replaceChildren(...items);
  return shown;
}

function setCallout(kind, title, text) {
  const box = $("callout");
  box.className = `callout ${kind}`;
  box.replaceChildren(el("strong", {}, title), el("span", {}, text));
  box.hidden = false;
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
    if (pos <= OPEN_COUNT) {
      setCallout(
        "open",
        `#${pos} of ${total} in the ${queue} queue`,
        `You're in the top ${OPEN_COUNT}, so reviewers can open your project right now. Waiting ${waitText(row)}. ${aheadText}`,
      );
    } else {
      const toGo = pos - OPEN_COUNT;
      setCallout(
        "locked",
        `#${pos} of ${total} in the ${queue} queue`,
        `Locked for now: ${toGo} more project${toGo === 1 ? "" : "s"} need to be reviewed before you reach the top ${OPEN_COUNT} and reviewers can open it. Waiting ${waitText(row)}. ${aheadText}`,
      );
    }
  } else if (waitingHits.length > 1) {
    setCallout("", `${waitingHits.length} projects match`, "Type more of the name, or search by #id, to narrow it down.");
  } else if (finalHits.length) {
    setCallout("open", "Passed first review", "It's out of the first-pass queue and waiting on the final fraud check and spot check.");
  } else {
    const other = queue === "software" ? "hardware" : "software";
    const inOther = [...data.queues[other].waiting, ...data.queues[other].final_checks].some((r) => matches(r, term));
    setCallout(
      "",
      inOther ? `It's in the ${other} queue` : "Not in the queue",
      inOther
        ? `Switch to the ${other} tab below.`
        : "If you shipped it, it may have been approved, sent back with \"needs changes\", or still be a draft. Check your project page in Pixl.",
    );
  }
}

function renderPipeline() {
  const sw = data.queues.software.waiting.length;
  const hw = data.queues.hardware.waiting.length;
  const fin = data.queues.software.final_checks.length + data.queues.hardware.final_checks.length;
  const all = sw + hw + fin || 1;
  $("total").textContent = sw + hw;
  for (const [id, n] of [["seg-software", sw], ["seg-hardware", hw], ["seg-final", fin]]) {
    const seg = $(id);
    seg.style.width = `${(n / all) * 100}%`;
    seg.firstElementChild.textContent = n / all >= 0.04 ? n : "";
  }
  const r = data.reviewed_24h;
  $("recent").textContent = r.approved + r.needs_changes;
  $("recent-breakdown").textContent = `(${r.approved} approved · ${r.needs_changes} needs changes)`;
}

function render() {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.queue === queue)));
  if (!data) return;
  const q = data.queues[queue];
  const term = $("search").value.trim();

  renderPipeline();
  $("c-software").textContent = data.queues.software.waiting.length;
  $("c-hardware").textContent = data.queues.hardware.waiting.length;

  const waitingHits = fillList($("waiting"), q.waiting, term, "Nothing waiting. Queue's clear.", true);
  const finalHits = fillList($("final"), q.final_checks, term, "Nothing in final checks.", false);
  renderCallout(term, term ? waitingHits : [], term ? finalHits : []);
}

// Snapshots older than this mean the updater has stopped running.
const STALE_MINUTES = 45;

function minutesAgo(iso) {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
}

async function refresh() {
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
    $("live").classList.toggle("on", !stale && !data.crawling);
    $("live-text").textContent = data.crawling ? "Scanning" : stale ? `Updated ${Math.round(mins / 60)}h ago` : "Live";
    render();
  } catch {
    $("updated").textContent = "Couldn't load the queue. Try refreshing.";
    $("live").classList.remove("on");
    $("live-text").textContent = "Offline";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(location.search);
  if (params.get("q")) $("search").value = params.get("q");

  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      queue = b.dataset.queue;
      render();
    }),
  );
  $("search").addEventListener("input", render);

  render();
  refresh();
  setInterval(refresh, 2 * 60 * 1000);
});
