/**
 * The playbook loader.
 *
 * Reads a playbook directory, assembles the raw machine contract, validates it
 * strictly, resolves every file and skill it references, and compiles an
 * immutable run plan. Deterministic: the same source inputs produce the same
 * plan digest, whatever order the filesystem hands entries back in.
 *
 * Layout:
 *
 *   <playbook>/PLAYBOOK.md     YAML frontmatter is the contract, body is for humans
 *   <playbook>/stages/*.md     one instruction file per agent stage
 *   <playbook>/gates/*.yaml    one gate definition per file
 *   <playbook>/checks/*        scripts the playbook's command gates run
 *
 * A command gate names a script the playbook ships as `${playbook}/checks/x.sh`,
 * in its executable or its arguments. The loader resolves that against the
 * playbook directory, so the same playbook runs from wherever it was copied to,
 * and folds the script's content into the gate's digest, so editing the check
 * invalidates the evidence it produced.
 */
import {
  compileRunPlan,
  planDigestInput,
  validatePlaybook,
  type Diagnostic,
  type Digest,
  type PlaybookDocument,
  type ResolvedResources,
  type RunPlan,
  type Validated,
} from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";
import { parse as parseYaml } from "yaml";

import { canonicalJson } from "./canonical.ts";
import { digestOf } from "./digest.ts";
import {
  globToRegExp,
  loadSkillCatalog,
  resolveSkills,
  type SkillCatalog,
} from "./skillCatalog.ts";

export interface LoadOptions {
  readonly playbookDir: string;
  /** Repository the run operates on. Context file patterns resolve against it. */
  readonly repoRoot: string;
  readonly skillRoots: readonly string[];
  readonly inputs: Readonly<Record<string, string>>;
  readonly compiledAt: string;
}

export interface LoadedPlaybook {
  readonly document: PlaybookDocument;
  readonly plan: RunPlan;
  readonly catalog: SkillCatalog;
}

function fail(diagnostics: readonly Diagnostic[]): Validated<never> {
  return { ok: false, diagnostics };
}

/** Splits YAML frontmatter from the human-facing body. Pure, so it is directly testable. */
export function splitFrontmatter(
  markdown: string,
  source: string,
): Validated<{ frontmatter: unknown; body: string }> {
  if (!markdown.startsWith("---")) {
    return fail([
      { source, field: "<document>", message: "PLAYBOOK.md must start with YAML frontmatter." },
    ]);
  }
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) {
    return fail([{ source, field: "<document>", message: "Unterminated YAML frontmatter." }]);
  }

  try {
    return {
      ok: true,
      value: {
        frontmatter: parseYaml(markdown.slice(3, end)) as unknown,
        body: markdown.slice(end + 4),
      },
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return fail([{ source, field: "<frontmatter>", message: `Invalid YAML: ${detail}` }]);
  }
}

/** The prefix a command gate uses for a file shipped inside the playbook. */
export const PLAYBOOK_BASE = "${playbook}/";

function expandPlaybookPath(value: unknown, playbookDir: string): unknown {
  return typeof value === "string" && value.startsWith(PLAYBOOK_BASE)
    ? `${playbookDir.replace(/\/+$/, "")}/${value.slice(PLAYBOOK_BASE.length)}`
    : value;
}

/**
 * Resolves `${playbook}/` in command gates' executables and arguments. Pure:
 * it only rewrites strings, and anything that is not a command gate passes
 * through for validation to judge.
 */
export function expandPlaybookPaths(gates: readonly unknown[], playbookDir: string): unknown[] {
  return gates.map((gate) => {
    if (typeof gate !== "object" || gate === null) return gate;
    const record = gate as Record<string, unknown>;
    if (record.type !== "command") return gate;
    return {
      ...record,
      executable: expandPlaybookPath(record.executable, playbookDir),
      ...(Array.isArray(record.args)
        ? { args: record.args.map((arg) => expandPlaybookPath(arg, playbookDir)) }
        : {}),
    };
  });
}

/** Parses YAML outside an Effect generator so a parse failure is a value, not a throw. */
function parseYamlSafely(text: string, source: string): Validated<unknown> {
  try {
    return { ok: true, value: parseYaml(text) as unknown };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return fail([{ source, field: "<document>", message: `Invalid YAML: ${detail}` }]);
  }
}

