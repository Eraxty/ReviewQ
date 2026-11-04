import {
  $,
  OPEN_COUNT,
  TIERS,
  TYPES,
  copyButton,
  el,
  fetchJSON,
  fmtDate,
  richText,
  round1,
  setupTheme,
  timeAgo,
  waitText,
} from "./shared.js";

const FIREBASE = "https://www.gstatic.com/firebasejs/13.2.0";
const id = (new URLSearchParams(location.search).get("id") || "").replace(/^#/, "").trim();
const DRAFT_KEY = `pq-draft-${id}`;
const TECHNICAL_FEATURES_MIN = 20;

// Same wording as the review form in Pixl's internal dashboard.
const TIER_BLURBS = {
  1: "A simple site, script, or tiny tool",
  2: "A focused app, CLI, or game with clean polish",
  3: "Multiple systems together: backend, state, infra",
  4: "Deep systems work, serious scope",
};
const VERDICTS = {
  approved: { label: "Approve", cls: "good" },
  needs_changes: { label: "Request changes", cls: "warn" },
  ban: { label: "Perm reject", cls: "bad" },
};
// Verdicts as Pixl's public API reports them.
const OFFICIAL = {
  approved: { label: "Approved", cls: "good" },
  needs_changes: { label: "Needs changes", cls: "warn" },
  rejected: { label: "Rejected", cls: "bad" },
  banned: { label: "Banned", cls: "bad" },
};
// The order and headers of the dash's audit note, so "copy whole review" pastes cleanly.
const FIELDS = [
  { key: "technical_features", label: "Technical features", header: "TECHNICAL FEATURES" },
  { key: "deflation_reason", label: "Why lower the hours?", header: "DEFLATION REASON" },
  { key: "notes", label: "Additional notes", header: "NOTES" },
  { key: "note", label: "Note to the player", header: "NOTE TO THE PLAYER" },
];

// Note macros from Pixl's internal dashboard (apps/internal-dashboard/lib/reviewMacros.ts,
// MIT License, Copyright (c) 2026 Pixl), so community notes match what reviewers send.
const BAD_README_PREFIX =
  "Hiii :hii: !! cool project, super tuff :yay: !! but i noticed your readme doesnt meet all the requirements yet (like for example missing ";
const MACROS = [
  {
    trigger: "/ai",
    text:
      "Hey, this project is being rejected as it violates our policy against excessive AI use. " +
      "At Pixl and at Hack Club, we want to see your projects reflect your own growth and learning as a person, " +
      "not how well an AI can code.\n" +
      "To avoid rejections in the future, try to limit your AI usage to a minimum. A good rule of thumb: consider " +
      "whether you could make your project again, but without AI. The answer should always be yes.\n\n" +
      "Feel free to resubmit another project to Pixl!",
  },
  { trigger: "/fraud", text: "This project was banned by the fraud squad. Please check fraud.hackclub.com " },
  {
    trigger: "/readmeai",
    text:
      "heyy :hii:, i like your project, very tuff!! however your readme looks ai generated right now :(Could you please make one yourself from scratch?? thanks!! here's a handy template you can use for reference: https://gist.github.com/FaizeenHoque/0709576cc598721df07fb62d2430e6fe\n" +
      "good luck! :yay2:",
  },
  {
    trigger: "/badreadme",
    text:
      BAD_README_PREFIX +
      ") :( Could you please edit it so it does?? thanks!! here's a handy template you can use for reference: https://gist.github.com/FaizeenHoque/0709576cc598721df07fb62d2430e6fe\n" +
      "good luck! :yay2:",
    caretOffset: BAD_README_PREFIX.length,
  },
];

function expandMacro(value, caret) {
  const before = value.slice(0, caret);
  const lower = before.toLowerCase();
  for (const macro of MACROS) {
    if (!lower.endsWith(macro.trigger)) continue;
    const start = before.length - macro.trigger.length;
    if (start > 0 && !/\s/.test(before[start - 1])) continue;
    return {
      value: before.slice(0, start) + macro.text + value.slice(caret),
      caret: start + (macro.caretOffset ?? macro.text.length),
    };
  }
  return null;
}

let details = null;
let claimed = 0; // hours the maker claims, from Hackatime
let fb = null; // Firebase modules and handles, once loaded
let communityState = "loading"; // loading | off | ready | error
let communityError = "";
let user = null;
let admin = false;
let reviews = [];
let mine = null;
let touched = false;
let posting = false;
let firstCards = true;

const ms = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : 0);
const https = (url) => (/^https:\/\//.test(url || "") ? url : null);

function avatar(url, name, cls = "avatar") {
  const initial = () => el("span", { class: `${cls} blank`, "aria-hidden": "true" }, (name || "?").trim().charAt(0).toUpperCase());
  if (!https(url)) return initial();
  return el("img", {
    class: cls,
    src: url,
    alt: "",
    loading: "lazy",
    referrerpolicy: "no-referrer",
    onerror: (e) => e.target.replaceWith(initial()),
  });
}

/* ---------- the project ---------- */

function findInQueue(queue, pid) {
  for (const [name, q] of Object.entries(queue?.queues || {})) {
    const pos = q.waiting.findIndex((r) => String(r.id) === String(pid));
    if (pos >= 0) return { queue: name, pos: pos + 1, total: q.waiting.length, row: q.waiting[pos] };
    const fin = q.final_checks.find((r) => String(r.id) === String(pid));
    if (fin) return { queue: name, final: true, row: fin };
  }
  return null;
}

function stat(value, label) {
  return el("div", { class: "stat" }, el("b", {}, value), el("span", {}, label));
}

function renderProject(queue) {
  const p = details.project;
  const owner = details.owner || {};
  const at = findInQueue(queue, p.id);
  document.title = `${p.name} · Pixl queue`;

  let place = null;
  if (at?.final) place = el("span", { class: "chip place open" }, "Passed first review");
  else if (at) {
    const open = at.pos <= OPEN_COUNT;
    place = el(
      "span",
      { class: `chip place ${open ? "open" : "locked"}` },
      `#${at.pos} of ${at.total} in ${at.queue} · ${open ? "reviewers can open it" : "locked for now"}`,
    );
  }

  const journalHours = details.entries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
  const image = https(p.image_url);
  const links = el(
    "div",
    { class: "proj-links" },
    https(p.repo_url) ? el("a", { class: "btn small", href: p.repo_url, target: "_blank", rel: "noopener nofollow" }, "Repo") : null,
    https(p.demo_url) ? el("a", { class: "btn small", href: p.demo_url, target: "_blank", rel: "noopener nofollow" }, "Demo") : null,
    el("a", { class: "btn small", href: `https://pixl.hackclub.com/projects/${encodeURIComponent(p.id)}`, target: "_blank", rel: "noopener" }, "Pixl page"),
  );

  const desc = p.description ? richText(p.description, "rich desc") : null;
  let more = null;
  if (desc && p.description.length > 600) {
    desc.classList.add("clamped");
    more = el("button", { type: "button", class: "link-btn" }, "Show the whole description");
    more.addEventListener("click", () => {
      const clamped = desc.classList.toggle("clamped");
      more.textContent = clamped ? "Show the whole description" : "Show less";
    });
  }

  const card = $("project");
  card.removeAttribute("aria-busy");
  card.replaceChildren(
    el(
      "div",
      { class: "proj-top" },
      image
        ? el("a", { class: "proj-image", href: image, target: "_blank", rel: "noopener" }, el("img", { src: image, alt: "", referrerpolicy: "no-referrer" }))
        : el("div", { class: "proj-image blank" }),
      el(
        "div",
        { class: "proj-head" },
        el(
          "div",
          { class: "chips" },
          el("span", { class: "chip" }, `#${p.id}`),
          place,
          TIERS[p.level] ? el("span", { class: "chip tier" }, TIERS[p.level]) : null,
          el("span", { class: "chip" }, TYPES[p.project_type] || p.project_type || "-"),
          p.is_peak ? el("span", { class: "chip peak" }, "Beacon pick") : null,
          at && !at.row.wait_exact ? el("span", { class: "chip resub" }, "Resubmitted") : null,
        ),
        el("h1", { class: "proj-name" }, p.name),
        el(
          "p",
          { class: "proj-by" },
          avatar(owner.avatar_url, owner.display_name),
          el("span", {}, "by ", el("strong", {}, owner.display_name || "unknown")),
          at ? el("span", { class: "sep" }, `waiting ${waitText(at.row)}`) : null,
          p.shipped_at ? el("span", { class: "sep" }, `shipped ${fmtDate(p.shipped_at)}`) : null,
        ),
        links,
      ),
    ),
    el(
      "div",
      { class: "stats" },
      stat(`${claimed}h`, "on Hackatime"),
      stat(String(details.entries.length), `journal${details.entries.length === 1 ? "" : "s"}${journalHours ? ` · ${round1(journalHours)}h logged` : ""}`),
      stat(String(details.reviews.length), `past review${details.reviews.length === 1 ? "" : "s"}`),
      stat(fmtDate(p.created_at), "started"),
    ),
    desc ? el("div", { class: "desc-box" }, desc, more) : null,
  );
}

function renderMissing(queue) {
  const at = findInQueue(queue, id);
  const card = $("project");
  card.removeAttribute("aria-busy");
  card.replaceChildren(
    el("h1", { class: "proj-name" }, /^\d{1,8}$/.test(id) ? `#${id} isn't here` : "No project picked"),
    el(
      "p",
      { class: "lead" },
      at
        ? "It's in the queue, but its details haven't been fetched yet. They update about every 10 minutes, so check back soon."
        : /^\d{1,8}$/.test(id)
          ? "Review pages only exist for projects waiting in the review queue. This one may have been approved, sent back with \"needs changes\", or still be a draft."
          : "Open a project from the queue to see its review page.",
    ),
    el(
      "div",
      { class: "proj-links" },
      el("a", { class: "btn small red", href: "./" }, "Back to the queue"),
      /^\d{1,8}$/.test(id)
        ? el("a", { class: "btn small", href: `https://pixl.hackclub.com/projects/${encodeURIComponent(id)}`, target: "_blank", rel: "noopener" }, "Pixl page")
        : null,
    ),
  );
}

/* ---------- README, commits, journals, past reviews ---------- */

function githubRepo(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(url || "");
  return m ? { owner: m[1], repo: m[2] } : null;
}

const loading = (text) => el("p", { class: "panel-msg loading-text" }, text);

function panelMsg(text, link = null) {
  return el("div", { class: "panel-msg" }, el("p", {}, text), link);
}

function githubTrouble(res, what, url) {
  const open = el("a", { class: "btn small", href: url, target: "_blank", rel: "noopener" }, "Open on GitHub");
  if (!res) return panelMsg("Couldn't reach GitHub.", open);
  if (res.status === 404) return panelMsg(what === "README" ? "This repo has no README (or it's private)." : "GitHub can't find this repo. It may be private, renamed or deleted.", open);
  if (res.status === 403 || res.status === 429)
    return panelMsg("GitHub only answers 60 requests an hour per visitor without a login, and that's used up for now. Try again later or open it on GitHub.", open);
  return panelMsg(`GitHub answered with an error (${res.status}).`, open);
}

function notGithub() {
  const url = https(details.project.repo_url);
  return panelMsg(
    url ? "The repo isn't on GitHub, so it can't be previewed here." : "This project has no repo link.",
    url ? el("a", { class: "btn small", href: url, target: "_blank", rel: "noopener nofollow" }, "Open the repo") : null,
  );
}

function readmeCss() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return `
    :root { color-scheme: ${document.documentElement.dataset.theme === "dark" ? "dark" : "light"}; }
    body { margin: 0; padding: 4px 2px; font: 15px/1.6 "DM Sans", system-ui, -apple-system, sans-serif; color: ${v("--ink")}; background: transparent; overflow-wrap: anywhere; }
    a { color: ${v("--red")}; }
    img { max-width: 100%; height: auto; }
    h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 0.5em; }
    h1:first-child, h2:first-child { margin-top: 0; }
    h1, h2 { padding-bottom: 0.3em; border-bottom: 2px solid ${v("--border")}; }
    pre, code { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: ${v("--paper")}; border-radius: 6px; }
    code { padding: 0.1em 0.35em; }
    pre { padding: 12px; overflow: auto; border: 2px solid ${v("--border")}; }
    pre code { padding: 0; background: none; }
    table { border-collapse: collapse; display: block; overflow: auto; }
    td, th { border: 1.5px solid ${v("--border")}; padding: 4px 10px; }
    blockquote { margin: 0; padding: 0 1em; border-left: 4px solid ${v("--faint")}; color: ${v("--dim")}; }
    hr { border: 0; border-top: 2px solid ${v("--border")}; }
    .anchor, .octicon { display: none; }
  `;
}

