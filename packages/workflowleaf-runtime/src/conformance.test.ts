import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/**
 * Removes comments and string literals so a provider's name appearing in prose
 * is not mistaken for the controller branching on it.
 */
export function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

const PROVIDERS = ["claude", "codex", "cursor", "opencode", "antigravity", "anthropic", "openai"];

const coreSource = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const here = path.dirname(new URL(import.meta.url).pathname);
  return yield* fs.readFileString(path.join(here, "..", "..", "workflowleaf-core", "src", file));
});

it.layer(NodeServices.layer)("provider neutrality", (it) => {
  // The audit's critical criterion: provider-specific behaviour belongs below
  // the adapter boundary. A branch on a provider name in the controller means
  // the abstraction failed, and the fix is in the adapter, not here.
  for (const file of ["controller.ts", "contracts.ts", "state.ts", "evidence.ts", "compile.ts"]) {
    it.effect(`${file} never names a provider`, () =>
      Effect.gen(function* () {
        const code = codeOnly(yield* coreSource(file)).toLowerCase();
        const found = PROVIDERS.filter((provider) => code.includes(provider));
        assert.deepStrictEqual(found, [], `${file} mentions ${found.join(", ")} in code`);
      }),
    );
  }

  it.effect("the controller does not reach for an ambient clock or the filesystem", () =>
    Effect.gen(function* () {
      const code = codeOnly(yield* coreSource("controller.ts"));
      for (const forbidden of ["Date.now(", "new Date(", "node:fs", "process.env"]) {
        assert.isFalse(code.includes(forbidden), `controller.ts uses ${forbidden}`);
      }
    }),
  );
});

describe("comment stripping", () => {
  it("ignores a provider named in a comment", () => {
    assert.notInclude(codeOnly("// claude is a provider\nconst x = 1;"), "claude");
  });

  it("ignores a provider named in a string", () => {
    assert.notInclude(codeOnly('const label = "codex";'), "codex");
  });

  it("keeps a provider named in real code", () => {
    assert.include(codeOnly("if (provider === claude) {}"), "claude");
  });

  it("does not eat a url inside code", () => {
    assert.include(codeOnly("const a = 1; // https://example.com\nconst b = 2;"), "const b");
  });
});
