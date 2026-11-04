import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone

import crawler
import export
from queue_rules import queue_of, reviews_per_day, sort_longest_wait, wait_start

NOW = datetime(2026, 11, 4, 12, tzinfo=timezone.utc)


def verdict(v, at):
    return {"verdict": v, "created_at": at}


class WaitStartTest(unittest.TestCase):
    def test_first_ship_is_exact(self):
        self.assertEqual(wait_start("2026-10-20T00:00:00Z", []), ("2026-10-20T00:00:00+00:00", True))

    def test_reship_counts_from_first_needs_changes(self):
        reviews = [verdict("needs_changes", "2026-10-14T00:00:00Z"), verdict("needs_changes", "2026-09-18T00:00:00Z")]
        self.assertEqual(wait_start("2026-11-02T19:21:00Z", reviews), ("2026-09-18T00:00:00+00:00", False))

    def test_unship_and_reship_keeps_the_first_ship_seen(self):
        # Shipped Oct 26, unshipped to a draft, shipped again Oct 30: no verdict in between.
        self.assertEqual(
            wait_start("2026-10-30T01:08:00.000Z", [], first_seen_ship="2026-10-26T09:00:00+00:00"),
            ("2026-10-26T09:00:00+00:00", False),
        )

    def test_first_seen_equal_to_shipped_at_is_exact(self):
        self.assertEqual(
            wait_start("2026-10-30T01:08:00.000Z", [], first_seen_ship="2026-10-30T01:08:00+00:00"),
            ("2026-10-30T01:08:00+00:00", True),
        )

    def test_update_of_approved_project_counts_from_this_ship(self):
        reviews = [verdict("approved", "2026-09-01T00:00:00Z"), verdict("needs_changes", "2026-10-10T00:00:00Z")]
        self.assertEqual(
            wait_start("2026-10-20T00:00:00Z", reviews, first_seen_ship="2026-08-01T00:00:00+00:00"),
            ("2026-10-20T00:00:00+00:00", True),
        )

    def test_never_shipped(self):
        self.assertEqual(wait_start(None, []), (None, False))


class OrderTest(unittest.TestCase):
    def test_longest_wait_first_and_unknown_last(self):
        rows = [
            {"id": 3, "wait_start": "2026-10-20T00:00:00Z"},
            {"id": 1, "wait_start": None},
            {"id": 2, "wait_start": "2026-09-18T00:00:00Z"},
        ]
        self.assertEqual([r["id"] for r in sort_longest_wait(rows)], [2, 3, 1])

    def test_queue_of(self):
        self.assertEqual(queue_of("cad"), "hardware")
        self.assertEqual(queue_of("hardware"), "hardware")
        self.assertEqual(queue_of("web"), "software")
        self.assertEqual(queue_of(None), "software")

    def test_reviews_per_day_counts_last_week_only(self):
        times = ["2026-11-03T00:00:00Z"] * 14 + ["2026-10-01T00:00:00.000Z"]
        self.assertEqual(reviews_per_day(times, NOW), 2.0)


