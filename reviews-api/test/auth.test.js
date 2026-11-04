import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

// Handlers read these when they load.
process.env.GITHUB_CLIENT_ID = "client-id";
process.env.GITHUB_CLIENT_SECRET = "client-secret";
process.env.REVIEWS_FILE = join(mkdtempSync(join(tmpdir(), "reviewq-")), "reviews.json");
process.env.SITE_URL = "https://eraxty.github.io/ReviewQ";

const SITE = process.env.SITE_URL;
const PAGE = `${SITE}/review.html?id=618`;
const TOKEN = "gho_aliceToken1234567890abcdef";
const API = "https://reviewq-api-eraxty.vercel.app";

// A pretend GitHub and Pages site behind fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === "https://github.com/login/oauth/access_token") {
    const body = JSON.parse(init.body);
    if (body.client_secret !== "client-secret" || body.code !== "good-code") return Response.json({ error: "bad_verification_code" });
    return Response.json({ access_token: TOKEN });
  }
  if (url === "https://api.github.com/user") {
    if (init.headers.Authorization !== `Bearer ${TOKEN}`) return new Response("{}", { status: 401 });
    return Response.json({ id: 42, login: "alice", name: "Alice", avatar_url: "https://avatars.githubusercontent.com/u/42" });
  }
  if (url === `${SITE}/p/618.json`) return Response.json({ project: { id: "618", repo_url: "https://github.com/someone/proxmox", hackatime_seconds: 41040 } });
  if (url === `${SITE}/p/700.json`) return Response.json({ project: { id: "700", repo_url: "https://github.com/Alice/own-thing", hackatime_seconds: 3600 } });
  if (url.startsWith(`${SITE}/p/`)) return new Response("", { status: 404 });
  return realFetch(url, init);
};

let login, callback, reviews, http;
before(async () => {
  login = await import("../api/auth/login.js");
  callback = await import("../api/auth/callback.js");
  reviews = await import("../api/reviews.js");
  http = await import("../lib/http.js");
});

const review = {
  verdict: "needs_changes",
  tier: 3,
  hours: 11.4,
  technical_features: "Proxmox-like web panel with an xterm.js websocket console.",
  notes: "",
  note: "Cool project! Add a screenshot to the README.",
};
const post = (body, ip = "1.1.1.1") =>
  reviews.POST(new Request(`${API}/api/reviews`, { method: "POST", headers: { "x-forwarded-for": ip }, body: JSON.stringify(body) }));

test("sign-in only sends people back to the site", () => {
  assert.equal(http.returnUrl(PAGE), PAGE);
  assert.equal(http.returnUrl(`${PAGE}#gh_token=x`), PAGE);
  assert.equal(http.returnUrl("http://localhost:5000/review.html?id=1"), "http://localhost:5000/review.html?id=1");
  assert.equal(http.returnUrl("https://evil.example/"), `${SITE}/`);
  assert.equal(http.returnUrl("https://eraxty.github.io/ReviewQevil/"), `${SITE}/`);
  assert.equal(http.returnUrl("javascript:alert(1)"), `${SITE}/`);
  assert.equal(http.returnUrl(null), `${SITE}/`);
});

test("login redirects to GitHub with no scopes and a state cookie", async () => {
  const res = await login.GET(new Request(`${API}/api/auth/login?return=${encodeURIComponent(PAGE)}`));
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(to.searchParams.get("client_id"), "client-id");
  assert.equal(to.searchParams.get("scope"), "");
  assert.equal(to.searchParams.get("redirect_uri"), `${API}/api/auth/callback`);
  const cookie = res.headers.get("set-cookie");
  assert.match(cookie, /^rq_oauth=[0-9a-f]{32}\./);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(cookie.split(";")[0].split(".")[0], `rq_oauth=${to.searchParams.get("state")}`);
});

async function signIn(code = "good-code", tamper = false) {
  const start = await login.GET(new Request(`${API}/api/auth/login?return=${encodeURIComponent(PAGE)}`));
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = start.headers.get("set-cookie").split(";")[0];
  return callback.GET(new Request(`${API}/api/auth/callback?code=${code}&state=${tamper ? "0".repeat(32) : state}`, { headers: { cookie } }));
}

test("callback hands the token back to the page in the fragment", async () => {
  const res = await signIn();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `${PAGE}#gh_token=${TOKEN}`);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
});

test("callback rejects a wrong state or a bad code", async () => {
  assert.equal((await signIn("good-code", true)).headers.get("location"), `${PAGE}#gh_error=expired`);
  assert.equal((await signIn("bad-code")).headers.get("location"), `${PAGE}#gh_error=failed`);
  const noCookie = await callback.GET(new Request(`${API}/api/auth/callback?code=good-code&state=abc`));
  assert.equal(noCookie.headers.get("location"), `${SITE}/#gh_error=expired`);
});

test("posting needs a real GitHub token and shows the account", async () => {
  assert.equal((await post({ project: "618", token: "nope", review })).status, 401);
  assert.equal((await post({ project: "618", token: "gho_someoneElsesTokenXXXXXXXX", review })).status, 401);
  const res = await post({ project: "618", token: TOKEN, review });
  assert.equal(res.status, 200);
  const { reviews: list, author } = await res.json();
  assert.equal(author, "gh42");
  assert.equal(list[0].login, "alice");
  assert.equal(list[0].name, "Alice");
  assert.equal(list[0].avatar, "https://avatars.githubusercontent.com/u/42");
});

test("you can't review a project whose repo you own", async () => {
  const res = await post({ project: "700", token: TOKEN, review: { ...review, hours: 1 } });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /your own repo/);
});

test("only queued projects can be reviewed", async () => {
  assert.equal((await post({ project: "999", token: TOKEN, review })).status, 404);
});
