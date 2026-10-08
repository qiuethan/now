# now.ethanqiu.ca

Self-updating "now" page that **tracks what I've actually been doing** rather than
restating a resume. A GitHub Action runs hourly, pulls live activity from the
GitHub API (repos, public events, and contributions), reads anonymous ActivityWatch
app totals synced from the Mac, **derives** the projects and stack from
that data, and commits the rendered `public/` files. Vercel serves them as static
files and exposes them as a read-only JSON API under `/api/*`. The API never
generates on request — it returns the last committed snapshot, regenerated hourly
by the Action and cached at the edge for an hour — so a request never triggers a
GitHub/OpenAI fetch.

```
config/now.json ──┐   (identity, links, optional availability — that's all)
GitHub repos ─────┤
GitHub events ────┼──> scripts/generate.mjs ──> public/tools/*.json + tools.json
GitHub graph ─────┤   (derive projects, stack, contributions)  + now.md + now.json ──> Vercel
ActivityWatch ────┘   (local aggregation → GitHub Actions variable; app totals only)
```

## Data model

JSON is the source of truth; `now.md` and `llms.txt` are renders of it. Every tool
is exposed as an API route (`GET /api/projects`), backed 1:1 by the committed static
file (`/tools/projects.json`) the route rewrites to, and carries `schema_version` so
consumers can detect changes. Schema version 2 removes the retired time-tracking
fields, adds `prsReviewed`, `issuesOpened`, `totalPushes`, `source`, and `partial`
to GitHub activity, and adds `full_name` and `last_activity_at` to public projects.
`totalCommits` is `null` when contribution data is unavailable; it is never inferred
from push events. `totalPushes` is `null` when the public event feed is unavailable.
The combined snapshot is also written as `public/snapshot.json`: Vercel omits the
legacy configuration filename `now.json` as a static asset. `/now.json`, `/json`,
and `/api/now` therefore all rewrite to the identical `snapshot.json` payload.

| Tool | Source | Notes |
|---|---|---|
| `get_identity` | config | name, location, links |
| `get_availability` | config | optional one line; the only soft-declared field |
| `get_projects` | **derived** | personal repos + contributed repos, ranked by recent activity; private repos anonymized (see below) |
| `get_stack` | **derived** | languages ranked across personal repos and public contributed repos |
| `get_activity` | **derived** | public GitHub contributions and anonymous coding-app time this week |
| `get_coding` | ActivityWatch | active time in Orca and VS Code, split by app and UTC date, with last-sync timestamp |
| `get_summary` | **derived** | prose summary of the week from public activity; deterministic fallback without `OPENAI_API_KEY` |
| `get_contributions` | **derived** | filtered contribution calendar (daily counts, past year) + totals/streaks |
| `get_writing` | **derived** | recent posts from the Substack RSS feed, newest first (title, url, date, excerpt) |

**Stale-persistence:** the committed `public/` *is* the cache. On each run, every
auto source falls back to its last-good value (flagged `stale: true`, original
`fetched_at` kept) if the fetch fails, so one API hiccup never blanks the page.
Cached data older than `settings.max_stale_days` (default 30) is dropped instead.
Weekly prose is regenerated from the available activity rather than reusing old
text, and carries the activity source’s stale status. Removed optional tool files
are deleted so their API paths cannot keep serving an obsolete snapshot.

## URLs (once deployed)

| URL | Returns |
|---|---|
| `now.ethanqiu.ca/` | `now.md` (markdown — the canonical LLM-facing page) |
| `now.ethanqiu.ca/json` or `/now.json` | full structured snapshot (CORS open) |
| `now.ethanqiu.ca/tools` or `/tools.json` | tool manifest |
| `now.ethanqiu.ca/tools/<name>.json` | one tool's typed payload |
| `now.ethanqiu.ca/llms.txt` | llms.txt index pointing at the above |

### API (`/api/*`)

Read-only JSON, same payloads as the tool files, cached at the edge for an hour.
Each response is the last hourly snapshot; the API does no work on request.

| Route | Returns |
|---|---|
| `GET /api` | tool manifest (the API index) |
| `GET /api/now` | full structured snapshot |
| `GET /api/identity` | identity payload |
| `GET /api/availability` | availability payload |
| `GET /api/projects` | projects payload |
| `GET /api/stack` | stack payload |
| `GET /api/activity` | activity payload |
| `GET /api/coding` | anonymous coding-app totals (available after first sync) |
| `GET /api/summary` | weekly prose summary payload |
| `GET /api/contributions` | contributions payload |
| `GET /api/writing` | writing payload |

## Config

`config/now.json` is small and hand-edited only when these change:

