# WorkflowLeaf fork ownership

This fork adds WorkflowLeaf on top of T3 Code and keeps taking upstream
updates. That only works if every change is either a new file in a
WorkflowLeaf-owned location or an upstream file we edit on purpose, with a
written reason and a condition for removing the edit again.

`ownership.json` records those lists plus the import boundaries, the
orientation rule and the enablement rule. `check.ts` enforces all of them.

`FORK-RULES.md` states the additive rule in short form. `CLAUDE.md` imports it,
so an agent working anywhere in this repository is told the fork stays additive
without having to find this directory first. That import is itself one of the
two recorded upstream edits.

```bash
node scripts/workflowleaf/check.ts              # against the recorded upstream base
node scripts/workflowleaf/check.ts --base HEAD~1
node scripts/workflowleaf/check.ts --orientation-base origin/main
```

The check fails when:

- a file outside every owned prefix is modified or deleted and is not in
  `allowedUpstreamEdits`;
- a new file appears inside an upstream directory (new files are how a fork
  stops being additive without anyone noticing);
- `allowedUpstreamEdits` has more entries than `maxUpstreamEdits`;
- `packages/workflowleaf-core` imports T3, the filesystem, the environment or
  an ambient clock;
- anything under `packages/workflowleaf-runtime` outside `src/adapters/t3/`
  imports a T3 package;
- an upstream workspace manifest depends on a WorkflowLeaf package, or an
  allow-listed upstream source file imports one (conformance case C14: T3 has
  to keep building with WorkflowLeaf deleted);
- a commit moves a layout-defining path without updating `ORIENTATION.md` in
  that same commit.

Each rule set is a pure function in `ownership.ts`, `imports.ts`,
`orientation.ts` and `enablement.ts`, tested against fixture change sets in the
neighbouring `.test.ts` files. Run them with `vp test run scripts/workflowleaf`.

Adding an upstream edit means adding an `allowedUpstreamEdits` entry that says
what it is for and when it goes away, and staying under `maxUpstreamEdits`.
Raising the cap is allowed and leaves a diff. Provider adapters and the
orchestration decider, projector and persistence are never on that list; a
change that needs one of them ends the experiment that asked for it instead.

## The orientation rule

`ORIENTATION.md` is the onboarding document, and onboarding material that lies
is worse than none. `orientation.layoutPaths` lists the paths that define the
layout it describes: the domain shape, the CLI commands, the profile schema,
the adapter directory and these rules. A commit touching one of them must also
touch `ORIENTATION.md`, or carry `orientation-unchanged: <reason>` in its
message.

Every commit in the range is judged alone, on its own diff and its own message.
A range-wide rule would let one commit's hatch excuse a sibling that really did
move the domain shape, and let one orientation edit cover every later change on
the branch. Merge commits are skipped; their changes arrive from commits already
judged.

The rule reads commits rather than the working tree, because the hatch is a
commit message. The range defaults to `origin/main..HEAD`, then `main..HEAD`.
With neither present the rule prints that it skipped; with an explicit
`--orientation-base` that does not resolve it fails, so CI cannot go quietly
green.

## merge-rehearsal.sh

Rehearses the next `git merge upstream/main` in a throwaway worktree and
records the upstream SHA, what the merge brought in, the files that conflicted,
the upstream-owned files the fork edits that upstream also changed, whether
the lockfile had to be regenerated, and each check's result and time. The
ownership gate runs with `--base <upstream SHA>` there, because after a merge
the fork's own changes are what sits on top of upstream's tip, not of the
recorded base.

## bin/wl

Runs the CLI from the checkout it lives in. It refuses, and names the command
that fixes it, when that checkout has no dependencies installed or its
`pnpm-lock.yaml` differs from the copy pnpm keeps of the lockfile it installed
from, which is what a pull that moved dependencies leaves behind.

## skills/

Skills that drive WorkflowLeaf live here rather than in a home directory, so a
flag rename and the file that types that flag move in one commit. Claude Code
only discovers skills under `~/.claude/skills`, so each one is linked into
place once:

```bash
ln -sfn "$PWD/scripts/workflowleaf/skills/wl-story" ~/.claude/skills/wl-story
```

Point the link at a checkout that outlives the work. A link into a throwaway
worktree stops resolving the day the worktree is removed, and a skill that
silently stops existing is worse than one that was never installed.
