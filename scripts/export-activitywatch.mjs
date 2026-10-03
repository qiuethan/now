import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { aggregateCoding, assertTrackerHealthy, codingActivity, DAY_MS, utcDay } from "./activitywatch.mjs";

const { values } = parseArgs({ options: {
  publish: { type: "boolean", default: false },
  repo: { type: "string" },
  output: { type: "string", default: path.join(os.homedir(), "Library/Application Support/now-activitywatch/summary.json") },
} });

async function local(route) {
  const response = await fetch(`http://127.0.0.1:5600/api/0/${route}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Local ActivityWatch returned HTTP ${response.status}`);
  return response.json();
}

try {
  const now = new Date().toISOString();
  const start = new Date(Date.parse(utcDay(now)) - 29 * DAY_MS).toISOString();
  const { hostname } = await local("info");
  if (typeof hostname !== "string") throw new Error("ActivityWatch hostname missing");
  const events = async (prefix) => {
    const query = new URLSearchParams({ start, end: now, limit: "100000" });
    const data = await local(`buckets/${encodeURIComponent(`${prefix}_${hostname}`)}/events?${query}`);
    if (!Array.isArray(data) || data.length >= 100000) throw new Error("ActivityWatch event limit reached; export cancelled");
    return data;
  };
  const [windows, afk] = await Promise.all([events("aw-watcher-window"), events("aw-watcher-afk")]);
  assertTrackerHealthy(afk, now);
  const summary = aggregateCoding(windows, afk, now);
  if (!codingActivity(summary, now)) throw new Error("Aggregate validation failed; export cancelled");
  const payload = JSON.stringify(summary, null, 2) + "\n";
  fs.mkdirSync(path.dirname(values.output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${values.output}.tmp`, payload, { mode: 0o600 });
  fs.renameSync(`${values.output}.tmp`, values.output);
  if (values.publish) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo ?? "")) throw new Error("Specify --repo OWNER/REPO to publish");
    execFileSync("gh", ["variable", "set", "ACTIVITYWATCH_SUMMARY", "--repo", values.repo], {
      input: payload, stdio: ["pipe", "ignore", "pipe"], timeout: 45_000,
    });
  }
  console.log(`${now} ActivityWatch totals ${values.publish ? "synced" : "exported locally"}: ${summary.days.length} days. Raw events remain local.`);
} catch (error) {
  // Subprocess errors may include arguments; do not dump stderr or local events.
  console.error(error.status !== undefined ? "ActivityWatch sync failed; check gh authentication and repository access." : error.message);
  process.exitCode = 1;
}
