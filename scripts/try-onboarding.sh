#!/usr/bin/env bash
# Try Grove's onboarding as a new user would, on a throwaway sample project. Nothing touches your real
# ~/.grove, ~/.claude or tmux: everything lives under $GROVE_TRY (default /tmp/grove-try).
#
#   scripts/try-onboarding.sh check            install + import end to end in a fake home; checks each step
#   scripts/try-onboarding.sh app              open Grove (from source) on an empty throwaway hub, as on
#                                              first launch: Add project → pick the sample repo
#   scripts/try-onboarding.sh app --imported   the same, with the sample's work already imported
#   scripts/try-onboarding.sh clean            stop its tmux and remove $GROVE_TRY
#
# The sample repo, acme-shop, has a Next.js-style web/ and a FastAPI-style api/, two worktrees in flight
# (one with uncommitted changes) and, in `check`, a Claude conversation in its main checkout.
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
T="${GROVE_TRY:-/tmp/grove-try}"  # keep it short: tmux socket paths have a length limit
FAKE="$T/home"
REPO="$FAKE/code/acme-shop"
SID=11111111-2222-3333-4444-555555555555
cmd="${1:-check}"

# Run from inside a tmux pane, $TMUX would send every tmux call (ours and grove's) to the live server that
# hosts your agents, whatever TMUX_TMPDIR says: drop it, and name our own server's socket outright.
unset TMUX TMUX_PANE
stop_tmux() { tmux -S "$T/tm/tmux-$(id -u)/default" kill-server 2>/dev/null || true; }

sample() {  # sample [with-conversation]
  stop_tmux
  rm -rf "$T"
  mkdir -p "$FAKE/.claude" "$T/tm" "$REPO/web/node_modules" "$REPO/api/.venv/bin"
  cd "$REPO"
  git init -q -b main
  git config user.email tester@example.com
  git config user.name Tester
  echo '{"scripts": {"dev": "next dev"}}' > web/package.json
  echo 'NEXT_PUBLIC_API_URL=http://localhost:8000' > web/.env.local
  printf 'from fastapi import FastAPI\napp = FastAPI()\n' > api/main.py
  echo 'DATABASE_URL=postgres://localhost/acme' > api/.env
  touch api/.venv/bin/python
  printf 'node_modules/\n.venv/\n.env*\n' > .gitignore
  git add -A && git commit -qm "acme shop"
  git worktree add -q -b tester/csv-export ../acme-shop-csv-export
  echo "WIP" > ../acme-shop-csv-export/export.py
  git worktree add -q -b fix/login-redirect ../acme-shop-login-fix
  if [ "${1:-}" = with-conversation ]; then
    local dir="$FAKE/.claude/projects/$(printf %s "$REPO" | sed 's/[^A-Za-z0-9]/-/g')"
    mkdir -p "$dir"
    printf '%s\n%s\n' "{\"cwd\":\"$REPO\",\"gitBranch\":\"main\"}" '{"aiTitle":"Fix checkout totals rounding"}' > "$dir/$SID.jsonl"
  fi
  cd "$R"
}

fails=0
step() {  # step <what> <command…>: runs it, shows ✓/✗ and its output on failure
  local what="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    echo "  ✓ $what"
  else
    echo "  ✗ $what"
    printf '%s\n' "$out" | sed 's/^/      /'
    fails=$((fails + 1))
  fi
}
has() { grep -q -- "$2" <<<"$1"; }

