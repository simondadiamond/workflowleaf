#!/bin/sh
# Runs one command the target repository declares in .workflowleaf/commands.
#
# The file is read at the run's base revision, not from the worktree, so the
# stage being checked cannot rewrite the check. Usage: repo-command.sh <name>
set -u

name="${1:?usage: repo-command.sh <name>}"
base="${WORKFLOWLEAF_BASE_REVISION:-}"

if [ -z "$base" ]; then
  echo "WORKFLOWLEAF_BASE_REVISION is not set. Run this through a WorkflowLeaf gate." >&2
  exit 2
fi

if ! commands=$(git show "$base:.workflowleaf/commands" 2>/dev/null); then
  echo "The repository has no .workflowleaf/commands at the run's base revision ${base}." >&2
  echo "Commit one to the base branch with a line like: ${name}: npm test" >&2
  exit 2
fi

line=$(printf '%s\n' "$commands" | grep -E "^${name}:" | head -n 1)
if [ -z "$line" ]; then
  echo ".workflowleaf/commands at ${base} declares no \"${name}:\" line." >&2
  exit 2
fi

command=${line#*:}
echo "\$${command}"
exec /bin/sh -c "$command"
