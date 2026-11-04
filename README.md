# ReviewQ

ts vibecoded dont blame me if smthin breaks

Review queue for Pixl: an unofficial live view of every project waiting for
its first review, longest wait at the top, so makers can find their position.
Reviewers can only open the top 15 of each queue, so the site marks where
that cutoff is and tells makers how many spots they still need to move up.

Live at **https://eraxty.github.io/ReviewQ/**

## How it's hosted

GitHub Pages only serves static files, and Pixl's API rejects browser
requests from other sites, so the page can't call it directly. Instead
`.github/workflows/pages.yml` runs every ~10 minutes:

1. restores the crawler database from the `state` branch,
2. runs `python crawler.py --budget 420` (queued projects first),
3. force-pushes the database back to `state` as a single commit,
4. runs `python export.py _site` (the `site/` files plus `queue.json`) and
   deploys it to Pages.

The crawler and exporter only use the Python standard library. GitHub can
delay scheduled runs, and it pauses schedules in repos with no activity for 60
days; re-enable the workflow from the Actions tab if that happens.

## Run locally

```bash
uv venv && uv pip install -r requirements.txt   # or: python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python app.py                          # http://localhost:5000
```

`app.py` serves the same `site/` folder plus a live `/queue.json`, with the
crawler running in the background. Don't run it while the Action is also
crawling unless you're fine with double the requests to Pixl.

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
