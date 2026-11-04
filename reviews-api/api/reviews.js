// GET    /api/reviews?project=618        the project's community reviews
// POST   /api/reviews {project, key, review}   post or edit your review
// DELETE /api/reviews {project, key}            delete your review

import { readFresh, storage } from "../lib/store.js";
import { body, claimedHours, failure, json, preflight, queuedProject, rateLimit } from "../lib/http.js";
import { authorFor, cleanReview, emptyDb, HttpError, remove, reviewsFor, update, upsert, validProjectId } from "../lib/reviews.js";

export function OPTIONS() {
  return preflight();
}

export async function GET(request) {
  try {
    const project = new URL(request.url).searchParams.get("project") || "";
    if (!validProjectId(project)) throw new HttpError(400, "Bad project id.");
    const db = (await readFresh())?.data || emptyDb();
    // A few seconds at the edge keeps reads cheap; posters get fresh data back from their POST.
    return json({ reviews: reviewsFor(db, project) }, { cache: "public, s-maxage=5, stale-while-revalidate=30" });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(request) {
  try {
    rateLimit(request);
    const { project, key, review } = await body(request);
    const author = authorFor(key);
    const details = await queuedProject(String(project));
    const clean = cleanReview(review, claimedHours(details));
    const db = await update(storage, (current) => upsert(current, String(project), author, clean));
    return json({ reviews: reviewsFor(db, String(project)), author });
  } catch (e) {
    return failure(e);
  }
}

export async function DELETE(request) {
  try {
    rateLimit(request);
    const { project, key } = await body(request);
    if (!validProjectId(String(project))) throw new HttpError(400, "Bad project id.");
    const author = authorFor(key);
    const db = await update(storage, (current) => remove(current, String(project), author));
    return json({ reviews: reviewsFor(db, String(project)) });
  } catch (e) {
    return failure(e);
  }
}
