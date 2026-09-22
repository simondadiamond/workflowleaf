import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type {
  AttemptId,
  Digest,
  GateDefinition,
  GateId,
  RunId,
  VisitId,
} from "@t3tools/workflowleaf-core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { evaluateGate, type GateContext } from "./gates.ts";
import { git, revParse } from "./git.ts";
import { decodeVerdict, reviewerArgs, type ReviewerConfig } from "./reviewer.ts";
import { takeSnapshot } from "./workspaces.ts";

const verdict = (satisfied: boolean, severity = "block") =>
  `{"satisfied":${String(satisfied)},"severity":"${severity}","summary":"s","failureScenario":"f"}`;

describe("reading a reviewer's verdict", () => {
  it("reads a bare verdict", () => {
    assert.strictEqual(decodeVerdict(verdict(true))?.satisfied, true);
  });

  it("reads a claude -p envelope, structured or as result text", () => {
    assert.strictEqual(
      decodeVerdict(`{"type":"result","structured_output":${verdict(false)}}`)?.satisfied,
      false,
    );
    assert.strictEqual(
      decodeVerdict(`{"type":"result","result":"${verdict(true).replaceAll('"', '\\"')}"}`)
        ?.satisfied,
      true,
    );
  });

  it("reads the last verdict line of chatty output", () => {
    assert.strictEqual(decodeVerdict(`thinking...\n${verdict(false)}\n`)?.satisfied, false);
  });

  it("treats anything outside the schema as no answer", () => {
    assert.isNull(decodeVerdict("Looks good to me!"));
    assert.isNull(decodeVerdict(`{"satisfied":"yes"}`));
  });

  it("substitutes the schema inline and by file", () => {
    const config: ReviewerConfig = {
      executable: "x",
      args: ["--json-schema", "${schema}", "--output-schema", "${schemaFile}"],
      timeoutMs: 1,
    };
    assert.deepStrictEqual(reviewerArgs(config, "{}", "/tmp/s.json"), [
      "--json-schema",
      "{}",
      "--output-schema",
      "/tmp/s.json",
    ]);
  });
});

/** A git worktree with one base commit and one uncommitted change on top. */
const makeChangedWorkspace = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const workspace = path.join(root, "work");
  yield* fs.makeDirectory(workspace, { recursive: true });
  yield* git(workspace, ["init", "-q", "-b", "main"]);
  yield* git(workspace, ["config", "user.email", "fixture@example.com"]);
  yield* git(workspace, ["config", "user.name", "Fixture"]);
  yield* fs.writeFileString(
    path.join(workspace, "math.js"),
    "export const add = (a, b) => a + b;\n",
  );
  yield* git(workspace, ["add", "."]);
  yield* git(workspace, ["commit", "-qm", "initial"]);
  const base = yield* revParse(workspace, "HEAD");
  yield* fs.writeFileString(
    path.join(workspace, "math.js"),
    "export const add = (a, b) => a - b;\n",
  );
  return { root, workspace, base, logDir: path.join(root, "logs") };
});

const reviewGate = (criteria?: string[]): Extract<GateDefinition, { type: "review" }> => ({
  id: "no-blockers" as GateId,
  type: "review",
  rubric: "The change does what it says.",
  ...(criteria === undefined ? {} : { criteria }),
  blockingSeverities: ["block"],
});

/**
 * A reviewer that is a shell script. Each call keeps the prompt it was given in
 * its own file, so a test can see what the judge saw and how often it was
 * asked, and answers with a fixed verdict.
 */
const scriptedReviewer = (root: string, answer: string): ReviewerConfig => ({
  executable: "/bin/sh",
  args: [
    "-c",
    `mkdir -p "${root}/prompts"; cat > "$(mktemp "${root}/prompts/p.XXXXXX")"; echo '${answer}'`,
  ],
  timeoutMs: 30_000,
});

const promptsSeen = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* fs.readDirectory(`${root}/prompts`);
  return yield* Effect.forEach(files, (file) => fs.readFileString(`${root}/prompts/${file}`));
});

