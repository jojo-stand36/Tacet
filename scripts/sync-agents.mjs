#!/usr/bin/env node
// Generate GitHub Copilot custom agents (.github/agents/<name>.agent.md)
// from the Claude Code subagents in .claude/agents/*.md (the source of truth).
//
//   node scripts/sync-agents.mjs          write generated files
//   node scripts/sync-agents.mjs --check  exit 1 if generated files are stale
//
// Source frontmatter must be simple `key: value` lines (name, description, tools, model).
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, ".claude/agents");
const outDir = join(root, ".github/agents");
const check = process.argv.includes("--check");

// Claude Code tool name -> Copilot tool alias.
// https://docs.github.com/en/copilot/reference/custom-agents-configuration
const TOOL_MAP = {
  Read: "read", NotebookRead: "read",
  Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit",
  Grep: "search", Glob: "search",
  Bash: "execute",
  WebSearch: "web", WebFetch: "web",
  Agent: "agent", Task: "agent",
  TodoWrite: "todo",
};

function parse(file) {
  const text = readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing frontmatter`);
  const fm = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i < 0) throw new Error(`${file}: bad frontmatter line: ${line}`);
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  for (const k of ["name", "description"]) if (!fm[k]) throw new Error(`${file}: missing ${k}`);
  if (fm.name !== basename(file, ".md")) throw new Error(`${file}: name must match file name`);
  return { fm, body: m[2].trim() };
}

function render({ fm, body }, srcRel) {
  const tools = fm.tools
    ? [...new Set(fm.tools.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
        const mapped = TOOL_MAP[t] ?? (t.startsWith("mcp__") ? null : t.toLowerCase());
        if (mapped === undefined) throw new Error(`unknown tool ${t}`);
        return mapped;
      }).filter(Boolean))]
    : null;
  const lines = [
    "---",
    `name: ${fm.name}`,
    `description: ${JSON.stringify(fm.description)}`,
  ];
  if (tools) lines.push(`tools: [${tools.map((t) => JSON.stringify(t)).join(", ")}]`);
  lines.push("---", "");
  lines.push(`<!-- GENERATED from ${srcRel} by scripts/sync-agents.mjs. Do not edit; edit the source and re-run. -->`, "");
  lines.push(body, "");
  if (tools?.includes("web")) {
    lines.push(
      "> Note for Copilot cloud agent: web tools are not available there. If you cannot reach a primary source, record the fact as UNVERIFIED and ask for this agent to be run in Claude Code (label `agent:claude`).",
      "",
    );
  }
  return lines.join("\n");
}

const sources = readdirSync(srcDir).filter((f) => f.endsWith(".md")).sort();
const expected = new Map();
for (const f of sources) {
  const agent = parse(join(srcDir, f));
  expected.set(`${agent.fm.name}.agent.md`, render(agent, `.claude/agents/${f}`));
}

let stale = [];
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const existing = readdirSync(outDir).filter((f) => f.endsWith(".agent.md"));
for (const f of existing) {
  if (!expected.has(f)) {
    stale.push(`orphan ${f}`);
    if (!check) rmSync(join(outDir, f));
  }
}
for (const [f, content] of expected) {
  const p = join(outDir, f);
  const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
  if (cur !== content) {
    stale.push(f);
    if (!check) writeFileSync(p, content);
  }
}

if (check && stale.length) {
  console.error(`Copilot agents out of date: ${stale.join(", ")}\nRun: node scripts/sync-agents.mjs`);
  process.exit(1);
}
console.log(check ? `Copilot agents up to date (${expected.size}).` : `Synced ${expected.size} agents (${stale.length} changed).`);
