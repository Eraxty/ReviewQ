// Community reviews, stored as one JSON document:
//   { reviews: { "<projectId>": [review, ...] }, banned: ["<author>", ...] }
// Nobody signs in. Each browser makes a random key and keeps it; the author id
// shown on a review is the first 16 hex characters of sha256(key), so a key
// can edit or delete its own reviews and nothing else, and the id says
// nothing about who wrote it.

import { createHash } from "node:crypto";

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

export function authorFor(key) {
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) throw new HttpError(400, "Bad reviewer key.");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

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

// Mutations take the current document and return the next one.

export function upsert(db, projectId, author, review, now = new Date()) {
  if (db.banned.includes(author)) throw new HttpError(403, "This reviewer key can't post any more.");
  const at = now.toISOString();
  const dayAgo = new Date(now.getTime() - 86400000).toISOString();
  const today = Object.values(db.reviews)
    .flat()
    .filter((r) => r.author === author && r.updated_at > dayAgo).length;
  const list = db.reviews[projectId] || [];
  const existing = list.find((r) => r.author === author);
  if (!existing && today >= MAX_REVIEWS_PER_AUTHOR_PER_DAY)
    throw new HttpError(429, "That's a lot of reviews for one day. Try again tomorrow.");
  const next = { author, ...review, created_at: existing?.created_at || at, updated_at: at };
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
