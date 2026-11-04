"""Local dev server: the same static site as GitHub Pages, with a live crawler."""

import os
import time

from flask import Flask, Response, abort, jsonify

import crawler
from snapshot import build

app = Flask(__name__, static_folder="site", static_url_path="")

_cache: dict = {"at": 0.0, "body": None}
CACHE_SECONDS = 30


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/queue.json")
def queue():
    if _cache["body"] is None or time.time() - _cache["at"] > CACHE_SECONDS:
        _cache["body"] = build()
        _cache["at"] = time.time()
    return jsonify(_cache["body"])


@app.get("/p/<int:pid>.json")
def project_details(pid: int):
    with crawler.connect() as conn:
        row = conn.execute("select json from details where id = ?", (pid,)).fetchone()
    if row is None:
        abort(404)
    return Response(row["json"], mimetype="application/json")


crawler.init_db()
# One crawler per machine: run a single process (no reloader, one gunicorn
# worker), or set PIXL_WAIT_NO_CRAWL=1 to serve the database as it is.
if os.environ.get("PIXL_WAIT_NO_CRAWL") != "1":
    crawler.start_background(lambda msg: app.logger.warning(msg))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
