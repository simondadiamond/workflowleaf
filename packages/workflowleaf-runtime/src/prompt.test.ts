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

describe("compileStagePrompt permissions", () => {
  const stageOf = (plan: RunPlan) =>
    plan.stages.find((candidate) => candidate.contract.id === STAGE_A)!;
  const promptWith = (permissions: { commentOnPullRequest: boolean; merge: boolean }) => {
    const plan = twoStagePlan();
    return compileStagePrompt({
      runId: "run-1",
      stage: stageOf(plan),
      plan,
      workspacePath: "/work",
      extraSkills: [],
      correction: null,
      permissions,
    });
  };

  // issue-1598-1: deliver commented on the pull request and opened an issue
  // under a profile that permits neither, because nothing told it.
  it("tells a stage it may not comment or open issues when the profile says so", () => {
    const prompt = promptWith({ commentOnPullRequest: false, merge: false });
    const section = prompt.slice(prompt.indexOf("## What this run may do on GitHub"));

    assert.include(section, "Do not open issues.");
    assert.include(section, "Do not comment on or review any pull request");
    assert.include(section, "Do not merge any pull request.");
    assert.include(section, ".workflowleaf/findings.md");
  });

  it("lets a stage reply on its pull request when the profile permits it", () => {
    const prompt = promptWith({ commentOnPullRequest: true, merge: false });

    assert.include(prompt, "You may comment on this run's pull request");
    assert.notInclude(prompt, "Do not comment on or review any pull request");
    // No flag grants opening issues.
    assert.include(prompt, "Do not open issues.");
  });
});
