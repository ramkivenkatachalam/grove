# Grove — working notes for Claude

Grove is a Mac app plus a CLI and a Claude Code mod for running several Claude Code agents side by side,
one git worktree per feature. README.md is the user-facing description; this file is how to work on it.

## Pieces and where they live

| Piece | Source | Live location (symlinked to the source) |
|---|---|---|
| CLI `fh` / `grove` (Python 3, **stdlib only**) | `cli/fh` | `~/.grove/bin/fh`, `~/.local/bin/{fh,grove}` |
| Claude Code mod (function hooks, TypeScript) | `mod/` | `~/.grove/mod`, loaded via `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` |
| Mac app (Electron 44 + React 19 + xterm.js 6) | `main.js`, `preload.js`, `ptybridge.py`, `renderer/` | `/Applications/Grove.app` (a built copy: rebuild to update) |
| tmux front end | `tmux/grove.tmux.conf` | `~/.grove/tmux.conf`, sourced from `~/.tmux.conf` |

Runtime state, never in git: `~/.grove/` — one folder per project, `projects/<p>/project.json`
(per-project config; Numos's is private there), and in it one folder per feature, `projects/<p>/<f>/`
with `feature.json` (registry), `status.json` (written by the mod), `brief.md` and `worktree/` (the git
worktree, or a link to one made before this layout). At the top: `prs.json`, `feedback.json`, `theme.json`,
`config.json` (`ui: app|tmux`, `defaultProject`), `focus.json`. Feature names are unique across projects
(tmux sessions are named by them). The app's file watcher ignores everything under `worktree/`.

How they connect: the app only draws (reads state files, attaches terminals); the CLI does the work; the
mod reports from inside each Claude session; tmux hosts every process (`fh_<feature>_<pane>` sessions).

## Working rules

- **Edit the source here** — the live locations are symlinks, so CLI and mod edits are live immediately.
  Running Claude sessions do *not* hot-reload the mod: restart them (`claude --continue`) to pick changes up.
- **CLI**: stdlib only, no third-party imports. `python3 -m py_compile cli/fh` after edits. Every command
  must stay safe to re-run (host, adopt, provision are idempotent).
- **Mod** (`mod/hooks/register.tsx`), the function-hooks API:
  - A helper that takes `$` must be a top-level function declaration (the validator rejects closures).
  - Type-check: point a scratch tsconfig at the engine's types (the plugin-authoring skill's `types/claude-code.d.ts`).
  - `claude plugin validate mod && claude plugin test mod`. All tests must pass. Add a test for new behaviour.
  - If `claude plugin test` says hooks modules are switched off ("rollout switch saved off"), run
    `claude -p "ok"` once to refresh it, then retest.
- **App**: no native node modules (terminals go through `ptybridge.py`). After renderer edits: `npm run build`.
  Check visuals with a screenshot, not by guessing:
  `GROVE_PROJECT=<name> FH_SCREENSHOT=/tmp/g.png npx electron .` (optionally `FH_SCREENSHOT_JS='…'` to set
  localStorage first, `GROVE_HUB=…` to use a throwaway hub). Then `npm run install-app` (quit Grove first).
- **Test generically**: anything touching projects, worktrees or services gets an end-to-end run against a
  throwaway project with `GROVE_HUB=/tmp/x/hub GROVE_BIN=$PWD/cli/fh TMUX_TMPDIR=/tmp/x/tm` (keep the
  TMUX_TMPDIR path short: tmux socket paths have a length limit). Never test against the user's live hub.
- **Accessibility**: every state carries a word, not just a colour; text ≥ 4.5:1 on its background;
  every click has a key.
- **Commits**: this checkout commits as `ramkivenkatachalam <ramki@utexas.edu>`; no mention of Claude in
  commit messages. Push to `origin` (github.com/ramkivenkatachalam/grove, private). Remote `work`
  (ramki-numosai/grove) and branch `work-main` are frozen history — don't push there.
- **Never put Numos-specific config in this repo.** Project specifics belong in that project's
  `.grove.json` or the user's private `~/.grove/projects/<name>/project.json`.

## Gotchas learned the hard way

- macOS `sleep infinity` exits at once — use `sleep 2147483647`.
- tmux `set-option -t` takes a pane target: write `=<session>:` (with the colon) for a session.
- zsh aborts a whole command line when a glob matches nothing (`rm -f 7-*.svg`): guard or avoid globs.
- Claude Code keeps showing its last status line until it re-runs the command; `fh statusline` therefore
  never prints an empty line in app mode.
- A Claude conversation can only be resumed from the folder it started in (transcripts are stored per
  folder under `~/.claude/projects/`), so session rows keep their original path.
- `fh adopt` rewrites a worktree's env files to its new ports; services start stopped.
- Offscreen Electron `capturePage` can return the previous frame: settle (two rAFs + a beat) and capture twice.

## Open items

- After a reboot, features keep their last state (⏳/❗) until their session restarts — show `offline`
  when no live Claude session exists.
- Numos config should move into the numosai repo as a committed `.grove.json` (needs a PR there).
- Teammates can't open the repo yet (private on a personal account): invite them or make it public.
- Pitch video (`~/Desktop/Grove-pitch-music.mp4`): source and renderer were in a session scratchpad; if it
  needs more edits, move them into `docs/video/` first.
