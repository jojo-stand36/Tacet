#!/usr/bin/env node
// Validate .claude/skills/*/SKILL.md so they work in both Claude Code and GitHub Copilot.
// Rules: frontmatter present; `name` equals the directory, lowercase-hyphenated;
// `description` present and <= 1024 chars; SKILL.md under 500 lines.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".claude/skills");
const errors = [];
let count = 0;

for (const name of readdirSync(dir).sort()) {
  const skillDir = join(dir, name);
  if (!statSync(skillDir).isDirectory()) continue;
  const file = join(skillDir, "SKILL.md");
  const where = `.claude/skills/${name}/SKILL.md`;
  if (!existsSync(file)) { errors.push(`${where}: missing`); continue; }
  count++;
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) { errors.push(`${where}: missing frontmatter`); continue; }
  const fm = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0 && !line.startsWith(" ")) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`${where}: directory must be lowercase-hyphenated`);
  if (fm.name !== name) errors.push(`${where}: name "${fm.name ?? ""}" must equal directory "${name}"`);
  if (!fm.description) errors.push(`${where}: description is required`);
  else if (fm.description.length > 1024) errors.push(`${where}: description is ${fm.description.length} chars (max 1024)`);
  const lines = text.split("\n").length;
  if (lines > 500) errors.push(`${where}: ${lines} lines (keep under 500; move reference material to sibling files)`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Skills OK (${count}).`);
