// Tests for create-issues.sh (#309), with a fake `gh`: `node --test scripts/*.test.mjs`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "create-issues.sh");

/**
 * A fake gh on PATH. GETs of repos/o/r/<list>?...page=N answer from <dir>/<list>.<N>.json (an
 * empty page when absent); every other call is logged as a write to <dir>/writes, with its stdin.
 * `--paginate` fails as it does behind the cloud proxy (repositories/<id> Link paths).
 */
const FAKE_GH = `#!/usr/bin/env bash
dir="$FAKE_GH_DIR"
echo "$*" >> "$dir/calls"
for a in "$@"; do
  if [[ "$a" == "--paginate" ]]; then
    echo "gh: Numeric-ID repository paths (repositories/{id}/...) are not supported through this proxy. (HTTP 403)" >&2
    exit 1
  fi
done
if [[ "$1" == "api" && $# -eq 2 ]]; then
  path="$2"
  list="\${path#repos/o/r/}"; list="\${list%%\\?*}"
  page=$(sed -n 's/.*[?&]page=\\([0-9]*\\).*/\\1/p' <<<"$path")
  f="$dir/$list.$page.json"
  if [[ -f "$f" ]]; then cat "$f"; else echo "[]"; fi
  exit 0
fi
{ echo "WRITE $*"; [[ " $* " == *" --input - "* ]] && cat; echo; } >> "$dir/writes"
echo "{}"
`;

function setup(t, { withGh = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tacet-create-issues-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  if (withGh) {
    writeFileSync(join(bin, "gh"), FAKE_GH);
    chmodSync(join(bin, "gh"), 0o755);
  }
  const issue = (title) => ({ title, milestone: "M1", labels: ["type:chore"], body: `Body of ${title}.` });
  writeFileSync(
    join(dir, "issues.json"),
    JSON.stringify({
      labels: [
        { name: "type:chore", color: "ededed" },
        { name: "new-label", color: "000000" },
      ],
      milestones: [{ title: "M1", description: "One." }],
      issues: ["A", "B", "C", "D"].map(issue),
    }),
  );
  const page = (name, items) => writeFileSync(join(dir, name), JSON.stringify(items));
  page("labels.1.json", [{ name: "type:chore" }]);
  page("milestones.1.json", [{ title: "M1", number: 1 }]);
  // Existing issues over two pages; a pull request titled like a roadmap issue does not count.
  page("issues.1.json", [{ title: "A" }, { title: "C", pull_request: { url: "x" } }]);
  page("issues.2.json", [{ title: "B" }]);
  const run = (...args) => {
    const r = spawnSync("bash", [script, "o/r", ...args], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_GH_DIR: dir,
        TACET_ROADMAP_JSON: join(dir, "issues.json"),
        TACET_CREATE_DELAY: "0",
      },
    });
    const read = (f) => {
      try {
        return readFileSync(join(dir, f), "utf8");
      } catch {
        return "";
      }
    };
    return { ...r, writes: read("writes"), calls: read("calls") };
  };
  return { run };
}

test("a dry-run reports what exists, on every page, and writes nothing", (t) => {
  const { run } = setup(t);
  const r = run("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /skip \(exists\): A/);
  assert.match(r.stdout, /skip \(exists\): B/);
  assert.match(r.stdout, /\[dry-run\] issue: C/);
  assert.match(r.stdout, /\[dry-run\] issue: D/);
  assert.match(r.stdout, /milestone exists: M1/);
  assert.match(r.stdout, /\[dry-run\] label exists \(color set\): type:chore/);
  assert.match(r.stdout, /\[dry-run\] label: new-label/);
  assert.match(r.stdout, /Done: 2 issue\(s\) would be created\./);
  assert.equal(r.writes, "");
  assert.doesNotMatch(r.calls, /--paginate/);
});

test("a real run creates only the missing issues, never one on a later page", (t) => {
  const { run } = setup(t);
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const created = [...r.writes.matchAll(/"title":\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(created, ["C", "D"]);
  assert.match(r.writes, /"milestone":\s*1/);
  assert.match(r.writes, /WRITE api -X PATCH repos\/o\/r\/labels\/type%3Achore -f color=ededed/);
  assert.match(r.writes, /WRITE api repos\/o\/r\/labels -f name=new-label -f color=000000/);
  assert.doesNotMatch(r.writes, /repos\/o\/r\/milestones -f/);
  assert.match(r.stdout, /Done: 2 issue\(s\) created\./);
  assert.doesNotMatch(r.calls, /--paginate/);
});

test("a dry-run without gh says it could not check, and lists everything", (t) => {
  const { run } = setup(t, { withGh: false });
  const r = run("--dry-run");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gh is not installed, so nothing that already exists is checked/);
  assert.match(r.stdout, /Done: 4 issue\(s\) would be created\./);
});
