import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError, validProjectId } from "./reviews.js";

// The queue site, where each queued project has p/<id>.json.
const SITE = (process.env.SITE_URL || "https://eraxty.github.io/ReviewQ").replace(/\/$/, "");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export function json(body, { status = 200, cache = "no-store" } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache },
  });
}

export const preflight = () => new Response(null, { status: 204, headers: CORS });

export function failure(e) {
  if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
  console.error(e);
  return json({ error: "Something went wrong on the server. Try again." }, { status: 500 });
}

export async function body(request) {
  const text = await request.text();
  if (text.length > 40000) throw new HttpError(413, "That's too much text.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Expected JSON.");
  }
}

// Only projects that are in the queue right now can be reviewed, and their
// claimed hours come from Pixl's data rather than the browser.
const projects = new Map();
export async function queuedProject(id) {
  if (!validProjectId(id)) throw new HttpError(400, "Bad project id.");
  const hit = projects.get(id);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) {
    if (!hit.details) throw new HttpError(404, "That project isn't in the review queue.");
    return hit.details;
  }
  const res = await fetch(`${SITE}/p/${id}.json`, { headers: { "User-Agent": "reviewq-api" } });
  if (res.status === 404) {
    projects.set(id, { at: Date.now(), details: null });
    throw new HttpError(404, "That project isn't in the review queue.");
  }
  if (!res.ok) throw new HttpError(502, "Couldn't check the project. Try again.");
  const details = await res.json();
  projects.set(id, { at: Date.now(), details });
  return details;
}

export function claimedHours(details) {
  return Math.round(((Number(details.project?.hackatime_seconds) || 0) / 3600) * 10) / 10;
}

// Enough for a classroom on one network, slow enough to stop a script.
const hits = new Map();
export function rateLimit(request, limit = 30, windowMs = 10 * 60 * 1000) {
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) throw new HttpError(429, "Slow down a little and try again in a few minutes.");
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
}

// Only the hash of the admin key lives here, so this file can be public.
const ADMIN_KEY_SHA256 = process.env.ADMIN_KEY_SHA256 || "180a45c92c50f9cec9c303ad2895ae6b4fb992043d8378e6596fa5a48846b494";

export function isAdmin(key) {
  if (typeof key !== "string" || !key) return false;
  const given = createHash("sha256").update(key).digest();
  return timingSafeEqual(given, Buffer.from(ADMIN_KEY_SHA256, "hex"));
}
