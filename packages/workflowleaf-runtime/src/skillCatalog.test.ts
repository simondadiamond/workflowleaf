import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  frontmatterOf,
  globToRegExp,
  loadSkillCatalog,
  resolveSkills,
  skillsForPaths,
} from "./skillCatalog.ts";

const writeSkill = Effect.fnUntraced(function* (root: string, id: string, description: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(root, id);
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.writeFileString(
    path.join(directory, "SKILL.md"),
    `---\nname: ${id}\ndescription: ${description}\n---\n\nbody\n`,
  );
});

const fixtureSkills = Effect.fnUntraced(function* () {
  const path = yield* Path.Path;
  return path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "test",
    "fixtures",
    "skills",
  );
});

it.layer(NodeServices.layer)("skill catalog", (it) => {
  it.effect("reads name and description from frontmatter", () =>
    Effect.gen(function* () {
      const catalog = yield* loadSkillCatalog([yield* fixtureSkills()]);
      const entry = catalog.byId.get("made-up-testing");

      assert.include(entry?.description ?? "", "fixture skill");
      assert.match(entry?.digest ?? "", /^sha256:/);
    }),
  );

  it.effect("skips a dangling symlink instead of failing the whole catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* writeSkill(root, "real-skill", "a skill that exists");
      yield* fs.symlink(path.join(root, "nowhere"), path.join(root, "dangling"));

      const catalog = yield* loadSkillCatalog([root]);
      assert.isTrue(catalog.byId.has("real-skill"));
      assert.strictEqual(catalog.byId.size, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("lets a later root shadow an earlier one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const first = yield* fs.makeTempDirectoryScoped();
      const second = yield* fs.makeTempDirectoryScoped();
      yield* writeSkill(first, "testing", "personal");
      yield* writeSkill(second, "testing", "project");

      const catalog = yield* loadSkillCatalog([first, second]);
      assert.strictEqual(catalog.byId.get("testing")?.description, "project");
      assert.strictEqual(catalog.byId.get("testing")?.root, second);
    }).pipe(Effect.scoped),
  );

  it.effect("ignores a directory with no SKILL.md", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(root, "not-a-skill"));
      yield* writeSkill(root, "real", "real one");

      const catalog = yield* loadSkillCatalog([root]);
      assert.deepStrictEqual([...catalog.byId.keys()], ["real"]);
    }).pipe(Effect.scoped),
  );

  it.effect("skips a configured root that does not exist", () =>
    Effect.gen(function* () {
      const catalog = yield* loadSkillCatalog(["/definitely/not/here"]);
      assert.strictEqual(catalog.byId.size, 0);
    }),
  );

  it.effect("reports what it could not resolve rather than dropping it", () =>
    Effect.gen(function* () {
      const catalog = yield* loadSkillCatalog([yield* fixtureSkills()]);
      const resolution = resolveSkills(catalog, ["made-up-testing", "not-installed"]);

      assert.deepStrictEqual([...resolution.resolved.keys()], ["made-up-testing"]);
      assert.deepStrictEqual([...resolution.missing], ["not-installed"]);
    }),
  );

  it.effect("changes a skill's digest when one of its scripts changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* writeSkill(root, "testing", "one");
      const script = path.join(root, "testing", "run.sh");
      yield* fs.writeFileString(script, "echo before\n");
      const before = (yield* loadSkillCatalog([root])).byId.get("testing")?.digest;

      yield* fs.writeFileString(script, "echo after\n");
      const after = (yield* loadSkillCatalog([root])).byId.get("testing")?.digest;

      assert.notStrictEqual(before, after);
    }).pipe(Effect.scoped),
  );
});

describe("frontmatter", () => {
  it("returns an empty record when there is none", () => {
    assert.deepStrictEqual(frontmatterOf("# just a heading\n"), {});
  });

  it("returns an empty record rather than throwing on malformed YAML", () => {
    assert.deepStrictEqual(frontmatterOf("---\nname: [unclosed\n---\n"), {});
  });
});

describe("path-triggered skills", () => {
  it("selects a skill when a changed path matches its rule", () => {
    assert.deepStrictEqual(
      skillsForPaths(
        [{ paths: "**/*.sql", load: "database-migrations" }],
        ["functions/db/001-add-column.sql"],
      ),
      ["database-migrations"],
    );
  });

  it("selects nothing when no path matches", () => {
    assert.deepStrictEqual(
      skillsForPaths(
        [{ paths: "**/*.sql", load: "database-migrations" }],
        ["apps/web/src/App.tsx"],
      ),
      [],
    );
  });

  it("deduplicates when two rules load the same skill", () => {
    assert.deepStrictEqual(
      skillsForPaths(
        [
          { paths: "**/*.sql", load: "database-migrations" },
          { paths: "migrations/**", load: "database-migrations" },
        ],
        ["migrations/001.sql"],
      ),
      ["database-migrations"],
    );
  });
});

describe("glob matching", () => {
  it("keeps a single star inside one path segment", () => {
    assert.isTrue(globToRegExp("docs/*.md").test("docs/a.md"));
    assert.isFalse(globToRegExp("docs/*.md").test("docs/nested/a.md"));
  });

  it("lets a double star cross segments", () => {
    assert.isTrue(globToRegExp("docs/**").test("docs/nested/a.md"));
  });

  it("does not treat a dot as a wildcard", () => {
    assert.isFalse(globToRegExp("a.md").test("axmd"));
  });
});
