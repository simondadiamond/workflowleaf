import { describe, expect, it } from "vite-plus/test";

import { groupThreadsByWorktree, type WorktreeGroupedEntry } from "./worktreeGrouping";

const pr1650 = { number: 1650, url: "https://github.com/o/r/pull/1650" };

const thread = (
  id: string,
  worktreePath: string | null,
  extra: {
    branch?: string;
    linked?: typeof pr1650;
    branchPr?: typeof pr1650;
  } = {},
) => ({
  id,
  environmentId: "env",
  worktreePath,
  branch: extra.branch ?? null,
  linkedPullRequest: extra.linked ?? null,
  branchPullRequest: extra.branchPr ?? null,
});

const shape = (entries: WorktreeGroupedEntry<ReturnType<typeof thread>>[]) =>
  entries.map((entry) =>
    entry.kind === "thread"
      ? entry.thread.id
      : `${entry.label}[${entry.threads.map((member) => member.id).join(",")}]`,
  );

describe("groupThreadsByWorktree", () => {
  it("folds threads sharing a worktree into one folder at the first thread's position", () => {
    const entries = groupThreadsByWorktree(
      [
        thread("a", "/wt/story-1", { branch: "t3code/story-1" }),
        thread("b", null),
        thread("c", "/wt/story-1"),
        thread("d", "/wt/story-2"),
      ],
      () => false,
    );

    expect(shape(entries)).toEqual(["t3code/story-1[a,c]", "b", "d"]);
  });

  it("joins the thread that started a run to its stages through the linked pull request", () => {
    const entries = groupThreadsByWorktree(
      [
        thread("babysit", "/wl/issue-1612-1", {
          branch: "workflowleaf/issue-1612-1",
          branchPr: pr1650,
        }),
        thread("driver", "/t3/t3code-6e51263a", { branch: "t3code/6e51263a", linked: pr1650 }),
        thread("other", "/t3/t3code-aaaa"),
      ],
      () => false,
    );

    expect(shape(entries)).toEqual(["workflowleaf/issue-1612-1[babysit,driver]", "other"]);
  });

  it("keeps a stage without a pull request in its worktree's folder", () => {
    const entries = groupThreadsByWorktree(
      [
        thread("plan", "/wl/issue-1612-1"),
        thread("build", "/wl/issue-1612-1", { branchPr: pr1650 }),
        thread("driver", "/t3/x", { linked: pr1650 }),
      ],
      () => false,
    );

    expect(shape(entries)).toEqual(["#1650[plan,build,driver]"]);
  });

  it("labels a folder by worktree directory when nothing else names it", () => {
    const entries = groupThreadsByWorktree(
      [thread("a", "/wt/t3code-9018b3d3"), thread("b", "/wt/t3code-9018b3d3")],
      () => false,
    );

    expect(shape(entries)).toEqual(["t3code-9018b3d3[a,b]"]);
  });

  it("keeps the same path in different environments apart", () => {
    const entries = groupThreadsByWorktree(
      [thread("a", "/wt/x"), { ...thread("b", "/wt/x"), environmentId: "other" }],
      () => false,
    );

    expect(shape(entries)).toEqual(["a", "b"]);
  });

  it("asks whether each folder is expanded", () => {
    const [folder] = groupThreadsByWorktree(
      [thread("a", "/wt/x"), thread("b", "/wt/x")],
      (_key, members) => members.some((member) => member.id === "b"),
    );

    expect(folder?.kind === "worktree" && folder.expanded).toBe(true);
  });
});
