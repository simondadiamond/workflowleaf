/**
 * Playbook validation and compilation.
 *
 * Validation is strict and the diagnostics name a file and a field, because the
 * alternative is asking a model to guess what a malformed contract meant. A
 * contract that constrains a model cannot itself be repaired by one.
 *
 * Compilation is a pure transformation: the caller resolves files, skills and
 * digests from disk and hands them in. Nothing here reads anything.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  PlaybookDocument,
  SCHEMA_VERSION,
  type GateDefinition,
  type PlaybookDocument as PlaybookDocumentType,
  type ResolvedSkill,
  type ResolvedStage,
  type RunPlan,
  type StageContract,
} from "./contracts.ts";
import type { Digest, Instant, StageId } from "./ids.ts";

export interface Diagnostic {
  /** The file the problem is in, so the reader does not have to search for it. */
  readonly source: string;
  /** Dotted path to the offending field, e.g. `stages[1].correction.stage`. */
  readonly field: string;
  readonly message: string;
}

export type Validated<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
    };

const ok = <A>(value: A): Validated<A> => ({ ok: true, value });
const fail = <A>(diagnostics: readonly Diagnostic[]): Validated<A> => ({ ok: false, diagnostics });

const decodePlaybook = Schema.decodeUnknownResult(PlaybookDocument, {
  onExcessProperty: "error",
  errors: "all",
});

/**
 * A path is usable only if it stays inside the worktree. Rejecting `..` and
 * absolute paths here means no later stage has to wonder whether a gate can
 * read outside the run.
 */
function pathEscapes(value: string): boolean {
  if (value.length === 0) return true;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return true;
  return value.split(/[\\/]/).some((segment) => segment === "..");
}

