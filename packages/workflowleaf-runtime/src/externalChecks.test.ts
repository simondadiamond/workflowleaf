import { assert, describe, it } from "@effect/vitest";

import { judgeExternal, type PullRequestState } from "./externalChecks.ts";

const HEAD = "a".repeat(40);

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
  } = {},
): PullRequestState {
  return {
    state: overrides.state ?? "OPEN",
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
    commits: {
      nodes: [
        {
          commit: {
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

  it("converges once checks are green and nothing is outstanding", () => {
    const green = pr({ checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] });
    const seen = judge("converged-on-head", green);
    assert.strictEqual(seen.state, "satisfied");
    assert.strictEqual(seen.boundValue, HEAD);
  });
});
