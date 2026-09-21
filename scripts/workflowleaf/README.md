# WorkflowLeaf fork ownership

This fork adds WorkflowLeaf on top of T3 Code and keeps taking upstream
updates. That only works if every change is either a new file in a
WorkflowLeaf-owned location or an upstream file we edit on purpose, with a
written reason and a condition for removing the edit again.

`ownership.json` records both lists plus the import boundaries that keep the
domain portable. `check.ts` enforces them.

```bash
node scripts/workflowleaf/check.ts              # against the recorded upstream base
node scripts/workflowleaf/check.ts --base HEAD~1
```

The check fails when:

- a file outside every owned prefix is modified or deleted and is not in
  `allowedUpstreamEdits`;
- a new file appears inside an upstream directory (new files are how a fork
  stops being additive without anyone noticing);
- `packages/workflowleaf-core` imports T3, the filesystem, the environment or
  an ambient clock;
- anything under `packages/workflowleaf-runtime` outside `src/adapters/t3/`
  imports a T3 package.

Both rule sets are pure functions in `ownership.ts` and `imports.ts`, tested
against fixture change sets in the neighbouring `.test.ts` files. Run them with
`vp test run scripts/workflowleaf`.

Adding an upstream edit means adding an `allowedUpstreamEdits` entry that says
what it is for and when it goes away. Provider adapters and the orchestration
decider, projector and persistence are never on that list; a change that needs
one of them ends the experiment that asked for it instead.
