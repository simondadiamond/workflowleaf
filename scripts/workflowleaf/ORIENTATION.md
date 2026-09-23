# WorkflowLeaf

A staged-run layer on a T3 Code fork. A **playbook** describes how a class of
work is done; a **run** is one story delivered as one pull request; each
**stage** gets a fresh provider context in one shared worktree; **gates** are
checked by code, never by the model being gated; a failing gate corrects inside
the same context.

A run id is the story plus its ordinal, `issue-42-1`. A story that outgrows one
pull request gets `issue-42-2`, so a split never collides. The draft pull
request is opened by code at run start when the profile permits it, and its
number is on the run record. Code marks it ready for review once the stage that
produces `pull-request` passes, when the profile permits that too.

Everything is additive on top of T3 so upstream's main branch keeps merging.

## Where everything is

| What                                        | Where                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Code, branch `main`                         | any worktree under `~/.t3/worktrees/t3code/`                                                                      |
| This document                               | `scripts/workflowleaf/ORIENTATION.md`, the source of truth                                                        |
| The additive rule, for every agent          | `scripts/workflowleaf/FORK-RULES.md`, imported by `CLAUDE.md`                                                     |
| Fork remote                                 | `origin` = `simondadiamond/workflowleaf`, `upstream` = `pingdotgg/t3code` (never push there)                      |
| Backlog                                     | issues on `simondadiamond/workflowleaf`, labelled `workflowleaf` + `p0`–`p3`                                      |
| Private material                            | `~/.workflowleaf/` — never commit any of it to the fork                                                           |
| Seam decision, live findings, skill mapping | `~/.workflowleaf/notes/`                                                                                          |
| Execution profiles                          | `~/.workflowleaf/profiles/*.json`                                                                                 |
| The generic playbook                        | `scripts/workflowleaf/playbooks/implement-pr/`                                                                    |
| The Marketplace playbook                    | `~/.workflowleaf/playbooks/fbm-t1/`                                                                               |
| Skills that drive runs                      | `scripts/workflowleaf/skills/`, linked into `~/.claude/skills` (see the README)                                   |
| `wl` from any directory                     | `~/Repos/t3code/scripts/workflowleaf/bin/wl`, called by full path; it keeps that checkout on `origin/main` itself |
| Whether T3's orchestration V2 is ready      | `scripts/workflowleaf/watch-upstream.sh` reports the four start signals for #23                                   |
| Rehearse the next upstream merge            | `scripts/workflowleaf/merge-rehearsal.sh`, recorded in `~/.workflowleaf/merge-rehearsals.jsonl`                   |
| The sandbox runs are proven against         | `simondadiamond/workflowleaf-sandbox` (private), cloned at `~/.workflowleaf/sandbox/`                             |

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
   A stage reports what it found and did not fix the same way, in
   `.workflowleaf/findings.md`. The worker records it on the run after each
   turn (`wl_findings`, once per text) and clears the file. It is not a gate and
   never changes the run: `status` counts it, `status <run>` lists it under
   `foundNotFixed`, and `wl errors` groups it as `found, not fixed`.
   The worker also records one itself when a file behind a symlink that
   leads out of the worktree changes during a stage (`outside-worktree`). A
   repository whose checkout hook links `.claude` or `.env` to the main
   checkout lets an agent edit files there that no gate, reviewer or pull
   request sees; this makes that visible, it does not stop it.
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

**T3's own `ci.yml` never runs on this fork, and is disabled.** Every job in it
asks for a Blacksmith runner (`blacksmith-8vcpu-ubuntu-2404` and friends), a
paid service the upstream organisation subscribes to and this fork does not, so
its checks would sit queued on every pull request forever. Editing their
`runs-on` would be a permanent upstream edit in the file upstream changes most.
Instead, `scripts/workflowleaf/disable-paid-workflows.sh` turns off, as a
repository setting, every workflow with a Blacksmith job. The fork-owned
`.github/workflows/workflowleaf-housekeeping.yml` runs it on every push to main
and every pull request, so a workflow an upstream merge brings in is turned off
too. Nothing in upstream's files changes, so merges stay conflict-free. A
workflow GitHub has never registered cannot be disabled until it first runs,
so one queued check can still appear once on the pull request that triggers it.
`.github/workflows/workflowleaf-t3.yml`, also fork-owned, runs T3's Check
(lint, format, typecheck), its package tests and its three server test shards
on `ubuntu-latest`. Those jobs are named `T3 check`, `T3 test` and
`T3 test server`. With the WorkflowLeaf job they are the signals that count.
Keep every fork workflow on `ubuntu-latest`.

