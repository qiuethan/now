# now.ethanqiu.ca

Self-updating "now" page that **tracks what I've actually been doing** rather than
restating a resume. A GitHub Action runs hourly, pulls live activity from the
GitHub API (repos + events) and WakaTime, **derives** the projects and stack from
that data, and commits the rendered `public/` files. Vercel serves them as static
files and exposes them as a read-only JSON API under `/api/*`. The API never
generates on request — it returns the last committed snapshot, regenerated hourly
by the Action and cached at the edge for an hour — so a request never triggers a
GitHub/WakaTime/OpenAI fetch.

```
config/now.json ──┐   (identity, links, optional availability — that's all)
GitHub repos ─────┤
GitHub events ────┼──> scripts/generate.mjs ──> public/tools/*.json + tools.json
GitHub graph ─────┤   (derive projects, stack, contributions)  + now.md + now.json ──> Vercel
WakaTime ─────────┘                                                                 (→ Fly API later)
```

## Data model

JSON is the source of truth; `now.md` and `llms.txt` are renders of it. Every tool
is exposed as an API route (`GET /api/projects`), backed 1:1 by the committed static
file (`/tools/projects.json`) the route rewrites to, and carries `schema_version` so
consumers stay stable.

| Tool | Source | Notes |
|---|---|---|
| `get_identity` | config | name, location, links |
| `get_availability` | config | optional one line; the only soft-declared field |
| `get_projects` | **derived** | GitHub repos, most-recently-pushed first; private repos anonymized (see below) |
| `get_stack` | **derived** | languages ranked across repos + WakaTime breakdown |
| `get_activity` | **derived** | commits/PRs/new repos this week + WakaTime time/languages |
| `get_summary` | **derived** | LLM-written prose summary of the week, from the same activity (omitted without `OPENAI_API_KEY`) |
| `get_contributions` | **derived** | GitHub contribution calendar (daily counts, past year) + totals/streaks |
| `get_writing` | **derived** | recent posts from the Substack RSS feed, newest first (title, url, date, excerpt) |

**Stale-persistence:** the committed `public/` *is* the cache. On each run, every
auto source falls back to its last-good value (flagged `stale: true`, original
`fetched_at` kept) if the fetch fails, so one API hiccup never blanks the page.
Cached data older than `settings.max_stale_days` (default 30) is dropped instead.

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
| `GET /api/summary` | weekly prose summary payload |
| `GET /api/contributions` | contributions payload |
| `GET /api/writing` | writing payload |

## Config

`config/now.json` is small and hand-edited only when these change:

- `identity` — name, headline, location, `github_username`, links
- `availability` — one optional line APIs can't infer; delete it for zero manual fields
- `substack_url` — your Substack publication URL; recent posts are pulled from its public RSS feed (delete it to drop the writing section)
- `settings` — `max_stale_days`, `max_projects`, `active_within_days`, `max_posts`

Everything else (projects, stack, activity) comes from GitHub + WakaTime. The
projects list is whatever you've pushed to most recently, and is only as good as
your repo descriptions — so write good ones.

### Private repos

With `settings.include_private: true`, your **personal** private repos are pulled
too (org/employer repos are hard-excluded — only repos owned by your account). To
avoid exposing them, each private repo is reduced to a short AI-written gist of its
domain, purpose, and primary tech — read from the repo's README — with its name,
URL, and source withheld (and the blurb dropped if it echoes the repo name). The
generator also bans integration lists, internal architecture, and the "core" idea.
Private repos are excluded from the stack counts and the public "this week" activity.
Requires both `GH_PAT` (to read private repos) and `OPENAI_API_KEY` (to write the
blurb) — without the OpenAI key, private repos are silently dropped, never shown raw.

> ⚠️ The AI blurb is obfuscation, not a guarantee. **Review the generated blurbs
> after the first run**, and make sure nothing in your personal private repos is
> client/NDA work you don't want even vaguely public.

## Setup

1. **Push to GitHub** (default branch `main`), then add repo secrets
   (Settings → Secrets → Actions):
   - `WAKATIME_API_KEY` — from https://wakatime.com/api-key (captures private work
     as coding time + languages; project names are withheld)
   - `OPENAI_API_KEY` — enables the LLM "this week" paragraph and the anonymized
     private-repo blurbs (`gpt-5-mini`; override with `NOW_LLM_MODEL`)
   - `GH_PAT` — a personal access token with read access to your private repos;
     required for `include_private` (the default `GITHUB_TOKEN` can't see them)
   - `GITHUB_TOKEN` is automatic — no setup needed.
2. **Import the repo into Vercel** (no framework; settings come from `vercel.json`)
   and add the `now.ethanqiu.ca` domain (CNAME → `cname.vercel-dns.com`).
3. **Point LLMs at it**: the portfolio's `llms.txt` references this site.

## Local run

Copy `.env.example` to `.env` and fill in your keys — `npm run generate` loads it
automatically (and ignores it in CI, where secrets come from the Action).

```sh
npm install
cp .env.example .env      # then fill in GH_PAT / OPENAI_API_KEY / WAKATIME_API_KEY
npm run generate          # works with zero keys too (public GitHub data only)
```

## Notes

- Every data source fails soft (see stale-persistence above).
- The hourly commit only happens when content changed; each push triggers a Vercel
  deploy (well within free-tier limits at 24/day max).
- The Action's `GITHUB_TOKEN` only sees public events, so private repo work won't
  appear there — WakaTime captures it as coding time + languages (project names
  withheld). WakaTime data comes from the Summaries API (the Stats endpoint
  under-reports for fresh/AI-tracked accounts).
