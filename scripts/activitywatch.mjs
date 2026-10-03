// Only this allowlisted aggregate crosses the boundary from the Mac to GitHub.
export const DAY_MS = 86_400_000;
export const APPS = ["Orca", "VS Code"];
export const utcDay = (value) => new Date(value).toISOString().slice(0, 10);

// AFK heartbeats continue even when no coding app is active. A running server
// alone does not prove the native watcher is still collecting activity.
export function assertTrackerHealthy(afkEvents, now = new Date().toISOString()) {
  const current = Date.parse(now);
  const healthy = Number.isFinite(current) && afkEvents.some((event) => {
    if (!["afk", "not-afk"].includes(event?.data?.status) ||
        !Number.isFinite(event.duration) || event.duration < 0) return false;
    const start = Date.parse(event.timestamp);
    const lastHeartbeat = start + event.duration * 1000;
    return Number.isFinite(lastHeartbeat) && start <= current + 30_000 &&
      lastHeartbeat <= current + 30_000 && current - lastHeartbeat <= 120_000;
  });
  if (!healthy) throw new Error("ActivityWatch coding watcher has no recent heartbeat; keeping the previous sync.");
}

function intervals(events, accept, start, end) {
  return events.filter(accept).flatMap((e) => {
    const timestamp = Date.parse(e.timestamp);
    const duration = e.duration;
    if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration <= 0) return [];
    const from = Math.max(start, timestamp);
    const to = Math.min(end, timestamp + duration * 1000);
    return to > from ? [[from, to, e.data.app === "Code" ? "VS Code" : e.data.app]] : [];
  });
}

export function aggregateCoding(windowEvents, afkEvents, now = new Date().toISOString()) {
  const end = Date.parse(now);
  const start = Date.parse(utcDay(end)) - 29 * DAY_MS;
  const active = [];
  for (const [a, b] of intervals(afkEvents, (e) => e?.data?.status === "not-afk", start, end).sort((a, b) => a[0] - b[0])) {
    const previous = active.at(-1);
    if (previous && a <= previous[1]) previous[1] = Math.max(previous[1], b);
    else active.push([a, b]);
  }
  const windows = intervals(windowEvents, (e) =>
    ["Orca", "Code"].includes(e?.data?.app) && e.data.title === "" &&
    typeof e.data.activity_session === "string" && e.data.activity_session.length > 0, start, end).sort((a, b) => a[0] - b[0]);
  const pieces = [];
  let activeIndex = 0;
  for (const [a, b, app] of windows) {
    while (activeIndex < active.length && active[activeIndex][1] <= a) activeIndex++;
    for (let index = activeIndex; index < active.length && active[index][0] < b; index++) {
      const [c, d] = active[index];
      if (Math.min(b, d) > Math.max(a, c)) pieces.push([Math.max(a, c), Math.min(b, d), app]);
    }
  }
  pieces.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const totals = new Map();
  let countedThrough = start;
  for (const [from, to, app] of pieces) {
    let cursor = Math.max(from, countedThrough);
    while (cursor < to) {
      const date = utcDay(cursor);
      const stop = Math.min(to, Date.parse(date) + DAY_MS);
      const row = totals.get(date) ?? { date, orca_seconds: 0, vscode_seconds: 0 };
      row[app === "Orca" ? "orca_seconds" : "vscode_seconds"] += (stop - cursor) / 1000;
      totals.set(date, row);
      cursor = stop;
    }
    countedThrough = Math.max(countedThrough, to);
  }
  return {
    schema_version: 1, source: "activitywatch", scope: "orca-vscode", timezone: "UTC",
    exported_at: now,
    days: [...totals.values()].map((d) => ({
      date: d.date, orca_seconds: Math.floor(d.orca_seconds), vscode_seconds: Math.floor(d.vscode_seconds),
    })),
  };
}

// Reconstruct known fields; never spread local events, metadata, or untrusted JSON.
export function codingActivity(raw, now = new Date().toISOString()) {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || raw.schema_version !== 1 || raw.source !== "activitywatch" ||
      raw.scope !== "orca-vscode" || raw.timezone !== "UTC" || !Array.isArray(raw.days) || raw.days.length > 30) return null;
  const exported = Date.parse(raw.exported_at);
  const current = Date.parse(now);
  if (!Number.isFinite(exported) || exported > current + 300_000 || current - exported > 30 * DAY_MS) return null;
  const firstDay = utcDay(Date.parse(utcDay(current)) - 6 * DAY_MS);
  const lastDay = utcDay(current);
  const seen = new Set();
  const days = [];
  for (const day of raw.days) {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(Date.parse(day.date)) ||
        utcDay(Date.parse(day.date)) !== day.date || seen.has(day.date) || day.date > utcDay(exported) ||
        !Number.isInteger(day.orca_seconds) || day.orca_seconds < 0 ||
        !Number.isInteger(day.vscode_seconds) || day.vscode_seconds < 0 ||
        day.orca_seconds + day.vscode_seconds > 86400) return null;
    seen.add(day.date);
    if (day.date >= firstDay && day.date <= lastDay) days.push({
      date: day.date, orca_seconds: day.orca_seconds, vscode_seconds: day.vscode_seconds,
    });
  }
  days.sort((a, b) => a.date.localeCompare(b.date));
  const apps = APPS.map((name) => ({
    name, seconds: days.reduce((sum, d) => sum + d[name === "Orca" ? "orca_seconds" : "vscode_seconds"], 0),
  }));
  return {
    source: "activitywatch", scope: "orca-vscode", timezone: "UTC", window: "last_7_days",
    window_start: firstDay, window_end: lastDay,
    total_seconds: apps.reduce((sum, a) => sum + a.seconds, 0), apps, days,
    fetched_at: new Date(exported).toISOString(), stale: current - exported > 2 * 3_600_000,
  };
}

export function durationLabel(seconds) {
  if (seconds > 0 && seconds < 60) return "less than 1 min";
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`;
}