const contextFor = Effect.fnUntraced(function* (input: {
  readonly workspace: string;
  readonly logDir: string;
  readonly base: string;
  readonly reviewer: ReviewerConfig;
}) {
  return {
    runId: "run-1" as RunId,
    visitId: "visit-1" as VisitId,
    attemptId: "attempt-1" as AttemptId,
    workspacePath: input.workspace,
    gateDigest: "gate-v1" as Digest,
    logDir: input.logDir,
    baseline: yield* takeSnapshot(input.workspace, "t0"),
    baseRevision: input.base,
    artifacts: [],
    reviewer: input.reviewer,
  } satisfies GateContext;
});

it.layer(NodeServices.layer, { excludeTestServices: true })("the review gate", (it) => {
  it.effect("fails the stage on a blocking finding, and records it as judgment", () =>
    Effect.gen(function* () {
      const { root, workspace, base, logDir } = yield* makeChangedWorkspace();
      const evidence = yield* evaluateGate(
        reviewGate(),
        yield* contextFor({
          workspace,
          logDir,
          base,
          reviewer: scriptedReviewer(root, verdict(false)),
        }),
      );

      assert.strictEqual(evidence.outcome, "failed");
      assert.strictEqual(evidence.tool, "review:/bin/sh");
      if (evidence.detail.kind !== "review") return assert.fail("expected review detail");
      assert.strictEqual(evidence.detail.findings.length, 1);
      assert.strictEqual(evidence.detail.findings[0]?.failureScenario, "f");
      // The judge was shown the change, not a description of it.
      const prompts = yield* promptsSeen(root);
      assert.include(prompts.join(""), "a - b");
      // Bound to the tree it judged: any later edit invalidates it.
      assert.isAbove(evidence.inputDigests.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("passes when every criterion is met, asking once per criterion", () =>
    Effect.gen(function* () {
      const { root, workspace, base, logDir } = yield* makeChangedWorkspace();
      const evidence = yield* evaluateGate(
        reviewGate(["It adds.", "It has a test."]),
        yield* contextFor({
          workspace,
          logDir,
          base,
          reviewer: scriptedReviewer(root, verdict(true)),
        }),
      );

      assert.strictEqual(evidence.outcome, "passed");
      if (evidence.detail.kind !== "review") return assert.fail("expected review detail");
      assert.strictEqual(evidence.detail.criteriaJudged, 2);
      const prompts = yield* promptsSeen(root);
      assert.strictEqual(prompts.length, 2);
      assert.isTrue(
        prompts.some((prompt) => prompt.includes("It adds.") && !prompt.includes("It has a test.")),
      );
      assert.isTrue(prompts.some((prompt) => prompt.includes("It has a test.")));
    }).pipe(Effect.scoped),
  );

  it.effect("passes a non-blocking finding through without failing the stage", () =>
    Effect.gen(function* () {
      const { root, workspace, base, logDir } = yield* makeChangedWorkspace();
      const evidence = yield* evaluateGate(
        reviewGate(),
        yield* contextFor({
          workspace,
          logDir,
          base,
          reviewer: scriptedReviewer(root, verdict(false, "note")),
        }),
      );
      assert.strictEqual(evidence.outcome, "passed");
      if (evidence.detail.kind !== "review") return assert.fail("expected review detail");
      assert.strictEqual(evidence.detail.findings[0]?.severity, "note");
    }).pipe(Effect.scoped),
  );

  it.effect("records a reviewer that did not answer as could-not-run, never as a pass", () =>
    Effect.gen(function* () {
      const { root, workspace, base, logDir } = yield* makeChangedWorkspace();
      const evidence = yield* evaluateGate(
        reviewGate(),
        yield* contextFor({ workspace, logDir, base, reviewer: scriptedReviewer(root, "LGTM") }),
      );
      assert.strictEqual(evidence.outcome, "error");
    }).pipe(Effect.scoped),
  );

  it.effect("records a reviewer that cannot start as could-not-run", () =>
    Effect.gen(function* () {
      const { workspace, base, logDir } = yield* makeChangedWorkspace();
      const evidence = yield* evaluateGate(
        reviewGate(),
        yield* contextFor({
          workspace,
          logDir,
          base,
          reviewer: { executable: "/nonexistent/reviewer", args: [], timeoutMs: 1000 },
        }),
      );
      assert.strictEqual(evidence.outcome, "error");
    }).pipe(Effect.scoped),
  );
});
