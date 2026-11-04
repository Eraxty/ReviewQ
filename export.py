"""Write the static site plus a queue.json snapshot, for GitHub Pages.

    python export.py _site

Each queued project also gets p/<id>.json with its public details, for the
review page. When community reviews are switched on (site/reviews-config.json),
queue.json rows carry how many reviews each project has.
"""

import json
import shutil
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import crawler
from snapshot import build

SITE = Path(__file__).parent / "site"
FIRESTORE = "https://firestore.googleapis.com/v1/projects/{project}/databases/(default)/documents:runAggregationQuery"


def firebase_config() -> dict | None:
    try:
        return json.loads((SITE / "reviews-config.json").read_text()).get("firebase")
    except (OSError, ValueError):
        return None


def review_count(config: dict, project_id: int) -> int:
    """How many community reviews a project has. A count query costs one read
    however many reviews match, so this stays cheap as reviews pile up."""
    body = {
        "structuredAggregationQuery": {
            "structuredQuery": {
                "from": [{"collectionId": "reviews"}],
                "where": {
                    "fieldFilter": {
                        "field": {"fieldPath": "project_id"},
                        "op": "EQUAL",
                        "value": {"stringValue": str(project_id)},
                    }
                },
            },
            "aggregations": [{"alias": "n", "count": {}}],
        }
    }
    req = urllib.request.Request(
        FIRESTORE.format(project=config["projectId"]) + f"?key={config['apiKey']}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as res:
        result = json.load(res)
    return int(result[0]["result"]["aggregateFields"]["n"]["integerValue"])


def add_review_counts(snapshot: dict) -> None:
    config = firebase_config()
    if not config:
        return
    rows = [r for q in snapshot["queues"].values() for r in (*q["waiting"], *q["final_checks"])]
    try:
        with ThreadPoolExecutor(8) as pool:
            counts = list(pool.map(lambda r: review_count(config, r["id"]), rows))
    except Exception as e:  # the queue matters more than the counts
        print(f"skipped review counts: {e!r}")
        return
    for row, n in zip(rows, counts):
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
        for pid, body in conn.execute("select id, json from details"):
            if pid in queued:
                (out / "p" / f"{pid}.json").write_text(body)
    print(f"wrote {out}/ ({len(queued)} project pages)")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "_site"))