function gatePaths(gate: GateDefinition): string[] {
  switch (gate.type) {
    case "command":
      return gate.cwd === undefined ? [] : [gate.cwd];
    case "file":
      return [gate.path];
    case "diff":
      return [...gate.allowedPaths];
    default:
      return [];
  }
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

/**
 * Checks the rules a schema cannot express: references that resolve, routes
 * that point backwards, artifacts that something actually produces, stage kinds
 * that carry the right parts.
 */
function semanticDiagnostics(document: PlaybookDocumentType, source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const at = (field: string, message: string) => diagnostics.push({ source, field, message });

  for (const id of duplicates(document.stages.map((stage) => stage.id))) {
    at("stages", `Duplicate stage id ${id}.`);
  }
  for (const id of duplicates(document.gates.map((gate) => gate.id))) {
    at("gates", `Duplicate gate id ${id}.`);
  }

  const gateById = new Map(document.gates.map((gate) => [gate.id as string, gate]));
  const stageIndex = new Map(document.stages.map((stage, index) => [stage.id as string, index]));

  for (const gate of document.gates) {
    for (const path of gatePaths(gate)) {
      if (pathEscapes(path)) {
        at(`gates.${gate.id}`, `Path ${path} leaves the run worktree.`);
      }
    }
  }

  const produced = new Set<string>(document.inputs);

  document.stages.forEach((stage, index) => {
    const field = `stages[${index}]`;

    for (const gateId of stage.gates) {
      if (!gateById.has(gateId as string)) {
        at(`${field}.gates`, `Gate ${gateId} is not defined.`);
      }
    }

    if (stage.instruction !== undefined && pathEscapes(stage.instruction)) {
      at(`${field}.instruction`, `Path ${stage.instruction} leaves the playbook directory.`);
    }
    for (const file of stage.context.files) {
      if (pathEscapes(file)) at(`${field}.context.files`, `Path ${file} leaves the run worktree.`);
    }

    for (const artifact of stage.consumes) {
      if (!produced.has(artifact)) {
        at(`${field}.consumes`, `Nothing earlier produces ${artifact}, and it is not a run input.`);
      }
    }
    for (const artifact of stage.produces) produced.add(artifact);

    if (stage.kind === "agent" && stage.instruction === undefined) {
      at(`${field}.instruction`, "An agent stage needs an instruction file.");
    }
    if (stage.kind === "check" && stage.instruction !== undefined) {
      at(
        `${field}.instruction`,
        "A check stage runs deterministic code; it has no instruction for a model.",
      );
    }
    if (stage.kind === "check") {
      const deterministic = stage.gates.filter((gateId) => {
        const gate = gateById.get(gateId as string);
        return (
          gate !== undefined &&
          (gate.type === "command" || gate.type === "file" || gate.type === "diff")
        );
      });
      if (deterministic.length === 0) {
        at(`${field}.gates`, "A check stage needs at least one command, file or diff gate.");
      }
    }
    if (stage.kind === "decision" && stage.gates.length > 0) {
      at(`${field}.gates`, "A decision stage is answered by a human, not by a gate.");
    }

    if (stage.correction.mode === "route-to") {
      const target = stageIndex.get(stage.correction.stage as string);
      if (target === undefined) {
        at(`${field}.correction.stage`, `Route target ${stage.correction.stage} is not a stage.`);
      } else if (target >= index) {
        at(
          `${field}.correction.stage`,
          `Route target ${stage.correction.stage} is not earlier than ${stage.id}. A correction goes backwards.`,
        );
      }
    }

    if (
      stage.correction.mode === "same-context" &&
      stage.budgets.attempts < stage.correction.maxAttempts
    ) {
      at(
        `${field}.budgets.attempts`,
        `Stage budget ${stage.budgets.attempts} is below its correction budget ${stage.correction.maxAttempts}.`,
      );
    }
  });

  if (document.stages.length === 0) at("stages", "A playbook needs at least one stage.");

  return diagnostics;
}

/** Validates a parsed playbook document. `source` is the file it came from. */
export function validatePlaybook(raw: unknown, source: string): Validated<PlaybookDocumentType> {
  const decoded = decodePlaybook(raw);

  if (Result.isFailure(decoded)) {
    return fail([{ source, field: "<document>", message: decoded.failure.message }]);
  }

  const diagnostics = semanticDiagnostics(decoded.success, source);
  return diagnostics.length === 0 ? ok(decoded.success) : fail(diagnostics);
}

// ---------------------------------------------------------------- compilation

export interface ResolvedResources {
  /** Instruction text and digest, keyed by stage id. */
  readonly instructions: ReadonlyMap<string, { readonly text: string; readonly digest: Digest }>;
  /** Digest per context file path. */
  readonly contextFiles: ReadonlyMap<string, Digest>;
  /** Resolved skill location and digest, keyed by skill id. */
  readonly skills: ReadonlyMap<string, { readonly path: string; readonly digest: Digest }>;
  /** Digest per gate definition, so an edited gate forces a replan. */
  readonly gateDigests: ReadonlyMap<string, Digest>;
}

export interface CompileOptions {
  readonly planDigest: Digest;
  readonly inputs: Readonly<Record<string, string>>;
  readonly compiledAt: Instant;
}

function resolveSkills(
  ids: readonly string[],
  resources: ResolvedResources,
  source: string,
  field: string,
  diagnostics: Diagnostic[],
): ResolvedSkill[] {
  const resolved: ResolvedSkill[] = [];
  for (const id of ids) {
    const skill = resources.skills.get(id);
    if (skill === undefined) {
      diagnostics.push({
        source,
        field,
        message: `Skill ${id} is not installed in any configured skill root.`,
      });
      continue;
    }
    resolved.push({ id, path: skill.path, digest: skill.digest });
  }
  return resolved;
}

function compileStage(
  stage: StageContract,
  document: PlaybookDocumentType,
  resources: ResolvedResources,
  source: string,
  index: number,
  diagnostics: Diagnostic[],
): ResolvedStage {
  const field = `stages[${index}]`;
  const gateById = new Map(document.gates.map((gate) => [gate.id as string, gate]));

  let instruction: ResolvedStage["instruction"] = null;
  if (stage.instruction !== undefined) {
    const found = resources.instructions.get(stage.id as string);
    if (found === undefined) {
      diagnostics.push({
        source,
        field: `${field}.instruction`,
        message: `Instruction file ${stage.instruction} was not resolved.`,
      });
    } else {
      instruction = found;
    }
  }

  const contextFiles = stage.context.files.flatMap((path) => {
    const digest = resources.contextFiles.get(path);
    if (digest === undefined) {
      diagnostics.push({
        source,
        field: `${field}.context.files`,
        message: `Context file ${path} was not resolved.`,
      });
      return [];
    }
    return [{ path, digest }];
  });

  const gates = stage.gates.flatMap((gateId) => {
    const definition = gateById.get(gateId as string);
    const digest = resources.gateDigests.get(gateId as string);
    if (definition === undefined || digest === undefined) {
      diagnostics.push({
        source,
        field: `${field}.gates`,
        message: `Gate ${gateId} could not be pinned.`,
      });
      return [];
    }
    return [{ definition, digest }];
  });

  return {
    contract: stage,
    instruction,
    contextFiles,
    requiredSkills: resolveSkills(
      stage.skills.required,
      resources,
      source,
      `${field}.skills.required`,
      diagnostics,
    ),
    lazySkills: resolveSkills(
      stage.skills.lazy,
      resources,
      source,
      `${field}.skills.lazy`,
      diagnostics,
    ),
    gates,
  };
}

/**
 * Compiles a validated playbook into the immutable plan a run executes.
 *
 * Missing required skills fail here rather than at dispatch: a stage that
 * discovers halfway through that it is missing its testing skill has already
 * spent the tokens.
 */
export function compileRunPlan(
  document: PlaybookDocumentType,
  resources: ResolvedResources,
  options: CompileOptions,
  source: string,
): Validated<RunPlan> {
  const diagnostics: Diagnostic[] = [];

  for (const input of document.inputs) {
    if (options.inputs[input] === undefined) {
      diagnostics.push({
        source,
        field: "inputs",
        message: `Run input ${input} was not supplied.`,
      });
    }
  }

  const stages = document.stages.map((stage, index) =>
    compileStage(stage, document, resources, source, index, diagnostics),
  );

  if (diagnostics.length > 0) return fail(diagnostics);

  return ok({
    schemaVersion: SCHEMA_VERSION,
    planDigest: options.planDigest,
    playbookId: document.id,
    playbookVersion: document.version,
    outcome: document.outcome,
    inputs: options.inputs,
    stages,
    policy: document.policy,
    compiledAt: options.compiledAt,
  });
}

/**
 * Everything the plan depends on by content, in a stable order. The runtime
 * hashes this to get `planDigest`; identical source inputs must produce an
 * identical string, so nothing here may depend on map iteration order.
 */
export function planDigestInput(
  document: PlaybookDocumentType,
  resources: ResolvedResources,
  inputs: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [
    `schemaVersion=${document.schemaVersion}`,
    `playbook=${document.id}@${document.version}`,
  ];

  for (const key of Object.keys(inputs).sort()) parts.push(`input:${key}=${inputs[key]}`);

  for (const stage of document.stages) {
    parts.push(`stage:${stage.id}:kind=${stage.kind}`);
    const instruction = resources.instructions.get(stage.id as string);
    if (instruction !== undefined)
      parts.push(`stage:${stage.id}:instruction=${instruction.digest}`);
    for (const path of [...stage.context.files].sort()) {
      parts.push(
        `stage:${stage.id}:context:${path}=${resources.contextFiles.get(path) ?? "missing"}`,
      );
    }
    for (const skillId of [...stage.skills.required].sort()) {
      parts.push(
        `stage:${stage.id}:skill:${skillId}=${resources.skills.get(skillId)?.digest ?? "missing"}`,
      );
    }
    for (const gateId of [...stage.gates].sort()) {
      parts.push(
        `stage:${stage.id}:gate:${gateId}=${resources.gateDigests.get(gateId as string) ?? "missing"}`,
      );
    }
  }

  return parts.join("\n");
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map((one) => `${one.source}: ${one.field}: ${one.message}`).join("\n");
}

export function stageOrder(document: PlaybookDocumentType): StageId[] {
  return document.stages.map((stage) => stage.id);
}
