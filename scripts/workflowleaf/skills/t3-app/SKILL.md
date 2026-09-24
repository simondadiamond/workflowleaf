---
name: t3-app
description: Move Simon's installed T3 Code desktop app between the official release and a build of the WorkflowLeaf fork, and back up or restore its data. Use when Simon says "switch to the fork build", "install the fork", "update my T3 app", "rebuild T3", "back up my T3 data", "roll back T3", "go back to the official T3", or asks which T3 build he is running.
---

# t3-app

Simon's T3 Code is a desktop app in `/Applications/T3 Code (Alpha).app`. It
runs either the official release or a build of this fork. Fork features, such
as the Worktrees sidebar view, reach him only through a fork build. Merging a
pull request changes nothing until the app is rebuilt and swapped.

One script does every step that touches the app or its data:

```bash
~/Repos/t3code/scripts/workflowleaf/bin/t3-app <command>
```

| Command          | What it does                                                                                            | Safe while T3 runs? |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------- |
| `status`         | Official or fork build and its version, whether it is running, the latest `.dmg`, the backups           | Yes                 |
| `backup`         | Copies the database (verified) and settings to `~/.t3/backups/<time>-v<version>/`                       | Yes                 |
| `build`          | Pulls `~/Repos/t3code` if it is a clean `main`, then builds `release/T3-Code-<version>-<arch>.dmg`      | Yes                 |
| `switch [dmg]`   | Waits for T3 Code to quit, backs up, keeps the old app in that backup, installs the build, reopens      | No, see below       |
| `rollback [dir]` | Waits for T3 Code to quit, sets aside what is live, restores the app and data a `switch` saved, reopens | No, see below       |

The script never deletes anything and never quits T3 Code. `switch` and
`rollback` wait for Simon to quit it.

## You are running inside the app you are replacing

Quitting T3 Code stops every agent in it, including you and any shell you
started. So `switch` and `rollback` must run in a Terminal window that T3 does
not own. Open one for Simon:

```bash
osascript -e 'tell application "Terminal" to do script "~/Repos/t3code/scripts/workflowleaf/bin/t3-app switch"' -e 'tell application "Terminal" to activate'
```

Then tell him to quit T3 Code when he is ready. The Terminal window waits,
backs up, installs, and reopens the app. Your conversation continues after the
reopen, but a turn in flight when he quits is interrupted.

## Switching to a fork build

1. `t3-app status`. Say which build is installed and whether a `.dmg` exists.
2. If the fork's `main` has changes the installed app does not have, or there is
   no `.dmg`: `t3-app build`. It takes several minutes. Run it in the background. It needs Apple's command line tools and Rust. If the build says Rust is missing, ask Simon before installing it with rustup (`--no-modify-path`); the script finds `~/.cargo/bin` on its own.
   Report the error as it stands if it fails, and stop.
3. Check that it is a quiet moment. Ask Simon whether any thread is working or a
   WorkflowLeaf stage is running (`wl status` with no run lists them). Quitting interrupts
   them. A stopped `wl` run can be resumed, and threads come back after the
   reopen, but work in the middle of a turn is lost.
4. Open the Terminal window with `switch`, as above.

The first time Simon moves from the official release to a fork build, tell him
these before step 4:

- **Updates stop.** A local build has no update feed. Upstream fixes arrive only
  when someone merges `upstream/main` into the fork and he rebuilds.
- **T3 Connect sign-in may not work.** The official build carries T3's sign-in
  keys and a local build does not. Local projects, worktrees and Tailscale do
  not depend on it.
- **The database moves forward.** A fork build can migrate the database past
  what the official release understands. `rollback` restores the database from
  before the switch, so threads created on the fork build are not in it. They
  stay in the set-aside folder.

## Going back

`rollback` with no argument restores the newest backup a `switch` made. Pass a
directory from `t3-app status` to pick another one. Open it in Terminal the same
way as `switch`. What was live moves to `~/.t3/backups/<time>-before-rollback/`,
so a rollback can itself be undone by hand.

## Backing up on request

`t3-app backup` runs inside T3 safely. It reports the folder it wrote. Each
backup is a full copy of the database, a few hundred MB, and nothing prunes them.
Mention the total when `status` shows many.

## Never

- Quit, kill or restart T3 Code yourself. Simon quits it.
- Run `switch` or `rollback` from your own shell.
- Delete anything in `~/.t3/backups` or `~/.t3/userdata`.
- Copy the database with `cp` while T3 runs. `backup` uses `VACUUM INTO` for that
  reason.
