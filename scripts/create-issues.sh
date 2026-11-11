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
#
# A dry-run reads (never writes) the repo's labels, milestones and issues, so it
# reports exactly what a real run would do (#309); without gh it cannot check and
# says so. Listings go page by page on repos/OWNER/REPO paths: `gh api --paginate`
# follows GitHub's Link header to repositories/<id>/... URLs, which some proxies
# (Claude Code cloud sessions) refuse.
set -euo pipefail

REPO="${1:?usage: $0 OWNER/REPO [--dry-run]}"
DRY="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Tests only: another roadmap file.
DATA="${TACET_ROADMAP_JSON:-$ROOT/roadmap/issues.json}"
API="repos/$REPO"

command -v jq >/dev/null || { echo "jq is required"; exit 1; }
dry() { [[ "$DRY" == "--dry-run" ]]; }
have_gh=1
command -v gh >/dev/null || have_gh=0
if [[ $have_gh == 0 ]]; then
  dry || { echo "gh is required"; exit 1; }
  echo "note: gh is not installed, so nothing that already exists is checked: everything is listed"
fi

# All items of a list endpoint (PATH may carry a query), as one JSON array, a page at a time.
list_all() {
  local path="$1" sep="?" page=1 out="[]" chunk
  [[ "$path" == *\?* ]] && sep="&"
  while :; do
    chunk=$(gh api "$API/$path${sep}per_page=100&page=$page")
    [[ $(jq 'length' <<<"$chunk") -gt 0 ]] || break
    out=$(jq -s 'add' <(printf '%s' "$out") <(printf '%s' "$chunk"))
    page=$((page + 1))
  done
  printf '%s' "$out"
}

echo "==> Labels"
existing_labels=""
[[ $have_gh == 0 ]] || existing_labels=$(list_all "labels" | jq -r '.[].name')
jq -c '.labels[]' "$DATA" | while read -r l; do
  name=$(jq -r .name <<<"$l"); color=$(jq -r .color <<<"$l")
  if grep -Fxq "$name" <<<"$existing_labels"; then
    if dry; then echo "  [dry-run] label exists (color set): $name"; continue; fi
    enc=$(jq -rn --arg s "$name" '$s|@uri')
    gh api -X PATCH "$API/labels/$enc" -f color="$color" >/dev/null
    echo "  label updated: $name"
  else
    if dry; then echo "  [dry-run] label: $name"; continue; fi
    gh api "$API/labels" -f name="$name" -f color="$color" >/dev/null
    echo "  label: $name"
  fi
done

echo "==> Milestones"
ms_json="[]"
[[ $have_gh == 0 ]] || ms_json=$(list_all "milestones?state=all")
jq -c '.milestones[]' "$DATA" | while read -r m; do
  title=$(jq -r .title <<<"$m"); desc=$(jq -r .description <<<"$m")
  if jq -e --arg t "$title" 'any(.[]; .title == $t)' <<<"$ms_json" >/dev/null; then
    echo "  milestone exists: $title"
  elif dry; then
    echo "  [dry-run] milestone: $title"
  else
    gh api "$API/milestones" -f title="$title" -f description="$desc" >/dev/null
    echo "  milestone: $title"
  fi
done
dry || ms_json=$(list_all "milestones?state=all")

echo "==> Issues"
existing_issues=""
# Pull requests are in this listing too: never let one stand in for an issue.
[[ $have_gh == 0 ]] ||
  existing_issues=$(list_all "issues?state=all" | jq -r '.[] | select(.pull_request == null) | .title')
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
  sleep "${TACET_CREATE_DELAY:-1}"   # stay well under secondary rate limits
done < <(jq -c '.issues[]' "$DATA")
echo "Done: $count issue(s) ${DRY:+would be }created."
