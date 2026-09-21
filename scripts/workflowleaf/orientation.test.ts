import { describe, expect, it } from "vite-plus/test";

import { findOrientationViolations, type CommitUnderReview } from "./orientation.ts";
import type { Change, OrientationRule } from "./ownership.ts";

const rule: OrientationRule = {
  path: "scripts/workflowleaf/ORIENTATION.md",
  layoutPaths: [
    "packages/workflowleaf-core/src/contracts.ts",
    "packages/workflowleaf-runtime/src/adapters/",
    "scripts/workflowleaf/ownership.json",
  ],
  escapeHatch: "orientation-unchanged:",
  reason: "layout moved",
};

const commit = (sha: string, message: string, paths: readonly string[]): CommitUnderReview => ({
  sha,
  subject: message.split("\n")[0] ?? "",
  message,
  changes: paths.map((path): Change => ({ path, kind: "modified" })),
});

describe("orientation staleness", () => {
  it("passes a commit that touches no layout-defining path", () => {
    const violations = findOrientationViolations(rule, [
      commit("a1", "fix(workflowleaf): a gate that cannot start no longer kills the run", [
        "packages/workflowleaf-runtime/src/gates.ts",
      ]),
    ]);

    expect(violations).toEqual([]);
  });

  it("fails a layout change that leaves the orientation alone", () => {
    const violations = findOrientationViolations(rule, [
      commit("a1", "feat(workflowleaf): add a field", [
        "packages/workflowleaf-core/src/contracts.ts",
      ]),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.touched).toEqual(["packages/workflowleaf-core/src/contracts.ts"]);
    expect(violations[0]?.sha).toBe("a1");
  });

  it("passes when the same commit updates the orientation", () => {
    const violations = findOrientationViolations(rule, [
      commit("a1", "feat(workflowleaf): add a field", [
        "packages/workflowleaf-core/src/contracts.ts",
        "scripts/workflowleaf/ORIENTATION.md",
      ]),
    ]);

    expect(violations).toEqual([]);
  });

  it("passes a commit that claims the escape hatch in its own message", () => {
    const violations = findOrientationViolations(rule, [
      commit(
        "a1",
        "refactor(workflowleaf): rename a local\n\norientation-unchanged: no documented shape moved",
        ["packages/workflowleaf-core/src/contracts.ts"],
      ),
    ]);

    expect(violations).toEqual([]);
  });

  it("does not let one commit's escape hatch excuse another", () => {
    // The hole the range-wide version had: a hatch on a trivial rename forgave
    // a sibling commit that really did move the domain shape.
    const violations = findOrientationViolations(rule, [
      commit("a1", "refactor: rename a local\n\norientation-unchanged: nothing moved", [
        "packages/workflowleaf-core/src/contracts.ts",
      ]),
      commit("b2", "feat(workflowleaf): add a stage kind", [
        "packages/workflowleaf-core/src/contracts.ts",
      ]),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.sha).toBe("b2");
  });

  it("does not let one commit's orientation edit cover a later one", () => {
    const violations = findOrientationViolations(rule, [
      commit("a1", "feat(workflowleaf): a documented change", [
        "scripts/workflowleaf/ownership.json",
        "scripts/workflowleaf/ORIENTATION.md",
      ]),
      commit("b2", "feat(workflowleaf): a second executor", [
        "packages/workflowleaf-runtime/src/adapters/grok/index.ts",
      ]),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.sha).toBe("b2");
  });

  it("matches a directory entry by prefix so a new adapter counts", () => {
    const violations = findOrientationViolations(rule, [
      commit("a1", "feat(workflowleaf): a second executor", [
        "packages/workflowleaf-runtime/src/adapters/grok/index.ts",
      ]),
    ]);

    expect(violations[0]?.touched).toEqual([
      "packages/workflowleaf-runtime/src/adapters/grok/index.ts",
    ]);
  });

  it("matches a file entry exactly, not by prefix", () => {
    // contracts.test.ts is not the domain shape, and a prefix match would claim it.
    const violations = findOrientationViolations(rule, [
      commit("a1", "test(workflowleaf): cover a decoder", [
        "packages/workflowleaf-core/src/contracts.test.ts",
      ]),
    ]);

    expect(violations).toEqual([]);
  });

  it("treats an empty range as nothing to document", () => {
    expect(findOrientationViolations(rule, [])).toEqual([]);
  });

  it("reports every layout path a commit touched, once and sorted", () => {
    const violations = findOrientationViolations(rule, [
      {
        sha: "a1",
        subject: "chore(workflowleaf): move things",
        message: "chore(workflowleaf): move things",
        changes: [
          { path: "scripts/workflowleaf/ownership.json", kind: "modified" },
          { path: "packages/workflowleaf-core/src/contracts.ts", kind: "modified" },
          { path: "packages/workflowleaf-core/src/contracts.ts", kind: "deleted" },
        ],
      },
    ]);

    expect(violations[0]?.touched).toEqual([
      "packages/workflowleaf-core/src/contracts.ts",
      "scripts/workflowleaf/ownership.json",
    ]);
  });
});
