# Grove

A Mac app for running several Claude Code agents at once, one per feature. Each feature grows in its
own git worktree with its own branch, ports, dev servers and Claude session; Grove shows them side by
side and tells you which one needs you.

![Grove on a demo project: the feature sidebar, the header (state, recap, next step, PR and CI, stage), Claude in the main panel, a service log and a shell on the right](docs/screenshot.png)

## What you get

- **One window per project**, its name at the top of the sidebar; ⇄ opens another project and shows
  how many features need you elsewhere. Grove reopens the projects you had open.
- **Sidebar** (Warp-style): every feature with its state (❗ needs you · ✓ your turn · ⏳ working),
  title, branch and PR/CI. Search (⌘K), **+ New** (⌘N), double-click to rename, right-click for more.
- **Header**: the feature's title, state, a one-line recap, the **next step**, PR / CI / review
  findings, git status, ports and the lifecycle stage (Explore → … → Merged).
- **Main panel**: the feature's live Claude Code session.
- **Panels**: shell, backend and frontend logs, opened on the right (⌘⌥S / ⌘⌥B / ⌘⌥F) and zoomable (⌘⇧↩).
- **Spin-offs**: inside any session, ask Claude to *spin off a related feature*; it writes a handover
  brief, Grove creates the feature and switches to it.
- **Dock badge** with the number of features waiting on you, plus desktop notifications.

Quitting Grove stops nothing: every terminal is a tmux session (`fh_<feature>_<pane>`) that keeps running.

## How it fits together

```
 ┌──────────── Grove.app (Electron) ─────────────┐
 │ sidebar · header · Claude panel · log panels  │   one window per project
 └───────┬──────────────────────────┬────────────┘
   reads state files          attaches terminals
         │                          │
 ~/.grove/                     tmux sessions  fh_<feature>_<pane>
   projects/<p>/<feature>/      (claude · shell · services …)
     feature.json status.json       ▲            ▲
         ▲      ▲                   │            │
   writes│      │writes        starts│            │runs inside
   ┌─────┴──┐ ┌─┴────────────────────┴──┐    ┌───┴─────────────┐
   │ grove  │ │ Claude Code mod          │    │ Claude Code     │
   │  CLI   │ │ (loaded by every session)│◀───│ sessions        │
   └────────┘ └──────────────────────────┘    └─────────────────┘
```

The app only draws; the CLI does the work; the mod reports from inside each Claude session; tmux
hosts every process, so the app can come and go.


