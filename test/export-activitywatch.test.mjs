import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("exporter leaves the previous snapshot and remote variable untouched when the watcher stops", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "now-export-test-"));
  try {
    const output = path.join(dir, "summary.json");
    const marker = path.join(dir, "published");
    const preload = path.join(dir, "fetch.mjs");
    fs.writeFileSync(preload, `
      globalThis.fetch = async (url) => {
        if (url.endsWith('/info')) return Response.json({ hostname: 'fixture' });
        const afk = url.includes('aw-watcher-afk');
        const state = process.env.TRACKER_STATE;
        const timestamp = new Date(Date.now() - (state === 'stopped' ? 86400000 : 0)).toISOString();
        return Response.json(afk && state !== 'missing' ? [{ timestamp, duration: 0, data: { status: 'afk' } }] : []);
      };
    `);
    fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\ncat > "$PUBLISH_MARKER"\n`, { mode: 0o755 });
    const run = (state) => spawnSync(process.execPath, ["--import", preload,
      fileURLToPath(new URL("../scripts/export-activitywatch.mjs", import.meta.url)),
      "--publish", "--repo", "fixture/now", "--output", output], {
      encoding: "utf8", env: { ...process.env, TRACKER_STATE: state, PUBLISH_MARKER: marker, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
    });
    fs.writeFileSync(output, "previous good snapshot\n");
    for (const state of ["stopped", "missing"]) {
      const result = run(state);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /no recent heartbeat/);
      assert.equal(fs.readFileSync(output, "utf8"), "previous good snapshot\n");
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(`${output}.tmp`), false);
    }
    // A live but idle tracker is healthy even with no coding events at all.
    const result = run("idle");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")).days, []);
    assert.equal(fs.readFileSync(marker, "utf8"), fs.readFileSync(output, "utf8"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
