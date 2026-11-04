// GET /api/leaderboard  the top community reviewers, all time and this week.

import { readFresh } from "../lib/store.js";
import { failure, json, preflight } from "../lib/http.js";
import { emptyDb, leaderboard } from "../lib/reviews.js";

export function OPTIONS() {
  return preflight();
}

export async function GET() {
  try {
    const db = (await readFresh())?.data || emptyDb();
    const { all, week, people } = leaderboard(db);
    const pub = ({ author, ...p }) => p;
    return json({ all: all.map(pub), week: week.map(pub), people }, { cache: "public, s-maxage=30" });
  } catch (e) {
    return failure(e);
  }
}
