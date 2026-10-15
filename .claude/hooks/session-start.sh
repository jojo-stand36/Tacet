#!/usr/bin/env bash
# SessionStart hook: prepare the environment and surface useful context.
# Output on stdout is added to the session context, so keep it short.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Cloud sessions start from a clean checkout: install deps once the monorepo exists.
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ] && [ -f pnpm-lock.yaml ]; then
  (corepack enable >/dev/null 2>&1 && pnpm install --frozen-lockfile >/dev/null 2>&1) \
    || echo "[tacet] pnpm install failed; run it manually."
fi

branch=$(git branch --show-current 2>/dev/null || echo "?")
echo "[tacet] branch: $branch"

# If the branch follows <agent>/<issue>-<slug>, point at the issue.
issue=$(sed -nE 's#^[^/]+/([0-9]+)-.*#\1#p' <<<"$branch")
if [ -n "$issue" ]; then
  echo "[tacet] working on issue #$issue. Run /pick-up-issue $issue to load it and its latest handoff."
fi

# Warn about stale generated files.
node scripts/gen-roadmap.mjs --check >/dev/null 2>&1 || echo "[tacet] ROADMAP.md is stale: run node scripts/gen-roadmap.mjs"
node scripts/sync-agents.mjs --check >/dev/null 2>&1 || echo "[tacet] Copilot agents are stale: run node scripts/sync-agents.mjs"
exit 0
