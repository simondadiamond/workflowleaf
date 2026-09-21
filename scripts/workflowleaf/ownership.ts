/**
 * Pure fork-ownership rules.
 *
 * The fork stays upstream-friendly only if every change is either (a) a new
 * file under a WorkflowLeaf-owned prefix or (b) an upstream file listed, with a
 * reason, in `allowedUpstreamEdits`. Everything here is pure so the rules can be
 * tested against fixture change sets without a git repository; `check-ownership.ts`
 * supplies the real ones.
 */

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
  readonly path: string;
  readonly kind: ChangeKind;
}

export interface AllowedUpstreamEdit {
  readonly path: string;
  readonly purpose: string;
  readonly removeWhen: string;
}

export interface ImportBoundary {
  readonly id: string;
  readonly root: string;
  readonly forbid?: readonly string[];
  readonly forbidInSource?: readonly string[];
  readonly forbidSymbolsInSource?: readonly string[];
  readonly exemptPrefixes?: readonly string[];
  /** Exact specifiers permitted despite matching a forbidden prefix. */
  readonly allowSpecifiers?: readonly string[];
  readonly reason: string;
}

export interface Ownership {
  readonly upstreamBase: string;
  readonly ownedPrefixes: readonly string[];
  readonly ownedFiles: readonly string[];
  readonly allowedUpstreamEdits: readonly AllowedUpstreamEdit[];
  readonly importBoundaries: readonly ImportBoundary[];
}

export interface OwnershipViolation {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly rule: "unowned-addition" | "unlisted-upstream-edit";
  readonly message: string;
}

export function isOwned(ownership: Ownership, path: string): boolean {
  if (ownership.ownedFiles.includes(path)) return true;
  return ownership.ownedPrefixes.some((prefix) => path.startsWith(prefix));
}

function isAllowedUpstreamEdit(ownership: Ownership, path: string): boolean {
  return ownership.allowedUpstreamEdits.some((entry) => entry.path === path);
}

/**
 * Classifies a change set against the ownership record.
 *
 * An addition outside every owned prefix counts as a violation even though it
 * touches no upstream line: new files in upstream directories are exactly how a
 * fork stops being additive without anyone noticing.
 */
export function findOwnershipViolations(
  ownership: Ownership,
  changes: readonly Change[],
): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];

  for (const change of changes) {
    if (isOwned(ownership, change.path)) continue;
    if (isAllowedUpstreamEdit(ownership, change.path)) continue;

    violations.push(
      change.kind === "added"
        ? {
            path: change.path,
            kind: change.kind,
            rule: "unowned-addition",
            message: `New file outside every WorkflowLeaf-owned prefix. Add it under an owned prefix, or record it in allowedUpstreamEdits with a purpose and a removal condition.`,
          }
        : {
            path: change.path,
            kind: change.kind,
            rule: "unlisted-upstream-edit",
            message: `Upstream-owned file ${change.kind} without an entry in allowedUpstreamEdits.`,
          },
    );
  }

  return violations;
}

/** Upstream files the fork currently edits, for the merge runbook's patch-size metric. */
export function upstreamEditCount(ownership: Ownership, changes: readonly Change[]): number {
  return changes.filter((change) => !isOwned(ownership, change.path)).length;
}

const STATUS_KINDS: Record<string, ChangeKind> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "modified",
  C: "added",
  T: "modified",
};

/**
 * Parses `git diff --name-status -z` output.
 *
 * NUL separation is not optional here: T3 has paths with spaces, and a
 * line-based parser silently truncates them into paths that look owned.
 */
export function parseNameStatusZ(payload: string): Change[] {
  const fields = payload.split("\0").filter((field) => field.length > 0);
  const changes: Change[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index]!;
    const code = status[0]!;
    const kind = STATUS_KINDS[code];

    if (kind === undefined) {
      index += 1;
      continue;
    }

    // Rename and copy statuses carry two paths; the destination is what exists now.
    if (code === "R" || code === "C") {
      const source = fields[index + 1];
      const destination = fields[index + 2];
      if (source !== undefined) changes.push({ path: source, kind: "deleted" });
      if (destination !== undefined) changes.push({ path: destination, kind: "added" });
      index += 3;
      continue;
    }

    const path = fields[index + 1];
    if (path !== undefined) changes.push({ path, kind });
    index += 2;
  }

  return changes;
}

export function formatOwnershipReport(violations: readonly OwnershipViolation[]): string {
  if (violations.length === 0) return "workflowleaf ownership: clean";
  const lines = violations.map(
    (violation) => `  ${violation.kind.padEnd(8)} ${violation.path}\n      ${violation.message}`,
  );
  return [`workflowleaf ownership: ${violations.length} violation(s)`, ...lines].join("\n");
}
