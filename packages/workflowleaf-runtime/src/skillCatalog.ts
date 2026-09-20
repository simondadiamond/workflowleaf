/**
 * The skill catalog.
 *
 * Metadata first: the catalog reads each skill's name and description and
 * nothing else. Content is hydrated only for the skills a stage actually
 * selected. Copying a whole skill library into a prompt is the cheapest way to
 * make a stage both expensive and worse at its job.
 *
 * A skill is pinned by the digest of its entire directory, instructions and
 * scripts together, so a script edited mid-run cannot silently change what a
 * pinned run executes.
 */
import type { Digest } from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYaml } from "yaml";

import { digestOfTree } from "./digest.ts";

export interface SkillEntry {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly digest: Digest;
  /** Which configured root this came from. Later roots shadow earlier ones. */
  readonly root: string;
}

export interface SkillCatalog {
  readonly byId: ReadonlyMap<string, SkillEntry>;
  readonly roots: readonly string[];
}

/** Parses a SKILL.md frontmatter block. Returns an empty record when there is none. */
export function frontmatterOf(markdown: string): Record<string, unknown> {
  if (!markdown.startsWith("---")) return {};
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return {};
  try {
    const parsed: unknown = parseYaml(markdown.slice(3, end));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const readSkill = Effect.fnUntraced(function* (directory: string, root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillFile = path.join(directory, "SKILL.md");

  if (!(yield* fs.exists(skillFile))) return null;

  const frontmatter = frontmatterOf(yield* fs.readFileString(skillFile));
  const id = typeof frontmatter.name === "string" ? frontmatter.name : path.basename(directory);

  return {
    id,
    path: directory,
    description: typeof frontmatter.description === "string" ? frontmatter.description : "",
    digest: yield* digestOfTree(directory),
    root,
  } satisfies SkillEntry;
});

/**
 * Builds the catalog from the configured roots, in order. A later root shadows
 * an earlier one for the same id, so a project skill can override a personal
 * one without either being edited.
 */
export const loadSkillCatalog = Effect.fnUntraced(function* (roots: readonly string[]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const byId = new Map<string, SkillEntry>();

  for (const root of roots) {
    if (!(yield* fs.exists(root))) continue;
    const info = yield* fs.stat(root);
    if (info.type !== "Directory") continue;

    for (const entry of [...(yield* fs.readDirectory(root))].sort()) {
      const directory = path.join(root, entry);
      const childInfo = yield* fs.stat(directory);
      if (childInfo.type !== "Directory") continue;
      const skill = yield* readSkill(directory, root);
      if (skill !== null) byId.set(skill.id, skill);
    }
  }

  return { byId, roots } satisfies SkillCatalog;
});

export interface SkillResolution {
  readonly resolved: ReadonlyMap<string, { readonly path: string; readonly digest: Digest }>;
  readonly missing: readonly string[];
}

export function resolveSkills(catalog: SkillCatalog, ids: readonly string[]): SkillResolution {
  const resolved = new Map<string, { path: string; digest: Digest }>();
  const missing: string[] = [];

  for (const id of ids) {
    const entry = catalog.byId.get(id);
    if (entry === undefined) {
      missing.push(id);
      continue;
    }
    resolved.set(id, { path: entry.path, digest: entry.digest });
  }

  return { resolved, missing };
}

/**
 * Path-triggered skills for the paths a stage is actually going to touch.
 *
 * Recomputed per stage rather than once per run: which skills a change needs is
 * not knowable until the change has a shape.
 */
export function skillsForPaths(
  rules: readonly { readonly paths: string; readonly load: string }[],
  paths: readonly string[],
): string[] {
  const selected = new Set<string>();

  for (const rule of rules) {
    const matcher = globToRegExp(rule.paths);
    if (paths.some((candidate) => matcher.test(candidate))) selected.add(rule.load);
  }

  return [...selected].sort();
}

/**
 * Supports `*`, `**` and `?`. Deliberately not a full glob implementation: a
 * rule nobody can predict the behaviour of is worse than one that only handles
 * the cases the playbooks actually use.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        if (pattern[index + 1] === "/") index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
