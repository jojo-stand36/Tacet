#!/usr/bin/env node
// Fail when the capability matrix's checked date for a surface under active development is
// older than the threshold (#66). Vendor surfaces change monthly; a stale row is a guess.
//
//   node scripts/check-matrix-freshness.mjs                     check against today
//   node scripts/check-matrix-freshness.mjs --max-age-days 30   threshold (default 30)
//   node scripts/check-matrix-freshness.mjs --today 2026-12-31  pretend it is that day
//
// Reads the table between `<!-- freshness:start -->` and `<!-- freshness:end -->` in
// docs/adapters/capability-matrix.md: `| Surface | Active | Checked |`, one row per surface,
// Active `yes` or `no`, Checked `YYYY-MM-DD`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = "<!-- freshness:start -->";
const END = "<!-- freshness:end -->";

/** Parse a `YYYY-MM-DD` date as UTC midnight, or return undefined. */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  // Reject dates like 2026-02-31, which Date.UTC rolls over.
  return d.getUTCDate() === Number(m[3]) && d.getUTCMonth() === Number(m[2]) - 1 ? t : undefined;
}

/** The surfaces of the freshness table. Throws on a malformed table. */
export function parseFreshness(markdown) {
  const a = markdown.indexOf(START);
  const b = markdown.indexOf(END);
  if (a < 0 || b < a) throw new Error(`no freshness table (${START} ... ${END})`);
  const rows = markdown
    .slice(a + START.length, b)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .map((l) => l.slice(1, l.endsWith("|") ? -1 : undefined).split("|").map((c) => c.trim()));
  const [header, rule, ...body] = rows;
  if (header?.join("|").toLowerCase() !== "surface|active|checked" || !rule?.every((c) => /^:?-+:?$/.test(c))) {
    throw new Error("freshness table must have the columns | Surface | Active | Checked |");
  }
  if (body.length === 0) throw new Error("freshness table has no surfaces");
  return body.map((cells, i) => {
    const [surface, active, checked] = cells;
    const where = `freshness table row ${i + 1}`;
    if (cells.length !== 3 || !surface) throw new Error(`${where}: expected 3 cells`);
    if (active !== "yes" && active !== "no") throw new Error(`${where} (${surface}): Active must be yes or no`);
    const t = parseDate(checked);
    if (t === undefined) throw new Error(`${where} (${surface}): Checked must be a date YYYY-MM-DD, not ${JSON.stringify(checked)}`);
    return { surface, active: active === "yes", checked, checkedAt: t };
  });
}

/** Active surfaces whose checked date is more than `maxAgeDays` before `today` (ms, UTC). */
export function staleSurfaces(surfaces, today, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  return surfaces
    .filter((s) => s.active)
    .map((s) => ({ ...s, ageDays: Math.floor((today - s.checkedAt) / DAY_MS) }))
    .filter((s) => s.ageDays > maxAgeDays);
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const maxAge = Number(arg("--max-age-days") ?? DEFAULT_MAX_AGE_DAYS);
  if (!Number.isInteger(maxAge) || maxAge < 0) throw new Error("--max-age-days must be a whole number");
  const todayArg = arg("--today");
  const now = new Date();
  const today = todayArg !== undefined ? parseDate(todayArg) : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (today === undefined) throw new Error("--today must be a date YYYY-MM-DD");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const file = "docs/adapters/capability-matrix.md";
  const surfaces = parseFreshness(readFileSync(join(root, file), "utf8"));
  const stale = staleSurfaces(surfaces, today, maxAge);
  if (stale.length === 0) {
    console.log(`Capability matrix is fresh: ${surfaces.filter((s) => s.active).length} active surfaces checked within ${maxAge} days.`);
    return 0;
  }
  console.error(`Capability matrix is stale (${file}): these surfaces are under active development and were last checked more than ${maxAge} days ago:`);
  for (const s of stale) console.error(`  - ${s.surface}: checked ${s.checked} (${s.ageDays} days ago)`);
  console.error(
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
