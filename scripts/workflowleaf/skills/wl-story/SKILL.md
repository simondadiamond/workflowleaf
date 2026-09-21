---
name: wl-story
description: Drive one story end to end through WorkflowLeaf, from a story number to an open draft pull request. Use when Simon says "wl-story 1600", "/wl-story 1600", "run story 1600 through WorkflowLeaf", "take this story through the playbook", or asks you to pick a WorkflowLeaf run back up. This is for running stories with WorkflowLeaf; use the workflowleaf skill for changing WorkflowLeaf itself.
---

# wl-story

Simon types a story number. Code creates the run, opens its draft pull request,
and drives the playbook's stages through their gates. Your job is to read the
story, start the run, report what happened, and stop when a person is needed.

A run is one story delivered as one pull request. The run id is the story plus
an ordinal, `issue-1600-1`.

## The division of labour, which is not negotiable

The run does: compile the plan, create the worktree, open the draft pull
request, dispatch each stage into a fresh provider context, run the gates,
write the evidence, feed a failing gate back as a correction, stop.

You do: read the story, start the run, report, and answer questions Simon asks.

You never: write or edit evidence, declare a gate passed, answer a pending
decision on Simon's behalf, mark a pull request ready, merge, or touch the run
store by hand. There is deliberately no command that lets you do any of these.
If you find yourself wanting one, that is a finding to report, not a workaround
to build.

## 0. Setup

Shell state does not survive between commands here, so every command below
carries its own prefix. Node 24 is required; the system node is 22 and fails.

```bash
cd ~/.t3/worktrees/t3code/<worktree>
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
export GH_CONFIG_DIR=$HOME/.workflowleaf/gh   # authed as simondadiamond
```

`wl` below means `node packages/workflowleaf-runtime/src/bin.ts`, run from that
directory. The profile is `fbm` unless Simon names another one.

## 1. Read the story before you start anything

```bash
wl profile show fbm
```

That gives the repository, the playbook this machine runs by default, and the
permissions. Two of them decide whether this run can meet its goal at all:

- `permissions.createPullRequest` off means the run opens no pull request. Say
  so before starting, rather than reporting at the end that there is nothing to
  show.
- `executor.kind: "fake"` means no provider runs anything. Same rule.

Then read the story in full, in the repository the profile names:

```bash
gh issue view <N> --repo <owner/repo> --comments
```

Do not start when any of these hold. Report which one, and stop:

- A WorkflowLeaf run already exists for the story (`wl status` lists them by
  run id). Pick that one back up instead, at §5.
- An open pull request already references the story, or another session holds
  it. Two runs on one story produce two pull requests for one piece of work.
- The story is not code: an account to re-enable, an email to send.
- The story is an epic. Run its oldest open child instead.

The playbook's inputs come from the story. Pass acceptance criteria as the
issue states them. A story with no acceptance criteria is a question for Simon,
not a gap for you to fill in.

## 2. Start the run: one command

```bash
wl run --profile fbm --owner wl-story --story issue-<N> \
  --input issue=<N> --input acceptance_criteria="<verbatim from the issue>"
```

No playbook path. The profile's `defaultPlaybook` is the answer, and typing a
path over it silently runs something other than what this machine is set up to
run. Pass one only when Simon names one.

The command opens the draft pull request before the first stage, prints a line
per stage start, per gate verdict and per stage settlement, and returns when the
run needs a person. A stage can take twenty minutes. Let it.

If it fails before any of that, the failure is about the setup rather than the
work: no profile, an invalid playbook, a lease another worker holds, a dirty
worktree. Report the message as it stands.

## 3. Report after each stage

Use the `story-update` skill's block, one per stage the run completed. Its
stages map onto the playbook's: `plan`, `build`, `review`, `deliver`. Take the
gate verdicts from the run's own output; never restate a gate as passing when
its verdict says otherwise, and never soften `error` into `failed`.

One block per stage, not one per line of output. A stage that corrected itself
twice and then passed is one report, and the corrections are worth a line each.

## 4. When the run stops

`wl run` and `wl resume` end with the run's state and why they stopped. Each
stop has exactly one right move:

| Stopped                       | What it means                                                           | What you do                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `finished`, state `succeeded` | Every stage passed its gates                                            | Report, with the pull request link. Stop.                                      |
| `finished`, state `failed`    | A stage ran out of attempts                                             | Report the failing gate and its evidence. Stop.                                |
| `needs-decision`              | The run is asking a person                                              | §4.1                                                                           |
| `paused`                      | Someone paused it                                                       | Say who, and stop.                                                             |
| `waiting-external`            | A watch stage is waiting on something outside the run, usually a review | Resume when the thing it waits on has moved (§5). Do not poll in a tight loop. |
| `idle`                        | The loop hit its transition bound                                       | Report it as a defect, with the run id. Do not restart it blindly.             |

A pull request being open is not the same as the run having succeeded. Report
both.

### 4.1 A decision, and the scope split

`wl status <run>` names the decision and its kind. Report it with a recommended
answer and end the turn. **Ending the turn is the notification** — that is how
Simon hears about it. Do not answer it, and do not keep working around it.

Simon answers, or tells you to:

```bash
wl decide <run> proceed|waive|abort --profile fbm --owner wl-story --revision <r>
```

The revision is in `wl status <run>`. The command refuses if the run moved since
you read it, which is the point: read it again rather than dropping the flag.

A `scope-split` decision is the one worth reading closely. A stage declared that
findings grew the story past this pull request. The declaration is in
`scopeSplit.detail` on the run. Report it verbatim. Splitting the story is
Simon's call, and a second run of the same story takes the next ordinal, so
nothing collides.

## 5. Picking a run back up

```bash
wl status                                   # every run, its state and its pull request
wl status <run>                             # one run in full, including the revision
wl resume <run> --profile fbm --owner wl-story --revision <r>
```

Under `/loop`, a wakeup is: read `wl status`, resume anything `waiting-external`
whose wait has moved, report anything new, and stop again. A wakeup with nothing
new says nothing.

## 6. Done

An open draft pull request on the run record, and the run in state `succeeded`.
Not a merged one. Simon marks a pull request ready and Simon merges, always.

## 7. Everything you had to do by hand is the output

A stage that needed a nudge, a gate that could not run, a step you did manually
because the run could not: each one is a finding, and it is worth more than the
story. Report it under "Need to know", and file it on
`simondadiamond/workflowleaf` with the `workflowleaf` label when Simon agrees it
should be fixed rather than remembered.
