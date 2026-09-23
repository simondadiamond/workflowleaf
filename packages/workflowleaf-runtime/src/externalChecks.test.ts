import { assert, describe, it } from "@effect/vitest";

import { judgeExternal, type PullRequestState } from "./externalChecks.ts";

const HEAD = "a".repeat(40);
const AUTHOR = "run-account";

function pr(
  overrides: {
    readonly headRefOid?: string;
    readonly state?: string;
    readonly checks?: readonly { name: string; status: string; conclusion: string | null }[];
    readonly threads?: readonly {
      resolved: boolean;
      outdated?: boolean;
      path: string;
      body: string;
    }[];
    readonly reviewDecision?: string | null;
    readonly reviewRequests?: number;
    readonly draft?: boolean;
    readonly reviews?: readonly { by: string; on?: string }[];
    readonly readyAt?: string;
    readonly committedAt?: string;
  } = {},
): PullRequestState {
  return {
    state: overrides.state ?? "OPEN",
    isDraft: overrides.draft ?? false,
    author: { login: AUTHOR },
    headRefOid: overrides.headRefOid ?? HEAD,
    reviewDecision: overrides.reviewDecision ?? null,
    reviewRequests: { totalCount: overrides.reviewRequests ?? 0 },
    reviewThreads: {
      nodes: (overrides.threads ?? []).map((thread) => ({
        isResolved: thread.resolved,
        isOutdated: thread.outdated ?? false,
        path: thread.path,
        line: 12,
        comments: { nodes: [{ body: thread.body, author: { login: "bot" } }] },
      })),
    },
    reviews: {
      nodes: (overrides.reviews ?? []).map((review) => ({
        author: { login: review.by },
        commit: { oid: review.on ?? HEAD },
      })),
    },
    timelineItems: {
      nodes: overrides.readyAt === undefined ? [] : [{ createdAt: overrides.readyAt }],
    },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: overrides.committedAt ?? "2026-09-22T12:00:00Z",
            statusCheckRollup: {
              contexts: {
                nodes: (overrides.checks ?? []).map((check) => ({
                  __typename: "CheckRun",
                  ...check,
                })),
              },
            },
          },
        },
      ],
    },
  };
}

const judge = (check: string, state: PullRequestState | null, localHead = HEAD) =>
  judgeExternal({ check, pr: state, localHead });

describe("external gates judge the pull request's head, not an older one", () => {
  it("refuses a green that belongs to a head the worktree has moved past", () => {
    const seen = judge("converged-on-head", pr({ headRefOid: "b".repeat(40) }));
    assert.strictEqual(seen.state, "unattributed");
    assert.include(seen.detail, "Push the work");
  });

  it("passes pull-request-exists on an open pull request at this head", () => {
    assert.strictEqual(judge("pull-request-exists", pr()).state, "satisfied");
    assert.strictEqual(judge("pull-request-exists", pr({ state: "CLOSED" })).state, "unsatisfied");
  });

  it("waits while checks run, and names what failed when they fail", () => {
    const running = pr({ checks: [{ name: "test", status: "IN_PROGRESS", conclusion: null }] });
    assert.strictEqual(judge("checks-green", running).state, "pending");

    const failing = pr({ checks: [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }] });
    const seen = judge("converged-on-head", failing);
    assert.strictEqual(seen.state, "unsatisfied");
    assert.include(seen.detail, "lint (FAILURE)");
  });

  it("lists every live unresolved thread so the correction can act on it", () => {
    const seen = judge(
      "converged-on-head",
      pr({
        threads: [
          { resolved: false, path: "src/a.ts", body: "This drops the null check.\nMore text." },
          { resolved: true, path: "src/b.ts", body: "fixed" },
          { resolved: false, outdated: true, path: "src/c.ts", body: "old" },
        ],
      }),
    );
    assert.strictEqual(seen.state, "unsatisfied");
    assert.include(seen.detail, "1 unresolved review thread(s)");
    assert.include(seen.detail, "src/a.ts:12 (bot): This drops the null check.");
    assert.notInclude(seen.detail, "src/b.ts");
    assert.notInclude(seen.detail, "src/c.ts");
  });

  it("waits on a reviewer who has not answered yet", () => {
    assert.strictEqual(judge("converged-on-head", pr({ reviewRequests: 1 })).state, "pending");
  });

  it("converges once checks are green, nothing is outstanding, and someone reviewed this head", () => {
    const green = pr({
      checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
      reviews: [{ by: "copilot-pull-request-reviewer" }],
    });
    const seen = judge("converged-on-head", green);
    assert.strictEqual(seen.state, "satisfied");
    assert.strictEqual(seen.boundValue, HEAD);
    assert.include(seen.detail, "copilot-pull-request-reviewer");
  });
});

describe("converged-on-head needs a review, not the absence of one (#42)", () => {
  // issue-1598-1: a draft, both review jobs SKIPPED, no reviews, nothing requested.
  const unreviewedDraft = pr({
    draft: true,
    checks: [
      { name: "review-deep", status: "COMPLETED", conclusion: "SKIPPED" },
      { name: "gates", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
  });

  it("waits on a draft whose only reviewer check was skipped", () => {
    const seen = judge("converged-on-head", unreviewedDraft);
    assert.strictEqual(seen.state, "pending");
    assert.include(seen.detail, "draft");
    assert.include(seen.detail, "skipped, not reviewed: review-deep");
  });

  it("does not count the author's own review, which a stage replying to a thread files", () => {
    const seen = judge("converged-on-head", pr({ reviews: [{ by: AUTHOR }] }));
    assert.strictEqual(seen.state, "pending");
  });

  it("does not count a review of an older head", () => {
    const seen = judge("converged-on-head", pr({ reviews: [{ by: "bot", on: "c".repeat(40) }] }));
    assert.strictEqual(seen.state, "pending");
  });

  it("converges without a review only after the profile's wait, counted from ready", () => {
    const ready = pr({ readyAt: "2026-09-22T12:30:00Z" });
    const at = (iso: string) =>
      judgeExternal({
        check: "converged-on-head",
        pr: ready,
        localHead: HEAD,
        now: Date.parse(iso),
        reviewWaitMinutes: 15,
      }).state;
    assert.strictEqual(at("2026-09-22T12:40:00Z"), "pending");
    assert.strictEqual(at("2026-09-22T12:45:00Z"), "satisfied");
  });

  it("never lets the wait pass a draft, which reviewers may never see", () => {
    const seen = judgeExternal({
      check: "converged-on-head",
      pr: unreviewedDraft,
      localHead: HEAD,
      now: Date.parse("2026-09-23T12:00:00Z"),
      reviewWaitMinutes: 1,
    });
    assert.strictEqual(seen.state, "pending");
  });
});
