import { describe, expect, it } from "vite-plus/test";

import { encodeHandle, threadsToArchive } from "./executor.ts";

const handle = (threadId: string, operation: string) =>
  encodeHandle({ threadId, messageId: `${operation}-msg`, commandId: `${operation}-turn` });

describe("which stage threads are archived when the next stage starts", () => {
  it("archives every earlier stage thread of the run, once each", () => {
    const earlier = [
      handle("wl-issue-1-1-visit-a", "op-1"),
      handle("wl-issue-1-1-visit-b", "op-2"),
      // A correction is another turn on the same thread, recorded again.
      handle("wl-issue-1-1-visit-b", "op-3"),
    ];
    expect(threadsToArchive("wl-issue-1-1-visit-c", earlier, new Set())).toEqual([
      "wl-issue-1-1-visit-a",
      "wl-issue-1-1-visit-b",
    ]);
  });

  it("never archives the thread that is starting", () => {
    const earlier = [
      handle("wl-issue-1-1-visit-a", "op-1"),
      handle("wl-issue-1-1-visit-c", "op-4"),
    ];
    expect(threadsToArchive("wl-issue-1-1-visit-c", earlier, new Set())).toEqual([
      "wl-issue-1-1-visit-a",
    ]);
  });

  it("does not ask again for a thread this process already archived, and skips unreadable handles", () => {
    const earlier = [handle("wl-issue-1-1-visit-a", "op-1"), "not-a-handle"];
    expect(
      threadsToArchive("wl-issue-1-1-visit-b", earlier, new Set(["wl-issue-1-1-visit-a"])),
    ).toEqual([]);
  });
});
