#!/bin/sh
# The stage's work is committed: nothing outside .workflowleaf/ is left
# uncommitted, and at least one commit since the base changes a file.
set -u

dirty=$(git status --porcelain -- . ':(exclude).workflowleaf')
if [ -n "$dirty" ]; then
  echo "Uncommitted changes. Commit them:"
  echo "$dirty"
  exit 1
fi

base="${WORKFLOWLEAF_BASE_REVISION:?WORKFLOWLEAF_BASE_REVISION is not set}"
changed=$(git diff --name-only "$base" HEAD -- . ':(exclude).workflowleaf')
if [ -z "$changed" ]; then
  echo "No commit since ${base} changes a file. The build produced nothing to deliver."
  exit 1
fi
echo "Committed changes:"
echo "$changed"
