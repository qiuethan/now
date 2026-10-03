// Public activity across repositories the user contributes to, regardless of owner.
// Push events no longer contain commit counts; use contribution data for those.
const DAY_MS = 24 * 60 * 60 * 1000;
const API = "https://api.github.com";

// Case-insensitive full owner/repository globs. Apply before README requests,
// model input, public activity, and contribution aggregation.
export function isExcludedRepository(fullName, settings = {}) {
  return (settings.excluded_repositories ?? []).some((pattern) => {
    const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${escaped}$`, "i").test(fullName);
  });
}

export const githubToken = () => process.env.GH_PAT || process.env.GITHUB_TOKEN;
export function githubHeaders() {
  const headers = { "User-Agent": "now-page-generator", Accept: "application/vnd.github+json" };
  if (githubToken()) headers.Authorization = `Bearer ${githubToken()}`;
  return headers;
}

async function request(url, options = {}) {
  const res = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(30_000), ...options });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  return res;
}

export async function fetchPublicEvents(username) {
  try {
    const events = [];
    let truncated = false;
    // GitHub exposes at most 300 events. Read all available pages: busy weeks
    // exceed one page, and events are not always ordered by created_at.
    for (let page = 1; page <= 3; page++) {
      const res = await request(`${API}/users/${username}/events/public?per_page=100&page=${page}`);
      events.push(...await res.json());
      const hasNext = /rel="next"/.test(res.headers.get("link") ?? "");
      if (!hasNext) break;
      if (page === 3) truncated = true;
    }
    return { events, truncated };
  } catch (err) {
    console.warn(`GitHub events skipped: ${err.message}`);
    return null;
  }
}

const contributionFields = `
  commitContributionsByRepository(maxRepositories: 100) {
    repository { nameWithOwner visibility }
    contributions(first: 100) {
      totalCount nodes { occurredAt commitCount } pageInfo { hasNextPage }
    }
  }
  pullRequestContributionsByRepository(maxRepositories: 100) {
    repository { nameWithOwner visibility }
    contributions(first: 100) {
      totalCount nodes { occurredAt pullRequest { number } } pageInfo { hasNextPage }
    }
  }
  pullRequestReviewContributionsByRepository(maxRepositories: 100) {
    repository { nameWithOwner visibility }
    contributions(first: 100) {
      totalCount nodes { occurredAt pullRequest { number } } pageInfo { hasNextPage }
    }
  }
  issueContributionsByRepository(maxRepositories: 100) {
    repository { nameWithOwner visibility }
    contributions(first: 100) {
      totalCount nodes { occurredAt issue { number } } pageInfo { hasNextPage }
    }
  }`;

export async function fetchRecentContributions(username, now, activeDays) {
  if (!githubToken()) return null;
  try {
    const res = await request(`${API}/graphql`, {
      method: "POST",
      headers: { ...githubHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($login: String!, $week: DateTime!, $recent: DateTime!, $to: DateTime!) {
          user(login: $login) {
            week: contributionsCollection(from: $week, to: $to) { ${contributionFields} }
            recent: contributionsCollection(from: $recent, to: $to) { ${contributionFields} }
          }
        }`,
        variables: {
          login: username,
          week: new Date(Date.parse(now.slice(0, 10)) - 6 * DAY_MS).toISOString(),
          recent: new Date(Date.parse(now) - Math.max(7, activeDays) * DAY_MS).toISOString(),
          to: now,
        },
      }),
    });
    const json = await res.json();
    if (json.errors?.length || !json.data?.user) throw new Error("contribution query failed");
    return json.data.user;
  } catch (err) {
    console.warn(`Recent contributions skipped: ${err.message}`);
    return null;
  }
}

