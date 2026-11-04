// Where the reviews document lives: Vercel Blob in production, or a local
// JSON file when REVIEWS_FILE is set (for running the API on your machine).

import { readFile, rename, writeFile } from "node:fs/promises";
import { blobStorage } from "./blob.js";
import { Conflict } from "./reviews.js";

function fileStorage(path) {
  let version = 0;
  return {
    async read() {
      try {
        return { data: JSON.parse(await readFile(path, "utf8")), etag: String(version) };
      } catch (e) {
        if (e.code === "ENOENT") return null;
        throw e;
      }
    },
    async write(data, etag) {
      if (etag !== null && etag !== String(version)) throw new Conflict();
      await writeFile(`${path}.tmp`, JSON.stringify(data, null, 1));
      await rename(`${path}.tmp`, path);
      version++;
    },
  };
}

export const storage = process.env.REVIEWS_FILE ? fileStorage(process.env.REVIEWS_FILE) : blobStorage;
export const readFresh = () => storage.read({ maxAgeMs: 5000 });
