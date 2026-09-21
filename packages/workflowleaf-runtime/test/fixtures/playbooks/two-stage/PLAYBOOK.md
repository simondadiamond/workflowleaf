---
schemaVersion: 1
id: synthetic-two-stage
name: Synthetic two stage
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
      required: [made-up-testing]
      lazy: []
      lazyRules: []
    gates: [artifact-has-content]
    correction:
      mode: same-context
      maxAttempts: 3
      onLostContext: fresh-with-evidence
    budgets:
      attempts: 3
    requiresCapabilities: [fresh-context]
  - id: summarize
    kind: agent
    instruction: stages/summarize.md
    consumes: [artifact.md]
    produces: [summary.md]
    context:
      files: ["docs/**"]
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

# Synthetic two stage

A public fixture. Stage one writes an artifact, stage two summarizes it.
