import { test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { deriveGitHubActivity, fetchPublicEvents, fetchRecentContributions, fetchGitHubRepos, filteredContributionDays, isExcludedRepository } from "../scripts/github.mjs";
import { buildProjects, deriveStack, renderActivityBody, fallbackSummary } from "../scripts/generate.mjs";

const NOW = "2026-10-02T18:00:00Z";
const AT = "2026-10-01T12:00:00Z";
const group = (name, nodes, visibility = "PUBLIC", totalCount = nodes.length) => ({
  repository: { nameWithOwner: name, visibility },
  contributions: { nodes, totalCount, pageInfo: { hasNextPage: false } },
});
const event = (type, name, payload = {}, extra = {}) => ({
  type, repo: { name }, payload, created_at: AT, public: true, ...extra,
});
const response = (data, next = false) => new Response(JSON.stringify(data), {
  headers: next ? { link: '<https://api.github.com/next>; rel="next"' } : {},
});
afterEach(() => mock.restoreAll());

test("private project data is not fetched or sent to AI without explicit configuration", async () => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-unused-key";
  const fetcher = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected private data request"); });
  try {
    const result = await buildProjects([
      { id: 42, name: "confidential", full_name: "org/confidential", private: true, pushed_at: AT },
    ], { include_private: true, private_ai_summaries: false }, NOW, null);
    assert.equal(result.projects[0].summary, "Private software project");
    assert.equal(fetcher.mock.callCount(), 0);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  }
});

test("modern push payloads record pushes without inventing zero commits", () => {
  const result = deriveGitHubActivity({ events: [event("PushEvent", "org/project", { head: "abc", before: "def" })] }, null, NOW);
  assert.equal(result.activity.totalCommits, null);
  assert.equal(result.activity.totalPushes, 1);
  assert.equal(result.activity.partial, true);
  assert.equal(result.recentRepos.get("org/project"), AT);
  assert.match(renderActivityBody({ github: result.activity }), /1 public pushes/);
});

test("public commits, PRs, and reviews cover organizations and deduplicate events", () => {
  const week = {
    commitContributionsByRepository: [group("org/project", [{ occurredAt: AT, commitCount: 8 }], "PUBLIC", 8)],
    pullRequestContributionsByRepository: [group("org/project", [{ occurredAt: AT, pullRequest: { number: 42 } }])],
    pullRequestReviewContributionsByRepository: [group("org/other", [{ occurredAt: AT, pullRequest: { number: 6 } }])],
  };
  const events = [event("PullRequestEvent", "org/project", { action: "opened", number: 42 }), event("PullRequestReviewEvent", "org/other", { pull_request: { number: 6 } })];
  const { activity, recentRepos } = deriveGitHubActivity({ events }, { week, recent: week }, NOW);
  assert.equal(activity.totalCommits, 8);
  assert.deepEqual(activity.prsOpened, ["org/project#42"]);
  assert.deepEqual(activity.prsReviewed, ["org/other#6"]);
  assert.deepEqual([...recentRepos.keys()], ["org/project", "org/other"]);
  assert.equal(activity.partial, false);
});

test("private and internal organization names and counts never enter activity", () => {
  const week = { commitContributionsByRepository: [
    group("secret/client", [{ occurredAt: AT, commitCount: 9 }], "PRIVATE", 9),
    group("internal/project", [{ occurredAt: AT, commitCount: 7 }], "INTERNAL", 7),
    group("public/project", [{ occurredAt: AT, commitCount: 2 }], "PUBLIC", 2),
  ] };
  const { activity, recentRepos } = deriveGitHubActivity({ events: [event("PushEvent", "secret/client", {}, { public: false })] }, { week, recent: week }, NOW);
  assert.equal(activity.totalCommits, 2);
  assert.deepEqual([...recentRepos.keys()], ["public/project"]);
  assert.doesNotMatch(JSON.stringify(activity), /secret|internal/);
});