export function deriveGitHubActivity(eventData, contributions, now, activeDays = 14, settings = {}) {
  if (!eventData && !contributions) return null;
  // Seven UTC calendar days including today, matching the heatmap's last_7_days.
  const weekCutoff = Date.parse(now.slice(0, 10)) - 6 * DAY_MS;
  const recentCutoff = Date.parse(now) - Math.max(7, activeDays) * DAY_MS;
  const recentRepos = new Map();
  const weeklyRepos = new Map();
  const prsOpened = new Set();
  const prsReviewed = new Set();
  const issuesOpened = new Set();
  const newRepos = new Set();
  const touch = (name, at) => {
    if (!name || !Number.isFinite(Date.parse(at)) || Date.parse(at) < recentCutoff || Date.parse(at) > Date.parse(now)) return;
    if (!recentRepos.has(name) || at > recentRepos.get(name)) recentRepos.set(name, at);
  };
  const repoStats = (name) => {
    if (!weeklyRepos.has(name)) weeklyRepos.set(name, { name, commits: contributions ? 0 : null, pushes: 0 });
    return weeklyRepos.get(name);
  };
  let truncated = eventData?.truncated ?? false;
  for (const collection of [contributions?.recent, contributions?.week]) {
    for (const [kind, groups] of Object.entries(collection ?? {})) {
      if (groups.length >= 100) truncated = true;
      for (const group of groups) {
        const name = group.repository?.nameWithOwner;
        if (!name || isExcludedRepository(name, settings)) continue;
        const isPublic = group.repository.visibility === "PUBLIC";
        if (!isPublic && !settings.include_private) continue;
        if (group.contributions.pageInfo?.hasNextPage) truncated = true;
        for (const node of group.contributions.nodes ?? []) touch(name, node.occurredAt);
        // Private repositories are discovered for anonymous project summaries,
        // but their names, PR numbers, and counts never enter weekly public data.
        if (!isPublic) continue;
        if (collection !== contributions.week) continue;
        const stats = repoStats(name);
        if (kind === "commitContributionsByRepository") stats.commits = group.contributions.totalCount;
        for (const node of group.contributions.nodes ?? []) {
          if (kind === "pullRequestContributionsByRepository") prsOpened.add(`${name}#${node.pullRequest.number}`);
          if (kind === "pullRequestReviewContributionsByRepository") prsReviewed.add(`${name}#${node.pullRequest.number}`);
          if (kind === "issueContributionsByRepository") issuesOpened.add(`${name}#${node.issue.number}`);
        }
      }
    }
  }
  const workEvents = new Set(["PushEvent", "PullRequestEvent", "PullRequestReviewEvent", "PullRequestReviewCommentEvent", "IssuesEvent", "IssueCommentEvent", "CommitCommentEvent", "CreateEvent", "ReleaseEvent"]);
  const seen = new Set();
  for (const event of eventData?.events ?? []) {
    if (event.public === false || event.actor?.type === "Bot" || /\[bot\]$/i.test(event.actor?.login ?? "") ||
        !workEvents.has(event.type) || !event.repo?.name) continue;
    if (event.id && seen.has(event.id)) continue;
    if (event.id) seen.add(event.id);
    const name = event.repo.name;
    if (isExcludedRepository(name, settings)) continue;
    touch(name, event.created_at);
    const timestamp = Date.parse(event.created_at);
    if (!Number.isFinite(timestamp) || timestamp < weekCutoff || timestamp > Date.parse(now)) continue;
    const stats = repoStats(name);
    const payload = event.payload ?? {};
    const number = payload.number ?? payload.pull_request?.number ?? payload.issue?.number;
    if (event.type === "PushEvent") stats.pushes++;
    if (event.type === "PullRequestEvent" && payload.action === "opened" && number) prsOpened.add(`${name}#${number}`);
    if (event.type === "PullRequestReviewEvent" && number) prsReviewed.add(`${name}#${number}`);
    if (event.type === "IssuesEvent" && payload.action === "opened" && number) issuesOpened.add(`${name}#${number}`);
    if (event.type === "CreateEvent" && payload.ref_type === "repository") newRepos.add(name);
  }
  const repos = [...weeklyRepos.values()].sort((a, b) => (b.commits ?? 0) - (a.commits ?? 0) || b.pushes - a.pushes || a.name.localeCompare(b.name));
  return {
    activity: {
      source: contributions ? "github_contributions_and_public_events" : "github_public_events",
      totalCommits: contributions ? repos.reduce((sum, r) => sum + r.commits, 0) : null,
      totalPushes: eventData ? repos.reduce((sum, r) => sum + r.pushes, 0) : null,
      repos,
      prsOpened: [...prsOpened].sort(),
      prsReviewed: [...prsReviewed].sort(),
      issuesOpened: [...issuesOpened].sort(),
      newRepos: [...newRepos].sort(),
      partial: !eventData || !contributions || truncated,
    },
    recentRepos,
  };
}

function normalizeRepo(r, lastActivity) {
  return {
    id: r.id, name: r.name, full_name: r.full_name, private: Boolean(r.private),
    description: r.description || "", language: r.language || null,
    url: r.html_url, homepage: r.homepage || "", stars: r.stargazers_count ?? 0,
    topics: r.topics || [], pushed_at: r.pushed_at,
    last_activity_at: lastActivity ?? null,
  };
}

