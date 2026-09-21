# WorkflowLeaf

A staged-run layer on a T3 Code fork. A **playbook** describes how a class of
work is done; a **run** is one story delivered as one pull request; each
**stage** gets a fresh provider context in one shared worktree; **gates** are
checked by code, never by the model being gated; a failing gate corrects inside
the same context.

A run id is the story plus its ordinal, `issue-42-1`. A story that outgrows one
pull request gets `issue-42-2`, so a split never collides. The draft pull
request is opened by code at run start when the profile permits it, and its
number is on the run record.

Everything is additive on top of T3 so upstream's main branch keeps merging.

## Where everything is

| What                                        | Where                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Code, branch `main`                         | any worktree under `~/.t3/worktrees/t3code/`                                                 |
| This document                               | `scripts/workflowleaf/ORIENTATION.md`, the source of truth                                   |
| The additive rule, for every agent          | `scripts/workflowleaf/FORK-RULES.md`, imported by `CLAUDE.md`                                |
| Fork remote                                 | `origin` = `simondadiamond/workflowleaf`, `upstream` = `pingdotgg/t3code` (never push there) |
| Backlog                                     | issues on `simondadiamond/workflowleaf`, labelled `workflowleaf` + `p0`–`p3`                 |
| Private material                            | `~/.workflowleaf/` — never commit any of it to the fork                                      |
| Seam decision, live findings, skill mapping | `~/.workflowleaf/notes/`                                                                     |
| Execution profiles                          | `~/.workflowleaf/profiles/*.json`                                                            |
| The Marketplace playbook                    | `~/.workflowleaf/playbooks/fbm-t1/`                                                          |

Two packages: `packages/workflowleaf-core` (pure domain, no T3, no filesystem,
no clock) and `packages/workflowleaf-runtime` (loader, store, gates, worker,
CLI, adapters). Plus `scripts/workflowleaf/` (the fork-ownership gate).

The user-level skill at `~/.claude/skills/workflowleaf/SKILL.md` is a pointer to
this file and holds nothing else. CI cannot read a file in the home directory,
so anything a check enforces has to live with the code.

## Setup, every session

```bash
cd ~/.t3/worktrees/t3code/<your-worktree>
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PWD/node_modules/.bin:$PATH"
```

Node 24 is required; the system node is 22 and will fail. If `vp` is missing,
run `pnpm install` first.

## Verify like this, and only like this

```bash
vp test run packages/workflowleaf-core packages/workflowleaf-runtime scripts/workflowleaf
vp run --filter @t3tools/workflowleaf-core typecheck
vp run --filter @t3tools/workflowleaf-runtime typecheck
node scripts/workflowleaf/check.ts        # fork ownership, imports, orientation, enablement
```

**Never run repo-wide checks** (`vp check`, `vp run -r test`) — CI owns those,
and AGENTS.md says so.

## Six things that will bite you

1. **The Effect language service is enforced, not advisory.** No `node:fs`,
   `node:path`, `node:child_process`, `console.log`, `new Date()`, `Date.now()`,
   `JSON.parse`/`JSON.stringify`. Use `effect/FileSystem`, `effect/Path`,
   `effect/Console`, `effect/DateTime`, `Schema.fromJsonString`, and
   `ChildProcess` from `effect/unstable/process`. Test files that genuinely need
   node builtins use the repo's own pragma: `// @effect-diagnostics nodeBuiltinImport:off`.
2. **The ownership gate fails any upstream file you edit** without an entry in
   `scripts/workflowleaf/ownership.json` giving a purpose and a removal
   condition, and `maxUpstreamEdits` caps how many such entries may exist at
   all. Today two upstream files are touched: `pnpm-lock.yaml`, which pnpm
   regenerates, and one `@import` line in `CLAUDE.md` that carries
   `FORK-RULES.md` to every agent in the repository. Adding a third is a
   decision, not a detail; the whole fork strategy rests on that number staying
   small.
3. **Core must import nothing.** No T3, no filesystem, no environment, no
   clock, no provider name. A test asserts this against the source with
   comments and strings stripped. Digests and timestamps are inputs.
4. **Effect 4 is not Effect 3.** `Effect.fork` is `Effect.forkChild`,
   `Effect.either` is `Effect.result`, `Config.string` is `Config.String`. Read
   `.repos/effect-smol/LLMS.md` before writing Effect code.
