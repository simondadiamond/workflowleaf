# This repository is a fork, and stays mergeable

`simondadiamond/workflowleaf` is a fork of `pingdotgg/t3code` that adds a
staged-run layer called WorkflowLeaf. It keeps taking upstream updates, so
`git merge upstream/main` has to stay an ordinary merge. Every change is
additive or it is not made.

**Additive means new files in fork-owned locations.** Those are
`packages/workflowleaf-core/`, `packages/workflowleaf-runtime/`,
`scripts/workflowleaf/`, `apps/server/src/workflowleaf/` and
`apps/web/src/features/workflowleaf/`. Put new work there.

**These are never touched**, whatever the task appears to need: provider
adapters, the orchestration decider, the projector, persistence, and the
event schema. A change that requires one of them ends the experiment that
asked for it. Say so rather than making the edit.

**Editing any other upstream file needs a record first.** Add an entry to
`scripts/workflowleaf/ownership.json` under `allowedUpstreamEdits` giving the
path, what the edit is for, and the condition under which it goes away. The
`maxUpstreamEdits` cap limits how many such entries may exist at all, so
adding one is a decision someone has to make on purpose.

**A check enforces all of this**, including the cap, the import boundaries,
whether T3 still builds with WorkflowLeaf deleted, and whether a commit left
the orientation out of date:

```bash
node scripts/workflowleaf/check.ts
```

Run it before you commit. It also runs on every pull request.

Everything else about WorkflowLeaf, the domain, the gates, the Effect traps,
what is proven and what is not, is in
[`scripts/workflowleaf/ORIENTATION.md`](ORIENTATION.md). Read it before
changing WorkflowLeaf code.