export async function fetchGitHubRepos(username, includePrivate, recentRepos = new Map(), settings = {}, now = new Date().toISOString()) {
  const owned = [];
  let ownedFailed = false;
  try {
    // Owned repositories plus repositories with actual recent contributions;
    // access to an organization alone does not make every repo a project.
    const base = includePrivate && githubToken()
      ? `${API}/user/repos?visibility=all&affiliation=owner&sort=pushed&per_page=100`
      : `${API}/users/${username}/repos?sort=pushed&per_page=100&type=owner`;
    for (let page = 1; ; page++) {
      const res = await request(`${base}&page=${page}`);
      owned.push(...await res.json());
      if (!/rel="next"/.test(res.headers.get("link") ?? "")) break;
    }
  } catch (err) {
    console.warn(`Owned GitHub repos skipped: ${err.message}`);
    ownedFailed = true;
  }
  const repos = new Map();
  let discoveryFailed = false;
  for (const r of owned) {
    if (isExcludedRepository(r.full_name, settings)) continue;
    if (r.owner?.login?.toLowerCase() !== username.toLowerCase() || r.fork || r.archived || r.name.toLowerCase() === username.toLowerCase()) continue;
    if (r.private && !includePrivate) continue;
    let lastActivity = recentRepos.get(r.full_name);
    if (!lastActivity && r.size !== 0) {
      try {
        // Repository pushes include bots and collaborators. Only authored work
        // can supply a historical fallback for the user's own repositories.
        const query = new URLSearchParams({ author: username, per_page: "1", until: now });
        const commits = await (await request(`${API}/repos/${r.full_name}/commits?${query}`)).json();
        const commit = commits[0];
        const authored = commit?.commit?.author?.date;
        if (commit?.author?.login?.toLowerCase() === username.toLowerCase() &&
            commit.author.type !== "Bot" && Number.isFinite(Date.parse(authored)) && Date.parse(authored) <= Date.parse(now)) {
          lastActivity = authored;
        }
      } catch (err) {
        console.warn(`Authored commit lookup skipped: ${err.message}`);
        discoveryFailed = true;
      }
    }
    repos.set(r.full_name, normalizeRepo(r, lastActivity));
  }
  for (const [name, at] of recentRepos) {
    if (isExcludedRepository(name, settings)) continue;
    if (repos.has(name) || name.toLowerCase() === `${username}/${username}`.toLowerCase()) continue;
    try {
      const r = await (await request(`${API}/repos/${name}`)).json();
      if (isExcludedRepository(r.full_name, settings) || r.archived) continue;
      const isPrivate = r.private !== false || (r.visibility && r.visibility !== "public");
      if (isPrivate && !includePrivate) continue;
      r.private = Boolean(isPrivate);
      repos.set(name, normalizeRepo(r, at));
    } catch (err) {
      console.warn(`Contributed repository lookup skipped: ${err.message}`);
      discoveryFailed = true;
    }
  }
  // Let the caller use the last complete snapshot if any repository source fails.
  if (ownedFailed || discoveryFailed) return null;
  return [...repos.values()];
}

export function filteredContributionDays(collection, settings = {}) {
  const days = new Map();
  for (const [kind, groups] of Object.entries(collection)) {
    if (groups.length >= 100) throw new Error("contribution repository limit reached");
    for (const group of groups) {
      const repo = group.repository;
      if (!repo || isExcludedRepository(repo.nameWithOwner, settings)) continue;
      if (repo.visibility !== "PUBLIC" && !settings.include_private) continue;
      if (group.contributions.pageInfo?.hasNextPage) throw new Error("contribution entry limit reached");
      for (const node of group.contributions.nodes ?? []) {
        const date = node.occurredAt.slice(0, 10);
        const count = kind === "commitContributionsByRepository" ? node.commitCount : 1;
        days.set(date, (days.get(date) ?? 0) + count);
      }
    }
  }
  return days;
}

export async function fetchFilteredContributionCalendar(username, now, settings = {}) {
  if (!githubToken()) return null;
  try {
    const end = Date.parse(now);
    const firstDay = Date.parse(now.slice(0, 10)) - 364 * DAY_MS;
    const days = new Map();
    for (let at = firstDay; at <= end; at += DAY_MS) days.set(new Date(at).toISOString().slice(0, 10), 0);
    // The profile heatmap cannot exclude owners. Rebuild from attributed
    // contributions in 28-day windows, omitting inaccessible/restricted entries.
    // Commit nodes are daily aggregates, so each window fits on one page.
    for (let from = firstDay; from <= end; from += 28 * DAY_MS) {
      const to = Math.min(from + 28 * DAY_MS - 1, end);
      const res = await request(`${API}/graphql`, {
        method: "POST",
        headers: { ...githubHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query($login: String!, $from: DateTime!, $to: DateTime!) {
            user(login: $login) { contributionsCollection(from: $from, to: $to) { ${contributionFields} } }
          }`,
          variables: { login: username, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
        }),
      });
      const json = await res.json();
      const collection = json.data?.user?.contributionsCollection;
      if (json.errors?.length || !collection) throw new Error("filtered contribution query failed");
      for (const [date, count] of filteredContributionDays(collection, settings)) {
        if (days.has(date)) days.set(date, days.get(date) + count);
      }
    }
    return {
      totalContributions: [...days.values()].reduce((sum, count) => sum + count, 0),
      weeks: [{ contributionDays: [...days].map(([date, contributionCount]) => ({ date, contributionCount })) }],
    };
  } catch (err) {
    console.warn(`Filtered contributions skipped: ${err.message}`);
    return null;
  }
}