- `identity` — name, headline, location, `github_username`, links
- `availability` — one optional line APIs can't infer; delete it for zero manual fields
- `substack_url` — your Substack publication URL; recent posts are pulled from its public RSS feed (delete it to drop the writing section)
- `settings` — `max_stale_days`, `max_projects`, `active_within_days`, `max_posts`, `include_private`, `excluded_repositories`

Everything else (projects, stack, activity) comes from GitHub. Public contributions
in organization repositories and repositories owned by other people count too.
The generator combines the public events feed with GraphQL commit, pull request,
review, and issue contributions. It discovers projects over `active_within_days`
(at least 7 days), fetches their metadata, and ranks them by your most recent
contribution. Personal repositories without recent contributions use the date of
the latest commit authored by the configured user on their default branch.
Automated pushes and collaborators' commits do not make a project recent. Merely
having access to an organization's repository does not make it a project. Private
organization repositories with recent contributions are eligible when
`include_private` is enabled.

`excluded_repositories` contains case-insensitive `owner/repository` patterns
with `*` wildcards. The configured `*shopify*` excludes Shopify and related owner
or repository names before repository-specific reads, project summaries, stack
counts, public activity, and heatmap aggregation. Changing this policy invalidates
old aggregate caches so an API failure cannot restore excluded work.

Weekly commit counts follow GitHub's contribution rules (including its default
branch rules), rather than counting every pushed commit. Pushes are reported
separately. The weekly window covers seven UTC calendar days including today,
matching the heatmap's `last_7_days`. Public events are paginated up to GitHub's 300-event limit; GraphQL
requests cover up to 100 repositories per contribution type and 100 entries per
repository. Incomplete sources or detected truncation set `github.partial: true`.
Without an authenticated contribution query, public events still discover
organization projects and report pushes, PRs, and reviews; commit counts are
unknown. Repository descriptions provide the project descriptions.

### Private repos

With `settings.include_private: true`, personal private repositories and private
organization repositories you recently contributed to are eligible, subject to
`excluded_repositories` and the token’s access (including SSO restrictions). To
avoid exposing them, each private repo is reduced to a short AI-written gist of its
domain, purpose, and primary tech — read from the repo's README — with its name,
URL, and source withheld (and the blurb dropped if it echoes the repo name). The
generator also bans integration lists, internal architecture, and the "core" idea.
Private repos are excluded from the stack counts and the public "this week" activity.
Requires `GH_PAT` to read private repos. Descriptive blurbs additionally require
`settings.private_ai_summaries: true`; this is **disabled** in the current configuration
so private READMEs and metadata are not sent to OpenAI. Unchanged cached blurbs are reused and other private projects
receive a generic "Private software project" label; no README is fetched for AI
processing in that mode.

> ⚠️ The AI blurb is obfuscation, not a guarantee. **Review the generated blurbs
> after the first run**, and make sure nothing in the included private repos is
> client/NDA work you don't want even vaguely public.

## Setup

1. **Push to GitHub** (default branch `main`), then add repo secrets
   (Settings → Secrets → Actions):
   - `OPENAI_API_KEY` — enables the LLM "this week" paragraph and the anonymized
     private-repo blurbs (`gpt-5.4-mini`; override with `NOW_LLM_MODEL`)
   - `GH_PAT` — a personal access token for the GitHub contribution query, with
     read access to the relevant private repos if `include_private` is enabled.
     Public organization contributions do not require private repository access.
   - `GITHUB_TOKEN` is automatic — no setup needed.
2. **Import the repo into Vercel** (no framework; settings come from `vercel.json`)
   and add the `now.ethanqiu.ca` domain (CNAME → `cname.vercel-dns.com`).
3. **Point LLMs at it**: the portfolio's `llms.txt` references this site.

## Local run

Copy `.env.example` to `.env` and fill in your keys — `npm run generate` loads it
automatically (and ignores it in CI, where secrets come from the Action).

```sh
npm install
cp .env.example .env      # then fill in GH_PAT / OPENAI_API_KEY
npm test                  # offline regression checks
npm run generate          # works with zero keys too (public GitHub events + repos)
```

## Notes

### ActivityWatch coding time (macOS)

With ActivityWatch installed, run `sh scripts/install-activitywatch-coding.sh` and
restart ActivityWatch. The tray app starts the local `aw-watcher-coding` module
instead of the general window and AFK watchers. The module allows only the exact
Orca and VS Code application identifiers. Other apps, a locked screen, and three
minutes without input count as inactive for coding; their names, titles, and URLs
are not recorded. Coding window events contain only the app name, an empty title,
and a session identifier. The official VS Code extension still records local
project/file/language details. Existing history from before the change is retained.

The module starts and stops with ActivityWatch. It communicates only with
`127.0.0.1:5600`. Its source is `scripts/aw-watcher-coding.swift`; run the compiled
binary with `--self-test` to verify filtering or `--check` to inspect the current
coding state without sending an event. To restore standard tracking, quit
ActivityWatch, restore `aw-qt.toml.before-coding-only` over `aw-qt.toml` in
`~/Library/Application Support/activitywatch/aw-qt/`, then reopen ActivityWatch.

