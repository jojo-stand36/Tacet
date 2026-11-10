// Tests for gen-roadmap.mjs (#231): `node --test scripts/*.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generate, main, sortIssues } from "./gen-roadmap.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { log() {}, error() {} };
const issue = (title, milestone, labels = ["type:feature", "priority:p2", "area:core", "agent:either"]) => ({
  title,
  milestone,
  labels,
  body: "Body.",
});
const data = (issues) => ({
  labels: [],
  milestones: [
    { title: "M0", description: "Zero." },
    { title: "M1", description: "One." },
  ],
  issues,
});

/** A scratch copy of the repo's roadmap files; removed after the test. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "tacet-roadmap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "roadmap"));
  cpSync(join(repo, "roadmap/issues.json"), join(dir, "roadmap/issues.json"));
  cpSync(join(repo, "ROADMAP.md"), join(dir, "ROADMAP.md"));
  return dir;
}
const readJson = (dir) => JSON.parse(readFileSync(join(dir, "roadmap/issues.json"), "utf8"));
const writeJson = (dir, d) => writeFileSync(join(dir, "roadmap/issues.json"), `${JSON.stringify(d, null, 2)}\n`);

test("sorts by milestone order, epics first, then title by code unit", () => {
  const epic = ["type:epic", "priority:p0", "area:core", "agent:claude"];
  const out = sortIssues(
    data([
      issue("b", "M1"),
      issue("Zed", "M0"),
      issue("`code` first?", "M0"),
      issue("epic", "M1", epic),
      issue("a", "M1"),
      issue("Ábc", "M0"),
    ]),
  ).map((i) => i.title);
  // Code units: "`" (0x60) sorts after "Z" (0x5a) and before "a"; "Á" after every ASCII letter.
  assert.deepEqual(out, ["Zed", "`code` first?", "Ábc", "epic", "a", "b"]);
});

test("refuses an unknown milestone and a duplicate title", () => {
  assert.throws(() => sortIssues(data([issue("x", "M9")])), /Unknown milestone "M9"/);
  assert.throws(() => sortIssues(data([issue("x", "M0"), issue("x", "M1")])), /Duplicate issue title "x"/);
});

test("the repo's own roadmap is canonical", () => {
  assert.equal(main(["--check"], quiet), 0);
  const want = generate(JSON.parse(readFileSync(join(repo, "roadmap/issues.json"), "utf8")));
  assert.equal(want.markdown, readFileSync(join(repo, "ROADMAP.md"), "utf8"));
});

test("--check fails on an unsorted issues.json, a stale ROADMAP.md or a duplicate title", (t) => {
  const dir = scratch(t);
  assert.equal(main(["--check", "--root", dir], quiet), 0);
  const d = readJson(dir);

  writeJson(dir, { ...d, issues: [...d.issues].reverse() });
  const errors = [];
  assert.equal(main(["--check", "--root", dir], { log() {}, error: (m) => errors.push(m) }), 1);
  assert.match(errors.join("\n"), /issues\.json is not in canonical order/);
  // Writing sorts it back, byte for byte.
  assert.equal(main(["--root", dir], quiet), 0);
  assert.deepEqual(readJson(dir), d);

  writeFileSync(join(dir, "ROADMAP.md"), `${readFileSync(join(dir, "ROADMAP.md"), "utf8")}hand edit\n`);
  assert.equal(main(["--check", "--root", dir], quiet), 1);
  assert.equal(main(["--root", dir], quiet), 0);
  assert.equal(main(["--check", "--root", dir], quiet), 0);

  writeJson(dir, { ...d, issues: [...d.issues, d.issues[0]] });
  assert.equal(main(["--check", "--root", dir], quiet), 1);
  assert.equal(main(["--root", dir], quiet), 1);
});

test("two branches that each add an entry merge without a conflict", (t) => {
  const dir = scratch(t);
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-qm", "base");
  const add = (branch, title, milestone) => {
    git("checkout", "-q", "-b", branch, "main");
    const d = readJson(dir);
    writeJson(dir, { ...d, issues: [...d.issues, issue(title, milestone)] });
    assert.equal(main(["--root", dir], quiet), 0);
    git("commit", "-qam", branch);
  };
  const m1 = readJson(dir).milestones[1].title;
  // Both appended to the end of the same milestone before #231: the conflict it fixes.
  add("one", "Add a fixture for the alpha adapter", m1);
  add("two", "Teach the Mini-conductor to retry", m1);
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-edit", "one");
  git("merge", "-q", "--no-edit", "two"); // throws on a conflict
  assert.equal(main(["--check", "--root", dir], quiet), 0);
});