function readmeTab() {
  const box = el("div", {}, loading("Loading the README from GitHub..."));
  const gh = githubRepo(details.project.repo_url);
  if (!gh) {
    box.replaceChildren(notGithub());
    return box;
  }
  const page = `https://github.com/${gh.owner}/${gh.repo}#readme`;
  (async () => {
    const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/readme`, {
      headers: { Accept: "application/vnd.github.html+json" },
    }).catch(() => null);
    if (!res || !res.ok) return box.replaceChildren(githubTrouble(res, "README", page));
    const html = await res.text();
    // No scripts can run in the frame (sandbox without allow-scripts); same
    // origin only so the page can size it to its content.
    const frame = el("iframe", {
      class: "readme-frame",
      title: "README",
      sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    });
    const fit = () => {
      const doc = frame.contentDocument;
      if (doc?.documentElement) frame.style.height = `${doc.documentElement.scrollHeight}px`;
    };
    const paint = () => {
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base href="https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/" target="_blank"><style>${readmeCss()}</style></head><body>${html}</body></html>`;
    };
    frame.addEventListener("load", () => {
      fit();
      frame.contentDocument?.addEventListener("load", fit, true); // images arriving
    });
    window.addEventListener("resize", fit);
    document.addEventListener("themechange", paint);
    paint();
    box.replaceChildren(
      el("div", { class: "panel-bar" }, el("span", {}, `${gh.owner}/${gh.repo}`), el("a", { href: page, target: "_blank", rel: "noopener" }, "Open on GitHub")),
      frame,
    );
  })();
  return box;
}

