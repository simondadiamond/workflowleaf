import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { loadPlaybook, splitFrontmatter, type LoadOptions } from "./load.ts";

const fixtures = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  return path.join(path.dirname(new URL(import.meta.url).pathname), "..", "test", "fixtures");
});

const options = Effect.fnUntraced(function* (overrides: Partial<LoadOptions> = {}) {
  const path = yield* Path.Path;
  const root = yield* fixtures();
  return {
    playbookDir: path.join(root, "playbooks", "two-stage"),
    repoRoot: path.join(root, "repo"),
    skillRoots: [path.join(root, "skills")],
    inputs: { topic: "a made-up topic" },
    compiledAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } satisfies LoadOptions;
});

/** A scoped, writable copy of the fixture playbook. */
const playbookCopy = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temp = yield* fs.makeTempDirectoryScoped();
  const target = path.join(temp, "two-stage");
  yield* fs.copy(path.join(yield* fixtures(), "playbooks", "two-stage"), target);
  return target;
});

const expectLoaded = Effect.fnUntraced(function* (overrides: Partial<LoadOptions> = {}) {
  const loaded = yield* loadPlaybook(yield* options(overrides));
  if (!loaded.ok) {
    return yield* Effect.die(loaded.diagnostics.map((one) => one.message).join("; "));
  }
  return loaded.value;
});

const expectDiagnostics = Effect.fnUntraced(function* (overrides: Partial<LoadOptions> = {}) {
  const loaded = yield* loadPlaybook(yield* options(overrides));
  if (loaded.ok) return yield* Effect.die("expected the load to fail");
  return loaded.diagnostics;
});

it.layer(NodeServices.layer)("loading a playbook", (it) => {
  it.effect("compiles the fixture into a run plan", () =>
    Effect.gen(function* () {
      const loaded = yield* expectLoaded();

      assert.strictEqual(loaded.plan.playbookId, "synthetic-two-stage");
      assert.lengthOf(loaded.plan.stages, 2);
      assert.include(loaded.plan.stages[0]?.instruction?.text ?? "", "artifact.md");
    }),
  );

  it.effect("merges gate files into the contract", () =>
    Effect.gen(function* () {
      const loaded = yield* expectLoaded();
      assert.deepStrictEqual(
        loaded.document.gates.map((gate) => gate.id as string),
        ["artifact-has-content", "summary-has-content"],
      );
    }),
  );

  it.effect("expands a context glob into concrete pinned paths", () =>
    Effect.gen(function* () {
      const loaded = yield* expectLoaded();
      const summarize = loaded.plan.stages[1]!;

      assert.deepStrictEqual(
        summarize.contextFiles.map((file) => file.path),
        ["docs/architecture.md"],
      );
      assert.match(summarize.contextFiles[0]?.digest ?? "", /^sha256:/);
    }),
  );

  it.effect("pins the required skill by the digest of its whole directory", () =>
    Effect.gen(function* () {
      const loaded = yield* expectLoaded();
      const produce = loaded.plan.stages[0]!;

      assert.deepStrictEqual(
        produce.requiredSkills.map((skill) => skill.id),
        ["made-up-testing"],
      );
      assert.match(produce.requiredSkills[0]?.digest ?? "", /^sha256:/);
    }),
  );

  it.effect("produces the same plan digest for the same inputs", () =>
    Effect.gen(function* () {
      const first = yield* expectLoaded();
      const second = yield* expectLoaded();
      assert.strictEqual(first.plan.planDigest, second.plan.planDigest);
    }),
  );

  it.effect("changes the plan digest when an instruction changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const before = yield* expectLoaded();

      const copy = yield* playbookCopy();
      yield* fs.writeFileString(path.join(copy, "stages", "produce.md"), "Write it differently.\n");
      const after = yield* expectLoaded({ playbookDir: copy });

      assert.notStrictEqual(after.plan.planDigest, before.plan.planDigest);
    }).pipe(Effect.scoped),
  );

  it.effect("changes the plan digest when a skill's script changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const before = yield* expectLoaded();

      const temp = yield* fs.makeTempDirectoryScoped();
      const skills = path.join(temp, "skills");
      yield* fs.copy(path.join(yield* fixtures(), "skills"), skills);
      yield* fs.writeFileString(
        path.join(skills, "made-up-testing", "run.sh"),
        "#!/usr/bin/env bash\necho changed\n",
      );

      const after = yield* expectLoaded({ skillRoots: [skills] });
      assert.notStrictEqual(after.plan.planDigest, before.plan.planDigest);
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a required skill is in no configured root", () =>
    Effect.gen(function* () {
      const diagnostics = yield* expectDiagnostics({ skillRoots: [] });
      assert.include(diagnostics[0]?.message ?? "", "made-up-testing");
    }),
  );

  it.effect("fails when an instruction file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const copy = yield* playbookCopy();
      yield* fs.remove(path.join(copy, "stages", "produce.md"));

      const diagnostics = yield* expectDiagnostics({ playbookDir: copy });
      assert.isTrue(diagnostics.some((one) => one.field.includes("instruction")));
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a context pattern matches nothing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const diagnostics = yield* expectDiagnostics({
        repoRoot: path.join(yield* fixtures(), "skills"),
      });
      assert.isTrue(diagnostics.some((one) => one.message.includes("matched nothing")));
    }),
  );

  it.effect("names the gate file for invalid YAML instead of asking a model to fix it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const copy = yield* playbookCopy();
      yield* fs.writeFileString(
        path.join(copy, "gates", "artifact-has-content.yaml"),
        "id: [unclosed\n",
      );

      const diagnostics = yield* expectDiagnostics({ playbookDir: copy });
      assert.strictEqual(diagnostics[0]?.source, "gates/artifact-has-content.yaml");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an unknown key in the frontmatter", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const copy = yield* playbookCopy();
      const file = path.join(copy, "PLAYBOOK.md");
      const text = yield* fs.readFileString(file);
      yield* fs.writeFileString(
        file,
        text.replace("outcome: summary", "outcome: summary\nretryStrategy: aggressive"),
      );

      const diagnostics = yield* expectDiagnostics({ playbookDir: copy });
      assert.isAbove(diagnostics.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("fails when a declared input is not supplied", () =>
    Effect.gen(function* () {
      const diagnostics = yield* expectDiagnostics({ inputs: {} });
      assert.isAbove(diagnostics.length, 0);
    }),
  );

  it.effect("reports a directory with no PLAYBOOK.md", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const empty = yield* fs.makeTempDirectoryScoped();
      const diagnostics = yield* expectDiagnostics({ playbookDir: empty });
      assert.include(diagnostics[0]?.message ?? "", "No PLAYBOOK.md");
    }).pipe(Effect.scoped),
  );
});

it("requires frontmatter", () => {
  const split = splitFrontmatter("# no frontmatter\n", "PLAYBOOK.md");
  assert.isFalse(split.ok);
});

it("reports unterminated frontmatter", () => {
  const split = splitFrontmatter("---\nid: x\n", "PLAYBOOK.md");
  assert.isFalse(split.ok);
});