class LockdownTest(unittest.TestCase):
    """If Pixl hides unshipped projects again, keep the last known queue."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = (crawler.DB_PATH, crawler.get_json)
        crawler.DB_PATH = Path(self.tmp.name) / "pixl.db"
        crawler.init_db()
        with crawler.connect() as conn:
            conn.execute(
                """insert into projects (id, name, queue, status, shipped_at, wait_start, fetched_at)
                   values (618, 'custom proxmox', 'software', 'shipped', '2026-11-02T19:21:00+00:00',
                           '2026-09-18T00:00:00+00:00', '2026-11-04T00:00:00+00:00')"""
            )
            conn.execute("insert into probes (id, status, checked_at) values (618, 'shipped', 0)")
        self.requests = []

    def tearDown(self):
        crawler.DB_PATH, crawler.get_json = self.saved
        self.tmp.cleanup()

    def fake_api(self, listed):
        def get_json(url):
            self.requests.append(url)
            if "shipped=unshipped" in url:
                return {"ok": True, "projects": listed}
            return None  # every single project 404s, like a locked API
        crawler.get_json = get_json

    def test_locked_api_keeps_the_queue_and_flags_it(self):
        self.fake_api([])
        self.assertEqual(crawler.sweep(log=lambda _: None), 0)
        self.assertEqual(len(self.requests), 1)  # only the list check, no probes
        with crawler.connect() as conn:
            self.assertEqual(conn.execute("select status from projects where id = 618").fetchone()[0], "shipped")
            self.assertIsNotNone(conn.execute("select value from meta where key = 'api_locked_since'").fetchone())

    def test_unlocking_clears_the_flag(self):
        self.fake_api([])
        crawler.sweep(log=lambda _: None)
        self.fake_api([{"id": "618", "status": "shipped"}])
        crawler.sweep(log=lambda _: None, budget_seconds=0.4)
        with crawler.connect() as conn:
            self.assertIsNone(conn.execute("select value from meta where key = 'api_locked_since'").fetchone())



def api_project(pid, status, **extra):
    return {
        "ok": True,
        "project": {
            "id": str(pid),
            "name": f"project {pid}",
            "description": "A thing",
            "project_type": "web",
            "level": 2,
            "status": status,
            "repo_url": "https://github.com/a/b",
            "demo_url": "https://a.github.io/b",
            "shipped_at": "2026-11-01T00:00:00.000Z",
            "created_at": "2026-10-01T00:00:00.000Z",
            "hackatime_seconds": 36000,
            "user_id": "secret-ish uuid",
            **extra,
        },
        "owner": {"id": "uuid", "display_name": "Maker", "avatar_url": "https://example.com/a.png"},
        "entries": [{"id": "1", "title": "Day 1", "content": "hi", "hours": 0, "created_at": "2026-10-02T00:00:00Z", "edited_at": None}],
        "reviews": [{"verdict": "needs_changes", "created_at": "2026-10-20T00:00:00Z", "note": "readme pls", "claimed_hours": 9, "approved_hours": None}],
        "upvotes": 3,
        "has_upvoted": False,
    }


class DetailsTest(unittest.TestCase):
    """Queued projects keep their public details for the review page."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = crawler.DB_PATH
        crawler.DB_PATH = Path(self.tmp.name) / "pixl.db"
        crawler.init_db()

    def tearDown(self):
        crawler.DB_PATH = self.saved
        self.tmp.cleanup()

    def details(self, pid):
        with crawler.connect() as conn:
            row = conn.execute("select json from details where id = ?", (pid,)).fetchone()
        return json.loads(row[0]) if row else None

    def test_queued_projects_keep_details(self):
        with crawler.connect() as conn:
            crawler.save_project(conn, api_project(618, "shipped"))
        d = self.details(618)
        self.assertEqual(d["project"]["repo_url"], "https://github.com/a/b")
        self.assertEqual(d["owner"], {"display_name": "Maker", "avatar_url": "https://example.com/a.png"})
        self.assertEqual(d["reviews"][0]["note"], "readme pls")
        self.assertEqual(d["entries"][0]["title"], "Day 1")
        # Only what the page shows, nothing else from the response.
        self.assertNotIn("user_id", d["project"])
        self.assertNotIn("upvotes", d)

    def test_details_go_when_a_project_leaves_the_queue(self):
        with crawler.connect() as conn:
            crawler.save_project(conn, api_project(618, "shipped"))
            crawler.save_project(conn, api_project(618, "approved"))
        self.assertIsNone(self.details(618))

    def test_export_writes_a_file_per_queued_project(self):
        with crawler.connect() as conn:
            crawler.save_project(conn, api_project(618, "shipped"))
            crawler.save_project(conn, api_project(700, "second_review"))
            crawler.save_project(conn, api_project(701, "draft"))
        out = Path(self.tmp.name) / "site"
        export.main(out)
        self.assertEqual(sorted(f.name for f in (out / "p").iterdir()), ["618.json", "700.json"])
        self.assertEqual(json.loads((out / "p" / "618.json").read_text())["project"]["id"], "618")
        self.assertTrue((out / "review.html").exists())


if __name__ == "__main__":
    unittest.main()
