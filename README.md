# ReviewQ

Review queue for Pixl: an unofficial live view of every project waiting for
its first review, longest wait at the top, so makers can find their position.
Reviewers can only open the top 15 of each queue, so the site marks those as
open for review and shows how many spots the rest still need to move up.

## Run

```bash
uv venv && uv pip install -r requirements.txt   # or: python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python app.py                          # http://localhost:5000
```

Production: run **one** process so only one crawler runs:

```bash
.venv/bin/gunicorn -w 1 --threads 8 -b 0.0.0.0:5000 app:app
```

Or set `PIXL_WAIT_NO_CRAWL=1` on the web process and run `python crawler.py`
separately (it does one pass and exits, so run it from cron/a timer).

## Where the data comes from

`GET https://server.pixl.hackclub.com/api/explore/projects/:id` is public and
returns a project's `status`, `shipped_at` and review history. The list
endpoint caps at 100 rows with no paging, so the crawler probes every id
instead, at 3 requests/s (the server allows 300/min per IP). The first pass
over ~2,400 ids takes ~13 minutes and is saved in `data/pixl.db`. After that:

| Status | Meaning | Re-checked every |
|---|---|---|
| `shipped` | waiting for first review (the dash's "Needs review") | 5 min |
| `fraud_review`, `second_review` | passed first review, waiting on final checks | 5 min |
| `needs_changes` | sent back to the maker | 15 min |
| `draft` | not shipped yet | 30 min |
| `approved` | done | 24 h |
| 404 | deleted, archived, rejected, banned or never existed | 6 h |

Each loop also reads the newest 100 unshipped projects from the list endpoint
and re-checks any whose status changed, so fresh ships show up within a minute
or two.

## Queue order

The review dash sorts longest-wait-first, counting from the **first** ship
(`apps/internal-dashboard/lib/queueWait.ts`), or from the update ship for an
update of an approved project. The public API only has the latest
`shipped_at`, which restarts on every reship. For a project resubmitted after
"needs changes", its first ship was before its first "needs changes" verdict,
so that verdict time is used as a lower bound and the wait shows as e.g.
`46d+`. Software and hardware (`project_type` hardware or cad) are separate
queues, like on the dash.

## Tests

```bash
.venv/bin/python -m unittest test_queue_rules
```
