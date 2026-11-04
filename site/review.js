// A public copy of Pixl's review dash (apps/internal-dashboard/app/review/[id]
// in hackclub/pixl, MIT License, Copyright (c) 2026 Pixl) for one queued
// project, plus anonymous community reviews that real reviewers can copy.

import { OPEN_COUNT, TIERS, TYPES, el, fetchJSON, fmtDate, round1, setupTheme, timeAgo, waitText } from "./shared.js";
import { PIXEL_VALUE_USD, averageUsdPerHourOver, levelForRe, pxPerHourOver, reForHours, rePerHour } from "./dash/economy.js";

const $ = (id) => document.getElementById(id);
const id = (new URLSearchParams(location.search).get("id") || "").replace(/^#/, "").trim();
const DRAFT_KEY = `pq-draft-${id}`;
const KEY_KEY = "pq-key";
const ADMIN_KEY = "pq-admin";
const SPLIT_KEY = "pq-split";
const TECHNICAL_FEATURES_MIN = 20;
const DEFAULT_PANEL = 460;

const TIER_BLURBS = {
  1: "A simple site, script, or tiny tool",
  2: "A focused app, CLI, or game with clean polish",
  3: "Multiple systems together: backend, state, infra",
  4: "Deep systems work, serious scope",
};
const VERDICTS = {
  approved: { label: "Approve", tone: "success" },
  needs_changes: { label: "Request changes", tone: "danger" },
  ban: { label: "Perm reject", tone: "danger" },
};
const OFFICIAL = {
  approved: { label: "Approved", tone: "success" },
  first_pass_approved: { label: "Approved (1st pass)", tone: "success" },
  needs_changes: { label: "Needs changes", tone: "danger" },
  banned: { label: "Banned", tone: "danger" },
  rejected: { label: "Rejected", tone: "danger" },
};
const STATUS = {
  shipped: { label: "In review", tone: "warning" },
  fraud_review: { label: "Fraud review", tone: "info" },
  second_review: { label: "Final review", tone: "cyan" },
};
// The order and headers of the dash's audit note, so a whole review pastes cleanly.
const FIELDS = [
  { key: "technical_features", label: "Technical features", header: "TECHNICAL FEATURES" },
  { key: "deflation_reason", label: "Why lower the hours?", header: "DEFLATION REASON" },
  { key: "notes", label: "Additional notes", header: "NOTES" },
  { key: "note", label: "Note to the player", header: "NOTE TO THE PLAYER" },
];

// From apps/internal-dashboard/lib/reviewMacros.ts.
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
    return { value: before.slice(0, start) + macro.text + value.slice(caret), caret: start + (macro.caretOffset ?? macro.text.length) };
  }
  return null;
}

// From apps/internal-dashboard/lib/commits.ts: commits AI tooling signed.
const AI_MESSAGE_RX =
  /co-authored-by:.*(claude|copilot|chatgpt|gpt|cursor|devin|aider|codex|gemini|jules|windsurf)|generated with \[?(claude|chatgpt|cursor|copilot|aider|codex)|🤖 generated/i;
const AI_AUTHOR_RX = /(^|\b)(claude|copilot|devin-ai|cursor-?agent|aider|codex|jules|chatgpt)(\b|\[bot\])|noreply@anthropic\.com|bot@openai\.com/i;

let details = null;
let claimed = 0;
let api = null; // community reviews API base, or null when not connected
let key = null;
let me = null; // { author, name }
let adminKey = null;
let reviews = [];
let reviewsState = "loading"; // loading | ready | off | error
let reviewsError = "";
let touched = false;
let posting = false;
let savedAt = 0;
let picked = ""; // the verdict last chosen, kept with the draft
let refreshTab = () => {};

const https = (url) => (/^https:\/\//.test(url || "") ? url : null);
const mine = () => (me ? reviews.find((r) => r.author === me.author) || null : null);
const anonName = (author) => `Anon #${String(author).slice(0, 4).toUpperCase()}`;

/* ---------- small dash components ---------- */

const badge = (text, tone = "neutral", attrs = {}) => el("span", { class: "hc-badge", "data-tone": tone, ...attrs }, text);
const countBadge = (n) => el("span", { class: "hc-badge", "data-variant": "count" }, String(n));
const callout = (tone, ...children) => el("div", { class: "hc-callout", "data-tone": tone }, el("div", { class: "rq-grow" }, ...children));
const empty = (title, body) => el("div", { class: "hc-empty" }, el("p", { class: "hc-empty-title" }, title), body ? el("p", { class: "hc-empty-body" }, body) : null);
const linkBtn = (href, text, variant = "hc-btn hc-btn-outline") => el("a", { class: variant, href, target: "_blank", rel: "noopener nofollow" }, text);

function avatar(url, size = 40) {
  return https(url)
    ? el("img", { class: "hc-avatar", src: url, alt: "", width: size, height: size, loading: "lazy", referrerpolicy: "no-referrer" })
    : el("span", { class: "hc-avatar hc-muted", style: `width:${size}px;height:${size}px;display:inline-flex` });
}

function copyBtn(getText, label = "Copy", cls = "hc-btn hc-btn-ghost hc-btn-sm rq-copy") {
  const button = el("button", { type: "button", class: cls }, label);
  button.addEventListener("click", async () => {
    const text = getText();
    let result = "Nothing to copy";
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
        result = "Copied!";
        button.dataset.done = "";
      } catch {
        result = "Couldn't copy";
      }
    }
    button.textContent = result;
    setTimeout(() => {
      button.textContent = label;
      delete button.dataset.done;
    }, 1400);
  });
  return button;
}

const TOKEN = /!\[[^\]]*\]\((https:\/\/[^)\s]+)\)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/g;

// Maker and reviewer text: paragraphs, links and markdown images, built as
// DOM nodes so nothing in it can run.
function rich(text) {
  const box = el("div", { class: "rq-rich" });
  for (const para of String(text || "").replace(/\r\n?/g, "\n").split(/\n{2,}/).filter((p) => p.trim())) {
    const p = el("p");
    para.split("\n").forEach((line, i) => {
      if (i) p.append(el("br"));
      let last = 0;
      for (const m of line.matchAll(TOKEN)) {
        p.append(line.slice(last, m.index));
        if (m[1]) p.append(el("img", { src: m[1], alt: "", loading: "lazy", referrerpolicy: "no-referrer" }));
        else p.append(el("a", { href: m[3] || m[4], target: "_blank", rel: "noopener nofollow ugc" }, m[2] || m[3] || m[4]));
        last = m.index + m[0].length;
      }
      p.append(line.slice(last));
    });
    box.append(p);
  }
  return box;
}

