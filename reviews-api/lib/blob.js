// The reviews document in a private Vercel Blob. Writes are conditional on the
// ETag that was read, so two people posting at once can't overwrite each other.

import { BlobPreconditionFailedError, get, put } from "@vercel/blob";
import { Conflict } from "./reviews.js";

const PATH = "reviews.json";

let cache = null; // { data, etag, at } for warm instances

export const blobStorage = {
  async read({ maxAgeMs = 0 } = {}) {
    if (cache && Date.now() - cache.at < maxAgeMs) return cache;
    const res = await get(PATH, { access: "private", useCache: false, ifNoneMatch: cache?.etag });
    console.log("DEBUG blob read", res ? res.statusCode : 404, JSON.stringify(res?.blob?.etag), "cached", JSON.stringify(cache?.etag));
    if (!res) return null;
    if (res.statusCode === 304) {
      cache = { ...cache, at: Date.now() };
      return cache;
    }
    const data = JSON.parse(await new Response(res.stream).text());
    cache = { data, etag: res.blob.etag, at: Date.now() };
    return cache;
  },

  async write(data, etag) {
    try {
      const result = await put(PATH, JSON.stringify(data), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        // First write creates the document; later ones must match what was read.
        allowOverwrite: etag !== null,
        ...(etag ? { ifMatch: etag } : {}),
      });
      cache = { data, etag: result.etag, at: Date.now() };
    } catch (e) {
      console.log("DEBUG blob write failed", e?.name, e?.message, "etag", JSON.stringify(etag));
      if (e instanceof BlobPreconditionFailedError || /already exists/i.test(e?.message || "")) {
        cache = null;
        throw new Conflict();
      }
      throw e;
    }
  },
};


