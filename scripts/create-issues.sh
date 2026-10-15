#!/usr/bin/env bash
# Create labels, milestones and issues from roadmap/issues.json using the GitHub CLI.
#
# Usage:
#   scripts/create-issues.sh OWNER/REPO            # create everything
#   scripts/create-issues.sh OWNER/REPO --dry-run  # print what would happen
#
# Requires: gh (authenticated: `gh auth login`), jq.
# Safe to re-run: existing labels/milestones are reused, and issues whose title
# already exists in the repo are skipped.
set -euo pipefail

REPO="${1:?usage: $0 OWNER/REPO [--dry-run]}"
DRY="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/roadmap/issues.json"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
if [[ "$DRY" != "--dry-run" ]]; then
  command -v gh >/dev/null || { echo "gh is required"; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "Run 'gh auth login' first"; exit 1; }
fi

run() { if [[ "$DRY" == "--dry-run" ]]; then echo "[dry-run] $*"; else "$@"; fi; }

echo "==> Labels"
jq -c '.labels[]' "$DATA" | while read -r l; do
  name=$(jq -r .name <<<"$l"); color=$(jq -r .color <<<"$l")
  run gh label create "$name" --repo "$REPO" --color "$color" --force >/dev/null
  echo "  label: $name"
done

echo "==> Milestones"
existing_ms=""
[[ "$DRY" != "--dry-run" ]] && existing_ms=$(gh api "repos/$REPO/milestones?state=all&per_page=100" --jq '.[].title')
jq -c '.milestones[]' "$DATA" | while read -r m; do
  title=$(jq -r .title <<<"$m"); desc=$(jq -r .description <<<"$m")
  if grep -Fxq "$title" <<<"$existing_ms"; then
    echo "  milestone exists: $title"
  else
    run gh api "repos/$REPO/milestones" -f title="$title" -f description="$desc" >/dev/null
    echo "  milestone: $title"
  fi
done

echo "==> Issues"
existing_issues=""
[[ "$DRY" != "--dry-run" ]] && existing_issues=$(gh issue list --repo "$REPO" --state all --limit 1000 --json title --jq '.[].title')
count=0
while read -r i; do
  title=$(jq -r .title <<<"$i")
  if grep -Fxq "$title" <<<"$existing_issues"; then
    echo "  skip (exists): $title"; continue
  fi
  ms=$(jq -r .milestone <<<"$i")
  body=$(jq -r .body <<<"$i")
  label_args=()
  while read -r lab; do label_args+=(--label "$lab"); done < <(jq -r '.labels[]' <<<"$i")
  run gh issue create --repo "$REPO" --title "$title" --body "$body" --milestone "$ms" "${label_args[@]}" >/dev/null
  echo "  issue: $title"
  count=$((count+1))
  [[ "$DRY" != "--dry-run" ]] && sleep 1   # stay well under secondary rate limits
done < <(jq -c '.issues[]' "$DATA")
echo "Done: $count issue(s) ${DRY:+would be }created."
