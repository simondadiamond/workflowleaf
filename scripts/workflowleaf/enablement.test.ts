import { describe, expect, it } from "vite-plus/test";

import { dependencyNames, findEnablementViolations, isWorkspaceManifest } from "./enablement.ts";
import type { EnablementRule } from "./ownership.ts";

const rule: EnablementRule = {
  packagePrefixes: ["@t3tools/workflowleaf"],
  reason: "T3 has to keep building with WorkflowLeaf deleted",
};

describe("C14, T3 runs with WorkflowLeaf disabled", () => {
  it("accepts upstream manifests that never mention WorkflowLeaf", () => {
    const violations = findEnablementViolations(
      rule,
      [
        {
          path: "apps/server/package.json",
          manifest: { name: "@t3tools/server", dependencies: { effect: "4.0.0" } },
        },
      ],
      [],
    );

    expect(violations).toEqual([]);
  });

  it("rejects an upstream manifest that depends on a WorkflowLeaf package", () => {
    const violations = findEnablementViolations(
      rule,
      [
        {
          path: "apps/server/package.json",
          manifest: { dependencies: { "@t3tools/workflowleaf-runtime": "workspace:*" } },
        },
      ],
      [],
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("upstream-depends-on-workflowleaf");
    expect(violations[0]?.offender).toBe("@t3tools/workflowleaf-runtime");
  });

  it("catches a dependency hidden in devDependencies", () => {
    const violations = findEnablementViolations(
      rule,
      [
        {
          path: "apps/web/package.json",
          manifest: { devDependencies: { "@t3tools/workflowleaf-core": "workspace:*" } },
        },
      ],
      [],
    );

    expect(violations).toHaveLength(1);
  });

  it("rejects an allow-listed upstream source file that imports WorkflowLeaf", () => {
    const violations = findEnablementViolations(
      rule,
      [],
      [
        {
          path: "apps/server/src/bin.ts",
          text: 'import { run } from "@t3tools/workflowleaf-runtime";\n',
        },
      ],
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("upstream-edit-imports-workflowleaf");
  });

  it("ignores a lockfile that names the packages, because it must", () => {
    const violations = findEnablementViolations(
      rule,
      [],
      [
        {
          path: "pnpm-lock.yaml",
          text: "  packages/workflowleaf-core:\n    dependencies:\n      effect: 4.0.0\n",
        },
      ],
    );

    expect(violations).toEqual([]);
  });
});

describe("dependency name extraction", () => {
  it("reads all four dependency fields", () => {
    const names = dependencyNames({
      dependencies: { a: "1" },
      devDependencies: { b: "1" },
      peerDependencies: { c: "1" },
      optionalDependencies: { d: "1" },
    });

    expect(names.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("survives a manifest that is not an object", () => {
    expect(dependencyNames(null)).toEqual([]);
    expect(dependencyNames("{}")).toEqual([]);
    expect(dependencyNames({ dependencies: "not a record" })).toEqual([]);
  });
});

describe("which tracked manifests get scanned", () => {
  it("scans a real workspace manifest", () => {
    expect(isWorkspaceManifest("apps/server/package.json")).toBe(true);
    expect(isWorkspaceManifest("package.json")).toBe(true);
  });

  it("skips vendored reference checkouts", () => {
    // .repos/ is read-only reference material, never built or imported, and CI
    // sparse-checks-out without it, so these paths are tracked but absent.
    expect(isWorkspaceManifest(".repos/alchemy-effect/benchmark/package.json")).toBe(false);
    expect(isWorkspaceManifest(".repos/effect-smol/package.json")).toBe(false);
  });

  it("skips anything under node_modules, nested included", () => {
    expect(isWorkspaceManifest("node_modules/effect/package.json")).toBe(false);
    expect(isWorkspaceManifest("apps/web/node_modules/left-pad/package.json")).toBe(false);
  });

  it("ignores a path that is not a manifest", () => {
    expect(isWorkspaceManifest("apps/server/src/bin.ts")).toBe(false);
  });
});
