/**
 * Content digests.
 *
 * Everything a run depends on is pinned by one of these. They are the reason a
 * verdict can be tied to exact inputs rather than to a timestamp.
 */
import { sha256 } from "@noble/hashes/sha2";
import type { Digest } from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import * as Path from "effect/Path";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

export function digestOf(content: string | Uint8Array): Digest {
  const bytes = typeof content === "string" ? encoder.encode(content) : content;
  return `sha256:${hex(sha256(bytes))}` as Digest;
}

export const digestOfFile = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return digestOf(yield* fs.readFile(file));
});

/**
 * Digest of a whole directory: every file's path and content, in sorted order.
 *
 * A skill is its instructions *and* the scripts it calls. Hashing only
 * `SKILL.md` would let a script change under a pinned run without anything
 * noticing.
 */
export const digestOfTree = Effect.fnUntraced(function* (
  root: string,
  ignore: readonly string[] = ["node_modules", ".git"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ignored = new Set(ignore);
  const parts: Uint8Array[] = [];

  const walk = (directory: string, relative: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      const entries = [...(yield* fs.readDirectory(directory))].sort();
      for (const entry of entries) {
        if (ignored.has(entry)) continue;
        const absolute = path.join(directory, entry);
        const key = relative === "" ? entry : `${relative}/${entry}`;
        const info = yield* fs.stat(absolute);
        if (info.type === "Directory") {
          yield* walk(absolute, key);
          continue;
        }
        parts.push(encoder.encode(`${key}\0`));
        parts.push(yield* fs.readFile(absolute));
        parts.push(encoder.encode("\0"));
      }
    });

  yield* walk(root, "");

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }

  return digestOf(joined);
});
