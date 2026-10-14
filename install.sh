#!/usr/bin/env bash
# Set Grove up on this Mac: check the tools it needs (offering to brew install the missing ones), link
# this checkout into the places Grove's pieces are loaded from, have every Claude Code session load the
# mod, and (with --app) build Grove.app into /Applications.
#   ./install.sh [--app] [--yes] [<repo>…]   --yes installs missing tools without asking; each <repo>
#                                            is brought in with `grove import` (a dry run)
# Safe to re-run; `git pull && ./install.sh --app` is also how to update.
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
H="$HOME/.grove"
APP=0
YES=0
REPOS=()
for a in "$@"; do
  case "$a" in
    --app) APP=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n 2,7p "$0"; exit 0 ;;
    *) REPOS+=("$a") ;;
  esac
done

# 1. tools: brew installs what it can (tmux, gh, node), with your OK
for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$d:$PATH" ;; esac
done
need=(git tmux gh claude python3)
[ "$APP" = 1 ] && need+=(npm)
brewable=()
manual=()
for t in "${need[@]}"; do
  command -v "$t" >/dev/null && continue
  case "$t" in
    tmux|gh) brewable+=("$t") ;;
    npm) brewable+=("node") ;;
    *) manual+=("$t") ;;
  esac
done
if [ ${#brewable[@]} -gt 0 ]; then
  if ! command -v brew >/dev/null; then
    manual+=("${brewable[@]}")
    echo "Homebrew is not installed; get it from https://brew.sh, then re-run ./install.sh"
  else
    ok=$YES
    if [ "$ok" = 0 ] && [ -t 0 ]; then
      read -r -p "Grove needs ${brewable[*]}. Install with Homebrew now? [Y/n] " reply
      case "$reply" in [nN]*) ;; *) ok=1 ;; esac
    fi
    if [ "$ok" = 1 ]; then
      brew install "${brewable[@]}"
    else
      manual+=("${brewable[@]}")
    fi
  fi
fi
if [ ${#manual[@]} -gt 0 ]; then
  echo "Still missing: ${manual[*]}"
  for t in "${manual[@]}"; do
    case "$t" in
      claude) echo "  claude:   curl -fsSL https://claude.ai/install.sh | bash   (then run claude once to sign in)" ;;
      git|python3) echo "  $t:  xcode-select --install" ;;
      node) echo "  node:     brew install node" ;;
      *) echo "  $t:  brew install $t" ;;
    esac
  done
  exit 1
fi
gh auth status >/dev/null 2>&1 || echo "note: gh is not signed in (gh auth login); PR and CI status stay empty until it is"

# 2. links
mkdir -p "$H/bin" "$H/projects"
link() {  # link <target in repo> <live path>
  if [ -e "$2" ] && [ ! -L "$2" ]; then mv "$2" "$2.bak.$(date +%s)"; fi
  ln -sfn "$1" "$2"
  echo "linked $2 -> $1"
}
link "$R/cli/grove" "$H/bin/grove"
link "$R/mod" "$H/mod"
link "$R/tmux/grove.tmux.conf" "$H/tmux.conf"
mkdir -p "$HOME/.local/bin" && ln -sfn "$R/cli/grove" "$HOME/.local/bin/grove"

grep -q ".grove/tmux.conf" "$HOME/.tmux.conf" 2>/dev/null || echo "source-file $H/tmux.conf" >> "$HOME/.tmux.conf"

# 3. every Claude session loads the mod (and, if none is set, uses Grove's status line)
python3 - "$H" <<'PY'
import json, os, shutil, sys, time
hub = sys.argv[1]
path = os.path.expanduser("~/.claude/settings.json")
try:
    with open(path) as f:
        s = json.load(f)
except FileNotFoundError:
    s = {}
except ValueError:
    print(f"settings: {path} is not valid JSON; add env.CLAUDE_CODE_PLUGIN_DIRS = {hub}/mod yourself")
    sys.exit(0)
env = s.setdefault("env", {})
mod = f"{hub}/mod"
have = env.get("CLAUDE_CODE_PLUGIN_DIRS", "")
changed = []
if mod not in have.split(":"):
    env["CLAUDE_CODE_PLUGIN_DIRS"] = f"{have}:{mod}" if have else mod
    changed.append("CLAUDE_CODE_PLUGIN_DIRS")
if "statusLine" not in s:
    s["statusLine"] = {"type": "command", "command": f"{hub}/bin/grove statusline"}
    changed.append("statusLine")
if changed:
    if os.path.exists(path):
        shutil.copy2(path, f"{path}.bak.{int(time.time())}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(s, f, indent=2)
        f.write("\n")
    print(f"settings: set {', '.join(changed)} in {path} (backup kept next to it)")
else:
    print("settings: Claude Code already loads the Grove mod")
PY

# 4. the app (quit first so the copy in /Applications can be replaced; agents keep running in tmux)
if [ "$APP" = 1 ]; then
  running=0
  if pgrep -xq Grove; then running=1; osascript -e 'quit app "Grove"' >/dev/null 2>&1 || true; sleep 2; fi
  (cd "$R" && npm install --no-fund --no-audit && npm run install-app)
  "$H/bin/grove" ui app >/dev/null
  echo "app: /Applications/Grove.app"
  [ "$running" = 1 ] && open -a Grove
fi

# 5. projects
for repo in "${REPOS[@]+"${REPOS[@]}"}"; do "$H/bin/grove" import "$repo"; done

cat <<MSG

Grove is installed. Next:
  - Bring in a repo and the work already on it:  grove import ~/code/my-repo
      (lists its worktrees and recent Claude conversations; add --yes to adopt them)
  - Start something new:                         grove new <name|TICKET-123>
  - Check everything:                            grove doctor
$( [ "$APP" = 1 ] || echo "  - The Mac app:                                 ./install.sh --app" )
Restart running Claude sessions so they load the mod.
MSG
