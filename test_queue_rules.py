import unittest
from datetime import datetime, timezone

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


if __name__ == "__main__":
    unittest.main()
