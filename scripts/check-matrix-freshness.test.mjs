// Tests for check-matrix-freshness.mjs (#66): `node --test scripts/*.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFreshness, staleSurfaces } from "./check-matrix-freshness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/check-matrix-freshness.mjs");
const day = (s) => Date.parse(`${s}T00:00:00Z`);
const table = (rows) =>
  ["<!-- freshness:start -->", "| Surface | Active | Checked |", "|---|---|---|", ...rows, "<!-- freshness:end -->"].join("\n");

test("parses the table and finds only active surfaces past the threshold", () => {
  const surfaces = parseFreshness(
    table(["| Claude Code | yes | 2026-11-10 |", "| Codex | yes | 2026-10-01 |", "| MCP | no | 2026-01-01 |"]),
  );
  assert.deepEqual(surfaces.map((s) => [s.surface, s.active]), [["Claude Code", true], ["Codex", true], ["MCP", false]]);
  // 30 days old is still fresh; 31 is stale.
  assert.deepEqual(staleSurfaces(surfaces, day("2026-10-31"), 30), []);
  assert.deepEqual(staleSurfaces(surfaces, day("2026-11-01"), 30).map((s) => [s.surface, s.ageDays]), [["Codex", 31]]);
});

test("refuses a malformed table", () => {
  assert.throws(() => parseFreshness("no table"), /no freshness table/);
  assert.throws(() => parseFreshness(table([])), /no surfaces/);
  assert.throws(() => parseFreshness(table(["| Codex | maybe | 2026-11-10 |"])), /Active must be yes or no/);
  assert.throws(() => parseFreshness(table(["| Codex | yes | 10 Nov |"])), /Checked must be a date/);
  assert.throws(() => parseFreshness(table(["| Codex | yes | 2026-02-31 |"])), /Checked must be a date/);
  assert.throws(
    () => parseFreshness(table(["| Codex | yes | 2026-11-10 |"]).replace("| Checked |", "| Date |")),
    /columns/,
  );
});

test("the real matrix passes today's check, fails once stale, and says how to refresh", () => {
  const surfaces = parseFreshness(readFileSync(join(root, "docs/adapters/capability-matrix.md"), "utf8"));
  const active = surfaces.filter((s) => s.active).map((s) => s.surface);
  for (const name of ["Claude Code", "Codex app-server", "OpenCode server", "Gemini CLI", "ACP"]) {
    assert.ok(active.includes(name), `${name} is marked active`);
  }
  const newest = Math.max(...surfaces.map((s) => s.checkedAt));
  const fresh = new Date(newest).toISOString().slice(0, 10);
  execFileSync(process.execPath, [script, "--today", fresh], { stdio: "pipe" });
  let failure;
  try {
    execFileSync(process.execPath, [script, "--today", "2099-01-01"], { stdio: "pipe" });
  } catch (err) {
    failure = err;
  }
  assert.equal(failure?.status, 1);
  const out = String(failure.stderr);
  assert.match(out, /Claude Code: checked \d{4}-\d{2}-\d{2} \(\d+ days ago\)/);
  assert.match(out, /Refresh each one/);
});