function span(msValue) {
  const mins = msValue / 60000;
  if (mins < 60) return `${Math.max(1, Math.round(mins))} min`;
  if (mins < 48 * 60) return `${round1(mins / 60)}h`;
  return `${Math.round(mins / 1440)} days`;
}

function commitsTab() {
  const box = el("div", {}, loading("Loading commits from GitHub..."));
  const gh = githubRepo(details.project.repo_url);
  if (!gh) {
    box.replaceChildren(notGithub());
    return box;
  }
  const page = `https://github.com/${gh.owner}/${gh.repo}/commits`;
  (async () => {
    const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/commits?per_page=100`).catch(() => null);
    if (!res || !res.ok) return box.replaceChildren(githubTrouble(res, "commits", page));
    const commits = await res.json();
    if (!Array.isArray(commits) || !commits.length) return box.replaceChildren(panelMsg("No commits yet."));
    const more = /rel="next"/.test(res.headers.get("Link") || "");
    const when = (c) => Date.parse(c.commit?.author?.date || c.commit?.committer?.date);
    const times = commits.map(when).filter(Number.isFinite).sort((a, b) => a - b);
    let gap = 0;
    for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i] - times[i - 1]);
    const days = new Set(times.map((t) => new Date(t).toISOString().slice(0, 10))).size;
    box.replaceChildren(
      el(
        "div",
        { class: "stats compact" },
        stat(`${commits.length}${more ? "+" : ""}`, "commits"),
        stat(String(days), `active day${days === 1 ? "" : "s"}`),
        stat(`${fmtDate(times[0])} → ${fmtDate(times.at(-1))}`, "first → latest"),
        stat(times.length > 1 ? span(gap) : "-", "longest gap"),
      ),
      el(
        "ol",
        { class: "commits" },
        commits.map((c) => {
          const message = c.commit?.message || "";
          const t = when(c);
          return el(
            "li",
            {},
            el("a", { class: "sha", href: c.html_url, target: "_blank", rel: "noopener" }, c.sha.slice(0, 7)),
            el("span", { class: "msg", title: message }, message.split("\n")[0] || "(no message)"),
            el("span", { class: "who" }, `${c.author?.login || c.commit?.author?.name || "?"} · ${Number.isFinite(t) ? timeAgo(t) : ""}`),
          );
        }),
      ),
      more ? el("p", { class: "panel-foot" }, "Showing the latest 100. ", el("a", { href: page, target: "_blank", rel: "noopener" }, "All commits on GitHub")) : null,
    );
  })();
  return box;
}

function journalsTab() {
  if (!details.entries.length) return panelMsg("No journal entries.");
  const entries = [...details.entries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return el(
    "div",
    { class: "entries" },
    entries.map((e) =>
      el(
        "article",
        { class: "entry" },
        el(
          "header",
          {},
          el("h3", {}, e.title || "Untitled"),
          el(
            "span",
            { class: "entry-meta" },
            new Date(e.created_at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }),
            Number(e.hours) > 0 ? el("span", { class: "chip" }, `${round1(Number(e.hours))}h`) : null,
            e.edited_at ? el("span", { class: "chip" }, "edited") : null,
          ),
        ),
        richText(e.content),
      ),
    ),
  );
}

function pastTab() {
  if (!details.reviews.length) return panelMsg("No reviews yet. This is its first time in the queue.");
  const list = [...details.reviews].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return el(
    "div",
    {},
    el("p", { class: "panel-foot top" }, "What Pixl's reviewers sent the maker. Their internal audit notes aren't public."),
    el(
      "div",
      { class: "entries" },
      list.map((r) => {
        const v = OFFICIAL[r.verdict] || { label: r.verdict, cls: "" };
        const hours =
          r.claimed_hours != null
            ? r.approved_hours != null
              ? `${r.approved_hours}h approved of ${r.claimed_hours}h`
              : `${r.claimed_hours}h claimed`
            : null;
        return el(
          "article",
          { class: "entry" },
          el(
            "header",
            {},
            el("span", { class: `verdict ${v.cls}` }, v.label),
            el("span", { class: "entry-meta" }, fmtDate(r.created_at), hours ? el("span", { class: "chip" }, hours) : null),
          ),
          r.note ? richText(r.note) : el("p", { class: "muted" }, "No note."),
        );
      }),
    ),
  );
}

function setupWork() {
  const built = {};
  const make = { readme: readmeTab, commits: commitsTab, journals: journalsTab, past: pastTab };
  $("c-journals").textContent = details.entries.length;
  $("c-past").textContent = details.reviews.length;
  const show = (name) => {
    document.querySelectorAll("#work-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    built[name] ||= make[name]();
    const panel = $("work-panel");
    panel.replaceChildren(built[name]);
    panel.classList.remove("swap");
    void panel.offsetWidth;
    panel.classList.add("swap");
  };
  document.querySelectorAll("#work-tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  show("readme");
}

/* ---------- your review ---------- */

const form = () => $("form");
const texts = () => FIELDS.map((f) => f.key);

function defaults() {
  return {
    verdict: "",
    tier: details.project.level || 1,
    hours: claimed,
    technical_features: "",
    deflation_reason: "",
    notes: "",
    note: "",
  };
}

function clampHours(value) {
  const n = Number(value);
  return Number.isFinite(n) ? round1(Math.min(claimed, Math.max(0, n))) : claimed;
}

function readForm() {
  const r = {
    verdict: form().elements.verdict.value || "",
    tier: Number($("tier").value) || 1,
    hours: clampHours($("hours").value === "" ? claimed : $("hours").value),
  };
  for (const key of texts()) r[key] = $(key).value;
  return r;
}

function fillForm(r) {
  for (const radio of form().elements.verdict) radio.checked = radio.value === r.verdict;
  $("tier").value = String(Math.min(4, Math.max(1, Number(r.tier) || 1)));
  const hours = clampHours(r.hours ?? claimed);
  $("hours").value = hours;
  $("hours-range").value = hours;
  for (const key of texts()) $(key).value = r[key] || "";
  updateDerived();
}

const blank = (r) => texts().every((k) => !String(r[k] || "").trim());

function same(a, b) {
  if (!a || !b) return false;
  return (
    a.verdict === b.verdict &&
    Number(a.tier) === Number(b.tier) &&
    clampHours(a.hours) === clampHours(b.hours) &&
    texts().every((k) => k === "deflation_reason" && clampHours(a.hours) >= claimed ? true : String(a[k] || "").trim() === String(b[k] || "").trim())
  );
}

function formatReview(r) {
  const deflated = round1(Number(r.claimed_hours ?? claimed) - Number(r.hours));
  const head = [
    r.verdict ? `Verdict: ${VERDICTS[r.verdict]?.label || r.verdict}` : null,
    `Tier: ${TIERS[r.tier] || r.tier}`,
    `Hours: ${r.hours}h of ${r.claimed_hours ?? claimed}h${deflated > 0 ? ` (${deflated}h deflated)` : ""}`,
  ].filter(Boolean);
  const sections = FIELDS.filter((f) => String(r[f.key] || "").trim() && !(f.key === "deflation_reason" && deflated <= 0)).map(
    (f) => `${f.header}:\n${String(r[f.key]).trim()}`,
  );
  return [head.join("\n"), ...sections].join("\n\n");
}

function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

let savedAt = 0;
function saveDraft() {
  touched = true;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...readForm(), saved_at: Date.now() }));
    savedAt = Date.now();
  } catch {
    savedAt = -1; // storage full or blocked
  }
  updateStatus();
}

function updateStatus() {
  const box = $("save-status");
  const r = readForm();
  let text;
  let tone = "";
  let action = null;
  if (savedAt === -1) {
    text = "Can't save drafts in this browser";
    tone = "bad";
  } else if (mine && same(r, mine)) {
    text = "Posted, up to date";
    tone = "ok";
  } else if (mine) {
    text = "Edited since you posted";
    tone = "warn";
    action = el("button", { type: "button", class: "link-btn", onclick: () => confirm("Swap your draft for the review you posted?") && (fillForm(mine), saveDraft()) }, "Load posted");
  } else if (savedAt || readDraft()) {
    text = "Draft saved in this browser";
    tone = "ok";
  } else {
    text = "Autosaves as you type";
  }
  box.className = `save-status ${tone}`;
  box.replaceChildren(...[el("span", { class: "save-dot" }), text, action && " · ", action].filter(Boolean));
}

function updateDerived() {
  const tier = Number($("tier").value) || 1;
  $("tier-blurb").textContent = TIER_BLURBS[tier];
  const hours = clampHours($("hours").value === "" ? claimed : $("hours").value);
  const cut = round1(claimed - hours);
  const deflate = $("deflate");
  if (cut > 0) {
    deflate.className = "deflate on";
    deflate.textContent = `${cut}h deflated (${Math.round((cut / (claimed || 1)) * 100)}% off): ${hours}h credited`;
  } else {
    deflate.className = "deflate";
    deflate.textContent = "Full hours. Drag down or type a lower number to deflate.";
  }
  $("hours-range").style.setProperty("--fill", `${claimed ? (hours / claimed) * 100 : 100}%`);
  $("deflation-field").hidden = cut <= 0;
  $("deflation-label").textContent = `Why lower the hours? (${claimed}h claimed → ${hours}h credited)`;
  const len = $("technical_features").value.trim().length;
  $("tf-count").textContent = `${Math.min(len, 9999)}/${TECHNICAL_FEATURES_MIN}`;
  $("tf-count").classList.toggle("done", len >= TECHNICAL_FEATURES_MIN);
  updateStatus();
}

function say(text, tone = "") {
  const msg = $("form-msg");
  msg.className = `form-msg ${tone}`;
  msg.textContent = text;
  if (text) {
    msg.classList.remove("show");
    void msg.offsetWidth;
    msg.classList.add("show");
  }
}

function problemWith(r) {
  if (!r.verdict) return "Pick a verdict first.";
  if (r.technical_features.trim().length < TECHNICAL_FEATURES_MIN)
    return `Technical features needs at least ${TECHNICAL_FEATURES_MIN} characters.`;
  if (r.hours < claimed && !r.deflation_reason.trim()) return "Say why you lowered the hours.";
  if (r.verdict === "approved" && !r.notes.trim()) return "Additional notes are required for an approval.";
  if (!r.note.trim()) return "Write a note to the player.";
  if (/missing\s*(?:X\b|\)\s*:\()/i.test(r.note)) return "Fill in what the README is missing in the /badreadme note.";
  return null;
}

function updatePostButton() {
  const post = $("post");
  post.disabled = posting;
  if (posting) post.textContent = "Posting...";
  else if (communityState !== "ready") post.textContent = "Post review";
  else if (!user) post.textContent = "Sign in with Google to post";
  else post.textContent = mine ? "Update review" : "Post review";
  $("delete-mine").hidden = !mine;
}

async function post(event) {
  event.preventDefault();
  const r = readForm();
  const problem = problemWith(r);
  if (problem) return say(problem, "bad");
  if (communityState === "off")
    return say("Posting isn't switched on for this copy of the site yet. Your draft is saved here, and the copy buttons work.", "bad");
  if (communityState !== "ready") return say("Community reviews didn't load, so posting can't work right now. Your draft is safe here.", "bad");
  if (!user) {
    await signIn();
    if (!user) return;
  }
  if (!$("attest").checked) return say("Tick the box to confirm you didn't make this project and checked it yourself.", "bad");

  const { doc, setDoc, serverTimestamp } = fb.S;
  const deflated = r.hours < claimed;
  const data = {
    project_id: id,
    uid: user.uid,
    author: user.displayName || "",
    photo: user.photoURL || "",
    verdict: r.verdict,
    tier: r.tier,
    claimed_hours: claimed,
    hours: r.hours,
    technical_features: r.technical_features.trim(),
    deflation_reason: deflated ? r.deflation_reason.trim() : "",
    notes: r.notes.trim(),
    note: r.note.trim(),
    created_at: mine?.raw?.created_at || serverTimestamp(),
    updated_at: serverTimestamp(),
  };
  const editing = !!mine;
  posting = true;
  updatePostButton();
  try {
    await setDoc(doc(fb.db, "reviews", `${id}_${user.uid}`), data);
    say(editing ? "Updated." : "Posted! Thanks for helping the queue move.", "ok");
  } catch (err) {
    say(
      err?.code === "permission-denied"
        ? "Firebase turned that down. Reload and try again; if it keeps happening, you may have been blocked from posting."
        : `Couldn't post: ${err?.message || err}`,
      "bad",
    );
  }
  posting = false;
  updatePostButton();
  updateStatus();
}

