// Runs firestore.rules in the emulator: `npm test` in this folder.
import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, serverTimestamp, where } from "firebase/firestore";

let env;

const ALICE = { uid: "alice", claims: { name: "Alice", picture: "https://lh3.googleusercontent.com/a" } };
const BOB = { uid: "bob", claims: { name: "Bob", picture: "" } };

const db = (who) => env.authenticatedContext(who.uid, who.claims).firestore();

function review(who, overrides = {}) {
  return {
    project_id: "618",
    uid: who.uid,
    author: who.claims.name,
    photo: who.claims.picture,
    verdict: "approved",
    tier: 2,
    claimed_hours: 11.4,
    hours: 9,
    technical_features: "A Proxmox web panel with a websocket console and LXC controls.",
    deflation_reason: "Few commits for the console, so 2.4h off.",
    notes: "",
    note: "Super cool project, keep it up!",
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
    ...overrides,
  };
}

const ref = (store, who, project = "618") => doc(store, "reviews", `${project}_${who.uid}`);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-reviewq",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8") },
  });
});

beforeEach(() => env.clearFirestore());

after(() => env.cleanup());

test("anyone can read reviews, signed in or not", async () => {
  await assertSucceeds(setDoc(ref(db(ALICE), ALICE), review(ALICE)));
  const anon = env.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(ref(anon, ALICE)));
  await assertSucceeds(getDocs(query(collection(anon, "reviews"), where("project_id", "==", "618"))));
});

test("signed out people can't post", async () => {
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(setDoc(doc(anon, "reviews", "618_alice"), review(ALICE)));
});

test("you can only post under your own id", async () => {
  await assertFails(setDoc(ref(db(BOB), ALICE), review(BOB)));
  await assertFails(setDoc(ref(db(BOB), BOB), review(BOB, { uid: "alice" })));
  await assertFails(setDoc(doc(db(ALICE), "reviews", "619_alice"), review(ALICE)));
});

test("the author name and photo must be the Google account's", async () => {
  await assertFails(setDoc(ref(db(ALICE), ALICE), review(ALICE, { author: "Pixl Staff" })));
  await assertFails(setDoc(ref(db(ALICE), ALICE), review(ALICE, { photo: "https://evil.example/x.png" })));
});

test("fields are checked", async () => {
  const mine = ref(db(ALICE), ALICE);
  await assertFails(setDoc(mine, review(ALICE, { verdict: "lgtm" })));
  await assertFails(setDoc(mine, review(ALICE, { tier: 5 })));
  await assertFails(setDoc(mine, review(ALICE, { tier: 2.5 })));
  await assertFails(setDoc(mine, review(ALICE, { hours: 12 })));
  await assertFails(setDoc(mine, review(ALICE, { technical_features: "too short" })));
  await assertFails(setDoc(mine, review(ALICE, { note: "" })));
  await assertFails(setDoc(mine, review(ALICE, { notes: "x".repeat(6001) })));
  await assertFails(setDoc(mine, review(ALICE, { extra: true })));
  await assertFails(setDoc(mine, review(ALICE, { project_id: "abc" })));
  await assertSucceeds(setDoc(mine, review(ALICE, { hours: 11.4, deflation_reason: "" })));
});

test("timestamps come from the server", async () => {
  await assertFails(setDoc(ref(db(ALICE), ALICE), review(ALICE, { created_at: new Date(0) })));
});

test("you can edit and delete your own review but not someone else's", async () => {
  await assertSucceeds(setDoc(ref(db(ALICE), ALICE), review(ALICE)));
  const saved = (await getDoc(ref(db(ALICE), ALICE))).data();
  await assertSucceeds(
    setDoc(ref(db(ALICE), ALICE), review(ALICE, { verdict: "needs_changes", created_at: saved.created_at })),
  );
  // created_at can't be rewritten on an edit.
  await assertFails(setDoc(ref(db(ALICE), ALICE), review(ALICE)));
  await assertFails(setDoc(ref(db(BOB), ALICE), review(ALICE, { created_at: saved.created_at })));
  await assertFails(deleteDoc(ref(db(BOB), ALICE)));
  await assertSucceeds(deleteDoc(ref(db(ALICE), ALICE)));
});

test("admins can delete any review and ban people", async () => {
  await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), "admins", "bob"), { note: "owner" }));
  await assertSucceeds(setDoc(ref(db(ALICE), ALICE), review(ALICE)));
  await assertSucceeds(getDoc(doc(db(BOB), "admins", "bob")));
  await assertFails(getDoc(doc(db(ALICE), "admins", "bob")));
  await assertSucceeds(deleteDoc(ref(db(BOB), ALICE)));
  await assertSucceeds(setDoc(doc(db(BOB), "banned", "alice"), { reason: "spam" }));
  await assertFails(setDoc(ref(db(ALICE), ALICE), review(ALICE)));
  // Non-admins can't ban, or make themselves admin.
  await assertFails(setDoc(doc(db(ALICE), "banned", "bob"), {}));
  await assertFails(setDoc(doc(db(ALICE), "admins", "alice"), {}));
});
