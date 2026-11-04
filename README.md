# ReviewQ

ts vibecoded dont blame me if smthin breaks

Review queue for Pixl: an unofficial live view of every project waiting for
its first review, longest wait at the top, so makers can find their position.
Reviewers can only open the top 15 of each queue, so the site marks where
that cutoff is and tells makers how many spots they still need to move up.

Live at **https://eraxty.github.io/ReviewQ/**

Every project in the queue also has a review page (`review.html?id=618`), a
copy of Pixl's review dash built from its open source code
(`apps/internal-dashboard`, MIT): the same look, the README, a commit table
with the time between commits, AI-commit flags and diffs you can open, the
journals, past review notes, the maker's level and earlier projects, a live
payout preview, and the same review form (hours to credit, tier, technical
features, why lower the hours, additional notes, note to the player with the
`/ai`, `/badreadme`... macros) with the verdict buttons at the bottom. Drafts
autosave in the browser and every field has a copy button.

Posting a review is anonymous: each browser makes a random key and shows up as
something like "Anon #3F9A". Real reviewers can copy what checks out into the
dash and double check it there. Community reviews are unofficial.

## How it's hosted

GitHub Pages only serves static files, and Pixl's API rejects browser
requests from other sites, so the page can't call it directly. Instead
`.github/workflows/pages.yml` runs every ~10 minutes:

1. restores the crawler database from the `state` branch,
2. runs `python crawler.py --budget 420` (queued projects first),
3. force-pushes the database back to `state` as a single commit,
4. runs `python export.py _site` (the `site/` files, `queue.json`, and
   `p/<id>.json` with the public details of each queued project) and deploys
   it to Pages.

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

## Community reviews (`reviews-api/`)

Pages can't store anything, so posted reviews go through a small API on
Vercel (`reviews-api/`, Node, no framework) that keeps them in one private
Vercel Blob document. Writes are conditional on the document's ETag, so two
people posting at once can't overwrite each other.

| Endpoint | What it does |
|---|---|
| `GET /api/reviews?project=618` | The project's reviews, newest first (cached 5 s at the edge) |
| `POST /api/reviews {project, key, review}` | Post or edit your review |
| `DELETE /api/reviews {project, key}` | Delete your review |
| `GET /api/counts` | Reviews per project, read by `export.py` for the queue page |
| `POST /api/admin {admin, action, project, author}` | `check`, `delete` someone's review, or `ban` their key |

Nobody signs in. The browser keeps a random 256-bit key in localStorage and
the review's author id is the first 16 hex characters of its SHA-256, so a key
can edit or delete only its own reviews and the id says nothing about who
wrote it. Reviewers can copy their key to another device from the form. The
server only accepts reviews for projects that are in the queue right now
(`p/<id>.json` on the site), takes the claimed hours from Pixl's data rather
than the browser, checks the same things the dash's form does, and limits
each address to 30 writes per 10 minutes.

Moderation: open any review page once as `review.html?id=<id>#admin=<key>`.
The key stays in that browser (it's removed from the address bar) and adds
Delete and Ban author buttons to every review. Only the key's SHA-256 is in
the code (`reviews-api/lib/http.js`), or set `ADMIN_KEY_SHA256` on Vercel to
use a different key.

Deploying it: create a Vercel project with `reviews-api` as the root
directory, add a private Blob store to it (which sets
`BLOB_READ_WRITE_TOKEN`), deploy, and put the deployment URL in
`site/reviews-config.json` as `{"api": "https://..."}`. Until then the review
pages work for drafting and copying, and say posting isn't connected.

Running it locally against a JSON file:

```bash
cd reviews-api && npm install
REVIEWS_FILE=reviews.local.json SITE_URL=http://localhost:5000 node dev.js   # http://localhost:8787
```

## Tests

```bash
.venv/bin/python -m unittest test_queue_rules
cd reviews-api && npm test
```
