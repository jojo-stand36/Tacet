#!/usr/bin/env node
// Generate ROADMAP.md from roadmap/issues.json.
//
//   node scripts/gen-roadmap.mjs          write ROADMAP.md
//   node scripts/gen-roadmap.mjs --check  exit 1 if ROADMAP.md is stale
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(readFileSync(join(root, "roadmap/issues.json"), "utf8"));
const check = process.argv.includes("--check");

const pick = (labels, prefix) =>
  labels.find((l) => l.startsWith(prefix))?.slice(prefix.length) ?? "";

const lines = [
  "# Roadmap",
  "",
  "_Generated from `roadmap/issues.json` by `scripts/gen-roadmap.mjs`. Do not edit by hand. GitHub issues are created with `scripts/create-issues.sh`._",
  "",
  "Routing: `copilot` = good for Copilot cloud agent, `claude` = Claude Code, `either` = both, `human` = needs a human decision. See `docs/HYBRID_WORKFLOW.md`.",
  "",
];

const known = new Set(data.milestones.map((m) => m.title));
for (const i of data.issues) {
  if (!known.has(i.milestone)) throw new Error(`Unknown milestone "${i.milestone}" on "${i.title}"`);
}

for (const m of data.milestones) {
  lines.push(`## ${m.title}`, "", m.description, "");
  for (const i of data.issues.filter((x) => x.milestone === m.title)) {
    const type = pick(i.labels, "type:");
    const pri = pick(i.labels, "priority:").toUpperCase();
    const route = [pick(i.labels, "agent:"), i.labels.includes("needs-human") ? "human" : ""]
      .filter(Boolean).join(" + ");
    const tags = [type, pri, route].filter(Boolean).map((t) => `\`${t}\``).join(" ");
    lines.push(`- [ ] **${i.title}** — ${tags}`);
  }
  lines.push("");
}

const out = lines.join("\n");
const path = join(root, "ROADMAP.md");
const cur = existsSync(path) ? readFileSync(path, "utf8") : null;
if (check) {
  if (cur !== out) {
    console.error("ROADMAP.md is out of date. Run: node scripts/gen-roadmap.mjs");
    process.exit(1);
  }
  console.log("ROADMAP.md up to date.");
} else {
  writeFileSync(path, out);
  console.log(cur === out ? "ROADMAP.md unchanged." : "ROADMAP.md regenerated.");
}
