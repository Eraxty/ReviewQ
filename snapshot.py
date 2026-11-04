"""The queue as the page shows it, built from the crawler's database."""

from datetime import datetime, timedelta, timezone

import crawler
from queue_rules import FINAL_CHECKS, WAITING, normalize, reviews_per_day, sort_longest_wait

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
        "generated_at": now.isoformat(),
        "reviewed_24h": {
            "approved": last_day.count("approved"),
            "needs_changes": last_day.count("needs_changes"),
        },
        # The first full crawl hasn't finished until a sweep has been recorded.
        "crawling": "last_sweep" not in meta,
        # Set while Pixl hides unshipped projects; the queue is then frozen.
        "api_locked_since": meta.get("api_locked_since"),
        "probed": probed,
        "top_id": top,
        "queues": queues,
    }
