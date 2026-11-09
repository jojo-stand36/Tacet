#!/usr/bin/env node
// Writes packages/core/schema/v1/*.json from the zod schemas (ADR-003 §7).
// Usage: node packages/core/scripts/gen-schemas.mjs [--check]
// Reads the compiled output in dist/, so run `tsc -b packages/core` first.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { allJsonSchemas, SCHEMA_VERSION } = await import(join(root, 'dist', 'index.js'));
const outDir = join(root, 'schema', `v${SCHEMA_VERSION}`);
const check = process.argv.includes('--check');

const expected = new Map(
  Object.entries(allJsonSchemas()).map(([name, doc]) => [
    `${name}.json`,
    `${JSON.stringify(doc, null, 2)}\n`,
  ]),
);

if (check) {
  const problems = [];
  let existing = [];
  try {
    existing = readdirSync(outDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const [file, text] of expected) {
    let current = null;
    try {
      current = readFileSync(join(outDir, file), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (current !== text) problems.push(`${file} is ${current === null ? 'missing' : 'stale'}`);
  }
  for (const file of existing) if (!expected.has(file)) problems.push(`${file} is not generated`);
  if (problems.length) {
    console.error(`JSON Schemas out of date:\n  ${problems.join('\n  ')}`);
    console.error('Run: pnpm --filter @tacet/core gen:schemas');
    process.exit(1);
  }
  console.log(`JSON Schemas up to date (${expected.size}).`);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) {
    if (f.endsWith('.json') && !expected.has(f)) {
      console.warn(`removing stale ${f}`);
      rmSync(join(outDir, f));
    }
  }
  for (const [file, text] of expected) writeFileSync(join(outDir, file), text);
  console.log(`Wrote ${expected.size} JSON Schemas to ${outDir}.`);
}
