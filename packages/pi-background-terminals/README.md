# pi-tian-background-terminals

Start, inspect, and stop long-running background shell processes from inside
the [pi coding agent](https://pi.dev).

The model can kick off a dev server, build, or watcher, keep working, and be
notified **exactly once** when the process exits — with the final output. It
can peek at output at any time and kill a process, but it can **never** write to
a process's stdin (processes are launched with `stdin: "ignore"`; there is no
input surface at all).

```text
■ 2 background terminals running • /ps to view
```

## Tools (for the model)

- **`bg_start`** — start a shell command in the background (`command`, `title`,
  optional `working_dir`). Fire-and-forget: returns immediately with an id such
  as `bt-1`, and a follow-up message with the final output arrives when the
  process exits. Max **8** running at once.
- **`bg_status`** — peek at one terminal's status and current output
  (tail-truncated), without blocking.
- **`bg_list`** — list all tracked terminals (running and settled) with pid,
  elapsed time, exit status, and output sizes.
- **`bg_kill`** — stop one or more terminals (SIGTERM to the whole process tree,
  escalating to SIGKILL). Returns each terminal's final state.

## `/ps` viewer

While ≥1 terminal is running, a one-line widget renders directly above the
editor. `/ps` opens a two-stage full-screen overlay:

1. **List** — every tracked terminal; `↑/↓`/`j`/`k` select, `Enter` inspect,
   `x` kill the selected running terminal, `Esc` close.
2. **Detail** (read-only) — metadata header, a `t`-toggled stdout/stderr view
   with a live tail, scrolling (`↑/↓`, `PgUp/PgDn`, `g`/`G`), and `x` to kill.

## How it works

- **Exactly-once completion, no polling.** On exit the model is woken via
  `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`. Delivery
  is keyed by terminal id in a drain-once map, and a `consumed` flag suppresses
  the auto-message when `bg_kill`/`bg_status` already returned the final state —
  so a completion is never delivered twice or mid-turn.
- **Bounded memory + full capture.** Each stream keeps a 2 MiB in-memory tail
  (head-dropped on a UTF-8 boundary) and spills the complete log to an
  owner-only file (`0600` in a `0700` per-session temp dir). Everything shown to
  the model is tail-truncated with pi's truncation utilities; the `/ps` viewer
  and spill files hold the rest.
- **Process-tree kill.** On POSIX children run in their own process group
  (`detached: true`) so a kill signals the whole tree (dev servers,
  grandchildren); Windows uses `taskkill /T`. Termination escalates
  SIGTERM → 2 s → SIGKILL.
- **Settle on stream close.** The completion notification fires on the child's
  `close` (stdio flushed), not `exit`, so the final output tail is always
  present.
- **Session-scoped.** Terminals do not survive `/new`, `/resume`, `/fork`,
  `/reload`, or quit — the session teardown kills every process tree and removes
  the spill directory.

The async core is built on [Effect](https://effect.website) v4 (a
`ManagedRuntime` holding one `TerminalManager` service); Node's `child_process`
stream plumbing stays plain callbacks. See
[`docs/implementation-guide.md`](./docs/implementation-guide.md) for the full
design.

## Install

```bash
pi install npm:pi-tian-background-terminals
```

Restart pi or run `/reload` afterwards.

## Development

This package uses Effect v4 (beta) and therefore TypeScript 7 (`tsgo`), so it is
built and checked in isolation from the rest of the repo:

```bash
npm install -w pi-tian-background-terminals
cd packages/pi-background-terminals
npm run check   # tsc (TS7) --noEmit
npm test        # node --test across manager/output/prompt/result-delivery/ps
```

## Credits

Ported from [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/background-terminals).

## License

MIT