async function deleteMine() {
  if (!mine || !confirm("Delete your posted review? Your draft stays in this browser.")) return;
  try {
    await fb.S.deleteDoc(fb.S.doc(fb.db, "reviews", mine.id));
    say("Deleted. Your draft is still here.", "ok");
  } catch (err) {
    say(`Couldn't delete: ${err?.message || err}`, "bad");
  }
}

function setupForm() {
  $("hours").max = claimed;
  $("hours-range").max = claimed;
  $("hours-of").textContent = `of ${claimed}h claimed`;

  for (const f of FIELDS) {
    document
      .querySelector(`[data-field="${f.key}"] .label-row`)
      .append(copyButton("Copy", () => $(f.key).value.trim(), { cls: "btn copy sm" }));
  }
  $("form-tools").append(
    copyButton("Copy whole review", () => formatReview(readForm())),
    el(
      "button",
      {
        type: "button",
        class: "btn copy",
        onclick: () => {
          if (!confirm("Clear your draft? A review you already posted stays posted.")) return;
          try {
            localStorage.removeItem(DRAFT_KEY);
          } catch {}
          savedAt = 0;
          fillForm(defaults());
          say("");
        },
      },
      "Clear",
    ),
  );

  const draft = readDraft();
  fillForm(draft ? { ...defaults(), ...draft } : defaults());
  if (draft) savedAt = draft.saved_at || 1;

  form().addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "note" && e.inputType?.startsWith("insert")) {
      const expanded = expandMacro(t.value, t.selectionStart ?? t.value.length);
      if (expanded) {
        t.value = expanded.value;
        t.setSelectionRange(expanded.caret, expanded.caret);
      }
    }
    if (t.id === "hours-range") $("hours").value = t.value;
    if (t.id === "hours" && t.value !== "") $("hours-range").value = clampHours(t.value);
    if (t.id === "attest") return;
    updateDerived();
    saveDraft();
  });
  form().addEventListener("change", (e) => {
    if (e.target.id === "attest") return;
    if (e.target.id === "hours") {
      e.target.value = clampHours(e.target.value === "" ? claimed : e.target.value);
      $("hours-range").value = e.target.value;
    }
    updateDerived();
    saveDraft();
  });
  form().addEventListener("submit", post);
  $("delete-mine").addEventListener("click", deleteMine);
  updatePostButton();
}