const readGateFiles = Effect.fnUntraced(function* (playbookDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gatesDir = path.join(playbookDir, "gates");

  if (!(yield* fs.exists(gatesDir))) return { ok: true, value: [] } satisfies Validated<unknown[]>;

  const diagnostics: Diagnostic[] = [];
  const gates: unknown[] = [];

  for (const entry of [...(yield* fs.readDirectory(gatesDir))].sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const text = yield* fs.readFileString(path.join(gatesDir, entry));
    const parsed = parseYamlSafely(text, `gates/${entry}`);
    if (parsed.ok) gates.push(parsed.value);
    else diagnostics.push(...parsed.diagnostics);
  }

  return (
    diagnostics.length > 0 ? fail(diagnostics) : { ok: true, value: gates }
  ) satisfies Validated<unknown[]>;
});

/**
 * Expands a context pattern against the repository.
 *
 * Literal paths and `**` prefixes only. A pattern language nobody can predict
 * is a worse contract than a short one, and every match ends up pinned by
 * digest anyway.
 */
const expandContextPattern = Effect.fnUntraced(function* (repoRoot: string, pattern: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!pattern.includes("*")) {
    return (yield* fs.exists(path.join(repoRoot, pattern))) ? [pattern] : [];
  }

  const matcher = globToRegExp(pattern);
  const base = pattern.split("*")[0]!.replace(/[^/]*$/, "");
  const root = path.join(repoRoot, base);
  if (!(yield* fs.exists(root))) return [];

  const found: string[] = [];
  const walk = (directory: string, relative: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      for (const entry of [...(yield* fs.readDirectory(directory))].sort()) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const absolute = path.join(directory, entry);
        const key = relative === "" ? entry : `${relative}/${entry}`;
        const info = yield* fs.stat(absolute);
        if (info.type === "Directory") {
          yield* walk(absolute, key);
          continue;
        }
        if (matcher.test(key)) found.push(key);
      }
    });

  yield* walk(root, base.replace(/\/$/, ""));
  return found.sort();
});

interface Resolution {
  readonly resources: ResolvedResources;
  /** Context patterns expanded to concrete paths, per stage id. */
  readonly expandedContext: ReadonlyMap<string, readonly string[]>;
  readonly diagnostics: readonly Diagnostic[];
}

const resolveResources = Effect.fnUntraced(function* (
  document: PlaybookDocument,
  options: LoadOptions,
  catalog: SkillCatalog,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const instructions = new Map<string, { text: string; digest: Digest }>();
  const contextFiles = new Map<string, Digest>();
  const skills = new Map<string, { path: string; digest: Digest }>();
  const gateDigests = new Map<string, Digest>();
  const expandedContext = new Map<string, readonly string[]>();
  const diagnostics: Diagnostic[] = [];

  for (const stage of document.stages) {
    if (stage.instruction !== undefined) {
      const file = path.join(options.playbookDir, stage.instruction);
      if (!(yield* fs.exists(file))) {
        diagnostics.push({
          source: "PLAYBOOK.md",
          field: `stages.${stage.id}.instruction`,
          message: `Instruction file ${stage.instruction} does not exist.`,
        });
      } else {
        const text = yield* fs.readFileString(file);
        instructions.set(stage.id as string, { text, digest: digestOf(text) });
      }
    }

    const expanded = new Set<string>();
    for (const pattern of stage.context.files) {
      const matches = yield* expandContextPattern(options.repoRoot, pattern);
      if (matches.length === 0) {
        diagnostics.push({
          source: "PLAYBOOK.md",
          field: `stages.${stage.id}.context.files`,
          message: `Context pattern ${pattern} matched nothing under ${options.repoRoot}.`,
        });
      }
      for (const match of matches) {
        expanded.add(match);
        if (contextFiles.has(match)) continue;
        contextFiles.set(match, digestOf(yield* fs.readFile(path.join(options.repoRoot, match))));
      }
    }
    // The plan pins concrete paths, so the stage's own pattern list has to be
    // expanded too rather than carried through as globs.
    expandedContext.set(stage.id as string, [...expanded].sort());

    const resolution = resolveSkills(catalog, [...stage.skills.required, ...stage.skills.lazy]);
    for (const [id, entry] of resolution.resolved) skills.set(id, entry);
    for (const id of resolution.missing) {
      // Required skills are reported by compileRunPlan, which fails the compile.
      if (stage.skills.required.includes(id)) continue;
      diagnostics.push({
        source: "PLAYBOOK.md",
        field: `stages.${stage.id}.skills.lazy`,
        message: `Lazy skill ${id} is not installed in any configured root.`,
      });
    }
  }

  for (const gate of document.gates) {
    if (gate.type !== "command") {
      gateDigests.set(gate.id as string, digestOf(canonicalJson(gate)));
      continue;
    }

    // A script the playbook ships is part of what the gate checks. Its content
    // goes into the digest so editing it invalidates what it produced; a
    // missing one fails here, at load, rather than at gate time mid-run.
    const root = `${options.playbookDir.replace(/\/+$/, "")}/`;
    const scripts: { path: string; digest: Digest }[] = [];
    for (const candidate of [gate.executable, ...gate.args]) {
      if (!candidate.startsWith(root)) continue;
      if (!(yield* fs.exists(candidate))) {
        diagnostics.push({
          source: `gates/${gate.id as string}`,
          field: candidate === gate.executable ? "executable" : "args",
          message: `${candidate.slice(root.length)} is not in the playbook directory.`,
        });
        continue;
      }
      scripts.push({
        path: candidate.slice(root.length),
        digest: digestOf(yield* fs.readFile(candidate)),
      });
    }
    gateDigests.set(
      gate.id as string,
      scripts.length === 0
        ? digestOf(canonicalJson(gate))
        : digestOf(canonicalJson({ gate, scripts })),
    );
  }

  return {
    resources: { instructions, contextFiles, skills, gateDigests },
    expandedContext,
    diagnostics,
  } satisfies Resolution;
});