5. **A stage declares a scope split by writing `.workflowleaf/scope-split.md`.**
   The worker reads it after every settlement and the run stops before the next
   stage. Nothing infers a split from the size of a diff, and the file lives
   under a snapshot exclusion so declaring one disturbs no gate.
6. **`it.effect` uses a test clock.** Anything that sleeps for real needs
   `it.layer(layer, { excludeTestServices: true })`.

## Design rules that outrank convenience

- **Prefer a script to a paragraph.** A rule the model must remember fails
  silently on a bad day; a rule that executes cannot. Determinism first, model
  judgment as the escalation path.
- **Additive on top of T3.** No provider-adapter edits, no new orchestration
  events, no decider or projector changes. A change that needs one of those
  ends the experiment that asked for it. This is the rule the fork rests on,
  so it also lives in `FORK-RULES.md`, which `CLAUDE.md` imports for agents
  that never load this file.
- **No model writes evidence.** Gates are run by code and their results
  recorded by code. There is deliberately no "mark passed" path.
- **Evidence is bound to inputs**, never to a timestamp: a snapshot id, a gate
  digest, and the digests of what it read.
- **Simplicity.** If a new abstraction is going in, say out loud what breaks
  without it.

## What cannot be mechanized

"Prefer a script to a paragraph" has a limit, and pretending otherwise produces
checks that are worse than the habits they replace. A check that guesses wrong
does not merely fail to help; it teaches everyone to route around it, and it
takes the real rule down with it.

These stay human judgment on purpose. Do not write a gate for them.

- **Whether a stage prompt asks for the right thing.** A prompt can be well
  formed, pass every schema, and still describe work nobody wanted.
- **Whether a scope split is genuine.** A stage declares one by writing the
  file. Nothing infers a split from a diff size, because the size of a change
  and the shape of a story are unrelated.
- **Whether an `allowedUpstreamEdits` removal condition is honest.** A script
  can insist the field is non-empty. Only a reader can tell whether the
  condition will ever be true.
- **Whether a gate's failure message helps the next person.** Gate exit codes
  are checkable; whether the text names the fix is not.
- **Whether a playbook leans on model judgment where a gate would do.** This
  was proposed as a check and deliberately rejected: "a gate would do here"
  has no mechanical definition, and a heuristic that guesses wrong teaches
  authors to phrase around it. The learning log catches these on real runs,
  where a human can see what actually broke.

When one of these goes wrong, the answer is a note in the learning log and a
conversation, not a new script.

## Keep this file honest

Onboarding material that lies is worse than none, so this is a check rather
than a habit. `check.ts` fails a commit that touches a layout-defining path
without also touching this file. The path set is `orientation.layoutPaths` in
`ownership.json`, and it covers the domain shape, the CLI commands, the profile
schema, the adapter directory and the ownership rules themselves.

The escape hatch is a commit message containing `orientation-unchanged: <reason>`.
It is deliberately cheap, because a change that genuinely does not affect
orientation should be able to say so in one line, and deliberately visible,
because the reason stays in the history if the claim turns out to be wrong.

Each commit is judged on its own diff and its own message. A range-wide rule
would let one commit's hatch excuse a sibling that really did move the domain
shape, and let one orientation edit cover every later change on the branch;
both were observed before the rule was tightened. So update the orientation in
the same commit, or say in that commit why you did not.

The gate reads commits, not the working tree, because the hatch is a commit
message. The ownership gate still covers uncommitted work, since its escape
hatch is a file you can edit right now.

## Committing

```bash
git -c user.name="Simon Paris" -c user.email="simondadiamond@gmail.com" commit ...
```

The repo is already configured this way. Conventional commit titles. Never push
to `upstream`.

Push work to `origin` as it lands rather than sitting on it. Work branches are
named by the worktree, `t3code/<something>`, and nothing depends on the name.
The fork checks run on pull requests and on pushes to `main`, so a pushed branch
gets no CI until it has a pull request open.

