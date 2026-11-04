// GET    /api/reviews?project=618        the project's community reviews
// POST   /api/reviews {project, token, review}   post or edit your review
// DELETE /api/reviews {project, token}            delete your review
// token is the reviewer's GitHub token from signing in.

import { readFresh, storage } from "../lib/store.js";
import { repoOwner, userFromToken } from "../lib/github.js";
import { body, claimedHours, failure, json, preflight, queuedProject, rateLimit } from "../lib/http.js";
import { cleanReview, emptyDb, HttpError, rankOf, remove, reviewsFor, update, upsert, validProjectId } from "../lib/reviews.js";

export function OPTIONS() {
  return preflight();
}

export async function GET(request) {
  try {
    const project = new URL(request.url).searchParams.get("project") || "";
    if (!validProjectId(project)) throw new HttpError(400, "Bad project id.");
    const db = (await readFresh())?.data || emptyDb();
    // A few seconds at the edge keeps reads cheap without showing anyone a
    // list more than ~10 s old; posters get fresh data back from their POST.
    return json({ reviews: reviewsFor(db, project) }, { cache: "public, s-maxage=8" });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(request) {
  try {
    rateLimit(request);
    const { project, token, review } = await body(request);
    const user = await userFromToken(token);
    const details = await queuedProject(String(project));
    if (repoOwner(details.project?.repo_url) === user.login.toLowerCase())
      throw new HttpError(403, "That's your own repo, so you can't review this project.");
    const clean = cleanReview(review, claimedHours(details));
    const db = await update(storage, (current) => upsert(current, String(project), user, clean));
    return json({ reviews: reviewsFor(db, String(project)), author: user.author, rank: rankOf(db, user.author) });
  } catch (e) {
    return failure(e);
  }
}

export async function DELETE(request) {
  try {
    rateLimit(request);
    const { project, token } = await body(request);
    if (!validProjectId(String(project))) throw new HttpError(400, "Bad project id.");
    const { author } = await userFromToken(token);
    const db = await update(storage, (current) => remove(current, String(project), author));
    return json({ reviews: reviewsFor(db, String(project)) });
  } catch (e) {
    return failure(e);
  }
}
