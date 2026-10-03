import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateCoding, assertTrackerHealthy, codingActivity } from "../scripts/activitywatch.mjs";
import { renderActivityBody } from "../scripts/generate.mjs";

const NOW = "2026-10-02T18:00:00.000Z";
const event = (timestamp, duration, data) => ({ timestamp, duration, data });
const window = (timestamp, duration, app = "Orca", extra = {}) => event(timestamp, duration, {
  app, title: "", activity_session: "local-session", ...extra,
});
const active = (timestamp, duration) => event(timestamp, duration, { status: "not-afk" });
const snapshot = (days) => ({ schema_version: 1, source: "activitywatch", scope: "orca-vscode", timezone: "UTC", exported_at: NOW, days });

test("tracker health follows the latest heartbeat end, including idle and newly started watchers", () => {
  assert.doesNotThrow(() => assertTrackerHealthy([active("2026-10-02T12:00:00Z", 21600)], NOW));
  assert.doesNotThrow(() => assertTrackerHealthy([event(NOW, 0, { status: "afk" })], NOW));
  for (const events of [[], [active("2026-10-01T12:00:00Z", 60)], [active("2026-10-02T17:57:00Z", 0)],
    [active(NOW, -1)], [active(NOW, Infinity)], [active("invalid", 0)], [active("2026-10-03T00:00:00Z", 0)],
    [event(NOW, 0, { status: "unknown" })], [null]]) {
    assert.throws(() => assertTrackerHealthy(events, NOW), /no recent heartbeat/);
  }
});

test("export intersects active time, omits other apps and old broad tracking, and strips all identifying fields", () => {
  const at = "2026-10-02T12:00:00Z";
  const data = aggregateCoding([
    window(at, 600, "Orca", { project: "/private/client/repo", url: "https://secret.invalid" }),
    window(at, 900, "Safari"),
    window("2026-10-02T13:00:00Z", 600, "Code", { activity_session: undefined, title: "private-file" }),
    window("2026-10-02T14:00:00Z", 600, "Code"),
  ], [active(at, 300), active("2026-10-02T13:00:00Z", 600), active("2026-10-02T14:00:00Z", 300)], NOW);
  assert.deepEqual(data.days, [{ date: "2026-10-02", orca_seconds: 300, vscode_seconds: 300 }]);
  assert.doesNotMatch(JSON.stringify(data), /private|client|secret|Safari|project|title|session|url/);
});

test("midnight is split into UTC days and overlapping events cannot double-count time", () => {
  const at = "2026-10-01T23:59:00Z";
  const result = aggregateCoding([window(at, 180), window(at, 180), window("2026-10-02T00:01:00Z", 120, "Code")],
    [active(at, 300), active(at, 300)], NOW);
  assert.deepEqual(result.days, [
    { date: "2026-10-01", orca_seconds: 60, vscode_seconds: 0 },
    { date: "2026-10-02", orca_seconds: 120, vscode_seconds: 60 },
  ]);
});

test("future, negative, non-finite, idle-only and out-of-range intervals add no time", () => {
  const events = [window("2026-10-03T12:00:00Z", 100), window("2026-01-01T00:00:00Z", 100),
    window(NOW, -1), window(NOW, Infinity), window("invalid", 100), null];
  assert.deepEqual(aggregateCoding(events, [active("2026-10-02T00:00:00Z", 86400)], NOW).days, []);
  assert.deepEqual(aggregateCoding([window("2026-10-02T00:00:00Z", 100)], [], NOW).days, []);
  assert.equal(aggregateCoding([window("2026-10-02T17:59:00Z", 600)], [active("2026-10-02T17:59:00Z", 600)], NOW).days[0].orca_seconds, 60);
});

test("stale exports roll forward with the calendar, retain sync time, and eventually expire", () => {
  const raw = snapshot([
    { date: "2026-09-25", orca_seconds: 500, vscode_seconds: 0 },
    { date: "2026-09-26", orca_seconds: 20, vscode_seconds: 30 },
    { date: "2026-10-02", orca_seconds: 60, vscode_seconds: 120 },
  ]);
  const sameDay = codingActivity(raw, NOW);
  assert.equal(sameDay.total_seconds, 230);
  assert.equal(sameDay.stale, false);
  const nextDay = codingActivity(raw, "2026-10-03T12:00:00Z");
  assert.equal(nextDay.total_seconds, 180);
  assert.equal(nextDay.fetched_at, NOW);
  assert.equal(nextDay.stale, true);
  assert.equal(codingActivity(raw, "2026-10-10T00:00:00Z").total_seconds, 0);
  assert.equal(codingActivity(raw, "2026-11-10T00:00:00Z"), null);
});

test("malformed aggregates are rejected and extra metadata never enters public fields", () => {
  const row = { date: "2026-10-02", orca_seconds: 60, vscode_seconds: 120, file: "/secret/private" };
  const raw = { ...snapshot([row]), hostname: "private-machine" };
  assert.doesNotMatch(JSON.stringify(codingActivity(raw, NOW)), /secret|private|hostname|file/);
  for (const invalid of ["broken", { ...raw, scope: "all-apps" }, { ...raw, exported_at: "2026-12-01T00:00:00Z" },
    snapshot([row, row]), snapshot([null]), snapshot([{ ...row, orca_seconds: -5 }]),
    snapshot([{ ...row, date: "2026-02-30" }]), snapshot([{ ...row, vscode_seconds: 86401 }])]) {
    assert.equal(codingActivity(invalid, NOW), null);
  }
});

test("coding time renders independently of GitHub with an explicit stale-sync note", () => {
  const coding = codingActivity(snapshot([{ date: "2026-10-02", orca_seconds: 3600, vscode_seconds: 1800 }]), "2026-10-03T00:00:00Z");
  const body = renderActivityBody({ github: null, summary: null, coding });
  assert.match(body, /1 hr 30 min/);
  assert.match(body, /Orca: 1 hr 0 min/);
  assert.match(body, /sync is overdue/);
});