// A 5x5 mirrored pixel avatar from the author id, so anonymous reviewers are
// still easy to tell apart.
function identicon(author, cls = "rq-identicon") {
  const canvas = el("canvas", { class: cls, width: 5, height: 5, "aria-hidden": "true" });
  const ctx = canvas.getContext("2d");
  const hex = String(author).padEnd(16, "0");
  ctx.fillStyle = `hsl(${parseInt(hex.slice(0, 3), 16) % 360} 70% 58%)`;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (parseInt(hex[(y * 3 + x + 3) % 16], 16) % 2) {
        ctx.fillRect(x, y, 1, 1);
        ctx.fillRect(4 - x, y, 1, 1);
      }
    }
  }
  return canvas;
}

/* ---------- anonymous identity ---------- */

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadIdentity() {
  try {
    key = localStorage.getItem(KEY_KEY);
  } catch {}
  if (!/^[0-9a-f]{64}$/.test(key || "")) {
    key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    try {
      localStorage.setItem(KEY_KEY, key);
    } catch {}
  }
  const author = (await sha256Hex(key)).slice(0, 16);
  me = { author, name: anonName(author) };
}

function renderIdentity() {
  const useKey = () => {
    const given = (prompt("Paste the reviewer key from your other device:") || "").trim().toLowerCase();
    if (!given) return;
    if (!/^[0-9a-f]{64}$/.test(given)) return alert("That isn't a reviewer key (64 characters, 0-9 and a-f).");
    try {
      localStorage.setItem(KEY_KEY, given);
    } catch {}
    location.reload();
  };
  const box = $("identity");
  box.title = "Your reviewer key lives only in this browser. Copy it to edit your reviews from another device.";
  box.replaceChildren(
    identicon(me.author, "rq-identicon sm"),
    el("span", {}, "Posting anonymously as ", el("b", {}, me.name)),
    el(
      "details",
      {},
      el("summary", {}, "Key"),
      el(
        "div",
        { class: "rq-key-menu" },
        copyBtn(() => key, "Copy my key", "hc-btn hc-btn-outline hc-btn-sm rq-copy"),
        el("button", { type: "button", class: "hc-btn hc-btn-outline hc-btn-sm", onclick: useKey }, "Use a key"),
      ),
    ),
  );
}

/* ---------- reviews API ---------- */

async function callApi(path, { method = "GET", body } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The reviews server answered ${res.status}.`);
  return data;
}

async function loadReviews() {
  if (!api) {
    reviewsState = "off";
    refreshTab("community");
    return;
  }
  try {
    const data = await callApi(`/api/reviews?project=${encodeURIComponent(id)}`);
    reviews = data.reviews || [];
    reviewsState = "ready";
  } catch (e) {
    if (reviewsState !== "ready") {
      reviewsState = "error";
      reviewsError = e.message;
    }
  }
  restorePosted();
  updateStatus();
  updateVerdictButtons();
  refreshTab("community");
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

function githubRepo(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(url || "");
  return m ? { owner: m[1], repo: m[2] } : null;
}

function ownerCard() {
  const p = details.project;
  const o = details.owner || {};
  const maker = details.maker;
  const item = (value, label) => el("span", {}, el("b", {}, value), label ? ` ${label}` : null);
  const meta = el("div", { class: "rq-owner-meta" });
  if (maker) {
    meta.append(
      item(`Lvl ${maker.level ?? "?"}`),
      item(`${round1(Number(maker.xp_hours) || 0)}h`, "approved before"),
      item(String(maker.approved?.length || 0), `approved project${maker.approved?.length === 1 ? "" : "s"}`),
      maker.created_at ? item(fmtDate(maker.created_at), "joined Pixl") : null,
    );
  }
  meta.append(item(`${claimed}h`, "on Hackatime"));

  const ghLine = el("span", { class: "hc-caption rq-xs" });
  const gh = githubRepo(p.repo_url);
  if (gh) {
    fetch(`https://api.github.com/users/${gh.owner}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        if (!u) return;
        ghLine.replaceChildren(
          "GitHub ",
          el("a", { class: "hc-link", href: u.html_url, target: "_blank", rel: "noopener" }, `@${u.login}`),
          `: ${u.public_repos} public repos, ${u.followers} followers, joined ${new Date(u.created_at).getFullYear()}`,
        );
      })
      .catch(() => {});
  }

  const earlier = maker?.approved?.length
    ? el(
        "details",
        { class: "hc-details" },
        el("summary", {}, `Earlier approved Pixl projects (${maker.approved.length})`),
        el(
          "div",
          { class: "hc-details-body" },
          el(
            "ul",
            { class: "rq-xs" },
            maker.approved.slice(0, 20).map((a) =>
              el(
                "li",
                {},
                el("a", { class: "hc-link", href: `https://pixl.hackclub.com/projects/${a.id}`, target: "_blank", rel: "noopener" }, a.name),
                ` · ${TIERS[a.level] || "?"} · ${a.approved_hours ?? round1((a.hackatime_seconds || 0) / 3600)}h`,
              ),
            ),
          ),
        ),
      )
    : null;

  return el(
    "div",
    { class: "hc-card", "data-density": "compact" },
    el("div", { class: "rq-owner" }, avatar(o.avatar_url), el("div", { class: "rq-grow" }, el("div", { class: "rq-owner-name" }, o.display_name || "Unknown maker"), meta, ghLine)),
    earlier,
  );
}

function renderLeft(queue) {
  const p = details.project;
  const at = findInQueue(queue, p.id);
  const status = STATUS[p.status] || { label: p.status, tone: "neutral" };
  document.title = `${p.name} · Review · Pixl queue`;

  let place = null;
  if (at && !at.final) {
    const open = at.pos <= OPEN_COUNT;
    place = badge(`#${at.pos} of ${at.total} in ${at.queue}${open ? "" : " · locked"}`, open ? "success" : "neutral", {
      title: open ? "In the top 15: reviewers can open it now" : "Below the top 15: reviewers can't open it yet",
    });
  }

  // Screenshot and description side by side, so the tabs aren't a long scroll away.
  const image = https(p.image_url);
  let about = null;
  if (p.description || image) {
    const body = p.description ? rich(p.description) : el("p", { class: "hc-caption" }, "No description.");
    body.classList.add("rq-desc");
    let more = null;
    if ((p.description || "").length > 420) {
      body.classList.add("clamped");
      more = el("button", { type: "button", class: "hc-btn hc-btn-ghost hc-btn-sm rq-more" }, "Show all");
      more.addEventListener("click", () => {
        more.textContent = body.classList.toggle("clamped") ? "Show all" : "Show less";
      });
    }
    about = el(
      "div",
      { class: `hc-card rq-about${image ? "" : " no-image"}` },
      image ? el("a", { class: "rq-hero-link", href: image, target: "_blank", rel: "noopener", title: "Open the full image" }, el("img", { class: "rq-hero", src: image, alt: "", referrerpolicy: "no-referrer" })) : null,
      el("div", { class: "rq-grow" }, body, more),
    );
  }

  const repo = https(p.repo_url);
  const demo = https(p.demo_url);
  $("left").replaceChildren(
    el(
      "div",
      {},
      el(
        "div",
        { class: "rq-row" },
        badge(status.label, status.tone),
        TIERS[p.level] ? badge(TIERS[p.level], "purple") : null,
        badge(TYPES[p.project_type] || p.project_type || "-", "info"),
        place,
        at ? badge(`waiting ${waitText(at.row)}`, "neutral", { title: `Shipped ${fmtDate(p.shipped_at)}` }) : null,
        at && !at.row.wait_exact ? badge("Resubmitted", "warning") : null,
        p.is_peak ? badge("Beacon", "yellow") : null,
        el("span", { class: "rq-id rq-mono" }, `#${p.id}`),
      ),
      el("h1", { class: "hc-title rq-title" }, p.name),
    ),
    ownerCard(),
    about,
    el(
      "div",
      { class: "rq-links" },
      repo ? linkBtn(repo, "Repo") : badge("No repo", "danger"),
      repo ? linkBtn(`${repo.replace(/\/$/, "")}#readme`, "README") : null,
      demo ? linkBtn(demo, "Live demo") : badge("No demo", "danger"),
      linkBtn(`https://pixl.hackclub.com/projects/${encodeURIComponent(p.id)}`, "Pixl page", "hc-btn hc-btn-ghost"),
    ),
    tabsCard(),
  );
}

