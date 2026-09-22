---
schemaVersion: 1
id: implement-pr
name: Implement a story as one pull request
version: "0.1"
outcome: reviewable-pull-request
inputs:
  - issue
  - story
stages:
  - id: plan
    kind: agent
    instruction: stages/plan.md
    consumes: [issue, story]
    produces: [".workflowleaf/plan.md"]
    context:
      files: []
    skills:
      required: []
      lazy: []
      lazyRules: []
    gates: [plan-is-executable]
    correction:
      mode: same-context
      maxAttempts: 3
      onLostContext: fresh-with-evidence
    budgets:
      attempts: 3
    requiresCapabilities: [fresh-context]
  - id: build
    kind: agent
    instruction: stages/build.md
    consumes: [".workflowleaf/plan.md"]
    produces: [diff, tests]
    context:
      files: []
    skills:
      required: []
      lazy: []
      lazyRules: []
    gates: [tests-pass, work-committed]
    correction:
      mode: same-context
      maxAttempts: 3
      onLostContext: fresh-with-evidence
    budgets:
      attempts: 3
    requiresCapabilities: [fresh-context, same-context-continuation, settled-completion]
  - id: review
    kind: check
    consumes: [diff, ".workflowleaf/plan.md"]
    produces: []
    context:
      files: []
    skills:
      required: []
      lazy: []
      lazyRules: []
    gates: [tests-pass, no-blocking-findings]
    correction:
      mode: route-to
      stage: build
      maxCycles: 2
    budgets:
      attempts: 1
    requiresCapabilities: []
  - id: deliver
    kind: agent
    instruction: stages/deliver.md
    consumes: [diff, ".workflowleaf/plan.md"]
    produces: [pull-request]
    context:
      files: []
    skills:
      required: []
      lazy: []
      lazyRules: []
    gates: [pushed, pr-body-complete, pull-request-is-this-run]
    correction:
      mode: same-context
      maxAttempts: 2
      onLostContext: fresh-with-evidence
    budgets:
      attempts: 2
    requiresCapabilities: [fresh-context]
  - id: babysit
    kind: watch
    consumes: [pull-request]
    produces: []
    context:
      files: []
    skills:
      required: []
      lazy: []
      lazyRules: []
    gates: [converged]
    correction:
      mode: route-to
      stage: build
      maxCycles: 2
    budgets:
      attempts: 6
    requiresCapabilities: []
policy:
  humanRequired:
    - merge
    - destructive-operations
---

# Implement a story as one pull request

Plan, build, review, deliver and babysit. The same shape fits most repositories.
Nothing here names a language, a test runner or a repository. What differs
between repositories lives in the repository itself.

## What the target repository provides

A committed file `.workflowleaf/commands`, one command per line:

```
test: npm test
```

`tests-pass` runs the `test` line. It reads the file from the run's base
revision rather than from the worktree, so the stage it checks cannot
loosen it. Declare more names and point more gates at them the same way.

## How each stage is checked

- **plan** writes `.workflowleaf/plan.md`. A file gate requires its sections.
- **build** changes the code and commits it. The repository's tests must pass
  and the change must be committed.
- **review** has no model context of its own. The tests run again on the exact
  tree under review. Then a separate reviewer process judges each criterion
  independently. A blocking finding sends the work back to build with every
  finding and its failure scenario.
- **deliver** pushes and writes the pull request body. Gates check that the
  push landed, that the body has its sections, and that the pull request's head
  is this run's.
- **babysit** waits until checks are green and every review thread is
  resolved. Unresolved threads send the work back to build, listing each
  thread. Merging stays with a person.
