import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("generation removes retired source data, invalidates excluded caches, and deletes obsolete tool files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "now-generator-test-"));
  try {
    fs.cpSync(path.join(ROOT, "scripts"), path.join(dir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(dir, "config"));
    fs.mkdirSync(path.join(dir, "public", "tools"), { recursive: true });
    const config = {
      identity: { name: "Test Person", github_username: "person", links: {} },
      settings: { include_private: true, excluded_repositories: ["*shopify*"] },
    };
    fs.writeFileSync(path.join(dir, "config", "now.json"), JSON.stringify(config));
    const toolPath = (name) => path.join(dir, "public", "tools", `${name}.json`);
    const oldData = { fetched_at: new Date().toISOString(), summary: "WakaTime and Shopify stale prose", wakatime: { seconds: 123 } };
    for (const name of ["summary", "activity", "projects", "stack", "contributions", "availability", "writing"]) {
      fs.writeFileSync(toolPath(name), JSON.stringify({ schema_version: 1, data: oldData }));
    }
    fs.writeFileSync(path.join(dir, "mock.mjs"), `
      globalThis.fetch = async (url) => {
        if (process.env.TEST_MODE === "failed") throw new Error("offline fixture");
        if (process.env.TEST_MODE === "no_discovery" && url.includes("/events/public")) throw new Error("events unavailable");
        if (url.includes("/events/public")) return new Response(JSON.stringify(process.env.TEST_MODE === "empty" ? [] : [
          { type: "PullRequestReviewEvent", public: true, created_at: new Date(Date.now() - 1000).toISOString(), repo: { name: "org/project" }, payload: { pull_request: { number: 12 } } },
          { type: "PushEvent", public: true, created_at: new Date(Date.now() - 1000).toISOString(), repo: { name: "Shopify/secret" }, payload: {} }
        ]));
        if (url.includes("/repos?")) return new Response("[]");
        if (url.endsWith("/repos/org/project")) return new Response(JSON.stringify({
          name: "project", full_name: "org/project", private: false, visibility: "public", language: "Go", pushed_at: new Date().toISOString()
        }));
        throw new Error("Unexpected request " + url);
      };
    `);
    const run = (mode, coding = "") => execFileSync(process.execPath, ["--import", path.join(dir, "mock.mjs"), path.join(dir, "scripts", "generate.mjs")], {
      env: { ...process.env, GH_PAT: "", GITHUB_TOKEN: "", OPENAI_API_KEY: "", ACTIVITYWATCH_SUMMARY: coding, TEST_MODE: mode },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const read = (name) => JSON.parse(fs.readFileSync(toolPath(name), "utf8"));
    run("active");
    assert.equal(read("activity").schema_version, 2);
    assert.deepEqual(read("activity").data.github.prsReviewed, ["org/project#12"]);
    assert.equal(read("projects").data.projects[0].full_name, "org/project");
    assert.equal(fs.existsSync(toolPath("availability")), false);
    assert.equal(fs.existsSync(toolPath("writing")), false);
    const snapshot = fs.readFileSync(path.join(dir, "public", "now.json"), "utf8");
    assert.doesNotMatch(snapshot, /wakatime|shopify/i);
    const fetched = read("activity").data.github.fetched_at;

    run("no_discovery");
    assert.equal(read("projects").data.stale, true);
    assert.equal(read("projects").data.projects[0].full_name, "org/project");

    run("failed");
    assert.equal(read("activity").data.github.stale, true);
    assert.equal(read("activity").data.github.fetched_at, fetched);
    assert.equal(read("summary").data.stale, true);

    config.settings.excluded_repositories.push("org/*");
    fs.writeFileSync(path.join(dir, "config", "now.json"), JSON.stringify(config));
    run("failed");
    assert.equal(read("activity").data.github, null);
    assert.deepEqual(read("projects").data.projects, []);
    assert.equal(fs.existsSync(toolPath("summary")), false);

    run("empty");
    assert.equal(fs.existsSync(toolPath("summary")), false);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "public", "now.md"), "utf8"), /no public|wakatime|shopify/i);

    const synced = new Date().toISOString();
    run("empty", JSON.stringify({
      schema_version: 1, source: "activitywatch", scope: "orca-vscode", timezone: "UTC", exported_at: synced,
      days: [{ date: synced.slice(0, 10), orca_seconds: 600, vscode_seconds: 300 }],
      project: "/private/never-publish-this", hostname: "never-publish-this",
    }));
    assert.equal(read("coding").data.total_seconds, 900);
    assert.deepEqual(read("activity").data.coding, read("coding").data);
    assert.match(fs.readFileSync(path.join(dir, "public", "now.md"), "utf8"), /15 min/);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "public", "now.json"), "utf8"), /never-publish-this/);
    run("empty");
    assert.equal(read("coding").data.fetched_at, synced);
    const cachedActivity = read("activity");
    cachedActivity.data.coding.fetched_at = new Date(Date.now() - 31 * 86400000).toISOString();
    fs.writeFileSync(toolPath("activity"), JSON.stringify(cachedActivity));
    run("empty");
    assert.equal(read("activity").data.coding, null);
    assert.equal(fs.existsSync(toolPath("coding")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