case "$cmd" in
  check)
    T="$(cd "$(dirname "$T")" 2>/dev/null && pwd -P)/$(basename "$T")"  # /tmp → /private/tmp: paths as git reports them
    FAKE="$T/home"; REPO="$FAKE/code/acme-shop"
    sample with-conversation
    export HOME="$FAKE" GROVE_HUB="$FAKE/.grove" GROVE_BIN="$R/cli/grove" TMUX_TMPDIR="$T/tm" GROVE_USER=tester
    echo "install"
    out="$("$R/install.sh" --yes 2>&1)"
    step "install.sh runs" test -L "$FAKE/.grove/bin/grove"
    step "every Claude session loads the mod" grep -q "$FAKE/.grove/mod" "$FAKE/.claude/settings.json"
    step "a second run changes nothing" has "$("$R/install.sh" --yes 2>&1)" "already loads the Grove mod"
    echo "import (dry run)"
    out="$(grove_out=$("$GROVE_BIN" import "$REPO/../acme-shop-csv-export" 2>&1); echo "$grove_out")"
    step "registers the main checkout, given a worktree" grep -q '"repo": "~/code/acme-shop"' "$GROVE_HUB/projects/acme-shop/project.json"
    step "guesses services" has "$out" '"name": "web"'
    step "guesses setup (venv, node_modules, env files)" python3 -c '
import json, sys
s = json.load(open(sys.argv[1]))["setup"]
assert s["link"] == ["api/.venv"] and s["clone"] == ["web/node_modules"], s
assert sorted(s["copy"]) == ["api/.env", "web/.env.local"], s' "$GROVE_HUB/projects/acme-shop/project.json"
    step "lists both worktrees" has "$out" "worktrees not in Grove: 2"
    step "flags uncommitted changes" has "$out" "acme-shop-csv-export  \[tester/csv-export\]  (uncommitted changes)"
    step "lists the conversation" has "$out" "Fix checkout totals rounding"
    step "adopts nothing yet" test -z "$(ls "$GROVE_HUB/projects/acme-shop" | grep -v project.json)"
    echo "import --yes"
    out="$("$GROVE_BIN" import --project acme-shop --yes 2>&1)"
    step "adopts both worktrees and the conversation" test "$(ls "$GROVE_HUB"/projects/acme-shop/*/feature.json | wc -l | tr -d ' ')" = 3
    step "gives each its own ports" test "$(cat "$GROVE_HUB"/projects/acme-shop/*/feature.json | grep -o '"web": [0-9][0-9]*' | sort -u | wc -l | tr -d ' ')" = 2
    step "copies setup into the worktrees" test -L "$FAKE/code/acme-shop-login-fix/api/.venv" -a -f "$FAKE/code/acme-shop-login-fix/web/.env.local"
    step "re-running finds nothing new" has "$("$GROVE_BIN" import "$REPO" 2>&1)" "Nothing to bring in"
    step "grove doctor is happy" has "$("$GROVE_BIN" doctor 2>&1)" "all good"
    stop_tmux
    echo
    if [ "$fails" = 0 ]; then echo "onboarding: all steps passed  (look around: HOME=$FAKE GROVE_HUB=$GROVE_HUB $GROVE_BIN ls)"
    else echo "onboarding: $fails step(s) failed"; exit 1; fi
    ;;
  app)
    sample
    export GROVE_HUB="$FAKE/.grove" GROVE_BIN="$R/cli/grove" TMUX_TMPDIR="$T/tm"
    mkdir -p "$GROVE_HUB/bin" && ln -sfn "$R/cli/grove" "$GROVE_HUB/bin/grove"
    if [ "${2:-}" = --imported ]; then
      "$GROVE_BIN" import "$REPO" --yes >/dev/null
      export GROVE_PROJECT=acme-shop
    fi
    cat <<MSG
Opening Grove on a throwaway hub ($GROVE_HUB). Your real projects are untouched.
$( [ "${2:-}" = --imported ] && echo "The sample's two worktrees are already imported." || echo "Click \"Add project\" and choose: $REPO" )
Claude sessions here are real (your login) and work on the sample repo only.
When done: scripts/try-onboarding.sh clean
MSG
    npm run build >/dev/null && npx electron .
    ;;
  clean)
    stop_tmux
    rm -rf "$T"
    echo "removed $T"
    ;;
  *)
    sed -n 2,12p "$0"
    exit 1
    ;;
esac
