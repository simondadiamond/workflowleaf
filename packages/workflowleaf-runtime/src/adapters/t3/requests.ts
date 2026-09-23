/**
 * Provider approvals on a T3 thread, read from its activities.
 *
 * T3 records an approval as `approval.requested`, its answer as
 * `approval.resolved`, and a reply the provider could no longer take as a
 * `provider.approval.respond.failed` whose detail says the request is stale or
 * unknown. There is no expiry event: a provider's callback simply does not
 * survive its session ending, and T3 only finds out when someone replies. So
 * a request is read as expired when T3 already said so, or when the thread has
 * no live session left to take the answer. Either way it is never answered as
 * if it were live.
 */
import type { AnswerOutcome, ProviderRequest } from "@t3tools/workflowleaf-core";

export interface ThreadActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt?: string;
}

export interface ThreadSession {
  readonly status: string;
}

/** Session states in which no provider is left holding the request's callback. */
const GONE: readonly string[] = ["stopped", "error"];

function requestIdOf(activity: ThreadActivity): string | null {
  const id = (activity.payload as { requestId?: unknown } | null)?.requestId;
  return typeof id === "string" ? id : null;
}

function detailOf(activity: ThreadActivity): string {
  const detail = (activity.payload as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" ? detail : "";
}

/** T3's own test for a reply the provider could not take (see `stalePendingRequestDetail`). */
export function isStaleDetail(detail: string): boolean {
  const lower = detail.toLowerCase();
  return lower.includes("stale pending") || lower.includes("unknown pending");
}

/** Approvals still waiting on an answer, with those that can no longer take one marked expired. */
export function approvalsFrom(
  activities: readonly ThreadActivity[],
  session: ThreadSession | null,
): ProviderRequest[] {
  const resolved = new Set<string>();
  const stale = new Set<string>();
  for (const activity of activities) {
    const id = requestIdOf(activity);
    if (id === null) continue;
    if (activity.kind === "approval.resolved") resolved.add(id);
    if (activity.kind === "provider.approval.respond.failed" && isStaleDetail(detailOf(activity))) {
      stale.add(id);
    }
  }

  const sessionGone = session === null || GONE.includes(session.status);
  return activities.flatMap((activity) => {
    const id = requestIdOf(activity);
    if (activity.kind !== "approval.requested" || id === null || resolved.has(id)) return [];
    return [
      {
        requestId: id,
        detail: detailOf(activity),
        openedAt: activity.createdAt ?? "",
        expired: stale.has(id) || sessionGone,
      } satisfies ProviderRequest,
    ];
  });
}

/** The activities that answer or refuse one request, oldest first. */
export function repliesTo(
  activities: readonly ThreadActivity[],
  requestId: string,
): ThreadActivity[] {
  return activities.filter(
    (activity) =>
      requestIdOf(activity) === requestId &&
      (activity.kind === "approval.resolved" ||
        activity.kind === "provider.approval.respond.failed"),
  );
}

/**
 * What became of an answer: the first reply to the request after the `seen`
 * replies that existed before it was sent. Null while T3 has recorded none.
 */
export function answerOutcomeFrom(
  activities: readonly ThreadActivity[],
  requestId: string,
  seen: number,
): AnswerOutcome | null {
  const reply = repliesTo(activities, requestId)[seen];
  if (reply === undefined) return null;
  if (reply.kind === "approval.resolved") return { kind: "answered" };
  const detail = detailOf(reply);
  return isStaleDetail(detail)
    ? { kind: "expired", reason: detail }
    : { kind: "not-pending", reason: detail };
}
