#!/bin/sh
# The run's pull request body contains every section named as an argument.
set -u

number="${WORKFLOWLEAF_PR_NUMBER:-}"
if [ -z "$number" ]; then
  echo "WORKFLOWLEAF_PR_NUMBER is not set: this run has no pull request." >&2
  exit 2
fi

if ! body=$(gh pr view "$number" --json body --jq .body); then
  echo "gh could not read pull request #${number}." >&2
  exit 2
fi

missing=0
for section in "$@"; do
  if ! printf '%s\n' "$body" | grep -qxF "$section"; then
    echo "The pull request body has no \"${section}\" line."
    missing=1
  fi
done
[ "$missing" -eq 0 ] && echo "Pull request #${number} has every required section."
exit "$missing"
