"""Crawls Pixl's public project API into SQLite.

The list endpoint caps at 100 rows with no paging, so every project id is
probed through /api/explore/projects/:id, which returns its status, ship time
and review history. After the first full pass, ids are re-checked on a
schedule that depends on their status: queued projects every few minutes,
drafts and the rest less often.
"""

import json
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from queue_rules import FINAL_CHECKS, WAITING, is_auto_verdict, normalize, queue_of, wait_start

API = "https://server.pixl.hackclub.com/api/explore/projects"
PLAYERS_API = "https://server.pixl.hackclub.com/api/explore/players"
USER_AGENT = "pixl-queue/1.0 (public review queue viewer)"
DB_PATH = Path(__file__).parent / "data" / "pixl.db"

# The server allows 300 requests/min per IP; stay well under it.
REQUESTS_PER_SECOND = 3
WORKERS = 4
# Keep probing this many ids past the highest one that exists.
ID_HEADROOM = 50

MIN = 60
RECHECK_SECONDS = {
    WAITING: 5 * MIN,
    **{s: 5 * MIN for s in FINAL_CHECKS},
    "needs_changes": 15 * MIN,
    "draft": 30 * MIN,
    "approved": 24 * 60 * MIN,
    None: 6 * 60 * MIN,  # 404: deleted, archived, rejected, banned or never existed
}
DEFAULT_RECHECK = 30 * MIN
PLAYER_RECHECK_SECONDS = 6 * 60 * MIN
# Lower runs first, so queue changes show up before the long tail of drafts.
PRIORITY = {WAITING: 0, **{s: 0 for s in FINAL_CHECKS}, "needs_changes": 1}

SCHEMA = """
create table if not exists projects (
  id integer primary key,
  name text not null,
  owner_name text,
  project_type text,
  queue text not null,
  level integer,
  status text not null,
  image_url text,
  created_at text,
  shipped_at text,
  wait_start text,
  wait_exact integer not null default 1,
  is_peak integer not null default 0,
  fetched_at text not null
);
create index if not exists projects_status on projects(status);
create table if not exists reviews (
  project_id integer not null,
  verdict text not null,
  created_at text not null
);
create index if not exists reviews_project on reviews(project_id);
create table if not exists probes (
  id integer primary key,
  status text,
  checked_at real not null
);
create table if not exists first_ships (
  id integer primary key,
  shipped_at text not null
);
create table if not exists meta (key text primary key, value text);
-- Public details (description, links, journals, past review notes) of queued
-- projects, for the review page.
create table if not exists details (
  id integer primary key,
  json text not null
);
-- Public profiles (level, approved hours, approved projects) of queued makers.
create table if not exists players (
  id text primary key,
  json text not null,
  fetched_at real not null
);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """A connection that commits on success and is always closed."""
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("pragma journal_mode=wal")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        # Seed first-seen ships from projects crawled before that table existed.
        missing = conn.execute(
            """select id, shipped_at from projects
               where shipped_at is not null and id not in (select id from first_ships)"""
        ).fetchall()
        conn.executemany(
            "insert into first_ships (id, shipped_at) values (?, ?)",
            [(r["id"], normalize(r["shipped_at"])) for r in missing],
        )


class RateLimiter:
    def __init__(self, per_second: float):
        self.gap = 1.0 / per_second
        self.next_at = 0.0
        self.lock = threading.Lock()

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next_at)
            self.next_at = at + self.gap
        time.sleep(max(0.0, at - now))


limiter = RateLimiter(REQUESTS_PER_SECOND)


def get_json(url: str) -> dict | None:
    """GET a JSON body. Returns None on 404, retries on 429 and network errors."""
    for attempt in range(5):
        limiter.wait()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code == 429:
                time.sleep(int(e.headers.get("Retry-After") or 30))
                continue
            if e.code >= 500:
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(2 ** attempt)
    raise RuntimeError(f"giving up on {url}")


QUEUED = (WAITING, *FINAL_CHECKS)


def public_details(data: dict) -> dict:
    """The parts of a project's API response the review page shows."""
    p = data["project"]
    owner = data.get("owner") or {}
    pick = lambda d, keys: {k: d.get(k) for k in keys}
    return {
        "project": pick(
            p,
            ("id", "user_id", "name", "description", "project_type", "level", "status", "image_url",
             "repo_url", "demo_url", "created_at", "shipped_at", "hackatime_seconds", "is_peak",
             "approved_hours"),
        ),
        "owner": pick(owner, ("display_name", "avatar_url")),
        "entries": [pick(e, ("id", "title", "content", "hours", "created_at", "edited_at")) for e in data.get("entries") or []],
        "reviews": [
            pick(r, ("verdict", "created_at", "note", "claimed_hours", "approved_hours"))
            for r in data.get("reviews") or []
        ],
    }


