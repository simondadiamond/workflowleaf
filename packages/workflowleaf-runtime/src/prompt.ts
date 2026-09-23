/**
 * Compiling a stage's input.
 *
 * What a stage receives is decided here, and it is artifacts and file paths,
 * never the previous stage's transcript. That is the whole point of separate
 * contexts: stage B reads what stage A produced, not how stage A talked itself
 * into producing it.
 *
 * Skills are named rather than pasted in. A stage that needs the testing skill
 * loads it; copying the whole library into every prompt makes the stage more
 * expensive and worse at its job. The name comes first and the path is a
 * fallback, because naming a path is an invitation to `cat` the file, and a
 * `cat` that trips the harness output cap hands the stage a truncated skill
 * that still looks like a skill.
 */
import type { ResolvedStage, RunPlan, StageId } from "@t3tools/workflowleaf-core";

/** Where a stage records what it found and did not fix. Read by the worker after each turn. */
export const FINDINGS_PATH = ".workflowleaf/findings.md";

export interface PromptInput {
  readonly runId: string;
  readonly stage: ResolvedStage;
  readonly plan: RunPlan;
  readonly workspacePath: string;
  /** Path-triggered skills selected from the paths the run has changed. */
  readonly extraSkills: readonly { readonly id: string; readonly path: string }[];
  /** Present only when this is a correction inside an existing context. */
  readonly correction: string | null;
  /** The `gh` config directory this repository needs, when it is not the active account's. */
  readonly ghConfigDir?: string | undefined;
  /** The profile's permissions, which the stage is told and asked to keep. */
  readonly permissions?: StagePermissions | undefined;
}

export interface StagePermissions {
  readonly commentOnPullRequest: boolean;
  readonly merge: boolean;
}

/**
 * What the profile lets the run do on GitHub, as the stage has to hear it.
 *
 * The flags describe what WorkflowLeaf does, but an agent with `gh` can do the
 * same things, and in issue-1598-1 one commented on a pull request and opened an
 * issue under a profile that permits neither. This asks. It cannot enforce:
 * only the provider's approvals stand between an agent and a `gh` call.
 */
function permissionsSection(permissions: StagePermissions): string {
  const rules = [
    "Do not open issues. Put anything you would have filed in `" + FINDINGS_PATH + "`.",
    permissions.commentOnPullRequest
      ? "You may comment on this run's pull request and reply to or resolve its review threads."
      : "Do not comment on or review any pull request, and do not reply to or resolve review threads. That includes scripts that post for you. If your instructions ask for a comment, do the rest and write what you would have posted in `" +
        FINDINGS_PATH +
        "`.",
    ...(permissions.merge ? [] : ["Do not merge any pull request."]),
  ];
  return [
    "## What this run may do on GitHub",
    "",
    "Pushing the run's branch is always allowed. Beyond that, this run's profile says:",
    "",
    ...rules.map((rule) => `- ${rule}`),
  ].join("\n");
}

function describeGate(gate: ResolvedStage["gates"][number]): string {
  const definition = gate.definition;
  switch (definition.type) {
    case "command":
      return `- ${definition.id} (command): \`${definition.executable} ${definition.args.join(" ")}\` must exit ${definition.expect.exitCode}`;
    case "file": {
      const size =
        definition.minBytes === undefined ? "" : `, at least ${definition.minBytes} bytes`;
      const contains =
        definition.mustContain === undefined || definition.mustContain.length === 0
          ? ""
          : `, containing ${definition.mustContain.map((needle) => `"${needle}"`).join(" and ")}`;
      return `- ${definition.id} (file): \`${definition.path}\` must exist${size}${contains}`;
    }
    case "diff":
      return `- ${definition.id} (diff): only these paths may change: ${definition.allowedPaths.join(", ")}`;
    case "review":
      return `- ${definition.id} (review): ${definition.rubric}`;
    case "external":
      return `- ${definition.id} (external): ${definition.check}, bound to the ${definition.boundTo}`;
  }
}

/**
 * The marker a hook or a log reader uses to tell which run and stage a context
 * belongs to without asking the model.
 */
