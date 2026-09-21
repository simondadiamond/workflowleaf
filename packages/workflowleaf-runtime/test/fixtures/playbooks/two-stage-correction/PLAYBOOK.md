---
schemaVersion: 1
id: synthetic-correction
name: Synthetic correction
version: "0.1"
outcome: summary
inputs:
  - topic
stages:
  - id: produce
    kind: agent
    instruction: stages/produce.md
    consumes: [topic]
    produces: [artifact.md]
    context:
      files: ["AGENTS.md"]
    skills:
      required: []
      lazy: []
      lazyRules: []
    gates: [artifact-is-reviewed]
    correction:
      mode: same-context
      maxAttempts: 3
      onLostContext: fresh-with-evidence
    budgets:
      attempts: 3
    requiresCapabilities: [fresh-context, same-context-continuation]
  - id: summarize
    kind: agent
    instruction: stages/summarize.md
    consumes: [artifact.md]
    produces: [summary.md]
    context:
      files: []
    skills:
      required: []
      lazy: []
      lazyRules: []
    gates: [summary-has-content]
    correction:
      mode: route-to
      stage: produce
      maxCycles: 2
    budgets:
      attempts: 2
    requiresCapabilities: [fresh-context]
policy:
  humanRequired: [merge]
---

# Synthetic correction

A public fixture for the correction path, and the one the live T3 seam is
checked against. The first stage's gate fails on its first attempt no matter
what the stage produced, so the run has to correct on the same provider thread
before it can move on. A second stage follows, so one run covers a correction
and a later stage opening a fresh context on the same worktree.

The gate ignores the stage's output on purpose. A stage is shown its gates in
the prompt, and for a command gate that means the whole argument list, so an
inline check is no more opaque than a file gate's `mustContain`. A fixture that
asks a model to fail proves nothing on the turn the model decides to comply.
What is under test here is the control flow, not the model.

A check that lives in its own script beside the playbook would be genuinely
opaque, and is the better shape for this. It is not available yet: a command
gate's executable resolves against the run's worktree, not the playbook.
