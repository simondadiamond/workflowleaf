/**
 * Pure rules for conformance case C14: T3 keeps working with WorkflowLeaf gone.
 *
 * "Disabled" means deletable. If no upstream workspace manifest depends on a
 * WorkflowLeaf package and no upstream file the fork edits imports one, then
 * removing `packages/workflowleaf-*` leaves a T3 that installs and builds.
 *
 * Upstream *source* files cannot import WorkflowLeaf by another route, because
 * editing one is already an unlisted upstream edit and the ownership rule
 * rejects it. That is why nothing here walks the T3 tree: the check would be
 * slow and would prove something already proven.
 */

import { extractSpecifiers, type SourceFile } from "./imports.ts";
import type { EnablementRule } from "./ownership.ts";

export interface Manifest {
  readonly path: string;
  /** The decoded package.json. Parsing belongs to the caller so this stays pure. */
  readonly manifest: unknown;
}

export interface EnablementViolation {
  readonly path: string;
  readonly rule: "upstream-depends-on-workflowleaf" | "upstream-edit-imports-workflowleaf";
  readonly offender: string;
  readonly message: string;
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** Every package name a manifest declares a dependency on, across all four fields. */
export function dependencyNames(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const record = manifest as Record<string, unknown>;
  const names: string[] = [];

  for (const field of DEPENDENCY_FIELDS) {
    const entry = record[field];
    if (typeof entry !== "object" || entry === null) continue;
    names.push(...Object.keys(entry));
  }

  return names;
}

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Tracked paths whose manifests say nothing about whether T3 builds. */
const UNSCANNED_MANIFEST_PREFIXES = [".repos/", "node_modules/"];

/**
 * Whether a tracked `package.json` is part of this workspace.
 *
 * `.repos/` holds vendored read-only reference checkouts that are never built
 * or imported, so their dependencies cannot affect whether T3 builds without
 * WorkflowLeaf. CI also sparse-checks-out without them, which means they are
 * tracked in git and absent from disk; the caller still needs its own
 * existence guard, since being tracked never guarantees being present.
 */
export function isWorkspaceManifest(path: string): boolean {
  if (!path.endsWith("package.json")) return false;
  return !UNSCANNED_MANIFEST_PREFIXES.some(
    (prefix) => path.startsWith(prefix) || path.includes(`/${prefix}`),
  );
}

/**
 * `manifests` and `upstreamEdits` are the upstream-owned ones only; the caller
 * filters. Non-source allow-listed files are skipped for the import rule,
 * because `pnpm-lock.yaml` names both packages by design and is generated.
 */
export function findEnablementViolations(
  rule: EnablementRule,
  manifests: readonly Manifest[],
  upstreamEdits: readonly SourceFile[],
): EnablementViolation[] {
  const violations: EnablementViolation[] = [];
  const matches = (name: string) => rule.packagePrefixes.some((prefix) => name.startsWith(prefix));

  for (const { path, manifest } of manifests) {
    for (const name of dependencyNames(manifest)) {
      if (!matches(name)) continue;
      violations.push({
        path,
        rule: "upstream-depends-on-workflowleaf",
        offender: name,
        message: rule.reason,
      });
    }
  }

  for (const file of upstreamEdits) {
    if (!SOURCE_EXTENSIONS.test(file.path)) continue;
    for (const { specifier } of extractSpecifiers(file.text)) {
      if (!matches(specifier)) continue;
      violations.push({
        path: file.path,
        rule: "upstream-edit-imports-workflowleaf",
        offender: specifier,
        message: rule.reason,
      });
    }
  }

  return violations;
}

export function formatEnablementReport(violations: readonly EnablementViolation[]): string {
  if (violations.length === 0) return "workflowleaf enablement: clean";
  const lines = violations.map(
    (violation) =>
      `  ${violation.path}  ${violation.offender}  [${violation.rule}]\n      ${violation.message}`,
  );
  return [`workflowleaf enablement: ${violations.length} violation(s)`, ...lines].join("\n");
}