/* ---------- community reviews ---------- */

function useAsDraft(r) {
  if (!blank(readForm()) && !confirm(`Replace your draft with ${r.author || "this"}'s review?`)) return;
  fillForm({ ...r, hours: Math.min(r.hours, claimed) });
  saveDraft();
  $("mine").scrollIntoView({ behavior: "smooth", block: "start" });
  say("Loaded into your draft. Check everything yourself before posting or pasting it anywhere.", "ok");
}

async function removeReview(r, ban) {
  const question = ban
    ? `Ban ${r.author || "this person"}? They can't post or edit reviews any more, and this review is deleted.`
    : `Delete ${r.uid === user?.uid ? "your" : `${r.author || "this"}'s`} review?`;
  if (!confirm(question)) return;
  const { doc, deleteDoc, setDoc, serverTimestamp } = fb.S;
  try {
    if (ban) await setDoc(doc(fb.db, "banned", r.uid), { name: r.author || "", by: user.uid, at: serverTimestamp() });
    await deleteDoc(doc(fb.db, "reviews", r.id));
  } catch (err) {
    alert(`Couldn't do that: ${err?.message || err}`);
  }
}

function reviewCard(r, i) {
  const isMine = user && r.uid === user.uid;
  const v = VERDICTS[r.verdict] || { label: r.verdict, cls: "" };
  const cut = round1(Number(r.claimed_hours) - Number(r.hours));
  const updated = ms(r.updated_at);
  const edited = updated - ms(r.created_at) > 60000;
  const card = el(
    "article",
    { class: `rv${isMine ? " mine" : ""}` },
    el(
      "header",
      { class: "rv-head" },
      avatar(r.photo, r.author),
      el(
        "div",
        { class: "rv-who" },
        el("strong", {}, r.author || "Someone", isMine ? el("span", { class: "chip you" }, "You") : null),
        el("small", {}, updated ? `${timeAgo(updated)}${edited ? " · edited" : ""}` : "just now"),
      ),
      el(
        "div",
        { class: "rv-tags" },
        el("span", { class: `verdict ${v.cls}` }, v.label),
        TIERS[r.tier] ? el("span", { class: "chip tier" }, TIERS[r.tier]) : null,
        el("span", { class: `chip${cut > 0 ? " cut" : ""}` }, cut > 0 ? `${r.hours}h of ${r.claimed_hours}h · -${cut}h` : `${r.hours}h, full`),
      ),
    ),
    FIELDS.filter((f) => String(r[f.key] || "").trim()).map((f) =>
      el(
        "section",
        { class: "rv-field" },
        el("div", { class: "rv-field-head" }, el("span", { class: "label" }, f.label), copyButton("Copy", () => String(r[f.key]).trim(), { cls: "btn copy sm" })),
        richText(r[f.key]),
      ),
    ),
    el(
      "footer",
      { class: "rv-actions" },
      copyButton("Copy whole review", () => formatReview(r)),
      isMine ? null : el("button", { type: "button", class: "btn copy", onclick: () => useAsDraft(r) }, "Use as my draft"),
      isMine || admin ? el("button", { type: "button", class: "btn copy danger", onclick: () => removeReview(r, false) }, "Delete") : null,
      admin && !isMine ? el("button", { type: "button", class: "btn copy danger", onclick: () => removeReview(r, true) }, "Ban author") : null,
    ),
  );
  if (firstCards) card.style.setProperty("--i", i);
  return card;
}

