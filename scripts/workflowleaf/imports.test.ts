import { describe, expect, it } from "vite-plus/test";

import { extractSpecifiers, findImportViolations } from "./imports.ts";
import type { ImportBoundary } from "./ownership.ts";

const T3_PACKAGE = "@t3" + "tools/";

const coreIsPortable: ImportBoundary = {
  id: "core-is-portable",
  root: "packages/workflowleaf-core/src",
  forbid: [T3_PACKAGE],
  forbidInSource: ["node:fs", "node:path"],
  forbidSymbolsInSource: ["Date.now(", "process.env"],
  reason: "Core stays portable.",
};

const t3Confined: ImportBoundary = {
  id: "t3-confined-to-adapter",
  root: "packages/workflowleaf-runtime/src",
  forbid: [`${T3_PACKAGE}contracts`],
  exemptPrefixes: ["packages/workflowleaf-runtime/src/adapters/t3/"],
  reason: "Only the T3 adapter may know that T3 exists.",
};

describe("import boundaries", () => {
  it("passes real-shaped WorkflowLeaf core files", () => {
    const violations = findImportViolations(
      [coreIsPortable],
      [
        {
          path: "packages/workflowleaf-core/src/controller.ts",
          text: `import * as Schema from "effect/Schema";\nimport type { RunPlan } from "./contracts.ts";\nexport const advance = (plan: RunPlan) => plan;\n`,
        },
      ],
    );

    expect(violations).toEqual([]);
  });

  it("rejects a T3 import in core", () => {
    const violations = findImportViolations(
      [coreIsPortable],
      [
        {
          path: "packages/workflowleaf-core/src/controller.ts",
          text: `import type { ThreadId } from "${T3_PACKAGE}contracts";\n`,
        },
      ],
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.boundaryId).toBe("core-is-portable");
    expect(violations[0]?.line).toBe(1);
  });

  it("rejects a T3 re-export in core, not only a direct import", () => {
    const violations = findImportViolations(
      [coreIsPortable],
      [
        {
          path: "packages/workflowleaf-core/src/index.ts",
          text: `export type { ThreadId } from "${T3_PACKAGE}contracts";\n`,
        },
      ],
    );

    expect(violations).toHaveLength(1);
  });

  it("rejects filesystem access and an ambient clock in core source", () => {
    const violations = findImportViolations(
      [coreIsPortable],
      [
        {
          path: "packages/workflowleaf-core/src/evidence.ts",
          text: `import { readFileSync } from "node:fs";\nexport const stamp = () => Date.now();\n`,
        },
      ],
    );

    expect(violations.map((violation) => violation.offender).sort()).toEqual([
      "Date.now(",
      "node:fs",
    ]);
  });

  it("allows a core test to import the test runner", () => {
    const violations = findImportViolations(
      [coreIsPortable],
      [
        {
          path: "packages/workflowleaf-core/src/controller.test.ts",
          text: `import { describe, it } from "vite-plus/test";\nimport { readFileSync } from "node:fs";\n`,
        },
      ],
    );

    expect(violations).toEqual([]);
  });

  it("confines T3 imports to the adapter directory", () => {
    const violations = findImportViolations(
      [t3Confined],
      [
        {
          path: "packages/workflowleaf-runtime/src/adapters/t3/executor.ts",
          text: `import type { ThreadId } from "${T3_PACKAGE}contracts";\n`,
        },
        {
          path: "packages/workflowleaf-runtime/src/worker.ts",
          text: `import type { ThreadId } from "${T3_PACKAGE}contracts";\n`,
        },
      ],
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("packages/workflowleaf-runtime/src/worker.ts");
  });

  it("catches a dynamic import used to dodge the static rule", () => {
    const violations = findImportViolations(
      [t3Confined],
      [
        {
          path: "packages/workflowleaf-runtime/src/store.ts",
          text: `const mod = await import("${T3_PACKAGE}contracts");\n`,
        },
      ],
    );

    expect(violations).toHaveLength(1);
  });
});

describe("specifier extraction", () => {
  it("reports the line of each specifier", () => {
    const found = extractSpecifiers(`import a from "x";\n\nexport * from "y";\n`);

    expect(found).toEqual([
      { specifier: "x", line: 1 },
      { specifier: "y", line: 3 },
    ]);
  });
});
