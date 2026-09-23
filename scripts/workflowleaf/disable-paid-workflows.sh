#!/bin/sh
# Disables every upstream workflow that asks for a Blacksmith runner.
#
# Upstream T3 pays for Blacksmith; this fork does not, so any job on a
# `blacksmith-*` runner queues forever and the workflow never finishes. That
# only adds checks to every pull request that will never report. Disabling a
# workflow is a repository setting, not a file change, so upstream merges stay
# conflict-free. A new upstream workflow arrives enabled, which is why the
# fork's `workflowleaf-housekeeping.yml` runs this after every push to main.
#
# Usage: disable-paid-workflows.sh [--dry-run] [owner/repo]
# Needs `gh` with actions:write on the repository.
set -eu

dry_run=false
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=true
  shift
fi
repo=${1:-simondadiamond/workflowleaf}
dir=$(cd "$(dirname "$0")/../../.github/workflows" && pwd)

for file in "$dir"/*.yml "$dir"/*.yaml; do
  [ -f "$file" ] || continue
  grep -Eq '^[[:space:]]*runs-on:.*blacksmith-' "$file" || continue
  name=$(basename "$file")
  # A workflow GitHub has never registered (it has never been triggered here)
  # answers 404, and has nothing to disable yet.
  state=$(gh api "repos/$repo/actions/workflows/$name" --jq .state 2>/dev/null) || state=unregistered
  case $state in
    active)
      if $dry_run; then
        echo "would disable $name"
      else
        gh api -X PUT "repos/$repo/actions/workflows/$name/disable" >/dev/null
        echo "disabled $name"
      fi
      ;;
    *) echo "skipped $name: $state" ;;
  esac
done
