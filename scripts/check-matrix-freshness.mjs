#!/usr/bin/env node
// Fail when the capability matrix's checked date for a surface under active development is
// older than the threshold (#66). Vendor surfaces change monthly; a stale row is a guess.
//
//   node scripts/check-matrix-freshness.mjs                     check against today (UTC)
//   node scripts/check-matrix-freshness.mjs --max-age-days 30   fail past this age (default 30)
//   node scripts/check-matrix-freshness.mjs --warn-days 7       warn this many days before (default 7)
//   node scripts/check-matrix-freshness.mjs --today 2026-12-31  pretend it is that day
//
// Reads the table between `<!-- freshness:start -->` and `<!-- freshness:end -->` in
// docs/adapters/capability-matrix.md: `| Surface | Active | Checked |`, one row per surface,
// Active `yes` or `no`, Checked `YYYY-MM-DD`. Warnings print as GitHub annotations.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_MAX_AGE_DAYS = 30;
export const DEFAULT_WARN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = "<!-- freshness:start -->";
const END = "<!-- freshness:end -->";

/** Parse a `YYYY-MM-DD` date as UTC midnight, or return undefined. */
export function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  if (!m) return undefined;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  // Reject dates like 2026-02-31, which Date.UTC rolls over.
  return d.getUTCDate() === Number(m[3]) && d.getUTCMonth() === Number(m[2]) - 1 ? t : undefined;
}

/** The surfaces of the freshness table. Throws on anything but a well-formed table. */
export function parseFreshness(markdown) {
  const a = markdown.indexOf(START);
  const b = markdown.indexOf(END);
  if (a < 0 || b < a) throw new Error(`no freshness table (${START} ... ${END})`);
  const lines = markdown
    .slice(a + START.length, b)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const stray = lines.find((l) => !l.startsWith("|"));
  if (stray !== undefined) throw new Error(`freshness table: not a table row: ${JSON.stringify(stray)}`);
  const rows = lines.map((l) => l.slice(1, l.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim()));
  const [header, rule, ...body] = rows;
  if (header?.join("|").toLowerCase() !== "surface|active|checked" || !rule?.every((c) => /^:?-+:?$/.test(c))) {
    throw new Error("freshness table must have the columns | Surface | Active | Checked |");
  }
  if (body.length === 0) throw new Error("freshness table has no surfaces");
  const seen = new Set();
  return body.map((cells, i) => {
    const [surface, active, checked] = cells;
    const where = `freshness table row ${i + 1}`;
    if (cells.length !== 3 || !surface) throw new Error(`${where}: expected 3 cells`);
    if (seen.has(surface)) throw new Error(`${where}: ${surface} is listed twice`);
    seen.add(surface);
    if (active !== "yes" && active !== "no") throw new Error(`${where} (${surface}): Active must be yes or no`);
    const t = parseDate(checked);
    if (t === undefined) throw new Error(`${where} (${surface}): Checked must be a date YYYY-MM-DD, not ${JSON.stringify(checked)}`);
    return { surface, active: active === "yes", checked, checkedAt: t };
  });
}

/**
 * Each active surface with its age on `today` (ms, UTC) and its state: `stale` past `maxAgeDays`,
 * `due` within `warnDays` of that, else `fresh`. A date more than a day ahead is an error (one
 * day of slack for whoever wrote their local date east of UTC).
 */
export function assess(surfaces, today, maxAgeDays = DEFAULT_MAX_AGE_DAYS, warnDays = DEFAULT_WARN_DAYS) {
  return surfaces
    .filter((s) => s.active)
    .map((s) => {
      const ageDays = Math.floor((today - s.checkedAt) / DAY_MS);
      if (ageDays < -1) throw new Error(`${s.surface}: Checked ${s.checked} is in the future`);
      const state = ageDays > maxAgeDays ? "stale" : ageDays > maxAgeDays - warnDays ? "due" : "fresh";
      return { ...s, ageDays, state };
    });
}

function wholeNumber(name, value) {
  const n = Number(value);
  if (value === "" || !Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number`);
  return n;
}

export function main(argv, today = undefined, out = console) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      "max-age-days": { type: "string" },
      "warn-days": { type: "string" },
      today: { type: "string" },
    },
  });
  const maxAge = wholeNumber("max-age-days", values["max-age-days"] ?? String(DEFAULT_MAX_AGE_DAYS));
  const warn = wholeNumber("warn-days", values["warn-days"] ?? String(DEFAULT_WARN_DAYS));
  let day = today;
  if (values.today !== undefined) {
    day = parseDate(values.today);
    if (day === undefined) throw new Error("--today must be a date YYYY-MM-DD");
  }
  if (day === undefined) {
    const now = new Date();
    day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const file = "docs/adapters/capability-matrix.md";
  const surfaces = assess(parseFreshness(readFileSync(join(root, file), "utf8")), day, maxAge, warn);
  for (const s of surfaces.filter((x) => x.state === "due")) {
    out.log(`::warning file=${file}::${s.surface} was checked ${s.checked} (${s.ageDays} days ago) and goes stale after ${maxAge} days: refresh it soon.`);
  }
  const stale = surfaces.filter((s) => s.state === "stale");
  if (stale.length === 0) {
    out.log(`Capability matrix is fresh: ${surfaces.length} active surfaces checked within ${maxAge} days.`);
    return 0;
  }
  out.error(`Capability matrix is stale (${file}): these surfaces are under active development and were last checked more than ${maxAge} days ago:`);
  for (const s of stale) out.error(`  - ${s.surface}: checked ${s.checked} (${s.ageDays} days ago)`);
  out.error(
    "Refresh each one: re-verify its rows against primary sources (verify-vendor-facts skill), update the facts and pins that changed, then set its Checked date in the freshness table. See \"Keeping it fresh\" at the top of the matrix.",
  );
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`check-matrix-freshness: ${err.message}`);
    process.exitCode = 1;
  }
}