/* ---------- detail tabs (ReviewDetailTabs.tsx) ---------- */

function tabsCard() {
  const tabs = [
    { key: "community", label: "Community", count: () => (reviewsState === "ready" ? reviews.length : undefined), build: communityTab },
    { key: "commits", label: "Commits", build: commitsTab },
    { key: "readme", label: "README", build: readmeTab },
    { key: "journals", label: "Journals", count: () => details.entries.length, build: journalsTab },
    { key: "past", label: "Past reviews", count: () => details.reviews.length, build: pastTab },
  ];
  const built = {};
  const bar = el("div", { class: "hc-tabs hc-tabs-fill", role: "tablist" });
  const body = el("div", { class: "rq-tab-body", role: "tabpanel" });
  let active = "community";
  const label = (t) => (t.count?.() !== undefined ? [t.label, countBadge(t.count())] : [t.label]);
  const buttons = tabs.map((t, i) => {
    const b = el("button", { type: "button", role: "tab", class: "hc-tab", title: `Shortcut: ${i + 1}`, "data-tab": t.key }, ...label(t));
    b.addEventListener("click", () => show(t.key));
    return b;
  });
  bar.append(...buttons);

  function show(name) {
    active = name;
    buttons.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    built[name] ||= tabs.find((t) => t.key === name).build();
    body.replaceChildren(built[name]);
    body.classList.remove("swap");
    void body.offsetWidth;
    body.classList.add("swap");
  }

  // Rebuild a tab whose data changed, and refresh the counts.
  refreshTab = (name) => {
    tabs.forEach((t, i) => buttons[i].replaceChildren(...label(t)));
    if (name && built[name]) {
      built[name] = tabs.find((t) => t.key === name).build();
      if (active === name) body.replaceChildren(built[name]);
    }
  };

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= tabs.length) show(tabs[n - 1].key);
  });

  show("community");
  return el("div", { class: "hc-card rq-tabs-card", "data-density": "flush" }, bar, body);
}

function githubTrouble(res, page) {
  const open = linkBtn(page, "Open on GitHub", "hc-btn hc-btn-outline hc-btn-sm");
  const box = (tone, text, extra = null) => el("div", { class: "rq-pad" }, callout(tone, el("p", {}, text), extra));
  if (!res) return box("warning", "Couldn't reach GitHub.", open);
  if (res.status === 404) return box("danger", "Repo not found or private (404) on github.com.");
  if (res.status === 403 || res.status === 429)
    return box("warning", "GitHub API rate limit hit. This is not “no commits”: GitHub only answers 60 requests an hour per visitor without a login. Wait a bit and reload, or open it on GitHub.", open);
  return box("warning", `GitHub answered ${res.status}.`, open);
}

function notGithub() {
  return empty("No commit API for this host", https(details.project.repo_url) ? "Open the repo link to review it by hand." : "This project has no repo link.");
}