test("review-only work is rendered as activity, with no idle or private-work claim", () => {
  const { activity } = deriveGitHubActivity({ events: [event("PullRequestReviewEvent", "org/project", { pull_request: { number: 8 } })] }, null, NOW);
  const text = renderActivityBody({ github: activity, summary: fallbackSummary(activity) });
  assert.match(text, /Reviewed pull requests: org\/project#8/);
  assert.doesNotMatch(text, /No public|private repos|coding time/i);
});

test("recent project discovery has a longer window than weekly activity and ignores stars", () => {
  const { activity, recentRepos } = deriveGitHubActivity({ events: [
    event("PushEvent", "friend/hackathon", {}, { created_at: "2026-09-20T12:00:00Z" }),
    event("PushEvent", "org/old", {}, { created_at: "2026-09-01T12:00:00Z" }),
    event("WatchEvent", "popular/library"),
    event("PushEvent", "future/project", {}, { created_at: "2026-10-10T00:00:00Z" }),
  ] }, null, NOW, 14);
  assert.equal(activity.totalPushes, 0);
  assert.deepEqual([...recentRepos.keys()], ["friend/hackathon"]);
});

test("all available event pages are read even when earlier pages contain old events", async () => {
  const urls = [];
  mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    if (url.endsWith("page=1")) return response([event("PushEvent", "org/old", {}, { created_at: "2026-09-01T00:00:00Z" })], true);
    return response([event("PullRequestEvent", "org/current", { action: "opened", number: 17 })]);
  });
  const data = await fetchPublicEvents("person");
  assert.equal(urls.length, 2);
  assert.deepEqual(deriveGitHubActivity(data, null, NOW).activity.prsOpened, ["org/current#17"]);
});

test("failed pagination discards partial results so cached data can be used", async () => {
  mock.method(globalThis, "fetch", async (url) => url.endsWith("page=1")
    ? response([event("PushEvent", "org/project")], true)
    : new Response("unavailable", { status: 503 }));
  assert.equal(await fetchPublicEvents("person"), null);
});

test("query truncation is explicitly marked partial", () => {
  const entry = group("org/project", [{ occurredAt: AT, pullRequest: { number: 1 } }]);
  entry.contributions.pageInfo.hasNextPage = true;
  const week = { pullRequestContributionsByRepository: [entry] };
  assert.equal(deriveGitHubActivity({ events: [] }, { week, recent: week }, NOW).activity.partial, true);
});

test("repository discovery includes public forks, paginates owned repos, and rechecks visibility", async () => {
  const repo = (name, extra = {}) => ({
    id: name, name: name.split("/")[1], full_name: name, owner: { login: name.split("/")[0] },
    private: false, visibility: "public", language: "TypeScript", pushed_at: AT, ...extra,
  });
  const urls = [];
  mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    if (url.includes("/users/person/repos") && url.endsWith("page=1")) return response([repo("person/one")], true);
    if (url.includes("/users/person/repos")) return response([repo("person/two"), repo("wrong/owner")]);
    if (url.endsWith("org/fork")) return response(repo("org/fork", { fork: true }));
    if (url.endsWith("org/hidden")) return response(repo("org/hidden", { private: true, visibility: "private" }));
    if (url.endsWith("org/internal")) return response(repo("org/internal", { visibility: "internal" }));
    throw new Error(`Unexpected URL ${url}`);
  });
  const repos = await fetchGitHubRepos("person", false, new Map([["org/fork", AT], ["org/hidden", AT], ["org/internal", AT]]));
  assert.deepEqual(repos.map((r) => r.full_name), ["person/one", "person/two", "org/fork"]);
  assert.equal(urls.length, 5);
  assert.deepEqual(deriveStack(repos).languages, [{ name: "TypeScript", repos: 3 }]);
});

test("project order and active state follow user contributions, not teammates' pushes", async () => {
  const repos = [
    { name: "old", full_name: "org/old", pushed_at: NOW, last_activity_at: "2026-09-01T00:00:00Z" },
    { name: "current", full_name: "org/current", pushed_at: "2026-09-01T00:00:00Z", last_activity_at: AT },
  ];
  const data = await buildProjects(repos, { max_projects: 6, active_within_days: 14 }, NOW, null);
  assert.deepEqual(data.projects.map((p) => [p.full_name, p.recently_active]), [["org/current", true], ["org/old", false]]);
});

