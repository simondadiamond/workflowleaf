#!/bin/sh
# The work is committed and HEAD is what the branch's upstream holds.
set -u

dirty=$(git status --porcelain -- . ':(exclude).workflowleaf')
if [ -n "$dirty" ]; then
  echo "Uncommitted changes. Commit and push them:"
  echo "$dirty"
  exit 1
fi

if ! upstream=$(git rev-parse '@{u}' 2>/dev/null); then
  echo "The branch has no upstream. Push it with: git push --set-upstream origin HEAD"
  exit 1
fi

git fetch --quiet 2>/dev/null
remote=$(git rev-parse '@{u}')
head=$(git rev-parse HEAD)
if [ "$head" != "$remote" ]; then
  echo "HEAD ${head} is not what the upstream holds (${remote}). Push with: git push"
  exit 1
fi
echo "Pushed: ${head}"
