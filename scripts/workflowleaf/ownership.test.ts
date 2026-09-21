import { describe, expect, it } from "vite-plus/test";

import {
  findOwnershipViolations,
  findUpstreamCapViolation,
  parseNameStatusZ,
  upstreamEditCount,
  type Ownership,
} from "./ownership.ts";

const ownership: Ownership = {
  upstreamBase: "7445aa733ada33e45289e5aa5055f79142556513",
  ownedPrefixes: ["packages/workflowleaf-core/", "scripts/workflowleaf/"],
  ownedFiles: ["packages/contracts/src/workflowleaf.ts"],
  maxUpstreamEdits: 1,
  allowedUpstreamEdits: [
    { path: "pnpm-lock.yaml", purpose: "workspace join", removeWhen: "packages removed" },
  ],
  orientation: {
    path: "scripts/workflowleaf/ORIENTATION.md",
    layoutPaths: ["packages/workflowleaf-core/src/contracts.ts"],
    escapeHatch: "orientation-unchanged:",
    reason: "layout moved",
  },
  enablement: { packagePrefixes: ["@t3tools/workflowleaf"], reason: "C14" },
  importBoundaries: [],
};

describe("fork ownership", () => {
  it("accepts new files under an owned prefix", () => {
    const violations = findOwnershipViolations(ownership, [
      { path: "packages/workflowleaf-core/src/contracts.ts", kind: "added" },
      { path: "scripts/workflowleaf/check.ts", kind: "added" },
    ]);

    expect(violations).toEqual([]);
  });

  it("accepts an owned file listed by exact path inside an upstream directory", () => {
    const violations = findOwnershipViolations(ownership, [
      { path: "packages/contracts/src/workflowleaf.ts", kind: "added" },
    ]);

    expect(violations).toEqual([]);
  });

  it("rejects an unlisted upstream edit", () => {
    const violations = findOwnershipViolations(ownership, [
      { path: "apps/server/src/orchestration/OrchestrationEngine.ts", kind: "modified" },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("unlisted-upstream-edit");
  });

  it("rejects a new file dropped into an upstream directory", () => {
    const violations = findOwnershipViolations(ownership, [
      { path: "apps/server/src/orchestration/StageController.ts", kind: "added" },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("unowned-addition");
  });

  it("accepts an upstream edit once it is listed with a reason", () => {
    const violations = findOwnershipViolations(ownership, [
      { path: "pnpm-lock.yaml", kind: "modified" },
    ]);

    expect(violations).toEqual([]);
  });

  it("rejects deletion of an upstream file", () => {
    const violations = findOwnershipViolations(ownership, [
      { path: "apps/server/src/ws.ts", kind: "deleted" },
    ]);

    expect(violations[0]?.rule).toBe("unlisted-upstream-edit");
  });

  it("counts upstream-owned paths for the merge runbook metric", () => {
    const count = upstreamEditCount(ownership, [
      { path: "packages/workflowleaf-core/src/contracts.ts", kind: "added" },
      { path: "pnpm-lock.yaml", kind: "modified" },
      { path: "apps/server/src/ws.ts", kind: "modified" },
    ]);

    expect(count).toBe(2);
  });
});

describe("git name-status parsing", () => {
  it("keeps paths containing spaces intact", () => {
    const changes = parseNameStatusZ(
      "M\0apps/web/src/a b.tsx\0A\0packages/workflowleaf-core/src/x.ts\0",
    );

    expect(changes).toEqual([
      { path: "apps/web/src/a b.tsx", kind: "modified" },
      { path: "packages/workflowleaf-core/src/x.ts", kind: "added" },
    ]);
  });

  it("splits a rename into a deletion and an addition", () => {
    const changes = parseNameStatusZ("R100\0apps/server/src/old.ts\0apps/server/src/new.ts\0");

    expect(changes).toEqual([
      { path: "apps/server/src/old.ts", kind: "deleted" },
      { path: "apps/server/src/new.ts", kind: "added" },
    ]);
  });
});

describe("upstream edit cap", () => {
  it("accepts an allow-list at the cap", () => {
    expect(findUpstreamCapViolation(ownership)).toBeUndefined();
  });

  it("rejects an allow-list that has outgrown the cap", () => {
    const drifted: Ownership = {
      ...ownership,
      allowedUpstreamEdits: [
        ...ownership.allowedUpstreamEdits,
        { path: "package.json", purpose: "a script", removeWhen: "never, probably" },
      ],
    };

    expect(findUpstreamCapViolation(drifted)).toContain("package.json");
  });

  it("counts recorded entries, not files that happen to be dirty", () => {
    // Nothing is dirty here and the cap still fails: the list is what accumulates.
    const drifted: Ownership = {
      ...ownership,
      maxUpstreamEdits: 0,
    };

    expect(findUpstreamCapViolation(drifted)).toContain("maxUpstreamEdits is 0");
  });
});
