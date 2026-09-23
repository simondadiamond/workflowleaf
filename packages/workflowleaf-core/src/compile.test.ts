import { describe, expect, it } from "vite-plus/test";

import {
  compileRunPlan,
  planDigestInput,
  validatePlaybook,
  type ResolvedResources,
} from "./compile.ts";
import type { Digest } from "./ids.ts";

const digest = (value: string) => value as Digest;

function rawStage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "produce",
    kind: "agent",
    instruction: "stages/produce.md",
    consumes: ["topic"],
    produces: ["artifact.md"],
    context: { files: [] },
    skills: { required: [], lazy: [], lazyRules: [] },
    gates: ["artifact-has-content"],
    correction: { mode: "same-context", maxAttempts: 3, onLostContext: "fresh-with-evidence" },
    budgets: { attempts: 3 },
    requiresCapabilities: ["fresh-context"],
    ...overrides,
  };
}

function rawDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "synthetic",
    name: "Synthetic",
    version: "0.1",
    outcome: "summary",
    inputs: ["topic"],
    stages: [
      rawStage(),
      rawStage({
        id: "summarize",
        instruction: "stages/summarize.md",
        consumes: ["artifact.md"],
        produces: ["summary.md"],
        gates: ["summary-has-content"],
      }),
    ],
    gates: [
      {
        id: "artifact-has-content",
        type: "file",
        path: "artifact.md",
        mustExist: true,
        minBytes: 8,
      },
      { id: "summary-has-content", type: "file", path: "summary.md", mustExist: true, minBytes: 4 },
    ],
    policy: { humanRequired: ["merge"] },
    ...overrides,
  };
}

function mustValidate(raw: unknown) {
  const result = validatePlaybook(raw, "PLAYBOOK.md");
  if (!result.ok) throw new Error(result.diagnostics.map((one) => one.message).join("; "));
  return result.value;
}

function expectDiagnostics(result: ReturnType<typeof validatePlaybook>) {
  if (result.ok) throw new Error("expected validation to fail");
  return result.diagnostics;
}

