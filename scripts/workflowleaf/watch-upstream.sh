#!/bin/sh
# Reports the four signals that say T3's orchestration V2 is stable enough to
# re-audit (#23, plan section 5.3). The audit starts when at least three hold.
#
# Each signal is read from GitHub, not inferred from file layout. Run it by
# hand or on a weekly schedule; it changes nothing.
#   GH_CONFIG_DIR=$HOME/.workflowleaf/gh scripts/workflowleaf/watch-upstream.sh
set -u
repo=pingdotgg/t3code
held=0

report() { # <held 0|1> <text>
  if [ "$1" -eq 1 ]; then held=$((held + 1)); echo "  yes  $2"; else echo "  no   $2"; fi
}

echo "Orchestration V2 signals on ${repo}:"

merged=$(gh search prs --repo "$repo" --merged --json number "orchestration v2 in:title" --limit 100 --jq length 2>/dev/null || echo 0)
open=$(gh search prs --repo "$repo" --state open --json number "orchestration v2 in:title" --limit 100 --jq length 2>/dev/null || echo 0)
latest=$(gh release list -R "$repo" --exclude-pre-releases --limit 1 --json tagName,publishedAt --jq '.[0] | "\(.tagName) \(.publishedAt)"' 2>/dev/null)
report "$([ "$merged" -gt 0 ] && [ "$open" -eq 0 ] && echo 1 || echo 0)" \
  "V2 merged and shipped: ${merged} V2 pull requests merged, ${open} still open; latest stable release ${latest}"

reopened=$(gh pr view 11360 -R "$repo" --json state --jq .state 2>/dev/null)
successor=$(gh search prs --repo "$repo" --state open --json number "thread_start in:title" --limit 20 --jq length 2>/dev/null || echo 0)
report "$([ "$reopened" = "OPEN" ] || [ "$successor" -gt 0 ] && echo 1 || echo 0)" \
  "Orchestration pull requests accepted again: #11360 is ${reopened}, ${successor} open successor(s)"

toolkits=$(gh api "repos/${repo}/contents/apps/server/src/mcp/toolkits" --jq '[.[].name] | join(", ")' 2>/dev/null)
report "$(printf '%s' "$toolkits" | grep -qi thread && echo 1 || echo 0)" \
  "Thread tools back in the t3-code MCP server: toolkits are ${toolkits}"

set -- $(gh release list -R "$repo" --exclude-pre-releases --limit 3 --json tagName --jq '.[].tagName' 2>/dev/null)
if [ $# -ge 3 ]; then
  touched=$(gh api "repos/${repo}/compare/$3...$1" --jq '[.files[].filename | select(test("packages/contracts/src/orchestration"))] | length' 2>/dev/null || echo 1)
  report "$([ "$touched" -eq 0 ] && echo 1 || echo 0)" \
    "Two releases without orchestration contract changes: $3 to $1 touched ${touched} contract file(s)"
else
  report 0 "Two releases without orchestration contract changes: fewer than three stable releases to compare"
fi

echo "${held} of 4 hold. The V2 audit (#23) starts at 3."
