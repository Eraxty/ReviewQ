import {
  $,
  DAY,
  ICONS,
  OPEN_COUNT,
  TIERS,
  TYPES,
  copyButton,
  el,
  fetchJSON,
  fmtDate,
  reduceMotion,
  setupTheme,
  svgIcon,
  waitText,
} from "./shared.js";

let data = null;
// Community review counts straight from the reviews API, so a new review
// shows up here within a minute instead of at the next queue rebuild.
let reviewsApi;
let reviewCounts = null;

async function refreshReviewCounts() {
  if (reviewsApi === undefined) reviewsApi = (await fetchJSON("reviews-config.json"))?.api || null;
  if (!reviewsApi) return;
  const res = await fetchJSON(`${reviewsApi.replace(/\/$/, "")}/api/counts`);
  if (res?.counts) reviewCounts = res.counts;
}

function applyReviewCounts() {
  if (!data || !reviewCounts) return;
  for (const q of Object.values(data.queues))
    for (const row of [...q.waiting, ...q.final_checks]) row.community_reviews = reviewCounts[row.id] || 0;
}
let queue = new URLSearchParams(location.search).get("queue") === "hardware" ? "hardware" : "software";

const reviewUrl = (id) => `review.html?id=${encodeURIComponent(id)}`;

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
    row.community_reviews
      ? el(
          "a",
          {
            class: "chip reviewed",
            href: reviewUrl(row.id),
            title: `${row.community_reviews} anonymous community review${row.community_reviews === 1 ? "" : "s"} on its review page. Not official: only Pixl's reviewers can approve a project.`,
          },
          svgIcon(ICONS.chat),
          `Unofficially reviewed${row.community_reviews > 1 ? ` \u00d7${row.community_reviews}` : ""}`,
        )
      : null,
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
      el("a", { class: "title", href: reviewUrl(row.id) }, row.name),
      meta,
    ),
    wait,
  );
}

function cutoffEl() {
  return el(
    "li",
    { class: "cutoff", "aria-label": `Reviewers can only open the top ${OPEN_COUNT}. Projects below are locked.` },
    el("span", {}, svgIcon(ICONS.lock, { cls: "lock" }), `Locked below: reviewers can only open the top ${OPEN_COUNT}`),
  );
}

function matches(row, term) {
  if (!term) return true;
  const t = term.toLowerCase().replace(/^@/, "");
  if (/^#\d+$/.test(t)) return String(row.id) === t.slice(1);
  if (/^\d+$/.test(t) && String(row.id) === t) return true;
  return row.name.toLowerCase().includes(t) || (row.owner_name || "").toLowerCase().includes(t);
}

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

function actions(id) {
  const link = () => `${location.origin}${location.pathname}?q=%23${id}${queue === "hardware" ? "&queue=hardware" : ""}`;
  return el(
    "div",
    { class: "callout-actions" },
    el("a", { class: "btn copy", href: reviewUrl(id) }, "Review page"),
    copyButton("Copy link", link),
  );
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
        row.community_reviews
          ? `It has ${row.community_reviews} unofficial community review${row.community_reviews === 1 ? "" : "s"}. They don't count until a Pixl reviewer checks it.`
          : null,
      ],
      action: actions(row.id),
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
      action: finalHits.length === 1 ? actions(finalHits[0][0].id) : null,
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
    const [res] = await Promise.all([fetch("queue.json", { cache: "no-store" }), refreshReviewCounts()]);
    data = await res.json();
    applyReviewCounts();
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

document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(location.search);
  if (params.get("q")) $("search").value = params.get("q");

  setupTheme();

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