describe("playbook validation", () => {
  it("accepts a well-formed playbook", () => {
    const result = validatePlaybook(rawDocument(), "PLAYBOOK.md");
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    const diagnostics = expectDiagnostics(
      validatePlaybook(rawDocument({ retryStrategy: "aggressive" }), "PLAYBOOK.md"),
    );
    expect(diagnostics[0]?.source).toBe("PLAYBOOK.md");
  });

  it("rejects an unquoted version that YAML would read as a number", () => {
    const diagnostics = expectDiagnostics(
      validatePlaybook(rawDocument({ version: 0.1 }), "PLAYBOOK.md"),
    );
    expect(diagnostics).toHaveLength(1);
  });

  it("rejects a future schema version", () => {
    const diagnostics = expectDiagnostics(
      validatePlaybook(rawDocument({ schemaVersion: 2 }), "PLAYBOOK.md"),
    );
    expect(diagnostics).toHaveLength(1);
  });

  it("names the field for a duplicate stage id", () => {
    const document = rawDocument({ stages: [rawStage(), rawStage()] });
    const diagnostics = expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md"));
    expect(diagnostics.some((one) => one.message.includes("Duplicate stage id produce"))).toBe(
      true,
    );
  });

  it("rejects a path rule that loads a skill the stage never pinned", () => {
    const withRule = (lazy: string[]) =>
      rawDocument({
        stages: [
          rawStage({
            skills: { required: [], lazy, lazyRules: [{ paths: "db/**", load: "migrations" }] },
          }),
        ],
      });

    const diagnostics = expectDiagnostics(validatePlaybook(withRule([]), "PLAYBOOK.md"));
    expect(diagnostics.map((one) => one.field)).toEqual(["stages[0].skills.lazyRules[0].load"]);
    expect(validatePlaybook(withRule(["migrations"]), "PLAYBOOK.md").ok).toBe(true);
  });

  it("rejects a gate reference that resolves to nothing", () => {
    const document = rawDocument({
      stages: [
        rawStage({ gates: ["does-not-exist"] }),
        rawStage({
          id: "summarize",
          consumes: ["artifact.md"],
          produces: ["summary.md"],
          gates: ["summary-has-content"],
        }),
      ],
    });
    const diagnostics = expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md"));
    expect(diagnostics.some((one) => one.field === "stages[0].gates")).toBe(true);
  });

  it("rejects a correction route that points forwards", () => {
    const document = rawDocument({
      stages: [
        rawStage({ correction: { mode: "route-to", stage: "summarize", maxCycles: 2 } }),
        rawStage({
          id: "summarize",
          consumes: ["artifact.md"],
          produces: ["summary.md"],
          gates: ["summary-has-content"],
        }),
      ],
    });
    const diagnostics = expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md"));
    expect(diagnostics.some((one) => one.message.includes("A correction goes backwards"))).toBe(
      true,
    );
  });

  it("rejects a path that leaves the worktree", () => {
    const document = rawDocument({
      gates: [
        { id: "artifact-has-content", type: "file", path: "../../etc/passwd", mustExist: true },
        { id: "summary-has-content", type: "file", path: "summary.md", mustExist: true },
      ],
    });
    const diagnostics = expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md"));
    expect(diagnostics.some((one) => one.message.includes("leaves the run worktree"))).toBe(true);
  });

  it("rejects an absolute path", () => {
    const document = rawDocument({
      gates: [
        { id: "artifact-has-content", type: "file", path: "/tmp/out.md", mustExist: true },
        { id: "summary-has-content", type: "file", path: "summary.md", mustExist: true },
      ],
    });
    expect(expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md")).length).toBeGreaterThan(0);
  });

  it("rejects consuming an artifact nothing produces", () => {
    const document = rawDocument({
      stages: [
        rawStage({ consumes: ["nowhere.md"] }),
        rawStage({
          id: "summarize",
          consumes: ["artifact.md"],
          produces: ["summary.md"],
          gates: ["summary-has-content"],
        }),
      ],
    });
    const diagnostics = expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md"));
    expect(
      diagnostics.some((one) => one.message.includes("Nothing earlier produces nowhere.md")),
    ).toBe(true);
  });

  it("rejects an agent stage with no instruction", () => {
    const stage = rawStage();
    delete stage.instruction;
    const document = rawDocument({
      stages: [
        stage,
        rawStage({
          id: "summarize",
          consumes: ["artifact.md"],
          produces: ["summary.md"],
          gates: ["summary-has-content"],
        }),
      ],
    });
    const diagnostics = expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md"));
    expect(diagnostics.some((one) => one.field === "stages[0].instruction")).toBe(true);
  });

  it("rejects a check stage that carries an instruction for a model", () => {
    const document = rawDocument({
      stages: [
        rawStage({ kind: "check" }),
        rawStage({
          id: "summarize",
          consumes: ["artifact.md"],
          produces: ["summary.md"],
          gates: ["summary-has-content"],
        }),
      ],
    });
    const diagnostics = expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md"));
    expect(diagnostics.some((one) => one.message.includes("no instruction for a model"))).toBe(
      true,
    );
  });

  it("rejects a stage budget below its own correction budget", () => {
    const document = rawDocument({
      stages: [
        rawStage({ budgets: { attempts: 1 } }),
        rawStage({
          id: "summarize",
          consumes: ["artifact.md"],
          produces: ["summary.md"],
          gates: ["summary-has-content"],
        }),
      ],
    });
    const diagnostics = expectDiagnostics(validatePlaybook(document, "PLAYBOOK.md"));
    expect(diagnostics.some((one) => one.field === "stages[0].budgets.attempts")).toBe(true);
  });
});

function resources(overrides: Partial<ResolvedResources> = {}): ResolvedResources {
  return {
    instructions: new Map([
      ["produce", { text: "Produce it.", digest: digest("d-produce") }],
      ["summarize", { text: "Summarize it.", digest: digest("d-summarize") }],
    ]),
    contextFiles: new Map(),
    skills: new Map([["testing", { path: "/skills/testing", digest: digest("d-testing") }]]),
    gateDigests: new Map([
      ["artifact-has-content", digest("d-gate-a")],
      ["summary-has-content", digest("d-gate-b")],
    ]),
    ...overrides,
  };
}

describe("compilation", () => {
  const document = mustValidate(rawDocument());

  it("pins instructions and gates by digest", () => {
    const compiled = compileRunPlan(
      document,
      resources(),
      {
        planDigest: digest("plan-1"),
        inputs: { topic: "x" },
        compiledAt: "2026-01-01T00:00:00.000Z",
      },
      "PLAYBOOK.md",
    );

    if (!compiled.ok) throw new Error(compiled.diagnostics.map((one) => one.message).join("; "));
    expect(compiled.value.stages[0]?.instruction?.digest).toBe("d-produce");
    expect(compiled.value.stages[0]?.gates[0]?.digest).toBe("d-gate-a");
    expect(compiled.value.planDigest).toBe("plan-1");
  });

  it("fails before dispatch when a required skill is missing", () => {
    const withSkill = {
      ...document,
      stages: document.stages.map((stage, index) =>
        index === 0
          ? { ...stage, skills: { ...stage.skills, required: ["database-migrations"] } }
          : stage,
      ),
    };

    const compiled = compileRunPlan(
      withSkill,
      resources(),
      {
        planDigest: digest("plan-1"),
        inputs: { topic: "x" },
        compiledAt: "2026-01-01T00:00:00.000Z",
      },
      "PLAYBOOK.md",
    );

    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.diagnostics[0]?.message).toContain("database-migrations");
  });

  it("fails when a declared run input was not supplied", () => {
    const compiled = compileRunPlan(
      document,
      resources(),
      { planDigest: digest("plan-1"), inputs: {}, compiledAt: "2026-01-01T00:00:00.000Z" },
      "PLAYBOOK.md",
    );

    expect(compiled.ok).toBe(false);
  });
});

describe("plan digest input", () => {
  it("is stable across map insertion order", () => {
    const forward = planDigestInput(mustValidate(rawDocument()), resources(), {
      topic: "x",
      other: "y",
    });
    const reversed = planDigestInput(
      mustValidate(rawDocument()),
      resources({
        gateDigests: new Map([
          ["summary-has-content", digest("d-gate-b")],
          ["artifact-has-content", digest("d-gate-a")],
        ]),
      }),
      { other: "y", topic: "x" },
    );

    expect(forward).toBe(reversed);
  });

  it("changes when an instruction changes", () => {
    const document = mustValidate(rawDocument());
    const before = planDigestInput(document, resources(), { topic: "x" });
    const after = planDigestInput(
      document,
      resources({
        instructions: new Map([
          ["produce", { text: "Produce it differently.", digest: digest("d-produce-2") }],
          ["summarize", { text: "Summarize it.", digest: digest("d-summarize") }],
        ]),
      }),
      { topic: "x" },
    );

    expect(before).not.toBe(after);
  });
});
