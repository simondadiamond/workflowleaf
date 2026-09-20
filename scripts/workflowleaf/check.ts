#!/usr/bin/env node
/**
 * Fork ownership and import-boundary gate.
 *
 * Run from the repository root:
 *   node scripts/workflowleaf/check.ts            # against the recorded upstream base
 *   node scripts/workflowleaf/check.ts --base <rev>
 *
 * Exits non-zero with a report when the fork edits an upstream file that is not
 * listed in ownership.json, or when a WorkflowLeaf package imports across a
 * boundary it is supposed to respect.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findImportViolations, formatImportReport, type SourceFile } from "./imports.ts";
import {
  findOwnershipViolations,
  formatOwnershipReport,
  parseNameStatusZ,
  upstreamEditCount,
  type Change,
  type Ownership,
} from "./ownership.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function loadOwnership(): Ownership {
  return JSON.parse(readFileSync(path.join(here, "ownership.json"), "utf8")) as Ownership;
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Changes relative to the recorded upstream base, including work that is not
 * committed yet. An ownership gate that only sees commits passes right up until
 * the moment someone runs it, which is the moment it matters least.
 */
function collectChanges(base: string): Change[] {
  const tracked = parseNameStatusZ(git(["diff", "--name-status", "-z", base, "--"]));
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry): Change => ({ path: entry, kind: "added" }));

  const seen = new Set<string>();
  return [...tracked, ...untracked].filter((change) => {
    const key = `${change.kind}:${change.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectSources(roots: readonly string[]): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (relative: string): void => {
    const absolute = path.join(repoRoot, relative);
    let entries: string[];
    try {
      entries = readdirSync(absolute);
    } catch {
      return; // A boundary whose package does not exist yet is not a violation.
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const child = `${relative}/${entry}`;
      if (statSync(path.join(repoRoot, child)).isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts|js|mjs)$/.test(entry)) continue;
      files.push({ path: child, text: readFileSync(path.join(repoRoot, child), "utf8") });
    }
  };

  for (const root of roots) walk(root);
  return files;
}

function main(): void {
  const args = process.argv.slice(2);
  const baseFlag = args.indexOf("--base");
  const ownership = loadOwnership();
  const base =
    baseFlag === -1 ? ownership.upstreamBase : (args[baseFlag + 1] ?? ownership.upstreamBase);

  try {
    git(["cat-file", "-e", `${base}^{commit}`]);
  } catch {
    console.error(
      `workflowleaf: upstream base ${base} is not in this repository. Fetch it, or pass --base <rev>.`,
    );
    process.exit(2);
  }

  const changes = collectChanges(base);
  const ownershipViolations = findOwnershipViolations(ownership, changes);
  const sources = collectSources(ownership.importBoundaries.map((boundary) => boundary.root));
  const importViolations = findImportViolations(ownership.importBoundaries, sources);

  console.log(formatOwnershipReport(ownershipViolations));
  console.log(formatImportReport(importViolations));
  console.log(
    `workflowleaf: ${changes.length} changed path(s) since ${base.slice(0, 12)}, ${upstreamEditCount(ownership, changes)} upstream-owned.`,
  );

  if (ownershipViolations.length > 0 || importViolations.length > 0) process.exit(1);
}

main();