To connect the tracker to the public page, sign in with `gh auth login` (access to
repository Actions variables), then run:

```sh
sh scripts/install-activitywatch-sync.sh qiuethan/now
npm run sync:activitywatch  # optional immediate sync
```

The installer copies the exporter into `~/Library/Application Support/now-activitywatch/`
and installs two per-user launch agents: ActivityWatch starts at login, and the
exporter runs at login and every 15 minutes while the Mac is awake. The exporter
reads only the local window and AFK buckets, accepts only the restricted tracker's
Orca/VS Code events, intersects them with active time, removes overlaps, and splits
durations at UTC midnight. The VS Code extension's file and project records are
never read or exported. Existing broad trial history is not published.
Before writing or publishing, the exporter requires an AFK heartbeat from the
last two minutes (idle heartbeats count). If the watcher stops while the server
stays up, the last good snapshot and its original sync time remain unchanged.

Only daily app totals for the last 30 UTC dates, a schema version, and the sync
timestamp are sent to the `ACTIVITYWATCH_SUMMARY` repository variable. This uses
the existing `gh` login; no token is copied into source or the launch agents.
Anonymous app totals can include time spent on any repository, per the selected
preference; the Shopify exclusion continues to apply to GitHub repository data.

The hourly Action reads the variable and publishes the most recent seven UTC
dates to `/api/coding`, `/api/activity`, `/now.json`, and `/now.md`. Updates follow
the Action schedule plus the existing one-hour CDN cache. GitHub can delay cron
runs. The page preserves the original sync timestamp and flags data after two
hours without a sync. Old dates roll out of the weekly window even while the Mac
is offline, and snapshots expire after 30 days. Quitting ActivityWatch stops new
recording; the sync job does not reopen it during the session.

For a local preview, run `node scripts/export-activitywatch.mjs` followed by
`npm run generate`. The generator reads the local summary automatically; CI reads
the repository variable. `ACTIVITYWATCH_SNAPSHOT_PATH` overrides the local file.
An explicitly set `ACTIVITYWATCH_SUMMARY` takes precedence, including an empty
value. Raw ActivityWatch events, app window titles, paths, machine identifiers,
and repository names never enter this export.

Logs are in `~/Library/Logs/now-activitywatch/`. To stop automatic syncing:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/ca.ethanqiu.now.activitywatch-sync.plist"
rm "$HOME/Library/LaunchAgents/ca.ethanqiu.now.activitywatch-sync.plist"
```

To disable ActivityWatch's start-at-login as well, unload and remove
`ca.ethanqiu.now.activitywatch-start.plist` in the same directory. The installed
scripts are independent of this checkout; rerun the installer after editing them.

### Generator behavior

- Every data source fails soft (see stale-persistence above).
- The hourly commit only happens when content changed; each push triggers a Vercel
  deploy (well within free-tier limits at 24/day max).
- GitHub contribution queries require authentication. If they fail, public events
  remain available and the activity section reports partial coverage.
- Public organization contributions are included in projects, stack, activity,
  and summaries. Private projects remain anonymous and are excluded from public
  weekly activity and language counts.
- The heatmap is rebuilt from repository-attributed commits, PRs, reviews, and
  issues in 28-day windows, applying the same exclusions before counting. It can
  include eligible private activity as daily counts. It omits inaccessible or
  unattributed contributions and repository creations, so totals can differ from
  the GitHub profile. If a window exceeds API limits, the last valid filtered
  calendar is used with a stale flag.


## Portfolio Sync

The separate [Portfolio Sync worker](https://github.com/qiuethan/portfolio-sync) runs from `.github/workflows/portfolio-sync.yml`. It reuses this repository's `GH_PAT` and `OPENAI_API_KEY` secrets. The service checkout is pinned to a reviewed commit; update that reference deliberately when upgrading the worker. `GH_PAT` needs access to the private worker repository and contents/PR write access to `qiuethan/Portfolio`.

Merge the portfolio's tracker integration before enabling this workflow. The hourly job publishes factual activity to `/portfolio-sync/activity.json`; a daily scan at 11:07 UTC can propose content changes in the portfolio repository. Use **Run workflow → scan** to start the initial baseline and catch-up proposal for the three Current work projects. GitHub PRs provide review and notifications. The worker never merges them.

Checkpoints are committed under `.portfolio-sync/state.json`, outside the public site directory. Only public, selected repository facts are served in the activity feed. Both update workflows share one concurrency group to serialize commits; neither cancels a running update. See the worker README for scope, recovery, and the pending Devpost/Overleaf connections.
