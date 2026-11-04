import os
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, render_template

import crawler
from queue_rules import FINAL_CHECKS, WAITING, normalize, reviews_per_day, sort_longest_wait

app = Flask(__name__)

_cache: dict = {"at": 0.0, "body": None}
CACHE_SECONDS = 30

ROW_COLUMNS = (
    "id, name, owner_name, project_type, queue, level, status, image_url, "
    "shipped_at, wait_start, wait_exact, is_peak"
)


def build() -> dict:
    statuses = (WAITING, *FINAL_CHECKS)
    marks = ",".join("?" * len(statuses))
    with crawler.connect() as conn:
        rows = [dict(r) for r in conn.execute(f"select {ROW_COLUMNS} from projects where status in ({marks})", statuses)]
        verdicts = conn.execute(
            """select p.queue, r.verdict, r.created_at from reviews r join projects p on p.id = r.project_id
               where r.verdict in ('approved', 'needs_changes')"""
        ).fetchall()
        probed, top = conn.execute("select count(*), max(id) from probes").fetchone()
        queue_checked = conn.execute(
            f"select min(checked_at) from probes where status in ({marks})", statuses
        ).fetchone()[0]
        meta = dict(conn.execute("select key, value from meta").fetchall())

    for r in rows:
        r["wait_exact"] = bool(r["wait_exact"])
        r["is_peak"] = bool(r["is_peak"])

    now = datetime.now(timezone.utc)
    queues = {}
    for q in ("software", "hardware"):
        mine = [r for r in rows if r["queue"] == q]
        queues[q] = {
            "waiting": sort_longest_wait([r for r in mine if r["status"] == WAITING]),
            "final_checks": sort_longest_wait([r for r in mine if r["status"] in FINAL_CHECKS]),
            "reviews_per_day": round(reviews_per_day([t for queue, _, t in verdicts if queue == q], now), 1),
        }
    day_ago = (now - timedelta(days=1)).isoformat()
    last_day = [v for _, v, t in verdicts if normalize(t) >= day_ago]
    return {
        "reviewed_24h": {
            "approved": last_day.count("approved"),
            "needs_changes": last_day.count("needs_changes"),
        },
        # The first full crawl hasn't finished until a sweep has been recorded.
        "crawling": "last_sweep" not in meta,
        "probed": probed,
        "top_id": top,
        "queue_checked_at": queue_checked,
        "queues": queues,
    }


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/queue")
def queue():
    if _cache["body"] is None or time.time() - _cache["at"] > CACHE_SECONDS:
        _cache["body"] = build()
        _cache["at"] = time.time()
    return jsonify(_cache["body"])


crawler.init_db()
# One crawler per machine: run a single process (no reloader, one gunicorn
# worker), or set PIXL_WAIT_NO_CRAWL=1 and run `python crawler.py` on a timer.
if os.environ.get("PIXL_WAIT_NO_CRAWL") != "1":
    crawler.start_background(lambda msg: app.logger.warning(msg))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