function fmtGap(s) {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// One request per commit per page view, shared by the hover preview and the inline view.
const diffs = new Map();
function loadDiff(gh, sha) {
  if (!diffs.has(sha)) {
    const request = fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/commits/${sha}`)
      .then(async (res) => {
        if (!res.ok) return { error: res.status === 403 || res.status === 429 ? "rate_limited" : res.status === 404 ? "not_found" : "failed" };
        const c = await res.json();
        return {
          files: (c.files || []).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })),
          additions: c.stats?.additions ?? 0,
          deletions: c.stats?.deletions ?? 0,
        };
      })
      .catch(() => ({ error: "failed" }));
    diffs.set(sha, request);
    request.then((d) => d.error && diffs.delete(sha));
  }
  return diffs.get(sha);
}

const DIFF_ERRORS = { rate_limited: "GitHub's rate limit was hit. Try again in a bit.", not_found: "That commit couldn't be found on GitHub." };
const NOISE_FILE_RX = /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/;
const lineKind = (line) => (line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : null);

function diffView(gh, sha, onStats) {
  const box = el("p", { class: "hc-caption rq-pad" }, "Loading diff...");
  loadDiff(gh, sha).then((d) => {
    if (d.error) return box.replaceWith(el("p", { class: "hc-caption rq-pad" }, DIFF_ERRORS[d.error] || "Couldn't load this diff right now."));
    onStats?.(d);
    if (!d.files.length) return box.replaceWith(el("p", { class: "hc-caption rq-pad" }, "This commit changed no files."));
    box.replaceWith(
      el(
        "div",
        { class: "hc-diff" },
        d.files.map((f) => {
          const lines = (f.patch || "").split("\n");
          return el(
            "details",
            { class: "hc-diff-file", open: !(NOISE_FILE_RX.test(f.path) || lines.length > 400) },
            el(
              "summary",
              {},
              el("span", { class: "hc-mono" }, f.path),
              f.status !== "modified" ? badge(f.status) : null,
              el("span", { class: "rq-lines", style: "margin-left:auto" }, el("span", { class: "rq-add" }, `+${f.additions}`), " ", el("span", { class: "rq-del" }, `-${f.deletions}`)),
            ),
            f.patch
              ? el("pre", {}, lines.map((line) => el("span", { "data-kind": lineKind(line) }, `${line || " "}\n`)))
              : el("p", { class: "hc-caption rq-xs rq-pad" }, "Binary file, or too large for GitHub to show inline."),
          );
        }),
      ),
    );
  });
  return box;
}

// CommitList.tsx: 10 a page, the wall-clock gap since the previous commit,
// AI commit flags, hover a hash to peek at the diff, click a message to open it.
function commitsTab() {
  const gh = githubRepo(details.project.repo_url);
  if (!gh) return notGithub();
  const page = `https://github.com/${gh.owner}/${gh.repo}/commits`;
  const wrap = el("div", {}, el("p", { class: "hc-caption rq-pad" }, "Loading commits from GitHub..."));
  const PER_PAGE = 10;
  const open = new Set();
  let commits = [];
  let hasMore = false;
  let nextPage = 2;
  let pageIndex = 0;

  const fetchPage = (n) => fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/commits?per_page=100&page=${n}`).catch(() => null);
  const toCommit = (c) => {
    const message = c.commit?.message || "";
    const author = c.author?.login || c.commit?.author?.name || "?";
    return {
      sha: c.sha,
      url: c.html_url,
      date: c.commit?.author?.date || c.commit?.committer?.date || "",
      message: message.split("\n")[0] || "(no message)",
      ai: AI_MESSAGE_RX.test(message) || AI_AUTHOR_RX.test(author) || AI_AUTHOR_RX.test(c.commit?.author?.email || ""),
      author,
    };
  };

  function row(c, gap) {
    const lines = el("td", { class: "rq-lines" });
    const fillLines = (d) => lines.replaceChildren(el("span", { class: "rq-add" }, `+${d.additions}`), " ", el("span", { class: "rq-del" }, `-${d.deletions}`));
    diffs.get(c.sha)?.then((d) => !d.error && fillLines(d));

    const sha = el("a", { class: "hc-link", href: c.url, target: "_blank", rel: "noreferrer" }, el("span", { class: "hc-mono" }, c.sha.slice(0, 7)));
    const shaCell = el("td", { class: "rq-sha-cell" }, sha);
    let timer = 0;
    let pop = null;
    const schedule = (show, delay) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (show && !pop && !open.has(c.sha)) {
          pop = el("div", { class: "hc-diff-popover" }, diffView(gh, c.sha, fillLines));
          pop.addEventListener("mouseenter", () => schedule(true, 0));
          pop.addEventListener("mouseleave", () => schedule(false, 200));
          shaCell.append(pop);
        } else if (!show && pop) {
          pop.remove();
          pop = null;
        }
      }, delay);
    };
    sha.addEventListener("mouseenter", () => schedule(true, 350));
    sha.addEventListener("mouseleave", () => schedule(false, 200));

    const isOpen = open.has(c.sha);
    const toggle = el(
      "button",
      { type: "button", class: "hc-commit-toggle", "aria-expanded": String(isOpen) },
      el("span", { class: "hc-muted" }, isOpen ? "▾" : "▸"),
      el("span", {}, c.message),
    );
    toggle.addEventListener("click", () => {
      if (isOpen) open.delete(c.sha);
      else open.add(c.sha);
      render();
    });
    const when = c.date ? new Date(c.date).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-";
    const tr = el(
      "tr",
      { class: isOpen ? "rq-open-row" : null },
      el(
        "td",
        { style: "white-space:nowrap" },
        el("span", { class: "hc-muted hc-mono" }, when),
        gap !== undefined ? el("span", { class: "rq-gap", title: "Wall-clock time since the previous commit", "data-long": gap > 3 * 86400 ? "" : null }, `+${fmtGap(gap)}`) : null,
      ),
      shaCell,
      el("td", { class: "rq-msg" }, el("div", { class: "rq-row" }, toggle, c.ai ? badge("AI commit", "purple", { title: "Signed by an AI tool (co-author trailer, bot author or generated-with footer)." }) : null)),
      lines,
      el("td", {}, el("span", { class: "hc-mono" }, c.author)),
    );
    return isOpen ? [tr, el("tr", { class: "hc-diff-row" }, el("td", { colspan: 5 }, diffView(gh, c.sha, fillLines)))] : [tr];
  }

  function render() {
    const asc = commits.filter((c) => c.date).sort((a, b) => a.date.localeCompare(b.date));
    const gaps = new Map();
    let longest = 0;
    for (let i = 1; i < asc.length; i++) {
      const s = (Date.parse(asc[i].date) - Date.parse(asc[i - 1].date)) / 1000;
      if (Number.isFinite(s) && s >= 0) {
        gaps.set(asc[i].sha, s);
        longest = Math.max(longest, s);
      }
    }
    const days = new Set(asc.map((c) => c.date.slice(0, 10))).size;
    const aiCount = commits.filter((c) => c.ai).length;
    const pages = Math.max(1, Math.ceil(commits.length / PER_PAGE));
    const shown = commits.slice(pageIndex * PER_PAGE, pageIndex * PER_PAGE + PER_PAGE);

    const loadMore = el("button", { type: "button", class: "hc-btn hc-btn-outline hc-btn-sm" }, "Load 100 more");
    loadMore.addEventListener("click", async () => {
      loadMore.disabled = true;
      loadMore.textContent = "Loading...";
      const res = await fetchPage(nextPage);
      if (res?.ok) {
        commits = [...commits, ...(await res.json()).map(toCommit)];
        hasMore = /rel="next"/.test(res.headers.get("Link") || "");
        nextPage++;
      } else hasMore = false;
      render();
    });

    wrap.replaceChildren(
      el(
        "p",
        { class: "hc-caption rq-caption-bar" },
        el("span", { class: "hc-mono" }, `${gh.owner}/${gh.repo}`),
        ` · ${commits.length}${hasMore ? "+" : ""} commits`,
        asc.length ? ` · ${fmtDate(asc[0].date)} to ${fmtDate(asc.at(-1).date)} · ${days} active day${days === 1 ? "" : "s"}` : "",
        longest ? ` · longest gap ${fmtGap(longest)}` : "",
        aiCount ? el("span", {}, " · ", badge(`${aiCount} AI commit${aiCount === 1 ? "" : "s"}`, "purple")) : null,
        el("br"),
        "Click a message to read its diff, hover a hash to peek. “+2h” is the time since the previous commit. Hackatime time per commit needs the maker's Slack ID, which Pixl keeps private.",
      ),
      el(
        "div",
        { class: "hc-table-wrap" },
        el(
          "table",
          { class: "hc-table" },
          el("thead", {}, el("tr", {}, ["When", "Commit", "Message", "Lines", "Author"].map((h) => el("th", {}, h)))),
          el("tbody", {}, shown.flatMap((c) => row(c, gaps.get(c.sha)))),
        ),
      ),
      pages > 1 || hasMore
        ? el(
            "nav",
            { class: "rq-pager" },
            el("span", { class: "hc-caption rq-xs" }, `Page ${pageIndex + 1} of ${pages}`),
            el(
              "div",
              { class: "rq-row" },
              pageIndex > 0 ? el("button", { type: "button", class: "hc-btn hc-btn-outline hc-btn-sm", onclick: () => ((pageIndex -= 1), render()) }, "Previous") : null,
              pageIndex < pages - 1 ? el("button", { type: "button", class: "hc-btn hc-btn-outline hc-btn-sm", onclick: () => ((pageIndex += 1), render()) }, "Next") : null,
              hasMore ? loadMore : null,
            ),
          )
        : null,
    );
  }

  (async () => {
    const res = await fetchPage(1);
    if (!res || !res.ok) return wrap.replaceChildren(githubTrouble(res, page));
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return wrap.replaceChildren(empty("No commits"));
    commits = list.map(toCommit);
    hasMore = /rel="next"/.test(res.headers.get("Link") || "");
    render();
  })();
  return wrap;
}

function readmeCss() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  return `
    :root { color-scheme: ${document.documentElement.dataset.theme === "dark" ? "dark" : "light"}; }
    body { margin: 0; padding: 16px 20px; font: 15px/1.6 "DM Sans", system-ui, sans-serif; color: ${v("--ink")}; background: ${v("--paper")}; overflow-wrap: anywhere; }
    a { color: ${v("--red")}; font-weight: 600; }
    img { max-width: 100%; height: auto; }
    h1, h2, h3 { line-height: 1.25; margin: 1.2em 0 0.5em; }
    h1:first-child, h2:first-child { margin-top: 0; }
    h1, h2 { padding-bottom: 0.3em; border-bottom: 2px solid ${v("--border")}; }
    pre, code { font: 13px/1.5 "JetBrains Mono", ui-monospace, Menlo, monospace; background: ${v("--paper-2")}; border-radius: 6px; }
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
  const gh = githubRepo(details.project.repo_url);
  if (!gh) return notGithub();
  const page = `https://github.com/${gh.owner}/${gh.repo}#readme`;
  const wrap = el("div", {}, el("p", { class: "hc-caption rq-pad" }, "Loading the README from GitHub..."));
  (async () => {
    const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/readme`, { headers: { Accept: "application/vnd.github.html+json" } }).catch(() => null);
    if (res?.status === 404) return wrap.replaceChildren(empty("No README", "This repo has no README, which most ships need."));
    if (!res || !res.ok) return wrap.replaceChildren(githubTrouble(res, page));
    const html = await res.text();
    // No scripts run in the frame (sandbox without allow-scripts); same
    // origin only so the page can size it to the content.
    const frame = el("iframe", { class: "rq-readme", title: "README", sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox" });
    const fit = () => {
      const doc = frame.contentDocument;
      if (doc?.documentElement) frame.style.height = `${doc.documentElement.scrollHeight}px`;
    };
    const paint = () => {
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><base href="https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/" target="_blank"><style>${readmeCss()}</style></head><body>${html}</body></html>`;
    };
    frame.addEventListener("load", () => {
      fit();
      frame.contentDocument?.addEventListener("load", fit, true);
    });
    window.addEventListener("resize", fit);
    document.addEventListener("themechange", paint);
    paint();
    wrap.replaceChildren(
      el("p", { class: "hc-caption rq-caption-bar" }, el("span", { class: "hc-mono" }, `${gh.owner}/${gh.repo}`), " · ", el("a", { class: "hc-link", href: page, target: "_blank", rel: "noopener" }, "Open on GitHub")),
      frame,
    );
  })();
  return wrap;
}

function journalsTab() {
  if (!details.entries.length) return empty("No journal entries");
  const entries = [...details.entries].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const hours = entries.reduce((s, e) => s + (Number(e.hours) || 0), 0);
  return el(
    "div",
    {},
    el("p", { class: "hc-caption rq-caption-bar" }, `${entries.length} journal entr${entries.length === 1 ? "y" : "ies"}${hours ? ` · ${round1(hours)}h logged outside Hackatime` : ""}`),
    entries.map((e) =>
      el(
        "article",
        { class: "rq-entry" },
        el(
          "div",
          { class: "rq-entry-head" },
          el("h3", {}, e.title || "Untitled"),
          Number(e.hours) > 0 ? badge(`${round1(Number(e.hours))}h`, "yellow") : null,
          e.edited_at ? badge("edited", "neutral", { "data-variant": "outline" }) : null,
          el("span", { class: "hc-caption rq-xs", style: "margin-left:auto" }, new Date(e.created_at).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })),
        ),
        rich(e.content),
      ),
    ),
  );
}

