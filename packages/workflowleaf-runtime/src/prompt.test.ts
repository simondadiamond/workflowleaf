import { assert, describe, it } from "@effect/vitest";
import type { Digest, RunPlan } from "@t3tools/workflowleaf-core";
import { STAGE_A, twoStagePlan } from "@t3tools/workflowleaf-core/testing";

import { compileStagePrompt } from "./prompt.ts";

function planWithSkills(): RunPlan {
  const base = twoStagePlan();
  return {
    ...base,
    stages: base.stages.map((resolved) =>
      resolved.contract.id !== STAGE_A
        ? resolved
        : {
            ...resolved,
            requiredSkills: [
              { id: "prove-it", path: "/skills/prove-it", digest: "sha256:prove" as Digest },
            ],
          },
    ),
  };
}

function promptFor(plan: RunPlan): string {
  const stage = plan.stages.find((candidate) => candidate.contract.id === STAGE_A)!;
  return compileStagePrompt({
    runId: "run-1",
    stage,
    plan,
    workspacePath: "/work",
    extraSkills: [{ id: "ponytail", path: "/skills/ponytail" }],
    correction: null,
  });
}

describe("compileStagePrompt skills", () => {
  // A stage that reads a skill's file instead of loading it can be handed a
  // truncated skill by its harness's output cap and never notice. The section
  // has to ask for the skill by name first, and offer the path only as the
  // fallback for a harness with no skill tool.
  it("names each skill and asks for the skill tool before it offers a path", () => {
    const prompt = promptFor(planWithSkills());
    const section = prompt.slice(prompt.indexOf("## Skills"));

    assert.include(section, "- `prove-it`");
    assert.include(section, "- `ponytail` (selected from the paths this run has changed)");
    assert.include(section, "skill tool");

    const byName = section.indexOf("- `prove-it`");
    const byPath = section.indexOf("/skills/prove-it/SKILL.md");
    assert.isAbove(byPath, byName);
    assert.isAbove(byPath, section.indexOf("Only if your harness has no skill tool"));
  });
});
