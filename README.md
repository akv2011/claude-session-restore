# Claude Session Restore

Bring back the Claude Code sessions you had open in VSCode before a shutdown,
and manage every chat across every project from one window.

Two problems, one tool:

1. **Restore.** You work with several `claude` sessions in separate VSCode
   terminals. After a shutdown you reopen each one by hand. This brings them all
   back, the way a browser restores tabs.
2. **Delete.** The CLI can name a chat but gives you no way to see them all and
   remove the finished ones. There are 235 sessions and 1.15 GB of transcripts on
   the machine this was built on, and nothing prunes them.

## Why a recorder is unavoidable

Every running `claude` process writes `~/.claude/sessions/<pid>.json`:

```json
{ "pid": 46821, "sessionId": "1deb9f98-...", "cwd": "/Users/you/Projects",
  "name": "Session_restore", "status": "busy", "procStart": "Sat Aug  8 19:11:23 2026" }
```

**Claude deletes these files on exit.** A scan found 9 files, all mapping to
living PIDs, and zero left over from the previous shutdown. So after a shutdown
there is nothing on disk describing what had been open, and no tool can work it
out after the fact.

The recorder therefore polls that registry every 5 seconds while you work and
keeps its own durable snapshot at `~/.claude-restore/state.json`. Nothing else in
this repo matters if that is not running.

## Install

```sh
bun install          # or npm install
node bin/csr.js daemon install    # arm the recorder (launchd, survives reboot)
```

Remove it any time with `node bin/csr.js daemon uninstall`.

### Recorder cost

Two modes, measured on an M4 Pro:

| Mode | Resident RAM | Cost | Snapshot staleness |
| --- | --- | --- | --- |
| `interval` (default, 30s) | **0 MB** | one ~90 ms tick per interval | up to 30s |
| `--resident` | 33-42 MB (node), 27-31 MB (bun) | 0.0% CPU | up to 5s |

Interval mode is the default because the ~40 MB of resident mode is the Node
runtime's floor, not the work: a tick reads nine small JSON files. Verified over
75 seconds of sampling, an armed interval recorder had a resident process in
**0 of 15 samples** while the snapshot still advanced on schedule.

Staleness is close to irrelevant here. Sessions live for hours, and the
`lastNonEmpty` fallback already covers the case where processes die just before
the final poll.

```sh
node bin/csr.js daemon install --interval 60   # even lazier
node bin/csr.js daemon install --resident      # 5s granularity, ~40 MB
node bin/csr.js daemon status                  # armed? mode? last capture?
```

`status` reports `armed` from whether launchd has the agent loaded, not from a
PID. In interval mode nothing is resident between ticks, so a PID check would
report a perfectly healthy recorder as off.

## Use

```sh
csr list             # every chat, grouped by project, with real names
csr live             # what is running right now
csr restore          # dry run: what would come back
csr restore --yes    # write .vscode/tasks.json and open VSCode
csr delete Old_spike        # dry run: every file that would go
csr delete Old_spike --yes  # move them to Trash
```

Delete and restore are dry runs until you pass `--yes`.

The GUI is the same thing in a window:

```sh
bunx electrobun build
open "build/dev-macos-arm64/Claude Session Restore-dev.app"
```

## How restore works, without an extension

VSCode runs tasks on folder open via `runOptions.runOn: "folderOpen"`, giving
each its own terminal. So restore just writes a `tasks.json`:

```json
{ "label": "claude: Session_restore", "type": "shell",
  "command": "claude --resume '1deb9f98-...'",
  "runOptions": { "runOn": "folderOpen" },
  "presentation": { "panel": "dedicated", "group": "claude" } }
```

Open the folder and VSCode spawns the terminals itself. Starts are staggered a
few seconds apart so nine sessions do not launch in the same instant. Your own
tasks are preserved; only labels beginning `claude: ` are rewritten.

### Two gates that fail silently

Writing `tasks.json` proves nothing on its own. Both of these must hold, and
neither reports anything when it does not:

**1. `task.allowAutomaticTasks` must be `"on"` in USER settings.** VSCode's own
schema marks it `scope: 1` (APPLICATION), the same scope as `update.mode`, and
application-scoped settings are read only from user settings. A copy in the
project's `.vscode/settings.json` is read by nobody. Run:

```sh
csr autotasks     # patches user settings.json in place, keeps comments, backs it up
```

**2. The folder must be trusted.** VSCode's `RunAutomaticTasks` returns before it
even looks at the setting when `isWorkspaceTrusted()` is false, so a folder you
have never opened does nothing at all until you answer the trust prompt.

Verified by experiment rather than assumption: an identical probe task never
fired in an untrusted folder and fired in 4 seconds in a trusted one.

Also worth knowing: `folderOpen` fires when a folder is *opened*, not when an
already-open window is focused. Restore is for a fresh boot. If VSCode is already
sitting on the folder, close that window first.

### Where the terminals appear

```sh
csr layout          # show current
csr layout view     # bottom terminal panel
csr layout editor   # editor tabs, splittable side by side
```

VSCode has no per-task location option (microsoft/vscode#212070 is open), so this
is the single global `terminal.integrated.defaultLocation`. Leaving it unset is
what makes a restore land split across both places: VSCode puts each terminal
back wherever it last was.

## What delete actually removes

Deleting the transcript alone leaves four other stores behind. All of these are
keyed by session id:

| Path | Notes |
| --- | --- |
| `projects/<dir>/<sid>.jsonl` | the transcript |
| `projects/<dir>/<sid>/subagents/` | subagent transcripts, 272 KB to 824 KB each |
| `session-env/<sid>/` | 66 present |
| `file-history/<sid>/` | 62 present |
| `tasks/<sid>/` | 21 present |
| `history.jsonl` | matching lines pruned |

`shell-snapshots` is **not** session keyed and is never touched.

Everything is moved to `~/.Trash`, never `rm`ed, and a chat with a live PID
cannot be deleted at all.

## Two bugs worth knowing about

Both were found against real data and both are covered by tests.

**`procStart` is UTC, `ps lstart` is local.** Liveness needs a PID-recycle check,
which means comparing the recorded start time to the real one. Compare them
naively on a +0530 machine and every live session shows a 5.5 hour skew and reads
as dead, so restore silently brings back nothing. The suite runs under
`TZ=Asia/Kolkata` so this cannot regress unnoticed.

**Project directory names are lossy.** Claude maps both `/` and `_` to `-`, so
`/Users/you/Movies/my_project` becomes `-Users-you-Movies-MA-SBI-neur` and
cannot be decoded back. The real `cwd` is read from inside the transcript
instead.

## Layout

```
src/core/      paths, liveness, registry, names, sessions, snapshot, deleter, api
src/restore/   tasks.json generation
src/recorder/  poll loop + launchd agent
src/bun/       Electrobun main process (thin RPC over src/core)
src/mainview/  the window
bin/csr.js     CLI
test/          44 tests, fixtures plus a read-only pass over real data
```

`src/core` is plain ESM with **zero dependencies**, only Node built-ins. That is
what lets the CLI, the Electrobun app, and any future shell share one
implementation, and it is why swapping the window framework costs nothing.

## Limitation

The recorder only knows what it observed. Sessions open before you install it, or
during an outage, are not in the snapshot, and the first boot after install
restores nothing. That is unavoidable: the registry leaves nothing behind.

## Test

```sh
npm test
```