function pastTab() {
  if (!details.reviews.length) return empty("No past reviews", "This is its first time in the queue.");
  const list = [...details.reviews].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return el(
    "div",
    {},
    el("p", { class: "hc-caption rq-caption-bar" }, "What Pixl's reviewers sent the maker. Their internal audit notes aren't public."),
    list.map((r) => {
      const v = OFFICIAL[r.verdict] || { label: r.verdict, tone: "neutral" };
      return el(
        "article",
        { class: "rq-entry" },
        el(
          "div",
          { class: "rq-entry-head" },
          badge(v.label, v.tone),
          r.claimed_hours != null ? badge(r.approved_hours != null ? `${r.approved_hours}h of ${r.claimed_hours}h` : `${r.claimed_hours}h claimed`, "neutral", { "data-variant": "outline" }) : null,
          el("span", { class: "hc-caption rq-xs", style: "margin-left:auto" }, fmtDate(r.created_at)),
        ),
        r.note ? rich(r.note) : el("p", { class: "hc-caption" }, "No note."),
      );
    }),
  );
}

/* ---------- community reviews ---------- */

function formatReview(r) {
  const claim = Number(r.claimed_hours ?? claimed);
  const cut = round1(claim - Number(r.hours));
  const head = [
    r.verdict ? `Verdict: ${VERDICTS[r.verdict]?.label || r.verdict}` : null,
    `Tier: ${TIERS[r.tier] || r.tier}`,
    `Hours: ${r.hours}h of ${claim}h${cut > 0 ? ` (${cut}h deflated)` : ""}`,
  ].filter(Boolean);
  const sections = FIELDS.filter((f) => String(r[f.key] || "").trim() && !(f.key === "deflation_reason" && cut <= 0)).map((f) => `${f.header}:\n${String(r[f.key]).trim()}`);
  return [head.join("\n"), ...sections].join("\n\n");
}

function useAsDraft(r) {
  if (!blank(readForm()) && !confirm(`Replace your draft with ${anonName(r.author)}'s review?`)) return;
  fillForm({ ...r, hours: Math.min(r.hours, claimed) });
  saveDraft();
  $("technical_features").focus({ preventScroll: true });
  say("info", "Loaded into your form. Check everything yourself before posting or pasting it anywhere.");
}

async function moderate(r, action) {
  const question = action === "ban" ? `Ban ${anonName(r.author)}? Every review they wrote is deleted and their key can't post again.` : `Delete ${anonName(r.author)}'s review?`;
  if (!confirm(question)) return;
  try {
    const data = await callApi("/api/admin", { method: "POST", body: { admin: adminKey, action, project: id, author: r.author } });
    reviews = data.reviews;
    refreshTab("community");
  } catch (e) {
    alert(e.message);
  }
}

