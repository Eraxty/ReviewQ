// GET /api/counts  how many community reviews each project has, for the queue page.

import { readFresh } from "../lib/store.js";
import { failure, json, preflight } from "../lib/http.js";
import { counts, emptyDb } from "../lib/reviews.js";

export function OPTIONS() {
  return preflight();
}

export async function GET() {
  try {
    const db = (await readFresh())?.data || emptyDb();
    return json({ counts: counts(db) }, { cache: "public, s-maxage=60, stale-while-revalidate=300" });
  } catch (e) {
    return failure(e);
  }
}
