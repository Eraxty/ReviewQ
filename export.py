"""Write the static site plus a queue.json snapshot, for GitHub Pages.

    python export.py _site

Each queued project also gets p/<id>.json with its public details and its
maker's public profile, for the review page. queue.json rows carry how many
community reviews each project has, from the reviews API in
site/reviews-config.json.
"""

import json
import shutil
import sys
import urllib.request
from pathlib import Path

import crawler
from snapshot import build

SITE = Path(__file__).parent / "site"


def reviews_api() -> str | None:
    try:
        return json.loads((SITE / "reviews-config.json").read_text()).get("api")
    except (OSError, ValueError):
        return None


def add_review_counts(snapshot: dict) -> None:
    """Mark each queued project with how many community reviews it has."""
    api = reviews_api()
    if not api:
        return
    try:
        req = urllib.request.Request(f"{api.rstrip('/')}/api/counts", headers={"User-Agent": crawler.USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as res:
            counts = json.load(res)["counts"]
    except Exception as e:  # the queue matters more than the counts
        print(f"skipped review counts: {e!r}")
        return
    for q in snapshot["queues"].values():
        for row in (*q["waiting"], *q["final_checks"]):
            n = counts.get(str(row["id"]))
            if n:
                row["community_reviews"] = n


def main(out: Path) -> None:
    crawler.init_db()
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(SITE, out)
    snapshot = build()
    add_review_counts(snapshot)
    (out / "queue.json").write_text(json.dumps(snapshot, separators=(",", ":")))

    queued = {r["id"] for q in snapshot["queues"].values() for r in (*q["waiting"], *q["final_checks"])}
    (out / "p").mkdir()
    with crawler.connect() as conn:
        for pid in queued:
            body = crawler.page_details(conn, pid)
            if body:
                (out / "p" / f"{pid}.json").write_text(body)
    print(f"wrote {out}/ ({len(queued)} project pages)")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "_site"))
