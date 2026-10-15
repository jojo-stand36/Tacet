#!/usr/bin/env bash
# Create labels, milestones and issues from roadmap/issues.json via the GitHub REST API.
#
# Usage:
#   scripts/create-issues.sh OWNER/REPO            # create everything
#   scripts/create-issues.sh OWNER/REPO --dry-run  # print what would happen
#
# Requires: gh (authenticated: `gh auth login`), jq.
# Safe to re-run: existing labels/milestones are reused, and issues whose title
# already exists in the repo are skipped. Uses REST only (no GraphQL).
set -euo pipefail

REPO="${1:?usage: $0 OWNER/REPO [--dry-run]}"
DRY="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$ROOT/roadmap/issues.json"
API="repos/$REPO"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
[[ "$DRY" == "--dry-run" ]] || command -v gh >/dev/null || { echo "gh is required"; exit 1; }

dry() { [[ "$DRY" == "--dry-run" ]]; }

echo "==> Labels"
existing_labels=""
dry || existing_labels=$(gh api --paginate "$API/labels?per_page=100" --jq '.[].name')
jq -c '.labels[]' "$DATA" | while read -r l; do
  name=$(jq -r .name <<<"$l"); color=$(jq -r .color <<<"$l")
  if dry; then echo "  [dry-run] label: $name"; continue; fi
  if grep -Fxq "$name" <<<"$existing_labels"; then
    enc=$(jq -rn --arg s "$name" '$s|@uri')
    gh api -X PATCH "$API/labels/$enc" -f color="$color" >/dev/null
    echo "  label updated: $name"
  else
    gh api "$API/labels" -f name="$name" -f color="$color" >/dev/null
    echo "  label: $name"
  fi
done

echo "==> Milestones"
ms_json="[]"
dry || ms_json=$(gh api --paginate "$API/milestones?state=all&per_page=100" | jq -s 'add // []')
jq -c '.milestones[]' "$DATA" | while read -r m; do
  title=$(jq -r .title <<<"$m"); desc=$(jq -r .description <<<"$m")
  if dry; then echo "  [dry-run] milestone: $title"; continue; fi
  if jq -e --arg t "$title" 'any(.[]; .title == $t)' <<<"$ms_json" >/dev/null; then
    echo "  milestone exists: $title"
  else
    gh api "$API/milestones" -f title="$title" -f description="$desc" >/dev/null
    echo "  milestone: $title"
  fi
done
dry || ms_json=$(gh api --paginate "$API/milestones?state=all&per_page=100" | jq -s 'add // []')

echo "==> Issues"
existing_issues=""
dry || existing_issues=$(gh api --paginate "$API/issues?state=all&per_page=100" --jq '.[].title')
count=0
while read -r i; do
  title=$(jq -r .title <<<"$i")
  if grep -Fxq "$title" <<<"$existing_issues"; then
    echo "  skip (exists): $title"; continue
  fi
  if dry; then echo "  [dry-run] issue: $title"; count=$((count+1)); continue; fi
  ms_title=$(jq -r .milestone <<<"$i")
  ms_num=$(jq -r --arg t "$ms_title" '.[] | select(.title == $t) | .number' <<<"$ms_json")
  jq -n --argjson i "$i" --argjson ms "${ms_num:-null}" \
    '{title: $i.title, body: $i.body, labels: $i.labels} + (if $ms then {milestone: $ms} else {} end)' \
    | gh api "$API/issues" --input - >/dev/null
  echo "  issue: $title"
  count=$((count+1))
  sleep 1   # stay well under secondary rate limits
done < <(jq -c '.issues[]' "$DATA")
echo "Done: $count issue(s) ${DRY:+would be }created."
