import { describe, expect, it } from "vite-plus/test";

import { groupThreadsByWorktree } from "./worktreeGrouping";

const thread = (id: string, worktreePath: string | null, branch: string | null = null) => ({
  id,
  environmentId: "env",
  worktreePath,
  branch,
});

describe("groupThreadsByWorktree", () => {
  it("folds threads sharing a worktree into one folder at the first thread's position", () => {
    const entries = groupThreadsByWorktree(
      [
        thread("a", "/wt/story-1", "t3code/story-1"),
        thread("b", null),
        thread("c", "/wt/story-1"),
        thread("d", "/wt/story-2"),
      ],
      () => false,
    );

    expect(
      entries.map((entry) => (entry.kind === "thread" ? entry.thread.id : entry.label)),
    ).toEqual(["t3code/story-1", "b", "d"]);
    const folder = entries[0];
    expect(folder?.kind === "worktree" && folder.threads.map((member) => member.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("labels a folder by worktree directory when no thread has a branch", () => {
    const [folder] = groupThreadsByWorktree(
      [thread("a", "/wt/t3code-9018b3d3"), thread("b", "/wt/t3code-9018b3d3")],
      () => false,
    );

    expect(folder?.kind === "worktree" && folder.label).toBe("t3code-9018b3d3");
  });

  it("keeps the same path in different environments apart", () => {
    const entries = groupThreadsByWorktree(
      [thread("a", "/wt/x"), { ...thread("b", "/wt/x"), environmentId: "other" }],
      () => false,
    );

    expect(entries.every((entry) => entry.kind === "thread")).toBe(true);
  });

  it("asks whether each folder is expanded", () => {
    const [folder] = groupThreadsByWorktree(
      [thread("a", "/wt/x"), thread("b", "/wt/x")],
      (_key, members) => members.some((member) => member.id === "b"),
    );

    expect(folder?.kind === "worktree" && folder.expanded).toBe(true);
  });
});