export function stageMarker(runId: string, stageId: StageId): string {
  return `WL-STAGE: ${runId}/${stageId}`;
}

export function compileStagePrompt(input: PromptInput): string {
  const { stage, plan } = input;
  const sections: string[] = [];

  sections.push(stageMarker(input.runId, stage.contract.id));
  sections.push(
    `You are performing the \`${stage.contract.id}\` stage of the \`${plan.playbookId}\` playbook, version ${plan.playbookVersion}.`,
  );
  sections.push(`Work in ${input.workspacePath}. Everything below is relative to it.`);
  if (input.ghConfigDir !== undefined) {
    sections.push(
      `This repository's GitHub account is configured in \`${input.ghConfigDir}\`. Run every \`gh\` command with \`GH_CONFIG_DIR=${input.ghConfigDir}\` set, and never switch the active account.`,
    );
  }

  if (input.permissions !== undefined) {
    sections.push(permissionsSection(input.permissions));
  }

  if (input.correction !== null) {
    sections.push(`## This is a correction\n\n${input.correction}`);
  }

  if (stage.instruction !== null) {
    sections.push(`## What to do\n\n${stage.instruction.text.trim()}`);
  }

  const inputs = Object.entries(plan.inputs)
    .filter(([key]) => stage.contract.consumes.includes(key))
    .map(([key, value]) => `- ${key}: ${value}`);
  const artifacts = stage.contract.consumes
    .filter((name) => plan.inputs[name] === undefined)
    .map((name) => `- \`${name}\``);

  if (inputs.length > 0 || artifacts.length > 0) {
    sections.push(
      [
        "## What you are given",
        ...(inputs.length > 0 ? ["", "Run inputs:", ...inputs] : []),
        ...(artifacts.length > 0
          ? ["", "Artifacts produced by earlier stages, already in the worktree:", ...artifacts]
          : []),
      ].join("\n"),
    );
  }

  if (stage.contextFiles.length > 0) {
    sections.push(
      ["## Context to read", "", ...stage.contextFiles.map((file) => `- \`${file.path}\``)].join(
        "\n",
      ),
    );
  }

  const skills = [
    ...stage.requiredSkills.map((skill) => ({ id: skill.id, path: skill.path, required: true })),
    ...input.extraSkills.map((skill) => ({ ...skill, required: false })),
  ];
  if (skills.length > 0) {
    sections.push(
      [
        "## Skills",
        "",
        "Load each of these by name, with your harness's skill tool, before you start.",
        "In Claude Code that is `Skill(<name>)`. They are instructions for this repository,",
        "not suggestions.",
        "",
        ...skills.map(
          (skill) =>
            `- \`${skill.id}\`${skill.required ? "" : " (selected from the paths this run has changed)"}`,
        ),
        "",
        "Do not open a skill's file instead. The skill tool gives you the whole skill, while",
        "a `cat` or a `Read` can be silently truncated, and a truncated skill is worse than no",
        "skill. Only if your harness has no skill tool, read these files, one per command, and",
        "confirm you got the whole file before you use it:",
        "",
        ...skills.map((skill) => `- ${skill.id}: \`${skill.path}/SKILL.md\``),
      ].join("\n"),
    );
  }

  if (stage.contract.produces.length > 0) {
    sections.push(
      [
        "## What you must produce",
        "",
        ...stage.contract.produces.map((name) => `- \`${name}\``),
      ].join("\n"),
    );
  }

  sections.push(
    [
      "## Found, not fixed",
      "",
      `If you notice a problem you are not fixing in this stage, such as a broken check, a`,
      `bug outside your task, or a nit you left alone, append it to \`${FINDINGS_PATH}\`, one`,
      "short paragraph each with the file it concerns. Your closing message reaches only this",
      "thread; that file reaches whoever runs the work. Do not open an issue for it instead.",
    ].join("\n"),
  );

  if (stage.gates.length > 0) {
    sections.push(
      [
        "## How this stage is checked",
        "",
        "These run after you stop, outside your context. Their result is what advances the run;",
        "saying the work is done does not.",
        "",
        ...stage.gates.map(describeGate),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}