function renderCommunity() {
  const list = $("rv-list");
  $("rv-count").textContent = reviews.length ? String(reviews.length) : "";
  if (communityState === "loading") return;
  if (communityState === "off") {
    list.replaceChildren(
      panelMsg(
        "Community reviews aren't switched on for this copy of the site yet. You can still write one in the Your review form: it saves in this browser and every copy button works.",
      ),
    );
    return;
  }
  if (communityState === "error") {
    list.replaceChildren(panelMsg(communityError));
    return;
  }
  if (!reviews.length) {
    list.replaceChildren(
      el("div", { class: "panel-msg empty-state" }, el("p", {}, el("strong", {}, "No community reviews yet."), " Be the first: check the work below and write yours in the form."), ),
    );
    return;
  }
  list.classList.toggle("enter", firstCards);
  list.replaceChildren(...reviews.map(reviewCard));
  firstCards = false;
}

const GOOGLE_G = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

function googleIcon() {
  const t = document.createElement("template");
  t.innerHTML = GOOGLE_G; // a fixed string, nothing user-provided
  return t.content.firstChild;
}

async function signIn() {
  if (!fb) return;
  try {
    await fb.A.signInWithPopup(fb.auth, new fb.A.GoogleAuthProvider());
  } catch (err) {
    if (["auth/popup-closed-by-user", "auth/cancelled-popup-request"].includes(err?.code)) return;
    say(
      err?.code === "auth/unauthorized-domain"
        ? "Sign-in isn't allowed on this domain yet (Firebase console > Authentication > Settings > Authorized domains)."
        : `Couldn't sign in: ${err?.code || err?.message || err}`,
      "bad",
    );
  }
}