test("GraphQL errors are treated as failure, not zero activity", async () => {
  const oldToken = process.env.GH_PAT;
  process.env.GH_PAT = "test-token";
  try {
    mock.method(globalThis, "fetch", async () => response({ errors: [{ message: "unavailable" }] }));
    assert.equal(await fetchRecentContributions("person", NOW, 14), null);
  } finally {
    if (oldToken === undefined) delete process.env.GH_PAT;
    else process.env.GH_PAT = oldToken;
  }
});

const POLICY = { include_private: true, excluded_repositories: ["*shopify*"] };

test("Shopify is excluded case-insensitively from public and private discovery and activity", () => {
  const week = { commitContributionsByRepository: [
    group("Shopify/private", [{ occurredAt: AT, commitCount: 9 }], "PRIVATE", 9),
    group("shopify-eng/public", [{ occurredAt: AT, commitCount: 4 }], "PUBLIC", 4),
    group("other/private", [{ occurredAt: AT, commitCount: 3 }], "PRIVATE", 3),
    group("other/public", [{ occurredAt: AT, commitCount: 2 }], "PUBLIC", 2),
  ] };
  const { activity, recentRepos } = deriveGitHubActivity({ events: [event("PushEvent", "SHOPIFY/project")] }, { week, recent: week }, NOW, 14, POLICY);
  assert.deepEqual([...recentRepos.keys()], ["other/private", "other/public"]);
  assert.equal(activity.totalCommits, 2);
  assert.equal(activity.totalPushes, 0);
  assert.doesNotMatch(JSON.stringify(activity), /shopify|other\/private/i);
  assert.equal(isExcludedRepository("person/shopify-work", POLICY), true);
});

test("private organization projects are fetched and anonymous; excluded repos are never fetched", async () => {
  const urls = [];
  mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    if (url.includes("/users/person/repos")) return response([]);
    assert.equal(url, "https://api.github.com/repos/other/secret");
    return response({ id: 123, name: "secret", full_name: "other/secret", private: true, visibility: "private", pushed_at: AT });
  });
  const repos = await fetchGitHubRepos("person", true, new Map([["Shopify/secret", AT], ["other/secret", AT]]), POLICY);
  assert.equal(repos.length, 1);
  assert.equal(repos[0].private, true);
  assert.equal(urls.length, 2);
  const data = await buildProjects(repos, POLICY, NOW, { projects: [{ private: true, id: 123, summary: "An anonymous project", pushed_at: AT.slice(0, 10) }] });
  assert.equal(data.projects[0].summary, "An anonymous project");
  assert.doesNotMatch(JSON.stringify(data), /other|secret|Shopify/);
  assert.deepEqual(deriveStack(repos, POLICY).languages, []);
});

test("excluded repositories cannot reach project summaries or language counts", async () => {
  mock.method(globalThis, "fetch", () => { throw new Error("No README may be requested"); });
  const repos = [{ full_name: "Shopify/secret", name: "secret", private: true, language: "Ruby", pushed_at: AT }];
  assert.deepEqual(await buildProjects(repos, POLICY, NOW, null), { projects: [] });
  assert.deepEqual(deriveStack([{ ...repos[0], private: false }], POLICY).languages, []);
});

test("filtered heatmap includes eligible private counts and excludes Shopify completely", () => {
  const collection = {
    commitContributionsByRepository: [
      group("Shopify/secret", [{ occurredAt: AT, commitCount: 50 }], "PRIVATE", 50),
      group("other/private", [{ occurredAt: AT, commitCount: 3 }], "PRIVATE", 3),
      group("other/public", [{ occurredAt: AT, commitCount: 2 }], "PUBLIC", 2),
    ],
    pullRequestReviewContributionsByRepository: [group("other/private", [{ occurredAt: AT, pullRequest: { number: 9 } }], "PRIVATE")],
  };
  assert.deepEqual([...filteredContributionDays(collection, POLICY)], [["2026-10-01", 6]]);
  assert.deepEqual([...filteredContributionDays(collection, { ...POLICY, include_private: false })], [["2026-10-01", 2]]);
});