| Piece | Where | Role |
|---|---|---|
| App | `main.js`, `preload.js`, `ptybridge.py`, `renderer/` | Electron + React + xterm.js. Reads state from `~/.grove`, attaches terminals to tmux sessions through a tiny Python pty bridge (no native modules) |
| `grove` CLI (`fh`) | `cli/fh` | Python, stdlib only. Projects, worktrees, per-service port allocation, env rewriting, dev servers, PR/CI sync, review-bot findings, ticket briefs, cleanup, `grove doctor` |
| Claude Code mod | `mod/` | Function hooks loaded by every Claude Code session: publishes each session's state, recap and next step, notifications, the `new_feature` tool, `/feature` commands |
| tmux | `fh_<feature>_<pane>` sessions | Hosts every Claude, service and shell process; the app attaches to them and nothing stops when it quits |
| tmux config | `tmux/grove.tmux.conf` | The terminal-only front end (header in tmux's status line), used with `fh ui tmux` |

State lives in `~/.grove/`, one folder per project and per feature:

```
~/.grove/projects/<project>/project.json             your config for the project
~/.grove/projects/<project>/<feature>/feature.json   registry entry
                                     /status.json    session state, written by the mod
                                     /brief.md       the task, until the agent picks it up
                                     /worktree/      the feature's git worktree
```

plus `prs.json`, `theme.json`, `config.json` at the top. A hub from an older version moves over with
`grove migrate` (existing worktrees stay put; their feature folders link to them).

## Projects

Grove works with any git repo. A project config says how to grow a feature from it:

```sh
grove project add ~/code/my-repo     # reads my-repo/.grove.json, or writes a starter config
grove new csv-export                 # in or outside the repo; --project picks one explicitly
```

The config is the repo's own **`.grove.json`** (commit it to share it with your team) merged under
**`~/.grove/projects/<name>/project.json`** (yours; at least `{"repo": "~/code/my-repo"}`).

| Key | What it does |
|---|---|
| `services` | Dev servers, each `{name, dir, run, ports: [lo, hi], reserved, key, hint, open}`. Every feature gets its own port per service; each service is a panel |
| `setup` | Preparing a new worktree: `link` (symlink to the main checkout's copy, e.g. a venv), `clone` (copy-on-write clone, e.g. node_modules), `copy` (e.g. env files), `run` (shell commands) |
| `env` | Rewrites per worktree: `port` points `localhost:NNNN` in a key at a service; `set` sets a whole value (`{web}` = the web port) |
| `labels` | Shows a value from an env file as a label (e.g. which database) and warns on some (e.g. `PROD`) |
| `checks`, `agentNotes` | What Claude should run before finishing, and anything else it should know |
| `base`, `branchPrefix`, `worktrees` | Branch start point, branch naming (`{user}/`), where worktrees go (default: each feature's folder in `~/.grove`) |

See [`examples/nextjs-fastapi.grove.json`](examples/nextjs-fastapi.grove.json).

## Bringing in work that already exists

| You have | Command | What happens |
|---|---|---|
| A worktree you made earlier | `grove adopt <worktree>…` | It becomes a feature: its own ports and env, a title from its PR, a ticket from its branch; services start stopped (`grove up <name>`) |
| A Claude conversation in a main checkout (e.g. an iTerm tab) | `grove sessions`, then `grove adopt --session <id>…` | It appears under **Sessions**; its panel waits for you to `/exit` the old copy, then resumes it with its full history |

Grove can't take over a running process, so a conversation moves by resuming it, and Grove refuses
to start a second Claude on a worktree that already has one.

## Commands

| Command | Does |
|---|---|
| `grove ls` | Features, ports, labels, PR/CI, state, recap → next |
| `grove new <name\|TICKET> [-p task]` | A new feature: worktree, ports, env, services, a briefed Claude |
| `grove adopt …` · `grove sessions` | Bring in existing worktrees or conversations (above) |
| `grove up\|down\|restart <name>` | Start, stop or restart a feature's services |
| `grove rename <name> <title>` | The title shown in Grove |
| `grove done <name>` · `grove clean [--yes]` | Close a feature (worktree kept) · remove merged, clean ones |
| `grove doctor` | Check projects and features: files, deps, ports, env, labels |
| `grove project add\|ls\|default\|show` | Manage projects |
| `grove pr` · `grove findings <name>` | Refresh PR/CI · list unanswered review-bot findings |
| `grove keepawake [on\|off\|--status]` | Keeps the Mac awake while any agent is working (sessions start it; it lets go when all are idle). `off` turns it off |
| `grove theme [palette]` · `grove ui app\|tmux` | Header palette · which front end new features open in |

## Install

```sh
./install.sh                 # links cli/, mod/ and tmux/ into ~/.grove
npm install
npm run install-app          # builds Grove.app into /Applications
```

Then add the settings lines `install.sh` prints, so every Claude session loads the mod.

## Develop

| Task | Command |
|---|---|
| Run from source | `npm start` |
| Rebuild and reinstall the app | `npm run install-app` (quit Grove first) |
| Regenerate the icon from `build/icon.svg` | `npm run icon` |
| Screenshot the app (visual checks) | `FH_SCREENSHOT=/tmp/grove.png npx electron .` |
| Validate / test the mod | `claude plugin validate mod && claude plugin test mod` |

## Keys

⌘1–9 switch feature · ⌘⇧1–9 open project · ⌘⇧O add project · ⌘N new · ⌘E rename · ⌘K find · ⌘⌥S/B/F shell/be/fe · ⌘⇧↩ zoom panel ·
⌘⇧R restart servers · right-click a feature for more · ⌥-drag selects text inside a terminal.
