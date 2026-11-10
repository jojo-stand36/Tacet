#!/usr/bin/env node
// Generate ROADMAP.md from roadmap/issues.json, and keep issues.json in its canonical order.
//
//   node scripts/gen-roadmap.mjs          sort roadmap/issues.json, write ROADMAP.md
//   node scripts/gen-roadmap.mjs --check  exit 1 if either file is not what this would write
//   --root DIR                            work on DIR instead of the repo (tests)
//
// Issues are sorted by milestone (the order of `milestones`), epics first, then title by UTF-16
// code unit (never localeCompare: ICU and locale vary between machines). New entries can be
// appended anywhere; two branches that each add one then land in different places in both files,
// so they merge without a conflict unless their titles sort next to each other (#231).
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pick = (labels, prefix) => labels.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? "";

const TOP_KEYS = ["labels", "milestones", "issues"];
const ISSUE_KEYS = ["title", "milestone", "labels", "body"];

/** Throws unless `obj` has exactly `keys`; returns a copy with them in that order. */
function exactly(obj, keys, what) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`${what} is not an object`);
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  const missing = keys.filter((k) => !(k in obj));
  if (extra.length || missing.length) {
    throw new Error(`${what}: ${[...missing.map((k) => `missing "${k}"`), ...extra.map((k) => `unknown "${k}"`)].join(", ")}`);
  }
  return Object.fromEntries(keys.map((k) => [k, obj[k]]));
}

/**
 * Throws on a malformed entry, an unknown milestone, an untrimmed title (GitHub trims titles, so
 * create-issues.sh would never see it as existing) or a duplicate title; returns the issues in
 * canonical order with their keys in canonical order.
 */
export function sortIssues(data) {
  const rank = new Map(data.milestones.map((m, i) => [m.title, i]));
  const titles = new Set();
  const issues = data.issues.map((i, n) => exactly(i, ISSUE_KEYS, `issue ${n} ("${i?.title}")`));
  for (const i of issues) {
    if (typeof i.title !== "string" || i.title === "" || i.title !== i.title.trim()) {
      throw new Error(`Issue title ${JSON.stringify(i.title)} is empty or has surrounding whitespace`);
    }
    if (!Array.isArray(i.labels)) throw new Error(`Labels of "${i.title}" are not a list`);
    if (!rank.has(i.milestone)) throw new Error(`Unknown milestone "${i.milestone}" on "${i.title}"`);
    if (titles.has(i.title)) throw new Error(`Duplicate issue title "${i.title}"`);
    titles.add(i.title);
  }
  const epic = (i) => (i.labels.includes("type:epic") ? 0 : 1);
  return issues.sort(
    (a, b) =>
      rank.get(a.milestone) - rank.get(b.milestone) ||
      epic(a) - epic(b) ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0),
  );
}

/** The canonical text of issues.json and ROADMAP.md for `data`. */
export function generate(data) {
  const top = exactly(data, TOP_KEYS, "roadmap/issues.json");
  const issues = sortIssues(top);
  const json = `${JSON.stringify({ ...top, issues }, null, 2)}\n`;
  const lines = [
    "# Roadmap",
    "",
    "_Generated from `roadmap/issues.json` by `scripts/gen-roadmap.mjs`. Do not edit by hand. GitHub issues are created with `scripts/create-issues.sh`._",
    "",
    "Routing: `copilot` = good for Copilot cloud agent, `claude` = Claude Code, `either` = both, `human` = needs a human decision. See `docs/HYBRID_WORKFLOW.md`.",
    "",
  ];
  for (const m of data.milestones) {
    lines.push(`## ${m.title}`, "", m.description, "");
    for (const i of issues.filter((x) => x.milestone === m.title)) {
      const type = pick(i.labels, "type:");
      const pri = pick(i.labels, "priority:").toUpperCase();
      const route = [pick(i.labels, "agent:"), i.labels.includes("needs-human") ? "human" : ""]
        .filter(Boolean)
        .join(" + ");
      const tags = [type, pri, route].filter(Boolean).map((t) => `\`${t}\``).join(" ");
      lines.push(`- [ ] **${i.title}** — ${tags}`);
    }
    lines.push("");
  }
  return { json, markdown: lines.join("\n") };
}

export function main(argv, out = console) {
  const check = argv.includes("--check");
  const at = argv.indexOf("--root");
  if (at >= 0 && !argv[at + 1]) {
    out.error("--root needs a directory");
    return 2;
  }
  const root = at >= 0 ? argv[at + 1] : join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = { json: join(root, "roadmap/issues.json"), markdown: join(root, "ROADMAP.md") };
  const curJson = readFileSync(files.json, "utf8");
  let want;
  try {
    want = generate(JSON.parse(curJson.replace(/^\uFEFF/, "")));
  } catch (err) {
    out.error(`roadmap/issues.json: ${err.message}`);
    return 1;
  }
  const curMd = existsSync(files.markdown) ? readFileSync(files.markdown, "utf8") : null;
  if (check) {
    const stale = [];
    if (curJson !== want.json) stale.push("roadmap/issues.json is not in canonical order or format");
    if (curMd !== want.markdown) stale.push("ROADMAP.md is out of date");
    for (const s of stale) out.error(`${s}. Run: node scripts/gen-roadmap.mjs`);
    if (stale.length) return 1;
    out.log("ROADMAP.md and roadmap/issues.json up to date.");
    return 0;
  }
  if (curJson !== want.json) writeFileSync(files.json, want.json);
  if (curMd !== want.markdown) writeFileSync(files.markdown, want.markdown);
  out.log(
    curJson === want.json && curMd === want.markdown
      ? "ROADMAP.md unchanged."
      : "ROADMAP.md regenerated; roadmap/issues.json sorted.",
  );
  return 0;
}

// Run as a script, even through a symlinked path: a check that silently does nothing would pass.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
