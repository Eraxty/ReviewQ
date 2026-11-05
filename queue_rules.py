"""How the review queue is ordered, rebuilt from public project data.

The review dash sorts the first-pass queue longest-wait-first, where the wait
starts at (apps/internal-dashboard/lib/queueWait.ts):
- the first ship, for a first ship or a fix-and-reship after "needs changes";
- the update ship itself, for an update of an already approved project.

The public API only has the latest shipped_at, which restarts on every
reship, including when a maker unships back to a draft and ships again. Two
things recover the first ship:
- the earliest shipped_at the crawler has ever seen for the project, the same
  "set once, never reset" rule as the dash's first_shipped_at;
- for a project sent back with "needs changes", its first ship came before
  that first verdict, so the verdict time is a lower bound.
- the first verdict itself is usually days after the ship, though. If it was
  an automatic send-back, it came seconds after the ship. Otherwise makers
  journal right before shipping, so the last journal entry before that
  verdict is a close guess (checked against the dash on Nov 5: 75 of 83
  projects on the exact day, up from 71).
Any of these moving the start earlier marks the wait as approximate.
"""

from datetime import datetime, timedelta, timezone

# First-pass queue, the dash's "Needs review".
WAITING = "shipped"
# Passed the first review, waiting on the fraud check or spot check.
FINAL_CHECKS = ("fraud_review", "second_review")
HARDWARE_TYPES = {"hardware", "cad"}
PACE_DAYS = 7


def queue_of(project_type: str | None) -> str:
    return "hardware" if project_type in HARDWARE_TYPES else "software"


def is_auto_verdict(review: dict) -> bool:
    """Pixl's bot sends back incomplete ships seconds after they're shipped."""
    return "sent back automatically" in (review.get("note") or "").lower()


def first_ship_guess(first_verdict: dict, journal_times: list[str], created_at: str | None) -> str:
    """Best guess at the ship that the first verdict reviewed."""
    verdict_at = normalize(first_verdict["created_at"])
    if first_verdict.get("auto"):
        return verdict_at
    before = [t for t in map(normalize, journal_times) if t < verdict_at]
    if not before:
        return verdict_at
    return max([max(before), *([normalize(created_at)] if created_at else [])])


def wait_start(
    shipped_at: str | None,
    reviews: list[dict],
    first_seen_ship: str | None = None,
    journal_times: list[str] = (),
    created_at: str | None = None,
) -> tuple[str | None, bool]:
    """(when the queue wait started, whether that time is exact)."""
    if not shipped_at:
        return None, False
    verdicts = sorted(reviews, key=lambda r: normalize(r["created_at"]))
    shipped = normalize(shipped_at)
    if any(r["verdict"] == "approved" for r in verdicts):
        # An update ship: its wait starts at this ship.
        return shipped, True
    first_nc = [r for r in verdicts if r["verdict"] == "needs_changes"][:1]
    earlier = [first_ship_guess(first_nc[0], list(journal_times), created_at)] if first_nc else []
    if first_seen_ship:
        earlier.append(first_seen_ship)
    start = min([shipped, *map(normalize, earlier)])
    return start, start == shipped


def sort_longest_wait(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda r: (normalize(r["wait_start"]) if r["wait_start"] else "9999", r["id"]))


def reviews_per_day(verdict_times: list[str], now: datetime) -> float:
    """Verdicts handed out per day over the last week, a rough review pace."""
    cutoff = (now - timedelta(days=PACE_DAYS)).isoformat()
    recent = [t for t in verdict_times if normalize(t) >= cutoff]
    return len(recent) / PACE_DAYS


def normalize(ts: str) -> str:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