function renderAccount() {
  const box = $("account");
  box.hidden = communityState !== "ready";
  if (!user) {
    box.replaceChildren(el("button", { type: "button", class: "btn", onclick: signIn }, googleIcon(), "Sign in"));
    return;
  }
  const first = (user.displayName || "Account").split(" ")[0];
  box.replaceChildren(
    el(
      "button",
      {
        type: "button",
        class: "btn account-btn",
        title: `Signed in as ${user.displayName || "you"}. Click to sign out.`,
        onclick: () => confirm("Sign out?") && fb.A.signOut(fb.auth),
      },
      avatar(user.photoURL, user.displayName, "avatar sm"),
      el("span", {}, first),
    ),
  );
}

async function onUser(u) {
  user = u;
  admin = false;
  // A write still on its way when the account changed waits for that account
  // to sign in again; don't leave this one stuck on "Posting...".
  posting = false;
  mine = user ? reviews.find((r) => r.uid === user.uid) || null : null;
  renderAccount();
  updatePostButton();
  restorePosted();
  renderCommunity();
  updateStatus();
  if (u) {
    const snap = await fb.S.getDoc(fb.S.doc(fb.db, "admins", u.uid)).catch(() => null);
    admin = !!snap?.exists();
    if (admin) renderCommunity();
  }
}

