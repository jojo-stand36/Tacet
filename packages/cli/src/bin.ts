#!/usr/bin/env node
import { main } from './main.js';

process.exitCode = main(process.argv.slice(2), {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
  cwd: process.cwd(),
});