function reviewCard(r, i) {
  const isMine = me && r.author === me.author;
  const v = VERDICTS[r.verdict] || { label: r.verdict, tone: "neutral" };
  const cut = round1(Number(r.claimed_hours) - Number(r.hours));
  const updated = Date.parse(r.updated_at);
  const edited = updated - Date.parse(r.created_at) > 60000;
  return el(
    "article",
    { class: `rq-review enter${isMine ? " mine" : ""}`, style: `--i:${i}` },
    el(
      "header",
      { class: "rq-review-head" },
      identicon(r.author),
      el("div", { class: "rq-who" }, el("strong", {}, anonName(r.author), isMine ? badge("You", "info") : null), el("small", {}, `${timeAgo(updated)}${edited ? " · edited" : ""}`)),
      badge(v.label, v.tone),
      TIERS[r.tier] ? badge(TIERS[r.tier], "purple") : null,
      badge(cut > 0 ? `${r.hours}h of ${r.claimed_hours}h · -${cut}h` : `${r.hours}h, full`, cut > 0 ? "warning" : "neutral", { "data-variant": "outline" }),
    ),
    FIELDS.filter((f) => String(r[f.key] || "").trim()).map((f) =>
      el(
        "section",
        { class: "rq-review-field" },
        el("div", { class: "rq-review-field-head" }, el("span", { class: "hc-eyebrow" }, f.label), copyBtn(() => String(r[f.key]).trim())),
        rich(r[f.key]),
      ),
    ),
    el(
      "footer",
      { class: "rq-review-actions" },
      copyBtn(() => formatReview(r), "Copy whole review", "hc-btn hc-btn-outline hc-btn-sm rq-copy"),
      isMine ? null : el("button", { type: "button", class: "hc-btn hc-btn-outline hc-btn-sm", onclick: () => useAsDraft(r) }, "Use as my draft"),
      isMine ? el("button", { type: "button", class: "hc-btn hc-btn-danger hc-btn-sm", onclick: deleteMine }, "Delete") : null,
      adminKey && !isMine ? el("button", { type: "button", class: "hc-btn hc-btn-danger hc-btn-sm", onclick: () => moderate(r, "delete") }, "Delete") : null,
      adminKey && !isMine ? el("button", { type: "button", class: "hc-btn hc-btn-danger hc-btn-sm", onclick: () => moderate(r, "ban") }, "Ban author") : null,
    ),
  );
}

function communityTab() {
  if (reviewsState === "loading") return el("p", { class: "hc-caption rq-pad" }, "Loading community reviews...");
  if (reviewsState === "off")
    return el(
      "div",
      { class: "rq-pad" },
      callout("neutral", el("p", {}, "Community reviews aren't connected on this copy of the site yet. You can still write a review in the form: it saves in this browser and every copy button works.")),
    );
  if (reviewsState === "error") return el("div", { class: "rq-pad" }, callout("warning", el("p", {}, `Couldn't load community reviews: ${reviewsError}`)));
  if (!reviews.length) return empty("No community reviews yet", "Check the commits, README and journals, then write yours in the form. It's anonymous.");

  const tally = {};
  for (const r of reviews) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  const hours = reviews.map((r) => Number(r.hours)).sort((a, b) => a - b);
  const median = hours.length % 2 ? hours[(hours.length - 1) / 2] : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2;
  return el(
    "div",
    {},
    el(
      "div",
      { class: "rq-summary" },
      `${reviews.length} anonymous review${reviews.length === 1 ? "" : "s"}:`,
      Object.entries(tally).map(([verdict, n]) => badge(`${n} ${VERDICTS[verdict]?.label || verdict}`, VERDICTS[verdict]?.tone || "neutral")),
      `median ${round1(median)}h of ${claimed}h`,
      el("span", { style: "margin-left:auto" }, "Unofficial. Double check before you copy."),
    ),
    el("div", { class: "rq-reviews" }, reviews.map(reviewCard)),
  );
}

/* ---------- your review (ReviewForm.tsx) ---------- */

const texts = () => FIELDS.map((f) => f.key);

function clampHours(value) {
  const n = Number(value);
  return Number.isFinite(n) ? round1(Math.min(claimed, Math.max(0, n))) : claimed;
}

function defaults() {
  return { verdict: "", tier: details.project.level || 1, hours: claimed, technical_features: "", deflation_reason: "", notes: "", note: "" };
}

function readForm() {
  const r = { verdict: picked, tier: Number($("tier").value) || 1, hours: clampHours($("hours").value === "" ? claimed : $("hours").value) };
  for (const k of texts()) r[k] = $(k).value;
  return r;
}

function fillForm(r) {
  picked = r.verdict || "";
  $("tier").value = String(Math.min(4, Math.max(1, Number(r.tier) || 1)));
  const hours = clampHours(r.hours ?? claimed);
  $("hours").value = hours;
  $("hours-range").value = hours;
  for (const k of texts()) $(k).value = r[k] || "";
  updateDerived();
}

const blank = (r) => texts().every((k) => !String(r[k] || "").trim());

function same(a, b) {
  if (!a || !b) return false;
  const full = clampHours(a.hours) >= claimed;
  return (
    Number(a.tier) === Number(b.tier) &&
    clampHours(a.hours) === clampHours(b.hours) &&
    texts().every((k) => (k === "deflation_reason" && full) || String(a[k] || "").trim() === String(b[k] || "").trim())
  );
}

function readDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

function saveDraft() {
  touched = true;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...readForm(), saved_at: Date.now() }));
    savedAt = Date.now();
  } catch {
    savedAt = -1;
  }
  updateStatus();
}

function updateStatus() {
  const box = $("save-status");
  const posted = mine();
  let text = "Autosaves as you type";
  let tone = null;
  if (savedAt === -1) {
    text = "Can't save drafts in this browser";
    tone = "danger";
  } else if (posted && same(readForm(), posted)) {
    text = `Posted as ${VERDICTS[posted.verdict]?.label || posted.verdict}`;
    tone = "success";
  } else if (posted) {
    text = "Edited since you posted";
  } else if (savedAt) {
    text = "Draft saved in this browser";
    tone = "success";
  }
  box.textContent = text;
  if (tone) box.dataset.tone = tone;
  else delete box.dataset.tone;
}

