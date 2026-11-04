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

Posting a review needs a GitHub sign-in, so every review shows who wrote it,
and signed-in visitors' GitHub requests (README, commits, diffs) run on their
own 5,000-an-hour limit instead of the shared 60. Real reviewers can copy what
checks out into the dash and double check it there. Community reviews are
unofficial. The queue page tags projects that have been unofficially reviewed
and has a leaderboard of the top community reviewers, all time and this week.

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
| `POST /api/reviews {project, token, review}` | Post or edit your review |
| `DELETE /api/reviews {project, token}` | Delete your review |
| `GET /api/counts` | Reviews per project, for the queue page's tags |
| `GET /api/leaderboard` | Top 25 reviewers, all time and this week |
| `GET /api/auth/login?return=<page>` | Starts GitHub sign-in |
| `GET /api/auth/callback` | GitHub sends people back here |
| `POST /api/admin {admin, action, project, author}` | `check`, `delete` someone's review, or `ban` their key |

Sign-in is a GitHub OAuth app asking for no scopes, so the token can only
read public data. The API swaps the code for a token with the app's secret and
sends the token back to the review page in the URL fragment; the page keeps it
in localStorage. Posting sends the token, the API asks GitHub whose it is, and
the review is stored under that GitHub user id with their login, name and
avatar, one review per person per project. Nobody can review a project whose
repo they own. The server only accepts reviews for projects that are in the
queue right now (`p/<id>.json` on the site), takes the claimed hours from
Pixl's data rather than the browser, checks the same things the dash's form
does, and limits each address to 30 writes per 10 minutes.

Moderation: open any review page once as `review.html?id=<id>#admin=<key>`.
The key stays in that browser (it's removed from the address bar) and adds
Delete and Ban author buttons to every review. A ban is by GitHub user id. Only the key's SHA-256 is in
the code (`reviews-api/lib/http.js`), or set `ADMIN_KEY_SHA256` on Vercel to
use a different key.

It runs as the `reviewq-api` Vercel project at
https://reviewq-api-eraxty.vercel.app, with a private Blob store
(`BLOB_READ_WRITE_TOKEN`), the GitHub OAuth app's `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` (callback `https://reviewq-api-eraxty.vercel.app/api/auth/callback`),
and Vercel Authentication turned off so browsers can reach it. To redeploy, deploy the `reviews-api` folder to that project.
The site finds the API through `site/reviews-config.json`; without an `api`
there, review pages still work for drafting and copying and say posting
isn't connected.

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
