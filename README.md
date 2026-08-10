# Claude Session Restore

Bring back the Claude Code sessions you had open in VSCode before a shutdown, and
manage every chat across every project from one window.

macOS. No VSCode extension.

![tests](https://img.shields.io/badge/tests-56%20passing-brightgreen)
![deps](https://img.shields.io/badge/core%20dependencies-0-blue)

## Why

If you work with several `claude` sessions in separate VSCode terminals, a
shutdown costs you all of them. There is no "reopen last tabs". You find each
folder, open a terminal, and try to remember which conversation was which.

And the CLI can name a chat but gives you no way to see them all and delete the
finished ones, so transcripts accumulate forever. A working machine can easily
carry a couple of hundred sessions and over a gigabyte of them.

## Why a recorder is unavoidable

Every running `claude` process writes `~/.claude/sessions/<pid>.json`:

```json
{ "pid": 46821, "sessionId": "1deb9f98-...", "cwd": "/Users/you/Projects",
  "name": "Refactor_auth", "status": "busy", "kind": "interactive",
  "procStart": "Sat Aug  8 19:11:23 2026" }
```

**Claude deletes these on exit.** Every file maps to a living process; nothing is
left behind from the previous shutdown. So after a shutdown there is no record on
disk of what had been open, and no tool can reconstruct it after the fact.

The recorder therefore samples that registry while you work and keeps its own
durable snapshot in `~/.claude-restore/state.json`. Nothing else here matters if
that is not running.

## Install

```sh
git clone https://github.com/akv2011/claude-session-restore
cd claude-session-restore
npm install                       # or: bun install
node bin/csr.js daemon install    # arm the recorder
node bin/csr.js autotasks         # let VSCode auto-run restored terminals
```

Undo with `daemon uninstall`. Optionally link the CLI:

```sh
ln -s "$PWD/bin/csr.js" ~/.local/bin/csr
```

## Use

```sh
csr list                     # every chat, grouped by project, by real name
csr live                     # what is running right now
csr restore                  # dry run: what would come back
csr restore --yes            # write tasks and open VSCode
csr delete Old_spike         # dry run: every file that would go
csr delete Old_spike --yes   # move them to Trash
csr layout view|editor       # where restored terminals open
csr daemon status            # armed? mode? last capture?
```

Delete and restore are dry runs until you pass `--yes`.

The GUI is the same thing in a window, built on
[Electrobun](https://electrobun.dev). It ships as an 18 MB self-extracting zstd
bundle and occupies about 72 MB once expanded, most of that the Bun runtime. An
equivalent Electron app is 150 MB or more installed.

```sh
bunx electrobun build --env=stable
open "build/stable-macos-arm64/Claude Session Restore.app"
```

## Recorder cost

| Mode | Resident RAM | Cost | Staleness |
| --- | --- | --- | --- |
| `interval` (default, 30s) | **0 MB** | one ~90 ms tick per interval | up to 30s |
| `--resident` | ~40 MB (node), ~29 MB (bun) | 0.0% CPU | up to 5s |

Interval is the default because that ~40 MB is the Node runtime's floor, not the
work: a tick reads a handful of small JSON files. Sampled repeatedly with the
agent armed, an interval recorder had no resident process at all while the
snapshot kept advancing on schedule.

Staleness barely matters. Sessions live for hours, and a `lastNonEmpty` fallback
covers the case where processes die just before the final poll, which would
otherwise overwrite a good restore set with an empty one.

## How restore works, without an extension

VSCode runs tasks on folder open, giving each its own terminal. So restore writes
a `tasks.json`:

```json
{ "label": "claude: Refactor_auth", "type": "shell",
  "command": "claude --resume '1deb9f98-...'",
  "runOptions": { "runOn": "folderOpen" },
  "presentation": { "panel": "dedicated", "group": "claude" } }
```

Open the folder and VSCode spawns the terminals itself. Starts are staggered so a
dozen sessions do not launch in the same instant. Your own tasks are preserved;
only labels beginning `claude: ` are rewritten.

### Two gates that fail silently

Writing `tasks.json` proves nothing. Both of these must hold, and neither reports
anything when it does not:

**1. `task.allowAutomaticTasks` must be `"on"` in USER settings.** VSCode's schema
marks it `scope: 1` (APPLICATION), the same scope as `update.mode`, and
application-scoped settings are read only from user settings. A copy in the
project's `.vscode/settings.json` is read by nobody. `csr autotasks` puts it in
the right place, patching JSONC textually so comments and formatting survive, and
backing the file up first.

**2. The folder must be trusted.** VSCode's `RunAutomaticTasks` returns before it
even inspects the setting when `isWorkspaceTrusted()` is false, so a folder you
have never opened does nothing at all until you answer the trust prompt.

An identical probe task never fired in an untrusted folder and fired in about
four seconds in a trusted one.

Also: `folderOpen` fires when a folder is *opened*, not when an already-open
window is focused. Restore is for a fresh boot.

### Where terminals appear

VSCode has no per-task terminal location option
([microsoft/vscode#212070](https://github.com/microsoft/vscode/issues/212070)),
only the global `terminal.integrated.defaultLocation`. Left unset, VSCode puts
each terminal back wherever it last was, which makes a restore land split across
the panel and the editor. `csr layout view|editor` pins it.

## What delete actually removes

Deleting the transcript alone leaves four other stores behind. All are keyed by
session id:

| Path | |
| --- | --- |
| `projects/<dir>/<sid>.jsonl` | the transcript |
| `projects/<dir>/<sid>/subagents/` | subagent transcripts |
| `session-env/<sid>/` | per session env |
| `file-history/<sid>/` | edit history |
| `tasks/<sid>/` | task state |
| `history.jsonl` | matching prompt lines |

`shell-snapshots` is **not** session keyed and is never touched.

Everything moves to `~/.Trash`, never `rm`, and a chat with a live PID cannot be
deleted at all.

## Three things that will bite anyone building on this

**`procStart` is UTC, `ps lstart` is local.** Liveness needs a PID-recycle check,
so you compare the recorded start time to the real one. Compare them naively on a
non-UTC machine and every live session shows a whole-hours skew and reads as
dead, so restore silently brings back nothing. The suite runs under a non-UTC
`TZ` so this cannot regress unnoticed.

**Project directory names are lossy.** Claude maps both `/` and `_` to `-`, so
`/Users/you/Code/my_project` becomes `-Users-you-Code-my-project` and cannot be
decoded back. Read the real `cwd` from inside the transcript instead.

**Not everything in the registry is a chat.** The daemon pre-warms background
workers that register themselves identically, with `"kind": "bg"`. They have no
transcript, `claude --resume` on them is meaningless, and counting them inflates
the running total and poisons a restore. Only `kind: "interactive"` is a terminal
a human used.

## Layout

```
src/core/      paths, liveness, registry, names, sessions, snapshot, deleter, api
src/restore/   tasks.json generation, VSCode settings patching
src/recorder/  poll loop + launchd agent
src/bun/       Electrobun main process (thin RPC over src/core)
src/mainview/  the window
bin/csr.js     CLI
test/          56 tests, fixtures plus a read-only pass over a real store
```

`src/core` is plain ESM with **zero dependencies**, only Node built-ins. That is
what lets the CLI and the desktop app share one implementation, and why swapping
the window framework costs nothing.

## Limitation

The recorder only knows what it observed. Sessions open before you install it, or
during an outage, are not in the snapshot, and the first boot after install
restores nothing. That is unavoidable: the registry leaves nothing behind.

## Test

```sh
npm test
```

## License

MIT
