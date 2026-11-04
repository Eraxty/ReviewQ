# ReviewQ

ts vibecoded dont blame me if smthin breaks

Review queue for Pixl: an unofficial live view of every project waiting for
its first review, longest wait at the top, so makers can find their position.
Reviewers can only open the top 15 of each queue, so the site marks where
that cutoff is and tells makers how many spots they still need to move up.

Live at **https://eraxty.github.io/ReviewQ/**

Every project in the queue also has a review page (`review.html?id=618`) laid
out like Pixl's review dash: its README, commits, journals and past review
notes, plus a review form with the same fields (verdict, tier, hours to credit,
technical features, why lower the hours, additional notes, note to the player
with the dash's `/ai`, `/badreadme`... macros). Drafts autosave in the browser.
Anyone signed in with Google can post their review, and every field has a copy
button, so a real reviewer can copy what checks out into the dash and double
check it there. Community reviews are unofficial.

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

## Community reviews (Firebase)

Pages can't store anything, so posted reviews live in Firestore and sign-in
is Firebase Auth with Google. Both fit the free Spark plan. Until
`site/reviews-config.json` has a config, review pages still work for drafting
and copying, and say posting isn't switched on.

To switch it on:

1. Create a project at https://console.firebase.google.com (no Analytics needed).
2. **Build > Authentication > Get started**, then enable **Google** under
   Sign-in method.
3. **Authentication > Settings > Authorized domains**: add `eraxty.github.io`.
4. **Build > Firestore Database > Create database**, production mode.
5. **Firestore > Rules**: paste in `firestore.rules` and publish (or
   `npx firebase-tools deploy --only firestore:rules --project <id>`).
6. **Project settings > General > Your apps**: add a Web app and copy
   `apiKey`, `authDomain`, `projectId` and `appId` into
   `site/reviews-config.json`:

   ```json
   { "firebase": { "apiKey": "...", "authDomain": "<id>.firebaseapp.com", "projectId": "<id>", "appId": "..." } }
   ```

   This config is meant to be public; the rules are what protect the data.

7. Push. The next run of the Action also adds a review count to each queue row.

What the rules allow: anyone can read reviews; a signed-in person can post one
review per project, edit or delete their own, and the name and photo on it
must be their Google account's. Moderation is from the Firebase console: a
document at `admins/<uid>` lets that person delete any review and ban authors
from the review page; a document at `banned/<uid>` stops someone from posting.
Find uids under **Authentication > Users**.

## Tests

```bash
.venv/bin/python -m unittest test_queue_rules
cd rules-test && npm install && npm test   # firestore.rules in the emulator, needs Java 11+
```

To try the review page against local emulators, run
`rules-test/node_modules/.bin/firebase emulators:start --project demo-reviewq`
and point `site/reviews-config.json` at
`{ "firebase": { "apiKey": "x", "authDomain": "localhost", "projectId": "demo-reviewq", "appId": "x", "emulators": true } }`.