/** The document the plan is compiled from: same contract, concrete context paths. */
function withExpandedContext(
  document: PlaybookDocument,
  expanded: ReadonlyMap<string, readonly string[]>,
): PlaybookDocument {
  return {
    ...document,
    stages: document.stages.map((stage) => ({
      ...stage,
      context: { files: expanded.get(stage.id as string) ?? stage.context.files },
    })),
  };
}

export const loadPlaybook = Effect.fnUntraced(function* (options: LoadOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const playbookFile = path.join(options.playbookDir, "PLAYBOOK.md");

  if (!(yield* fs.exists(playbookFile))) {
    return fail([
      { source: options.playbookDir, field: "<document>", message: "No PLAYBOOK.md here." },
    ]) satisfies Validated<LoadedPlaybook>;
  }

  const split = splitFrontmatter(yield* fs.readFileString(playbookFile), "PLAYBOOK.md");
  if (!split.ok) return split satisfies Validated<LoadedPlaybook>;

  const gateFiles = yield* readGateFiles(options.playbookDir);
  if (!gateFiles.ok) return gateFiles satisfies Validated<LoadedPlaybook>;

  const frontmatter =
    typeof split.value.frontmatter === "object" && split.value.frontmatter !== null
      ? (split.value.frontmatter as Record<string, unknown>)
      : {};

  const inlineGates = Array.isArray(frontmatter.gates) ? frontmatter.gates : [];
  const validated = validatePlaybook(
    {
      ...frontmatter,
      gates: expandPlaybookPaths([...gateFiles.value, ...inlineGates], options.playbookDir),
    },
    "PLAYBOOK.md",
  );
  if (!validated.ok) return validated satisfies Validated<LoadedPlaybook>;

  const catalog = yield* loadSkillCatalog(options.skillRoots);
  const resolution = yield* resolveResources(validated.value, options, catalog);
  if (resolution.diagnostics.length > 0) {
    return fail(resolution.diagnostics) satisfies Validated<LoadedPlaybook>;
  }

  const document = withExpandedContext(validated.value, resolution.expandedContext);
  const planDigest = digestOf(planDigestInput(document, resolution.resources, options.inputs));

  const compiled = compileRunPlan(
    document,
    resolution.resources,
    { planDigest, inputs: options.inputs, compiledAt: options.compiledAt },
    "PLAYBOOK.md",
  );
  if (!compiled.ok) return compiled satisfies Validated<LoadedPlaybook>;

  return {
    ok: true,
    value: { document, plan: compiled.value, catalog },
  } satisfies Validated<LoadedPlaybook>;
});