**Rehearse before merging upstream.** `scripts/workflowleaf/merge-rehearsal.sh`
merges `upstream/main` into a throwaway worktree of `origin/main`, reinstalls,
runs the WorkflowLeaf checks and T3's own typecheck and tests (`--quick` skips
T3's), and appends what it found to `~/.workflowleaf/merge-rehearsals.jsonl`.
It touches no branch. Git merges `pnpm-lock.yaml` as text, and a merge with no
conflict can still leave a lockfile pnpm rejects; regenerate it with
`pnpm install --no-frozen-lockfile`, which the rehearsal does and records. Two
rehearsals in a row that conflicted or failed a check mean the seam needs
review before the merge, and the script says so.

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
node packages/workflowleaf-runtime/src/bin.ts validate [playbook-dir] --profile <name> --input k=v
node packages/workflowleaf-runtime/src/bin.ts compile  [playbook-dir] --profile <name> --input k=v
node packages/workflowleaf-runtime/src/bin.ts run      [playbook-dir] --profile <name> --story issue-42 --input k=v
node packages/workflowleaf-runtime/src/bin.ts status [run]
node packages/workflowleaf-runtime/src/bin.ts status --pr 1234
node packages/workflowleaf-runtime/src/bin.ts resume <run> --profile <name> [--poll 120]
node packages/workflowleaf-runtime/src/bin.ts errors --since 30d
node packages/workflowleaf-runtime/src/bin.ts replay [run]
node packages/workflowleaf-runtime/src/bin.ts requests <run> --profile <name>
node packages/workflowleaf-runtime/src/bin.ts answer <run> <request> accept|decline --profile <name>
```

The playbook directory is optional. Without one, the profile's
`defaultPlaybook` is used, and a command with neither fails rather than
guessing. A playbook is copied between repositories and shared, so the path it
sits at belongs to the profile, which is the local half of the pair. Passing a
directory still wins, because one repository has more than one playbook.

`run` takes `--story`, falling back to the `issue` input, and derives the run id
from it. There is no `--id`. Without `--base` it fetches the profile's
`pullRequest.baseBranch` and branches from `<remote>/<baseBranch>`, so a run
starts from what its pull request targets, not from whatever the profile's
checkout has checked out. A profile with no `pullRequest` falls back to `HEAD`.

`resume`, `pause`, `cancel` and `decide` take `--revision` and refuse when the
run has moved since you looked. The number is on the run: `status` carries
`revision` in both its detail forms.

A run in `running` that no worker holds a lease on shows as `running, stale`
in `status`, with `stale: true` in its detail. Nothing will move it until
someone resumes or cancels it.

`cancel` commits the cancel and nothing else. It never reconciles or starts a
stage, so it works on a run whose executor is gone. A stage still in flight is
interrupted if its executor answers, and its operation is closed either way.

Every command that drives a run prints a line as each stage starts, each gate
returns a verdict and each stage settles. The lines are read off the records
either side of each commit, so they report what was persisted and never what
was merely attempted. The same lines are appended to
`~/.workflowleaf/runs/<run>/progress.log`, and `status <run>` shows the last of
them, so a second terminal or an agent between turns can see how far a run has
got while another process is still driving it. A gate verdict carries the first
line of its detail when it did not pass, and always for an external gate,
because "passed" alone does not say what GitHub showed.
`run` writes a `run starting` line to the progress log before it opens the worktree and
the pull request, so `status <run>` in the seconds before the run record
exists says the run is starting instead of that there is no such run.

On a T3 executor each stage is a thread titled `WorkflowLeaf <run> <stage>`.
When the next stage starts, the adapter settles the run's earlier stage
threads with T3's own `thread.settle` command, so one stage thread per run is
active in the sidebar. The settled ones stay readable under Settled (#47).

`replay` feeds a run's recorded transitions back through the controller from
its initial state and fails at the first transition whose effects or revision
differ, or on a different final state. With no run it replays every run in the
store, so run it after changing `controller.ts`: a change that alters what a
past run would have done fails there instead of on the next live run. The ids
a transition mints are handed back from what the run recorded, so changing the
id scheme does not break replay; minting an id the run never recorded does.

A run that stops on a decision asks for it where T3 already shows work
waiting on you. Through a T3 profile it opens a thread named
`WorkflowLeaf decision: <run>` in the run's worktree, in `approval-required`
mode, whose one turn puts the question to the user with the provider's question
tool. The thread shows as awaiting input and sends the usual device alert. The
answer is read from T3's record of the reply (`user-input.resolved`), never
from what the model says. `wl resume <run> --poll 30` waits on that thread and
resumes the run once someone answers. `wl decide` still works, and takes the
thread's question down when it does. Each decision is recorded in the store's
`wl_decisions` against the visit that raised it, with where it was asked and
where it was answered, so the record does not depend on the thread. Only a
provider can open a question, which is why this spends one short model turn;
an executor with no provider behind it asks nowhere but the terminal.

`errors` is the learning log. It is derived from what runs already recorded
(failed evidence, raised decisions, human answers, limitations) and grouped by
cause, so there is no second writer to forget.

## Profiles that reach real systems

A T3 executor names its bearer token by `tokenEnv`, by `tokenFile`, or both.
The environment variable wins when it is set. `tokenFile` lets a run start
without exporting anything first. Tokens live in `~/.workflowleaf/tokens/`,
mode 0600, and last 30 days. To mint one, run `t3 pair --base-dir <home>`,
then exchange the pairing token at `POST /oauth/token`.

`ghConfigDir` names the `gh` config for a repository whose account is not the
active one. FBM's is `~/.fbm/gh` (`autoParis`). WorkflowLeaf's own `gh` calls
and command gates use it, and each stage prompt tells the agent to. The active
account is never switched.

`permissions` holds four flags, all false unless granted:
`createPullRequest`, `commentOnPullRequest`, `merge` and `liveCanary`, plus
`markPullRequestReady`, which may be left out and then means false. They
cover what WorkflowLeaf itself does outside the worktree. `markPullRequestReady`
exists because review bots commonly skip drafts: FBM's do, so a run that leaves
its pull request a draft is never reviewed. `fbm` has it on. What an agent may do
inside it is the executor's `runtimeMode` (T3's own four modes) and the
provider's approvals. With `approval-required`, a stage's provider asks before
acting: `wl requests <run>` lists what it is waiting on and `wl answer` accepts
or declines, or answer in T3 itself. A request whose provider session ended
without closing it is shown as expired and never answered as if it were live.
A profile that still carries the retired `deploy` flag loads; the key is
dropped.

An agent with `gh` can do what those flags describe, so every stage prompt
also says what the profile permits on GitHub: no issues ever (findings go in
`.workflowleaf/findings.md`), no pull request comments, reviews or thread
replies unless `commentOnPullRequest`, and no merge unless `merge`. This asks
and cannot enforce. Only the provider's approvals stand between an agent and a
`gh` call. The fixer loop replies to review threads, so a profile that wants
it needs `commentOnPullRequest`; the sandbox profiles have it, `fbm` does not.

`fbm` drives the live T3 install against FB-marketplace-uploader and opens
draft pull requests against `staging`. `sandbox-live` drives the live install
against the sandbox. The other `sandbox*` profiles drive a dev server.

## Path-triggered skills

A stage's `lazyRules` map path globs to skills in its `skills.lazy`; `wl
validate` rejects a rule that loads anything else. The rules are matched
against the paths the run has actually changed since its base revision, plus
what the stage declares it produces, at dispatch and again when each turn
settles. A skill that turns up only at settlement means the stage wrote
something it was not briefed for, so the run refreshes the stage with the skill
before any gate runs: a second turn in the same context, or a fresh context
carrying the same message when the executor cannot continue one, which is
recorded as a limitation. A refresh does not spend an attempt. Each visit
records the skills it has been given in `skills`, so none is given twice.

## How each gate type is judged

No gate reads the worktree until it has stopped changing. A settlement only
speaks for the executor's own turn, not for a process that turn left running,
so the worker waits for two snapshots two seconds apart to agree
(`DEFAULT_QUIET` in `worker.ts`). A tree still changing after three minutes is
not judged: every gate reports `error` naming the paths, and the run stops for
a person without spending an attempt. The before-and-after snapshot around each
gate stays as the safety net, recording a pass on a tree that moved as `stale`.

- `command`, `file`, `diff`: by code, in the run's worktree. A command gate can
  run a script the playbook ships by naming it `${playbook}/checks/x.sh`; the
  loader resolves that against the playbook directory and folds the script's
  content into the gate digest, so editing the check invalidates its evidence.
  Command gates get `WORKFLOWLEAF_BASE_REVISION`, `WORKFLOWLEAF_PR_NUMBER`,
  `WORKFLOWLEAF_RUN_ID` and `WORKFLOWLEAF_WORKTREE` in their environment. The
  generic playbook reads the target repository's `.workflowleaf/commands` at the
  base revision, so a stage cannot loosen the command that checks it.
- `review`: by the profile's `reviewer`, a separate process started by code
  and never the stage's own context. Absent, it is a fresh `claude -p` with
  read-only tools and no user settings. One call per entry in the gate's
  `criteria` (or one for the whole `rubric`), each answering against a JSON
  schema. A reviewer that does not answer in the schema records `error`,
  never a pass.
- `external`: by reading the run's pull request through `gh`, bound to its
  head commit and compared with the worktree's HEAD. `pull-request-exists`,
  `checks-green` and `converged-on-head` exist. An unresolved condition (CI
  running, a reviewer yet to answer) records `pending`: the run parks in
  `waiting_external` and `resume` checks again. `--poll <seconds>` keeps
  checking for up to `--poll-for` minutes. `converged-on-head` also needs a
  submitted review of the head by someone other than the pull request's
  author, because "nothing outstanding" is also what a pull request nobody
  looked at shows, and `SKIPPED` checks prove nothing was reviewed (#42). A
  repository with no reviewer sets `pullRequest.reviewWaitMinutes` in the
  profile: a ready pull request then converges after that long without one.

A stage that routes back (`correction: route-to`) sends its failing verdicts
with the dispatch, so the stage it returns to starts from the findings rather
than from nothing.

## What is proven and what is not

**Proven:** the loader, controller, store, gates and worker against fake and
file-writing executors; the run-id ordinal and the scope-split stop, end to end
through the worker; and the worker driving the live T3 adapter end to end
(#5) — a two-stage run and a one-stage run with a deliberate gate failure, its
correction delivered as a second turn on the same thread, and the run finishing
green, with zero upstream files changed.

**A real story end to end (#26 on the sandbox).** `issue-1-1` in the sandbox
ran the generic playbook through a live T3 dev server to `succeeded`. It went
through plan, build, an independent review judged per criterion by `claude -p`,
deliver with the pull request body checked by script, and babysit with
convergence read from GitHub. Its draft pull request carries the code and the
body. The `gh` half of opening a pull request is now proven.

The `wl-story` skill (#1) drives a run by hand. It takes a story number,
starts the run, reports each stage and stops when a person is needed.

`issue-3-1` proved the fixer loop live. The run parked on a running CI check,
and a review thread was posted on its pull request. Babysit routed the thread
to build, build fixed it, deliver replied and resolved the thread, and the run
converged with no human step.

`issue-5-1` ran the same playbook and the same controller on Codex
(`gpt-5.6-sol`), with only the profile changed (#16, C12). It corrected two
failing gates inside the same context and succeeded.

A sandbox proof run is finished only when it is cleaned up. Close its sandbox
pull request and issue unmerged, so the sandbox stays at its fixture, and put
back any profile you changed for the proof. A proof that starts stage threads on
the live T3 install leaves them in Simon's sidebar, so archive any the run did
not settle itself.

**Not proven:** a real Marketplace story (#26 proper), which needs a profile
pointing at that repository and the account that can push to it; recovery
against a live server (#18).

Eight bugs have been found only by running against a real server, none of them
visible from reading the handler: a wrong payload shape, a nested field read
flat, a subscription attached after dispatch instead of before, a subscription
attached before the thread existed (which deadlocked), corrections that named
no evidence, a gate that could not start taking the whole run down, run records
from before a field existed failing every `status`, and one dangling symlink in
a skill root failing every load. Prefer a live check to an argument.
