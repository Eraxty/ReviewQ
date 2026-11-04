import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { authorFor, ban, cleanReview, Conflict, counts, emptyDb, HttpError, remove, reviewsFor, update, upsert } from "../lib/reviews.js";

const key = () => randomBytes(32).toString("hex");
const good = {
  verdict: "needs_changes",
  tier: 3,
  hours: 8,
  technical_features: "Proxmox-like web panel with an xterm.js websocket console.",
  deflation_reason: "Few commits for the console.",
  notes: "",
  note: "Cool project! Add a screenshot to the README.",
};

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

test("author ids come from the key and reveal nothing else", () => {
  const k = key();
  assert.equal(authorFor(k), createHash("sha256").update(k).digest("hex").slice(0, 16));
  assert.notEqual(authorFor(key()), authorFor(k));
  assert.throws(() => authorFor("short"), HttpError);
});

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

test("one review per person per project, editable, deletable", () => {
  const a = authorFor(key());
  const b = authorFor(key());
  let db = upsert(emptyDb(), "618", a, cleanReview(good, 11.4), new Date("2026-11-04T10:00:00Z"));
  db = upsert(db, "618", b, cleanReview(good, 11.4), new Date("2026-11-04T10:01:00Z"));
  db = upsert(db, "618", a, cleanReview({ ...good, verdict: "approved", notes: "Steady commits." }, 11.4), new Date("2026-11-04T11:00:00Z"));
  const list = reviewsFor(db, "618");
  assert.equal(list.length, 2);
  assert.equal(list[0].author, a, "newest edit first");
  assert.equal(list[0].verdict, "approved");
  assert.equal(list[0].created_at, "2026-11-04T10:00:00.000Z", "created_at survives edits");
  assert.deepEqual(counts(db), { 618: 2 });
  db = remove(db, "618", a);
  assert.deepEqual(reviewsFor(db, "618").map((r) => r.author), [b]);
  assert.throws(() => remove(db, "618", a), HttpError);
});

test("banned authors lose their reviews and can't post again", () => {
  const a = authorFor(key());
  let db = upsert(emptyDb(), "618", a, cleanReview(good, 11.4));
  db = upsert(db, "700", a, cleanReview(good, 11.4));
  db = ban(db, a);
  assert.deepEqual(counts(db), {});
  assert.throws(() => upsert(db, "618", a, cleanReview(good, 11.4)), (e) => e.status === 403);
});

test("people posting at the same time don't overwrite each other", async () => {
  const storage = memoryStorage();
  const authors = Array.from({ length: 8 }, () => authorFor(key()));
  await Promise.all(authors.map((a) => update(storage, (db) => upsert(db, "618", a, cleanReview(good, 11.4)))));
  assert.equal(storage.peek().reviews["618"].length, 8);
});