def save_project(conn: sqlite3.Connection, data: dict) -> str:
    p = data["project"]
    reviews = [
        {"verdict": r["verdict"], "created_at": r["created_at"], "auto": is_auto_verdict(r)}
        for r in data.get("reviews") or []
        if r.get("verdict") and r.get("created_at")
    ]
    journals = [e["created_at"] for e in data.get("entries") or [] if e.get("created_at")]
    pid = int(p["id"])
    shipped_at = p.get("shipped_at")
    if shipped_at:
        # Pixl's first_shipped_at is set once and never reset, but only the
        # latest shipped_at is public. Remember the earliest one seen so an
        # unship and reship doesn't send a project to the back of the queue.
        conn.execute(
            """insert into first_ships (id, shipped_at) values (?, ?)
               on conflict(id) do update set shipped_at = min(shipped_at, excluded.shipped_at)""",
            (pid, normalize(shipped_at)),
        )
    first_seen = conn.execute("select shipped_at from first_ships where id = ?", (pid,)).fetchone()
    start, exact = wait_start(
        shipped_at, reviews, first_seen[0] if first_seen else None, journals, p.get("created_at")
    )
    owner = data.get("owner") or {}
    status = p.get("status") or "unknown"
    conn.execute(
        """insert or replace into projects
           (id, name, owner_name, project_type, queue, level, status, image_url,
            created_at, shipped_at, wait_start, wait_exact, is_peak, fetched_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            pid,
            p.get("name") or "",
            owner.get("display_name"),
            p.get("project_type"),
            queue_of(p.get("project_type")),
            p.get("level"),
            status,
            p.get("image_url"),
            p.get("created_at"),
            shipped_at,
            start,
            int(exact),
            int(bool(p.get("is_peak"))),
            datetime.now(timezone.utc).isoformat(),
        ),
    )
    conn.execute("delete from reviews where project_id = ?", (pid,))
    conn.executemany(
        "insert into reviews (project_id, verdict, created_at) values (?,?,?)",
        [(pid, r["verdict"], r["created_at"]) for r in reviews],
    )
    if status in QUEUED:
        conn.execute(
            "insert or replace into details (id, json) values (?, ?)",
            (pid, json.dumps(public_details(data), separators=(",", ":"))),
        )
    else:
        conn.execute("delete from details where id = ?", (pid,))
    return status


def public_player(data: dict) -> dict:
    """The parts of a maker's public profile the review page shows."""
    player = data.get("player") or {}
    return {
        **{k: player.get(k) for k in ("display_name", "created_at", "pixels", "xp_hours", "re", "level")},
        "approved": [
            {k: p.get(k) for k in ("id", "name", "project_type", "level", "hackatime_seconds", "approved_hours", "shipped_at")}
            for p in data.get("projects") or []
        ],
    }


def refresh_player(user_id: str) -> None:
    """Fetch a queued maker's public profile unless it's recent."""
    with connect() as conn:
        row = conn.execute("select fetched_at from players where id = ?", (user_id,)).fetchone()
    if row and time.time() - row["fetched_at"] < PLAYER_RECHECK_SECONDS:
        return
    data = get_json(f"{PLAYERS_API}/{user_id}/public")
    with connect() as conn:
        if data and data.get("ok"):
            conn.execute(
                "insert or replace into players (id, json, fetched_at) values (?, ?, ?)",
                (user_id, json.dumps(public_player(data), separators=(",", ":")), time.time()),
            )
        else:
            conn.execute("delete from players where id = ?", (user_id,))


def probe(pid: int) -> str | None:
    data = get_json(f"{API}/{pid}")
    with connect() as conn:
        if data and data.get("ok") and data.get("project"):
            status = save_project(conn, data)
        else:
            status = None
            # Gone from the public API, so no longer in any queue.
            conn.execute("delete from projects where id = ?", (pid,))
            conn.execute("delete from reviews where project_id = ?", (pid,))
            conn.execute("delete from details where id = ?", (pid,))
        conn.execute(
            "insert or replace into probes (id, status, checked_at) values (?,?,?)",
            (pid, status, time.time()),
        )
    user_id = ((data or {}).get("project") or {}).get("user_id")
    if status in QUEUED and isinstance(user_id, str) and len(user_id) == 36:
        refresh_player(user_id)
    return status


def unshipped_list() -> dict[int, str]:
    """Status of the newest 100 unshipped projects, by id.

    Empty means the API is hiding unshipped projects again (it did for a day,
    server commit b38c4d14): every queued project would then 404.
    """
    data = get_json(f"{API}?shipped=unshipped&limit=100") or {}
    return {int(p["id"]): p.get("status") for p in data.get("projects", [])}


def changed_in_list(listed: dict[int, str]) -> set[int]:
    """Ids whose status in the unshipped list differs from ours.

    Catches fresh ships between the slower draft re-checks.
    """
    if not listed:
        return set()
    with connect() as conn:
        marks = ",".join("?" * len(listed))
        known = dict(conn.execute(f"select id, status from probes where id in ({marks})", list(listed)).fetchall())
    return {pid for pid, status in listed.items() if known.get(pid, "?") != status}


def due_ids(urgent: set[int] = frozenset()) -> list[int]:
    """Ids worth probing now, queued projects first."""
    now = time.time()
    with connect() as conn:
        checked = {r["id"]: (r["status"], r["checked_at"]) for r in conn.execute("select * from probes")}
    top = max((pid for pid, (status, _) in checked.items() if status), default=0)
    top = max([top, *urgent])

    due = []
    for pid in range(1, top + ID_HEADROOM + 1):
        state = checked.get(pid)
        if pid in urgent or state is None:
            due.append((0, -pid))
            continue
        status, at = state
        if now - at > RECHECK_SECONDS.get(status, DEFAULT_RECHECK):
            due.append((PRIORITY.get(status, 2), -pid))
    return [-neg for _, neg in sorted(due)]


def sweep(log=print, budget_seconds: float | None = None) -> int:
    listed = unshipped_list()
    with connect() as conn:
        if listed:
            conn.execute("delete from meta where key = 'api_locked_since'")
        else:
            conn.execute(
                "insert or ignore into meta (key, value) values ('api_locked_since', ?)",
                (datetime.now(timezone.utc).isoformat(),),
            )
    if not listed:
        # Probing now would 404 every queued project and empty the queue, so
        # keep the last known one until unshipped projects are public again.
        log("[crawler] the API lists no unshipped projects, keeping the last known queue")
        return 0
    due = due_ids(changed_in_list(listed))
    ids = due
    if budget_seconds is not None:
        # Due ids come queued-first, so a capped run still covers the queue
        # and leaves the rest of the drafts for the next run.
        ids = due[: int(budget_seconds * REQUESTS_PER_SECOND)]
    if not ids:
        return 0
    started = time.time()
    if len(ids) > 50:
        log(f"[crawler] probing {len(ids)} ids")
    with ThreadPoolExecutor(WORKERS) as pool:
        for i, _ in enumerate(pool.map(probe, ids), 1):
            if i % 250 == 0:
                log(f"[crawler] {i}/{len(ids)} probed")
    if len(ids) == len(due):
        # Only a pass that covered everything due counts; the first one ends
        # the initial crawl (snapshot.build reports "crawling" until then).
        with connect() as conn:
            conn.execute(
                "insert or replace into meta (key, value) values ('last_sweep', ?)",
                (datetime.now(timezone.utc).isoformat(),),
            )
    if len(ids) > 50:
        log(f"[crawler] sweep of {len(ids)} ids done in {time.time() - started:.0f}s")
    return len(ids)


def run_forever(log=print) -> None:
    init_db()
    while True:
        try:
            sweep(log)
        except Exception as e:  # keep the site up even if the API misbehaves
            log(f"[crawler] sweep failed: {e!r}")
        time.sleep(60)


def start_background(log=print) -> threading.Thread:
    t = threading.Thread(target=run_forever, args=(log,), daemon=True, name="crawler")
    t.start()
    return t


def page_details(conn: sqlite3.Connection, pid: int) -> str | None:
    """A queued project's details plus its maker's public profile, as JSON."""
    row = conn.execute("select json from details where id = ?", (pid,)).fetchone()
    if row is None:
        return None
    details = json.loads(row["json"])
    user_id = details["project"].get("user_id")
    player = conn.execute("select json from players where id = ?", (user_id,)).fetchone() if user_id else None
    details["maker"] = json.loads(player["json"]) if player else None
    return json.dumps(details, separators=(",", ":"))


def checkpoint() -> None:
    """Fold the write-ahead log into pixl.db so the file can be copied alone."""
    with connect() as conn:
        conn.execute("pragma wal_checkpoint(truncate)")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="One crawl pass over the Pixl project API.")
    parser.add_argument("--budget", type=float, help="stop after about this many seconds of requests")
    args = parser.parse_args()
    init_db()
    sweep(budget_seconds=args.budget)
    checkpoint()
