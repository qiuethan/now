# now.ethanqiu.ca

Self-updating "now" page. A GitHub Action runs hourly, pulls live activity from
the GitHub API and WakaTime, merges it with the hand-maintained status in
`config/now.json`, optionally has Claude write a short prose summary, and
commits the rendered `public/now.md` + `public/now.json`. Vercel serves the
result as static files — there is no server.

```
config/now.json ──┐
GitHub events ────┼──> scripts/generate.mjs ──> public/now.md + now.json ──> Vercel
WakaTime stats ───┘         (hourly via GitHub Actions)
```

## URLs (once deployed)

| URL | Returns |
|---|---|
| `now.ethanqiu.ca/` | `now.md` (markdown — the canonical LLM-facing page) |
| `now.ethanqiu.ca/now.md` | same |
| `now.ethanqiu.ca/json` or `/now.json` | structured JSON (CORS open, for the portfolio site) |
| `now.ethanqiu.ca/llms.txt` | llms.txt index pointing at the above |

## Setup

1. **Fill in the TODOs in `config/now.json`** — availability summary and
   graduation year. Also double-check the `recent_wins` dates (they're
   approximate). This file is the part you hand-edit going forward.
2. **Push to GitHub**, then add repo secrets (Settings → Secrets → Actions):
   - `WAKATIME_API_KEY` — from https://wakatime.com/api-key
   - `ANTHROPIC_API_KEY` — optional; enables the LLM "this week" paragraph
     (uses `claude-haiku-4-5`, ~a fraction of a cent per run; override with a
     `NOW_LLM_MODEL` env var in the workflow if you want a different model)
   - `GITHUB_TOKEN` is automatic — no setup needed.
3. **Import the repo into Vercel** (no framework, settings come from
   `vercel.json`) and add the `now.ethanqiu.ca` domain (CNAME →
   `cname.vercel-dns.com`).
4. **Point LLMs at it**: the portfolio repo's `public/llms.txt` references this
   site, and check that nothing in robots.txt blocks crawlers.

## Local run

```sh
npm install
npm run generate          # works with zero env vars (GitHub data only)
$env:WAKATIME_API_KEY="..."; npm run generate   # with WakaTime
```

## Notes

- Every data source fails soft: no WakaTime key → section omitted; GitHub API
  down → section omitted; no Anthropic key → bullet-point data without prose.
- The hourly commit only happens when content actually changed, and each push
  triggers a Vercel deploy (well within free-tier limits at 24/day max).
- The Action's `GITHUB_TOKEN` only sees public events, so private repo work at
  Shopify won't appear — WakaTime is what captures that (project names only).