// TierAndPayout in ReviewForm.tsx, from the maker's public lifetime RE.
function renderPayout(hours, tier) {
  const reBefore = Number(details.maker?.re) || 0;
  const hoursRe = reForHours(hours, tier);
  const reAfter = reBefore + hoursRe;
  const rate = pxPerHourOver(reBefore, reAfter);
  const px = Math.round(hours * rate);
  const usd = (px * PIXEL_VALUE_USD).toFixed(2);
  const before = levelForRe(reBefore);
  const after = levelForRe(reAfter);
  const row = (label, value, strong = false) => el("div", { class: `rq-payout-row${strong ? " strong" : ""}` }, el("span", {}, label), el("span", {}, value));
  $("payout-summary").textContent = `Payout: ${px.toLocaleString()} px · $${usd}`;
  $("payout-body").replaceChildren(
    row(`This project · ${hours}h × ${rePerHour(tier)} RE/h`, `${round1(hoursRe).toLocaleString()} RE`),
    row("Their RE before → after", `${round1(reBefore).toLocaleString()} → ${round1(reAfter).toLocaleString()}`),
    row("Their level before → after", `${before} → ${after}${after > before ? " ▲" : ""}`),
    row("Rate (averaged over this ship)", `${Math.round(rate)} px/h · $${averageUsdPerHourOver(reBefore, reAfter).toFixed(2)}/h`),
    row("Payout", `${px.toLocaleString()} px · $${usd}`, true),
    el(
      "p",
      { class: "hc-caption rq-xs" },
      details.maker
        ? "Same maths as the dash, from the maker's public lifetime RE. Trials, funding grants, bounties and community-goal bonuses aren't public, so they aren't counted."
        : "The maker's profile hasn't been fetched yet, so this assumes they have no RE.",
    ),
  );
}

function updateDerived() {
  const tier = Number($("tier").value) || 1;
  $("tier-blurb").textContent = TIER_BLURBS[tier];
  const hours = clampHours($("hours").value === "" ? claimed : $("hours").value);
  const cut = round1(claimed - hours);
  $("hours-hint").textContent = cut > 0 ? `${cut}h deflated (${Math.round((cut / (claimed || 1)) * 100)}%) of ${claimed}h` : `Decrease only · ${claimed}h claimed`;
  $("hours-range").style.setProperty("--fill", `${claimed ? (hours / claimed) * 100 : 100}%`);
  $("deflation-field").hidden = cut <= 0;
  $("deflation-label").textContent = `Why lower the hours? (${claimed}h claimed → ${hours}h credited)`;
  const len = $("technical_features").value.trim().length;
  $("tf-count").textContent = `${len}/${TECHNICAL_FEATURES_MIN}`;
  if (len >= TECHNICAL_FEATURES_MIN) $("tf-count").dataset.done = "";
  else delete $("tf-count").dataset.done;
  renderPayout(hours, tier);
  updateVerdictButtons();
  updateStatus();
}

function say(tone, text) {
  $("form-msg").replaceChildren(text ? callout(tone, el("p", {}, text)) : "");
}

function problemWith(r) {
  if (r.technical_features.trim().length < TECHNICAL_FEATURES_MIN) return ["technical_features", `Technical features needs at least ${TECHNICAL_FEATURES_MIN} characters.`];
  if (r.hours < claimed && !r.deflation_reason.trim()) return ["deflation_reason", "Say why you lowered the hours."];
  if (r.verdict === "approved" && !r.notes.trim()) return ["notes", "Additional notes are required for approval."];
  if (!r.note.trim()) return ["note", "Write a note to the player."];
  if (/missing\s*(?:X\b|\)\s*:\()/i.test(r.note)) return ["note", "Fill in what the README is missing in the /badreadme note."];
  return null;
}

const VERDICT_LABELS = { approved: "Approve", needs_changes: "Request changes", ban: "Perm reject project" };

function updateVerdictButtons() {
  const posted = mine();
  for (const b of $("verdicts").querySelectorAll("button")) {
    b.disabled = posting;
    b.textContent = posting && b.value === picked ? "Posting..." : VERDICT_LABELS[b.value];
    if (posted && posted.verdict === b.value) b.dataset.picked = "";
    else delete b.dataset.picked;
  }
}

async function post(verdict) {
  picked = verdict;
  saveDraft();
  const r = readForm();
  const problem = problemWith(r);
  if (problem) {
    say("danger", problem[1]);
    $(problem[0]).focus();
    return;
  }
  if (!api) return say("neutral", "Posting isn't connected on this copy of the site yet. Your draft is saved here and every copy button works.");
  if (!$("attest").checked) return say("danger", "Tick the box to confirm you didn't make this project and checked it yourself.");
  posting = true;
  updateVerdictButtons();
  const editing = !!mine();
  try {
    const data = await callApi("/api/reviews", {
      method: "POST",
      body: {
        project: id,
        key,
        review: {
          verdict,
          tier: r.tier,
          hours: r.hours,
          technical_features: r.technical_features,
          deflation_reason: r.hours < claimed ? r.deflation_reason : "",
          notes: r.notes,
          note: r.note,
        },
      },
    });
    reviews = data.reviews;
    reviewsState = "ready";
    say("success", editing ? "Updated. Reviewers see the new version right away." : "Posted! Reviewers can copy it from the Community tab.");
    celebrate(editing ? "Review updated" : "+1 review");
    refreshTab("community");
  } catch (e) {
    say("danger", e.message);
  }
  posting = false;
  updateVerdictButtons();
  updateStatus();
}

async function deleteMine() {
  if (!mine() || !confirm("Delete your posted review? Your draft stays in this browser.")) return;
  try {
    const data = await callApi("/api/reviews", { method: "DELETE", body: { project: id, key } });
    reviews = data.reviews;
    say("success", "Deleted. Your draft is still here.");
    refreshTab("community");
    updateStatus();
    updateVerdictButtons();
  } catch (e) {
    say("danger", e.message);
  }
}

// With no draft in this browser, start from the review you already posted.
function restorePosted() {
  const posted = mine();
  if (posted && !touched && !readDraft()) fillForm(posted);
}

function setupForm() {
  $("hours").max = claimed;
  $("hours-range").max = claimed;
  for (const f of FIELDS) document.querySelector(`[data-field="${f.key}"] .rq-field-head`).append(copyBtn(() => $(f.key).value.trim()));
  $("tools").append(
    copyBtn(() => formatReview(readForm()), "Copy whole review", "hc-btn hc-btn-outline hc-btn-sm rq-copy"),
    el(
      "button",
      {
        type: "button",
        class: "hc-btn hc-btn-ghost hc-btn-sm",
        onclick: () => {
          if (!confirm("Clear your draft? A review you already posted stays posted.")) return;
          try {
            localStorage.removeItem(DRAFT_KEY);
          } catch {}
          savedAt = 0;
          fillForm(defaults());
          say("", "");
        },
      },
      "Clear",
    ),
  );
  const draft = readDraft();
  fillForm(draft ? { ...defaults(), ...draft } : defaults());
  if (draft) savedAt = draft.saved_at || 1;

  const form = $("form");
  form.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "attest") return;
    if (t.id === "note" && e.inputType?.startsWith("insert")) {
      const expanded = expandMacro(t.value, t.selectionStart ?? t.value.length);
      if (expanded) {
        t.value = expanded.value;
        t.setSelectionRange(expanded.caret, expanded.caret);
      }
    }
    if (t.id === "hours-range") $("hours").value = t.value;
    if (t.id === "hours" && t.value !== "") $("hours-range").value = clampHours(t.value);
    updateDerived();
    saveDraft();
  });
  form.addEventListener("change", (e) => {
    if (e.target.id === "attest") return;
    if (e.target.id === "hours") {
      e.target.value = clampHours(e.target.value === "" ? claimed : e.target.value);
      $("hours-range").value = e.target.value;
    }
    updateDerived();
    saveDraft();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const verdict = e.submitter?.value;
    if (verdict && !posting) post(verdict);
  });
}

