// Community reviews, stored as one JSON document:
//   { reviews: { "<projectId>": [review, ...] }, banned: ["<author>", ...] }
// Reviewers sign in with GitHub. A review's author is "gh<GitHub user id>",
// which survives username changes, plus the login, name and avatar to show.

export const VERDICTS = ["approved", "needs_changes", "ban"];
export const TECHNICAL_FEATURES_MIN = 20;
const LIMITS = { technical_features: 6000, deflation_reason: 4000, notes: 6000, note: 4000 };
const MAX_REVIEWS_PER_AUTHOR_PER_DAY = 40;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Conflict extends Error {}

export const AUTHOR_RX = /^gh\d{1,12}$/;

export function validProjectId(id) {
  return typeof id === "string" && /^[0-9]{1,8}$/.test(id);
}

const round1 = (n) => Math.round(n * 10) / 10;

// The review as stored: only known fields, trimmed, hours clamped to what
// the project actually claims (from Pixl, never from the browser).
export function cleanReview(input, claimedHours) {
  if (!input || typeof input !== "object") throw new HttpError(400, "Missing review.");
  const r = {};
  if (!VERDICTS.includes(input.verdict)) throw new HttpError(400, "Pick a verdict.");
  r.verdict = input.verdict;
  const tier = Number(input.tier);
  if (!Number.isInteger(tier) || tier < 1 || tier > 4) throw new HttpError(400, "Tier must be 1 to 4.");
  r.tier = tier;
  const hours = Number(input.hours);
  if (!Number.isFinite(hours) || hours < 0) throw new HttpError(400, "Hours must be a number.");
  r.claimed_hours = claimedHours;
  r.hours = round1(Math.min(hours, claimedHours));
  for (const [key, max] of Object.entries(LIMITS)) {
    const value = input[key] ?? "";
    if (typeof value !== "string") throw new HttpError(400, `${key} must be text.`);
    if (value.length > max) throw new HttpError(400, `${key} is too long (max ${max} characters).`);
    r[key] = value.trim();
  }
  if (r.technical_features.length < TECHNICAL_FEATURES_MIN)
    throw new HttpError(400, `Technical features needs at least ${TECHNICAL_FEATURES_MIN} characters.`);
  if (r.hours < claimedHours && !r.deflation_reason) throw new HttpError(400, "Say why you lowered the hours.");
  if (r.hours >= claimedHours) r.deflation_reason = "";
  if (r.verdict === "approved" && !r.notes) throw new HttpError(400, "Additional notes are required for an approval.");
  if (!r.note) throw new HttpError(400, "Write a note to the player.");
  return r;
}

export function emptyDb() {
  return { reviews: {}, banned: [] };
}

export function reviewsFor(db, projectId) {
  return [...(db.reviews[projectId] || [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function counts(db) {
  const out = {};
  for (const [id, list] of Object.entries(db.reviews)) if (list.length) out[id] = list.length;
  return out;
}

// Reviewers ranked by how many projects they've reviewed, all time and in
// the last 7 days. Ties go to whoever reviewed most recently.
export function leaderboard(db, now = new Date(), limit = 25) {
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  const people = new Map();
  for (const list of Object.values(db.reviews)) {
    for (const r of list) {
      if (!r.login) continue;
      const p = people.get(r.author) || { author: r.author, login: r.login, name: "", avatar: "", reviews: 0, week: 0, approved: 0, needs_changes: 0, ban: 0, last: "" };
      p.reviews++;
      if (r.created_at > weekAgo) p.week++;
      p[r.verdict] = (p[r.verdict] || 0) + 1;
      if (r.updated_at > p.last) Object.assign(p, { last: r.updated_at, login: r.login, name: r.name || "", avatar: r.avatar || "" });
      people.set(r.author, p);
    }
  }
  const rank = (field) =>
    [...people.values()].filter((p) => p[field] > 0).sort((a, b) => b[field] - a[field] || b.last.localeCompare(a.last));
  const all = rank("reviews");
  return { all: all.slice(0, limit), week: rank("week").slice(0, limit), people: all.length };
}

export function rankOf(db, author) {
  const { all } = leaderboard(db, new Date(), Infinity);
  const i = all.findIndex((p) => p.author === author);
  return i < 0 ? null : { position: i + 1, reviews: all[i].reviews, of: all.length };
}

// Mutations take the current document and return the next one.

export function upsert(db, projectId, user, review, now = new Date()) {
  const { author } = user;
  if (db.banned.includes(author)) throw new HttpError(403, "This GitHub account can't post reviews any more.");
  const at = now.toISOString();
  const dayAgo = new Date(now.getTime() - 86400000).toISOString();
  const today = Object.values(db.reviews)
    .flat()
    .filter((r) => r.author === author && r.updated_at > dayAgo).length;
  const list = db.reviews[projectId] || [];
  const existing = list.find((r) => r.author === author);
  if (!existing && today >= MAX_REVIEWS_PER_AUTHOR_PER_DAY)
    throw new HttpError(429, "That's a lot of reviews for one day. Try again tomorrow.");
  const next = {
    author,
    login: user.login,
    name: user.name,
    avatar: user.avatar,
    ...review,
    created_at: existing?.created_at || at,
    updated_at: at,
  };
  return {
    ...db,
    reviews: { ...db.reviews, [projectId]: [...list.filter((r) => r.author !== author), next] },
  };
}

export function remove(db, projectId, author) {
  const list = db.reviews[projectId] || [];
  if (!list.some((r) => r.author === author)) throw new HttpError(404, "No review to delete.");
  const rest = list.filter((r) => r.author !== author);
  const reviews = { ...db.reviews };
  if (rest.length) reviews[projectId] = rest;
  else delete reviews[projectId];
  return { ...db, reviews };
}

export function ban(db, author) {
  const reviews = {};
  for (const [id, list] of Object.entries(db.reviews)) {
    const rest = list.filter((r) => r.author !== author);
    if (rest.length) reviews[id] = rest;
  }
  return { reviews, banned: [...new Set([...db.banned, author])] };
}

// Read, change, write back only if nobody else wrote in between.
export async function update(storage, change, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    const current = await storage.read();
    const db = current?.data || emptyDb();
    const next = change(db);
    try {
      await storage.write(next, current?.etag ?? null);
      return next;
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      await new Promise((r) => setTimeout(r, 40 * (i + 1) + Math.random() * 60));
    }
  }
  throw new HttpError(503, "Too many people posting at once. Try again.");
}
