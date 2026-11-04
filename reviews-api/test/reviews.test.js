import assert from "node:assert/strict";
import { test } from "node:test";
import { ban, cleanReview, Conflict, counts, emptyDb, HttpError, remove, reviewsFor, update, upsert } from "../lib/reviews.js";

const good = {
  verdict: "needs_changes",
  tier: 3,
  hours: 8,
  technical_features: "Proxmox-like web panel with an xterm.js websocket console.",
  deflation_reason: "Few commits for the console.",
  notes: "",
  note: "Cool project! Add a screenshot to the README.",
};
const user = (id, login = `user${id}`) => ({ author: `gh${id}`, login, name: "", avatar: `https://avatars.githubusercontent.com/u/${id}` });

// In memory, with the same compare-and-swap behaviour as the blob store.
function memoryStorage() {
  let doc = null;
  let version = 0;
  return {
    async read() {
      return doc && { data: structuredClone(doc), etag: String(version) };
    },
    async write(data, etag) {
      if ((doc ? String(version) : null) !== etag) throw new Conflict();
      doc = structuredClone(data);
      version++;
    },
    peek: () => doc,
  };
}

test("reviews are checked like the dash form", () => {
  assert.equal(cleanReview(good, 11.4).hours, 8);
  assert.equal(cleanReview({ ...good, hours: 99 }, 11.4).hours, 11.4, "hours capped at the claim");
  assert.equal(cleanReview({ ...good, hours: 11.4 }, 11.4).deflation_reason, "", "no reason kept without deflation");
  const bad = [
    { verdict: "lgtm" },
    { tier: 5 },
    { tier: 2.5 },
    { technical_features: "short" },
    { deflation_reason: "" },
    { verdict: "approved", notes: "" },
    { note: "  " },
    { notes: "x".repeat(6001) },
    { note: 7 },
  ];
  for (const change of bad) assert.throws(() => cleanReview({ ...good, ...change }, 11.4), HttpError, JSON.stringify(change));
});

test("one review per GitHub account per project, editable, deletable", () => {
  let db = upsert(emptyDb(), "618", user(1, "alice"), cleanReview(good, 11.4), new Date("2026-11-04T10:00:00Z"));
  db = upsert(db, "618", user(2, "bob"), cleanReview(good, 11.4), new Date("2026-11-04T10:01:00Z"));
  db = upsert(db, "618", user(1, "alice-renamed"), cleanReview({ ...good, verdict: "approved", notes: "Steady commits." }, 11.4), new Date("2026-11-04T11:00:00Z"));
  const list = reviewsFor(db, "618");
  assert.equal(list.length, 2);
  assert.equal(list[0].author, "gh1", "newest edit first");
  assert.equal(list[0].login, "alice-renamed", "keeps up with username changes");
  assert.equal(list[0].verdict, "approved");
  assert.equal(list[0].created_at, "2026-11-04T10:00:00.000Z", "created_at survives edits");
  assert.deepEqual(counts(db), { 618: 2 });
  db = remove(db, "618", "gh1");
  assert.deepEqual(reviewsFor(db, "618").map((r) => r.author), ["gh2"]);
  assert.throws(() => remove(db, "618", "gh1"), HttpError);
});

test("banned accounts lose their reviews and can't post again", () => {
  let db = upsert(emptyDb(), "618", user(1), cleanReview(good, 11.4));
  db = upsert(db, "700", user(1), cleanReview(good, 11.4));
  db = ban(db, "gh1");
  assert.deepEqual(counts(db), {});
  assert.throws(() => upsert(db, "618", user(1), cleanReview(good, 11.4)), (e) => e.status === 403);
});

test("people posting at the same time don't overwrite each other", async () => {
  const storage = memoryStorage();
  await Promise.all(Array.from({ length: 8 }, (_, i) => update(storage, (db) => upsert(db, "618", user(i), cleanReview(good, 11.4)))));
  assert.equal(storage.peek().reviews["618"].length, 8);
});

test("leaderboard ranks reviewers by reviews, with a weekly board", async () => {
  const { leaderboard, rankOf } = await import("../lib/reviews.js");
  const now = new Date("2026-11-20T12:00:00Z");
  const old = new Date("2026-11-01T12:00:00Z");
  let db = emptyDb();
  db = upsert(db, "1", user(1, "alice"), cleanReview(good, 11.4), old);
  db = upsert(db, "2", user(1, "alice"), cleanReview(good, 11.4), old);
  db = upsert(db, "3", user(1, "alice"), cleanReview(good, 11.4), old);
  db = upsert(db, "1", user(2, "bob"), cleanReview(good, 11.4), now);
  db = upsert(db, "2", user(2, "bob"), cleanReview({ ...good, verdict: "approved", notes: "ok" }, 11.4), now);
  const board = leaderboard(db, now);
  assert.deepEqual(board.all.map((p) => [p.login, p.reviews]), [["alice", 3], ["bob", 2]]);
  assert.deepEqual(board.week.map((p) => [p.login, p.week]), [["bob", 2]], "alice's reviews are older than a week");
  assert.equal(board.all[1].approved, 1);
  assert.equal(board.people, 2);
  assert.deepEqual(rankOf(db, "gh2"), { position: 2, reviews: 2, of: 2 });
  assert.equal(rankOf(db, "gh9"), null);
});
