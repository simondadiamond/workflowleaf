/**
 * Pure orientation-staleness rule.
 *
 * Onboarding material that lies is worse than none, and remembering to update
 * it is exactly the kind of rule that fails quietly on a bad day. So a commit
 * that moves anything the orientation describes has to touch the orientation,
 * or say in its own message why it did not.
 *
 * Each commit is judged alone, never as part of a range. A range-wide rule
 * lets one commit's escape hatch excuse a different commit that really did
 * move the domain shape, and lets one orientation edit cover every later
 * change on the same branch. Both are the silent failure this rule exists to
 * prevent. That is also why the rule reads commits rather than the working
 * tree: the hatch is a commit message, so a commit is the only thing that can
 * carry one. The ownership rule keeps covering uncommitted work, because its
 * escape hatch is a file you can edit right now.
 */

import type { Change, OrientationRule } from "./ownership.ts";

export interface CommitUnderReview {
  readonly sha: string;
  readonly subject: string;
  readonly message: string;
  readonly changes: readonly Change[];
}

export interface OrientationViolation {
  readonly sha: string;
  readonly subject: string;
  readonly orientationPath: string;
  readonly touched: readonly string[];
  readonly escapeHatch: string;
  readonly reason: string;
}

function matchesLayout(rule: OrientationRule, path: string): boolean {
  return rule.layoutPaths.some((layout) =>
    layout.endsWith("/") ? path.startsWith(layout) : path === layout,
  );
}

/**
 * One violation per commit that moved a layout-defining path, left the
 * orientation alone, and did not claim the exemption in its own message.
 *
 * Merge commits are the caller's problem to exclude: their changes arrive from
 * commits that were judged on their own.
 */
export function findOrientationViolations(
  rule: OrientationRule,
  commits: readonly CommitUnderReview[],
): OrientationViolation[] {
  const violations: OrientationViolation[] = [];

  for (const commit of commits) {
    const touched = commit.changes
      .filter((change) => matchesLayout(rule, change.path))
      .map((change) => change.path);
    if (touched.length === 0) continue;
    if (commit.changes.some((change) => change.path === rule.path)) continue;
    if (commit.message.includes(rule.escapeHatch)) continue;

    violations.push({
      sha: commit.sha,
      subject: commit.subject,
      orientationPath: rule.path,
      touched: [...new Set(touched)].sort(),
      escapeHatch: rule.escapeHatch,
      reason: rule.reason,
    });
  }

  return violations;
}

export function formatOrientationReport(violations: readonly OrientationViolation[]): string {
  if (violations.length === 0) return "workflowleaf orientation: clean";

  const lines = violations.flatMap((violation) => [
    `  ${violation.sha.slice(0, 12)}  ${violation.subject}`,
    ...violation.touched.map((path) => `      moved ${path}`),
    `      ${violation.reason}`,
    `      Update ${violation.orientationPath} in that commit, or put "${violation.escapeHatch} <reason>" in its message.`,
  ]);

  return [
    `workflowleaf orientation: ${violations.length} commit(s) left the orientation behind`,
    ...lines,
  ].join("\n");
}