// With no draft in this browser, start from the review you already posted.
function restorePosted() {
  if (mine && !touched && !readDraft()) fillForm(mine);
}

async function startCommunity(config) {
  if (!config) {
    communityState = "off";
    renderCommunity();
    updatePostButton();
    return;
  }
  try {
    const [app, A, S] = await Promise.all([
      import(`${FIREBASE}/firebase-app.js`),
      import(`${FIREBASE}/firebase-auth.js`),
      import(`${FIREBASE}/firebase-firestore.js`),
    ]);
    const firebaseApp = app.initializeApp(config);
    fb = { A, S, auth: A.getAuth(firebaseApp), db: S.getFirestore(firebaseApp) };
    if (config.emulators) {
      // Local testing against `firebase emulators:start` (see the README).
      A.connectAuthEmulator(fb.auth, `http://${location.hostname}:9099`, { disableWarnings: true });
      S.connectFirestoreEmulator(fb.db, location.hostname, 8095);
      window.emulatorSignIn = (claims) => A.signInWithCredential(fb.auth, A.GoogleAuthProvider.credential(JSON.stringify(claims)));
    }
  } catch {
    communityState = "error";
    communityError = "Couldn't load community reviews. An ad or tracker blocker may be blocking Firebase (gstatic.com).";
    renderCommunity();
    return;
  }
  communityState = "ready";
  renderAccount();
  updatePostButton();
  fb.A.onAuthStateChanged(fb.auth, onUser);
  const { collection, onSnapshot, query, where } = fb.S;
  onSnapshot(
    query(collection(fb.db, "reviews"), where("project_id", "==", id)),
    (snap) => {
      reviews = snap.docs
        .map((d) => ({ id: d.id, raw: d.data(), ...d.data({ serverTimestamps: "estimate" }) }))
        .sort((a, b) => ms(b.updated_at) - ms(a.updated_at));
      mine = user ? reviews.find((r) => r.uid === user.uid) || null : null;
      restorePosted();
      renderCommunity();
      updatePostButton();
      updateStatus();
    },
    (err) => {
      communityState = "error";
      communityError = `Couldn't load community reviews (${err?.code || err?.message || err}).`;
      renderCommunity();
    },
  );
}

/* ---------- start ---------- */

async function main() {
  setupTheme();
  const valid = /^\d{1,8}$/.test(id);
  const [found, queue, config] = await Promise.all([
    valid ? fetchJSON(`p/${id}.json`) : null,
    fetchJSON("queue.json"),
    fetchJSON("reviews-config.json"),
  ]);
  if (!found?.project) return renderMissing(queue);
  details = found;
  details.entries ||= [];
  details.reviews ||= [];
  claimed = round1((Number(details.project.hackatime_seconds) || 0) / 3600);
  if (queue?.api_locked_since) {
    $("banner").hidden = false;
    $("banner").textContent = "Pixl stopped showing unreviewed projects publicly, so these details may be out of date.";
  }
  renderProject(queue);
  $("workspace").hidden = false;
  setupWork();
  setupForm();
  startCommunity(config?.firebase || null);
}

main();
