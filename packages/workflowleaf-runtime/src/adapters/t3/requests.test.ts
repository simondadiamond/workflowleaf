import { describe, expect, it } from "vite-plus/test";

import { answerOutcomeFrom, approvalsFrom } from "./requests.ts";

const requested = (requestId: string) => ({
  kind: "approval.requested",
  payload: {
    requestId,
    requestKind: "command",
    requestType: "command",
    detail: "touch approved.txt",
  },
  createdAt: "2026-09-22T00:00:00.000Z",
});
const resolved = (requestId: string) => ({
  kind: "approval.resolved",
  payload: { requestId, decision: "accept" },
});
const failed = (requestId: string, detail: string) => ({
  kind: "provider.approval.respond.failed",
  payload: { requestId, detail },
});
const STALE = (id: string) =>
  `Stale pending approval request: ${id}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
const running = { status: "running" };

describe("approvals a stage is waiting on", () => {
  it("lists an open approval as live while its session is", () => {
    expect(approvalsFrom([requested("a")], running)).toEqual([
      {
        requestId: "a",
        detail: "touch approved.txt",
        openedAt: "2026-09-22T00:00:00.000Z",
        expired: false,
      },
    ]);
  });

  it("drops one that was answered", () => {
    expect(approvalsFrom([requested("a"), resolved("a")], running)).toEqual([]);
  });

  it("shows one the provider refused as stale as expired, not as live (C09)", () => {
    expect(approvalsFrom([requested("a"), failed("a", STALE("a"))], running)[0]?.expired).toBe(
      true,
    );
  });

  it("shows every open one as expired once the session that asked has ended (C09)", () => {
    expect(approvalsFrom([requested("a")], { status: "stopped" })[0]?.expired).toBe(true);
    expect(approvalsFrom([requested("a")], null)[0]?.expired).toBe(true);
  });

  it("keeps one open when a reply failed for a reason that is not staleness", () => {
    const [request] = approvalsFrom(
      [requested("a"), failed("a", "No active provider session is bound to this thread.")],
      running,
    );
    expect(request?.expired).toBe(false);
  });
});

describe("what became of an answer", () => {
  it("reads only replies that arrived after it was sent", () => {
    const earlier = [
      requested("a"),
      failed("a", "No active provider session is bound to this thread."),
    ];
    expect(answerOutcomeFrom(earlier, "a", 1)).toBeNull();
    expect(answerOutcomeFrom([...earlier, resolved("a")], "a", 1)).toEqual({ kind: "answered" });
  });

  it("reports a stale refusal as expired", () => {
    expect(answerOutcomeFrom([requested("a"), failed("a", STALE("a"))], "a", 0)?.kind).toBe(
      "expired",
    );
  });
});
