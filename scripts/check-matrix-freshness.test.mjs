// Tests for check-matrix-freshness.mjs (#66): `node --test scripts/*.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assess, parseFreshness } from "./check-matrix-freshness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/check-matrix-freshness.mjs");
const day = (s) => Date.parse(`${s}T00:00:00Z`);
const table = (rows) =>
  ["<!-- freshness:start -->", "| Surface | Active | Checked |", "|---|---|---|", ...rows, "<!-- freshness:end -->"].join("\n");
const run = (args) => {
  try {
    return { status: 0, out: execFileSync(process.execPath, [script, ...args], { stdio: "pipe" }).toString() };
  } catch (err) {
    return { status: err.status, out: String(err.stdout) + String(err.stderr) };
  }
};

test("finds active surfaces that are due or stale, and ignores inactive ones", () => {
  const surfaces = parseFreshness(
    table(["| Claude Code | yes | 2026-11-10 |", "| Codex | yes | 2026-10-01 |", "| MCP | no | 2026-01-01 |"]),
  );
  assert.deepEqual(surfaces.map((s) => [s.surface, s.active]), [["Claude Code", true], ["Codex", true], ["MCP", false]]);
  const at = (list, d) => assess(list, day(d), 30, 7).map((s) => [s.surface, s.ageDays, s.state]);
  assert.deepEqual(at(surfaces, "2026-11-11"), [
    ["Claude Code", 1, "fresh"],
    ["Codex", 41, "stale"],
  ]);
  // Codex was checked 2026-10-01: fresh up to 23 days, due (warned) from 24, stale from 31.
  const codex = surfaces.filter((s) => s.surface === "Codex");
  assert.deepEqual(at(codex, "2026-10-24"), [["Codex", 23, "fresh"]]);
  assert.deepEqual(at(codex, "2026-10-25"), [["Codex", 24, "due"]]);
  assert.deepEqual(at(codex, "2026-10-31"), [["Codex", 30, "due"]]);
  assert.deepEqual(at(codex, "2026-11-01"), [["Codex", 31, "stale"]]);
});

test("refuses a date more than a day ahead", () => {
  const surfaces = parseFreshness(table(["| Codex | yes | 2026-11-12 |"]));
  assert.equal(assess(surfaces, day("2026-11-11"))[0]?.state, "fresh");
  assert.throws(() => assess(surfaces, day("2026-11-10")), /in the future/);
});

test("refuses a malformed table", () => {
  assert.throws(() => parseFreshness("no table"), /no freshness table/);
  assert.throws(() => parseFreshness(table([])), /no surfaces/);
  assert.throws(() => parseFreshness(table(["| Codex | maybe | 2026-11-10 |"])), /Active must be yes or no/);
  assert.throws(() => parseFreshness(table(["| Codex | yes | 10 Nov |"])), /Checked must be a date/);
  assert.throws(() => parseFreshness(table(["| Codex | yes | 2026-02-31 |"])), /Checked must be a date/);
  assert.throws(() => parseFreshness(table(["Codex | yes | 2026-11-10 |"])), /not a table row/);
  assert.throws(() => parseFreshness(table(["| Codex | yes | 2026-11-10 |", "| Codex | no | 2026-11-10 |"])), /listed twice/);
  assert.throws(
    () => parseFreshness(table(["| Codex | yes | 2026-11-10 |"]).replace("| Checked |", "| Date |")),
    /columns/,
  );
});

test("refuses unknown or empty arguments instead of ignoring them", () => {
  for (const args of [["--today=2099-01-01x"], ["--toady", "2099-01-01"], ["--max-age-days", ""], ["--today"]]) {
    const r = run(args);
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.out, /check-matrix-freshness:/);
  }
});

test("the real matrix: fresh after a refresh, a warning a week ahead, a clear failure once stale", () => {
  const surfaces = parseFreshness(readFileSync(join(root, "docs/adapters/capability-matrix.md"), "utf8"));
  const active = surfaces.filter((s) => s.active);
  for (const name of ["Claude Code", "Codex app-server", "OpenCode server", "Gemini CLI", "ACP"]) {
    assert.ok(active.some((s) => s.surface === name), `${name} is marked active`);
  }
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const newest = Math.max(...active.map((s) => s.checkedAt));
  const oldest = Math.min(...active.map((s) => s.checkedAt));
  assert.equal(run(["--today", iso(newest)]).status, 0);
  const due = run(["--today", iso(oldest + 25 * 86_400_000)]);
  assert.equal(due.status, 0);
  assert.match(due.out, /::warning file=docs\/adapters\/capability-matrix\.md::.* goes stale after 30 days/);
  const stale = run(["--today", iso(oldest + 31 * 86_400_000)]);
  assert.equal(stale.status, 1);
  assert.match(stale.out, /checked \d{4}-\d{2}-\d{2} \(31 days ago\)/);
  assert.match(stale.out, /Refresh each one/);
});
