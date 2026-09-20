---
schemaVersion: 1
id: synthetic-correction
name: Synthetic correction
version: "0.1"
outcome: artifact
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
policy:
  humanRequired: [merge]
---

# Synthetic correction

A public fixture for the correction path, and the one the live T3 seam is
checked against. Its gate is a command, so the compiled prompt describes it
only by the command line it runs and not by what that command checks. The stage writes what its instruction asked for,
the gate disagrees, and the correction has to carry enough for the same
provider context to fix it on a second turn.

A `file` gate cannot do this job: the prompt spells out every fragment and byte
count a file gate wants, so the first attempt passes.

The check is inline rather than a script in this directory because a command
gate's executable resolves against the run's worktree, not against the
playbook. A playbook cannot ship its own check script yet.
