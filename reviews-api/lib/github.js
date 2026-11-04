// GitHub sign-in (the OAuth web flow) and finding out who a token belongs to.
// Sign-in asks for no scopes: the token can only read public data, which is
// all the review page needs (and it lifts GitHub's limit to 5,000 an hour).

import { createHash } from "node:crypto";
import { HttpError } from "./reviews.js";

const GITHUB = (process.env.GITHUB_URL || "https://github.com").replace(/\/$/, "");
const GITHUB_API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");

export function oauthApp() {
  const id = process.env.GITHUB_CLIENT_ID;
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (!id || !secret) throw new HttpError(503, "GitHub sign-in isn't set up on the server yet.");
  return { id, secret };
}

export function authorizeUrl(clientId, redirectUri, state) {
  const url = new URL(`${GITHUB}/login/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "");
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

export async function exchangeCode(code, redirectUri) {
  const { id, secret } = oauthApp();
  const res = await fetch(`${GITHUB}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "reviewq-api" },
    body: JSON.stringify({ client_id: id, client_secret: secret, code, redirect_uri: redirectUri }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.access_token !== "string") throw new HttpError(401, "GitHub didn't accept that sign-in.");
  return data.access_token;
}

// Cached for a few minutes so posting doesn't ask GitHub every time.
const users = new Map();

export async function userFromToken(token) {
  if (typeof token !== "string" || !/^[\w-]{20,255}$/.test(token)) throw new HttpError(401, "Sign in with GitHub to post.");
  const key = createHash("sha256").update(token).digest("hex");
  const hit = users.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.user;
  const res = await fetch(`${GITHUB_API}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "reviewq-api" },
  });
  if (res.status === 401) throw new HttpError(401, "Your GitHub sign-in ran out. Sign in again.");
  if (!res.ok) throw new HttpError(502, "Couldn't check your GitHub account. Try again.");
  const u = await res.json();
  const user = { author: `gh${u.id}`, login: String(u.login), name: String(u.name || "").slice(0, 80), avatar: String(u.avatar_url || "") };
  users.set(key, { at: Date.now(), user });
  if (users.size > 5000) users.clear();
  return user;
}

export function repoOwner(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\//i.exec(url || "");
  return m ? m[1].toLowerCase() : null;
}
