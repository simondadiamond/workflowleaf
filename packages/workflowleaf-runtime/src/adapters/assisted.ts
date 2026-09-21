/**
 * Assisted mode.
 *
 * When no executor can drive a provider, WorkflowLeaf still loads playbooks,
 * owns a worktree, runs gates and records evidence. What it does not do is
 * pretend to execute stages. This executor reports every capability as absent,
 * so the controller stops at the first agent stage with an explicit limitation
 * instead of producing a run that looks autonomous and is not.
 *
 * The compiled stage prompt is still written to the worktree, so a person can
 * paste it into whichever harness they are using and bring the artifacts back.
 */
import type {
  ContinueOutcome,
  ExecutorCapabilities,
  ExecutorPort,
  InspectOutcome,
  OperationId,
  StageHandle,
  StageRequest,
  StageSettlement,
} from "@t3tools/workflowleaf-core";

/** Assisted mode never observes a real settlement, so its timestamp is a constant. */
const EPOCH = "1970-01-01T00:00:00.000Z";

export const ASSISTED_CAPABILITIES: ExecutorCapabilities = {
  freshContext: false,
  sameContextContinuation: false,
  settledCompletion: false,
  interrupt: false,
  recovery: false,
};

export class AssistedExecutor implements ExecutorPort {
  readonly prompts: { readonly stageId: string; readonly text: string }[] = [];

  capabilities(): Promise<ExecutorCapabilities> {
    return Promise.resolve(ASSISTED_CAPABILITIES);
  }

  startStage(request: StageRequest): Promise<StageHandle> {
    this.prompts.push({ stageId: request.stage.contract.id as string, text: request.input });
    return Promise.reject(
      new Error(
        "Assisted mode cannot start a provider context. Run the stage by hand, then resume the run.",
      ),
    );
  }

  continueStage(): Promise<ContinueOutcome> {
    return Promise.resolve({
      kind: "unsupported",
      reason: "Assisted mode has no context to continue.",
    });
  }

  inspect(): Promise<InspectOutcome> {
    return Promise.resolve({
      kind: "unknown",
      reason: "Assisted mode cannot tell whether an operation ran.",
    });
  }

  interrupt(): Promise<void> {
    return Promise.resolve();
  }

  awaitSettlement(handle: StageHandle): Promise<StageSettlement> {
    return Promise.resolve({
      operationId: handle.operationId as OperationId,
      outcome: "error",
      settled: false,
      detail: "Assisted mode does not execute stages.",
      at: EPOCH,
    });
  }
}