**T3's own CI never runs on this fork, and waiting for it wastes your time.**
Every job in `.github/workflows/ci.yml` asks for a Blacksmith runner
(`blacksmith-8vcpu-ubuntu-2404` and friends), a paid service the upstream
organisation subscribes to and this fork does not. Those jobs queue forever;
no CI run here has ever completed. The WorkflowLeaf workflow is on
`ubuntu-latest`, which is the only reason it runs, so keep it that way. Check
`runs-on` before believing a queued job will start. The WorkflowLeaf job is
the signal that counts, and repo-wide checks stay a local, scoped exercise.

**Opening a pull request against `main` is pre-authorized here.** AGENTS.md
tells agents never to open one unless asked; Simon has asked, standingly, for
this fork. Open it once the work is ready and let CI run the gates. This covers
`origin` only. Never open one against `upstream`, and merging stays his call.

WorkflowLeaf is `main` now. It is the branch the work lands on, and
`git merge upstream/main` into it stays a normal merge: what keeps upstream
mergeable is the ownership gate, not a side branch. There is no
`workflowleaf/main` any more.

`gh` has two accounts on this machine and Simon switches the active one for his
own work, so never rely on it and never switch it yourself. This repository
carries its own:

```bash
export GH_CONFIG_DIR=$HOME/.workflowleaf/gh   # authed as simondadiamond, only
```

`git push` needs nothing: the repository's local credential helper already
pins that config dir, so a push authenticates as `simondadiamond` whichever
account `gh` happens to be on. Only the `gh` command itself needs the variable.
A session started after this was set up gets it from
`.claude/settings.local.json`; one that did not, prefixes the command.

## Where to start

`gh issue list --repo simondadiamond/workflowleaf --label p0`

The five p0 issues are mostly independent, with two couplings worth respecting:

- **#4** (per-check entry point in `lane-dod.sh`) is fully independent and about
  an hour. It deletes duplication introduced during the first build. Good first
  task. Strictly additive: no existing check may stop running.
- **#5** (worker meets the live T3 adapter) is the untested seam and the gate on
  any real use. Do it early. The live recipe is in
  `~/.workflowleaf/notes/T08-live-seam-findings.md`.
- **#3** (run = story = pull request) changes run identity, so land it before
  **#1** (the story skill), which reports against it.
- **#2** (genericize the playbook) touches the same playbook as #3. Do not run
  both at once.

**Dogfooding starts at #26, not #21.** #26 is the first real story end to end,
gated only on #5, #3 and #1; the Marketplace playbook at
`~/.workflowleaf/playbooks/fbm-t1/` already validates and compiles as-is, so it
does not wait for the playbook to be made generic. #21 is the later ten-story
comparison against a baseline — the measurement, not the start. Run real stories
as soon as those three land and let #6 (the learning log) collect what breaks.

## Driving it today

```bash
node packages/workflowleaf-runtime/src/bin.ts validate <playbook-dir> --profile <name> --input k=v
node packages/workflowleaf-runtime/src/bin.ts compile  <playbook-dir> --profile <name> --input k=v
node packages/workflowleaf-runtime/src/bin.ts run      <playbook-dir> --profile <name> --story issue-42 --input k=v
node packages/workflowleaf-runtime/src/bin.ts status
node packages/workflowleaf-runtime/src/bin.ts status --pr 1234
```

`run` takes `--story`, falling back to the `issue` input, and derives the run id
from it. There is no `--id`.

`resume`, `pause`, `cancel` and `decide` take `--revision` and refuse when the
run has moved since you looked.

## What is proven and what is not

**Proven:** the loader, controller, store, gates and worker against fake and
file-writing executors; the run-id ordinal and the scope-split stop, end to end
through the worker; and the worker driving the live T3 adapter end to end
(#5) — a two-stage run and a one-stage run with a deliberate gate failure, its
correction delivered as a second turn on the same thread, and the run finishing
green, with zero upstream files changed.

**Not proven:** opening a real pull request through `gh` — the git half is
tested, the `gh` half has never run; a second provider (#16); recovery against
a live server (#18); and any real story end to end.

Six bugs have been found only by running against a real server, none of them
visible from reading the handler: a wrong payload shape, a nested field read
flat, a subscription attached after dispatch instead of before, a subscription
attached before the thread existed (which deadlocked), corrections that named
no evidence, and a gate that could not start taking the whole run down. Prefer
a live check to an argument.
