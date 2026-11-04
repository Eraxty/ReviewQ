// POST /api/admin {admin, action: "check" | "delete" | "ban", project?, author?}
// Moderation with the admin key; only its SHA-256 is stored (lib/http.js).

import { storage } from "../lib/store.js";
import { body, failure, isAdmin, json, preflight, rateLimit } from "../lib/http.js";
import { AUTHOR_RX, ban, HttpError, remove, reviewsFor, update, validProjectId } from "../lib/reviews.js";

export function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  try {
    rateLimit(request, 60);
    const { admin, action, project, author } = await body(request);
    if (!isAdmin(admin)) throw new HttpError(403, "Wrong admin key.");
    if (action === "check") return json({ ok: true });
    if (typeof author !== "string" || !AUTHOR_RX.test(author)) throw new HttpError(400, "Bad author.");
    if (action === "delete") {
      if (!validProjectId(String(project))) throw new HttpError(400, "Bad project id.");
      const db = await update(storage, (current) => remove(current, String(project), author));
      return json({ reviews: reviewsFor(db, String(project)) });
    }
    if (action === "ban") {
      const db = await update(storage, (current) => ban(current, author));
      return json({ reviews: validProjectId(String(project)) ? reviewsFor(db, String(project)) : [] });
    }
    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    return failure(e);
  }
}