/* ---------- the party after posting (ReviewCelebration.tsx) ---------- */

const CONFETTI = ["#f1c40f", "#ec3750", "#5bc0de", "#a633d6", "#338eda", "#ff8c37", "#33d6a6"];
const CONFETTI_MS = 3600;

// A pop, then a quick rising C-major arpeggio with a sparkle on top.
function playSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void ctx.resume();
    const master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime;
    const noiseLen = Math.floor(ctx.sampleRate * 0.12);
    const buffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1800;
    noise.connect(filter);
    filter.connect(master);
    noise.start(t0);
    const notes = [523.25, 659.25, 783.99, 1046.5, 1568];
    notes.forEach((freq, i) => {
      const last = i === notes.length - 1;
      const start = t0 + 0.06 + i * 0.08;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = last ? "triangle" : "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(last ? 0.5 : 0.7, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + (last ? 0.5 : 0.22));
      osc.connect(gain);
      gain.connect(master);
      osc.start(start);
      osc.stop(start + 0.55);
    });
    setTimeout(() => void ctx.close().catch(() => {}), 1500);
  } catch {}
}

// Two cannons from the bottom corners plus a shower from the top.
function launchConfetti() {
  const canvas = el("canvas", { "aria-hidden": "true", class: "rq-confetti", style: "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999" });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  document.body.append(canvas);
  const w = innerWidth;
  const h = innerHeight;
  const color = () => CONFETTI[Math.floor(Math.random() * CONFETTI.length)];
  const pieces = [];
  const burst = (x, y, angle, count) => {
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * 0.9;
      const speed = 9 + Math.random() * 9;
      pieces.push({ x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, size: 6 + Math.random() * 7, rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.4, color: color(), round: Math.random() < 0.25 });
    }
  };
  burst(0, h, -Math.PI / 3, 70);
  burst(w, h, (-2 * Math.PI) / 3, 70);
  for (let i = 0; i < 60; i++) {
    pieces.push({ x: Math.random() * w, y: -20 - Math.random() * h * 0.5, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, size: 6 + Math.random() * 6, rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.3, color: color(), round: Math.random() < 0.25 });
  }
  const start = performance.now();
  const frame = (now) => {
    const elapsed = now - start;
    ctx.clearRect(0, 0, w, h);
    const fade = elapsed > CONFETTI_MS - 700 ? Math.max(0, (CONFETTI_MS - elapsed) / 700) : 1;
    for (const p of pieces) {
      p.vy += 0.28;
      p.vx *= 0.992;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
    if (elapsed < CONFETTI_MS) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

function celebrate(text) {
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) launchConfetti();
  playSound();
  const card = el("div", { class: "rq-reward", role: "status", "aria-live": "polite" }, text);
  document.body.append(card);
  setTimeout(() => card.remove(), 2400);
}

/* ---------- resizable split (ReviewSplit.tsx) ---------- */

function setupSplit() {
  const split = $("split");
  const handle = $("handle");
  let width = DEFAULT_PANEL;
  try {
    width = Number(localStorage.getItem(SPLIT_KEY)) || DEFAULT_PANEL;
  } catch {}
  const apply = (w, save = false) => {
    width = Math.round(Math.min(Math.max(w, 340), Math.max(340, split.clientWidth * 0.65)));
    split.style.setProperty("--review-right", `${width}px`);
    if (save) {
      try {
        localStorage.setItem(SPLIT_KEY, String(width));
      } catch {}
    }
  };
  apply(width);
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    split.dataset.dragging = "";
  });
  handle.addEventListener("pointermove", (e) => dragging && apply(split.getBoundingClientRect().right - e.clientX - 12));
  handle.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    delete split.dataset.dragging;
    apply(width, true);
  });
  handle.addEventListener("dblclick", () => apply(DEFAULT_PANEL, true));
  handle.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    apply(width + (e.key === "ArrowLeft" ? 24 : -24), true);
  });
}

/* ---------- start ---------- */

function renderMissing(queue) {
  const at = findInQueue(queue, id);
  const valid = /^\d{1,8}$/.test(id);
  $("loading").hidden = true;
  $("missing").hidden = false;
  $("missing").replaceChildren(
    el(
      "div",
      { class: "hc-card" },
      el("h1", { class: "hc-title" }, valid ? `#${id} isn't here` : "No project picked"),
      el(
        "p",
        { class: "hc-caption", style: "margin:10px 0 16px" },
        at
          ? "It's in the queue, but its details haven't been fetched yet. They update about every 10 minutes."
          : valid
            ? "Review pages only exist for projects waiting in the review queue. This one may have been approved, sent back with “needs changes”, or still be a draft."
            : "Open a project from the queue to review it.",
      ),
      el(
        "div",
        { class: "rq-links" },
        el("a", { class: "hc-btn", href: "./" }, "Back to the queue"),
        valid ? linkBtn(`https://pixl.hackclub.com/projects/${encodeURIComponent(id)}`, "Pixl page") : null,
      ),
    ),
  );
}

async function main() {
  setupTheme();
  // A moderator opens any review page once with #admin=<key>; the key is
  // kept in this browser and checked by the server on every action.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("admin")) {
    try {
      localStorage.setItem(ADMIN_KEY, hash.get("admin"));
    } catch {}
    history.replaceState(null, "", location.pathname + location.search);
  }
  const valid = /^\d{1,8}$/.test(id);
  const [found, queue, config] = await Promise.all([
    valid ? fetchJSON(`p/${id}.json`) : null,
    fetchJSON("queue.json"),
    fetchJSON("reviews-config.json"),
    loadIdentity(),
  ]);
  if (!found?.project) return renderMissing(queue);
  details = found;
  details.entries ||= [];
  details.reviews ||= [];
  claimed = round1((Number(details.project.hackatime_seconds) || 0) / 3600);
  api = config?.api ? String(config.api).replace(/\/$/, "") : null;

  $("loading").hidden = true;
  $("split").hidden = false;
  renderLeft(queue);
  setupSplit();
  setupForm();
  renderIdentity();
  loadReviews();
  setInterval(() => document.visibilityState === "visible" && api && !posting && loadReviews(), 30000);

  try {
    adminKey = localStorage.getItem(ADMIN_KEY);
  } catch {}
  if (adminKey && api) {
    callApi("/api/admin", { method: "POST", body: { admin: adminKey, action: "check" } })
      .then(() => refreshTab("community"))
      .catch(() => {
        adminKey = null;
        try {
          localStorage.removeItem(ADMIN_KEY);
        } catch {}
      });
  } else adminKey = null;
}

main();
