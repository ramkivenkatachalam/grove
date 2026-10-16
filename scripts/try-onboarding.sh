#!/usr/bin/env bash
# Try Grove's onboarding as a new user would, on a throwaway sample project. Nothing touches your real
# ~/.grove, ~/.claude or tmux: everything lives under $GROVE_TRY (default /tmp/grove-try).
#
#   scripts/try-onboarding.sh check              install + import end to end in a fake home; checks each step
#   scripts/try-onboarding.sh app                Grove (from source) on an empty throwaway hub, as on first
#                                                launch: Add project → pick the sample repo
#   scripts/try-onboarding.sh app --added        as just after picking it: the "bring your work in" sheet
#   scripts/try-onboarding.sh app --imported     with the sample's work already brought in
#   scripts/try-onboarding.sh app … --demo       also give the sample its Claude conversations (a fake home,
#                                                so Claude panels there are not signed in: for screenshots)
#   scripts/try-onboarding.sh app … --fail       give web a single port, so only one worktree can come in
#                                                and the other goes to "Fix with Claude"
#   scripts/try-onboarding.sh clean              stop its tmux and remove $GROVE_TRY
#
# The sample repo, acme-shop, has a Next.js-style web/ and a FastAPI-style api/, an origin, and three
# worktrees: csv-export (2 commits ahead, uncommitted changes, a Claude conversation), login-fix (1 commit
# ahead) and search-spike (nothing new for 40 days). Its main checkout has a Claude conversation too
# (in `check`, and in `app --demo`).
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
T="${GROVE_TRY:-/tmp/grove-try}"  # keep it short: tmux socket paths have a length limit
mkdir -p "$T" && T="$(cd "$T" && pwd -P)"  # /tmp → /private/tmp: paths as git reports them
FAKE="$T/home"
REPO="$FAKE/code/acme-shop"
cmd="${1:-check}"
shift || true
mode="" demo=0 fail=0
for a in "$@"; do
  case "$a" in
    --added|--imported) mode="$a" ;;
    --demo) demo=1 ;;
    --fail) fail=1 ;;
  esac
done

# Run from inside a tmux pane, $TMUX would send every tmux call (ours and grove's) to the live server that
# hosts your agents, whatever TMUX_TMPDIR says: drop it, and name our own server's socket outright.
unset TMUX TMUX_PANE
stop_tmux() { tmux -S "$T/tm/tmux-$(id -u)/default" kill-server 2>/dev/null || true; }
# shells and apps that were just stopped can still write on their way out (a shell's history, an app's
# window state): try a few times
wipe() { local i; for i in 1 2 3 4 5; do rm -rf "$T" 2>/dev/null && return; sleep 1; done; rm -rf "$T"; }

conversation() {  # conversation <folder it ran in> <id> <title> <minutes ago>
  local dir="$FAKE/.claude/projects/$(printf %s "$1" | sed 's/[^A-Za-z0-9]/-/g')"
  mkdir -p "$dir"
  printf '%s\n%s\n' "{\"cwd\":\"$1\",\"gitBranch\":\"$(git -C "$1" branch --show-current)\"}" "{\"aiTitle\":\"$3\"}" > "$dir/$2.jsonl"
  touch -t "$(date -v-"$4"M +%Y%m%d%H%M)" "$dir/$2.jsonl"
}

sample() {  # sample [with-conversations]
  stop_tmux
  wipe
  mkdir -p "$FAKE/.claude" "$T/tm" "$REPO/web/node_modules" "$REPO/api/.venv/bin"
  export GIT_AUTHOR_NAME=Tester GIT_AUTHOR_EMAIL=tester@example.com GIT_COMMITTER_NAME=Tester GIT_COMMITTER_EMAIL=tester@example.com
  git init -q --bare "$T/origin.git"
  cd "$REPO"
  git init -q -b main
  git config user.email tester@example.com
  echo '{"scripts": {"dev": "next dev"}}' > web/package.json
  echo 'NEXT_PUBLIC_API_URL=http://localhost:8000' > web/.env.local
  printf 'from fastapi import FastAPI\napp = FastAPI()\n' > api/main.py
  echo 'DATABASE_URL=postgres://localhost/acme' > api/.env
  touch api/.venv/bin/python
  printf 'node_modules/\n.venv/\n.env*\n' > .gitignore
  local old="$(( $(date +%s) - 40 * 86400 )) +0000"
  git add -A && GIT_AUTHOR_DATE="$old" GIT_COMMITTER_DATE="$old" git commit -qm "acme shop"
  git remote add origin "$T/origin.git" && git push -q origin main && git remote set-head origin main >/dev/null
  git worktree add -q -b tester/csv-export ../acme-shop-csv-export origin/main 2>/dev/null
  (cd ../acme-shop-csv-export && echo "def export(): ..." > export.py && git add export.py && git commit -qm "csv export"
   echo "def rows(): ..." >> export.py && git commit -qam "csv rows" && echo "# WIP: quoting" >> export.py)
  git worktree add -q -b fix/login-redirect ../acme-shop-login-fix origin/main 2>/dev/null
  (cd ../acme-shop-login-fix && echo "next = '/'" > api/auth.py && git add api/auth.py && git commit -qm "login redirect")
  git worktree add -q -b tester/search-spike ../acme-shop-search-spike origin/main 2>/dev/null
  if [ "${1:-}" = with-conversations ]; then
    conversation "$REPO" 11111111-2222-3333-4444-555555555555 "Fix checkout totals rounding" 40
    conversation "$FAKE/code/acme-shop-csv-export" 22222222-3333-4444-5555-666666666666 "Add CSV export to orders" 130
    mkdir -p "$REPO/.claude/worktrees/agent-1"  # Claude Code's own agent worktree: never offered
    conversation "$REPO/.claude/worktrees/agent-1" 33333333-4444-5555-6666-777777777777 "" 50
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
web_ports() {  # web_ports <lo> <hi>: the sample project's port range for web
  python3 - "$GROVE_HUB/projects/acme-shop/project.json" "$1" "$2" <<'PY'
import json, sys
path, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
conf = json.load(open(path))
for s in conf["services"]:
    if s["name"] == "web":
        s["ports"] = [lo, hi]
json.dump(conf, open(path, "w"), indent=2)
PY
}
free_web_port() {  # a port in web's usual range that nothing is listening on
  python3 -c '
import socket
for port in range(3001, 3100):
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)):
            print(port); break'
}
features_n() { ls "$GROVE_HUB"/projects/acme-shop/*/feature.json 2>/dev/null | wc -l | tr -d ' '; }

case "$cmd" in
  check)
    sample with-conversations
    export HOME="$FAKE" GROVE_HUB="$FAKE/.grove" GROVE_BIN="$R/cli/grove" TMUX_TMPDIR="$T/tm" GROVE_USER=tester
    echo "install"
    out="$("$R/install.sh" --yes 2>&1)"
    step "install.sh runs" test -L "$FAKE/.grove/bin/grove"
    step "every Claude session loads the mod" grep -q "$FAKE/.grove/mod" "$FAKE/.claude/settings.json"
    step "a second run changes nothing" has "$("$R/install.sh" --yes 2>&1)" "already loads the Grove mod"
    echo "import (what the app's Add project runs)"
    json="$("$GROVE_BIN" import "$REPO/../acme-shop-csv-export" --json 2>/dev/null)"
    step "registers the main checkout, given a worktree" grep -q '"repo": "~/code/acme-shop"' "$GROVE_HUB/projects/acme-shop/project.json"
    step "guesses setup (venv, node_modules, env files)" python3 -c '
import json, sys
s = json.load(open(sys.argv[1]))["setup"]
assert s["link"] == ["api/.venv"] and s["clone"] == ["web/node_modules"], s
assert sorted(s["copy"]) == ["api/.env", "web/.env.local"], s' "$GROVE_HUB/projects/acme-shop/project.json"
    echo "set up with Claude (no .grove.json)"
    step "offers it in the import JSON" has "$json" '"setupWithClaude": true'
    step "drafts a brief with the guess, the keys and the rules" python3 -c '
import sys
d = sys.argv[1]
assert "exec npm run dev" in d and "localhost:NNNN" in d and "agentNotes" in d, d
assert ".grove.json" in d and "project show acme-shop" in d and "doctor" in d, d
assert "## Try it (ask me first)" in d and "new setup-check --project acme-shop" in d and "%{http_code}" in d, d
assert "## Share it (ask me first)" in d and "new grove-json --project acme-shop" in d, d' "$("$GROVE_BIN" project setup acme-shop --draft)"
    "$GROVE_BIN" project setup acme-shop --start >/dev/null 2>&1
    step "starts a Set up session that can read the repo" python3 -c '
import json, sys
f = json.load(open(sys.argv[1] + "/feature.json"))
assert f["kind"] == "session" and f["helper"] == "setup" and f["addDirs"] == [sys.argv[2]], f' \
      "$GROVE_HUB/projects/acme-shop/setup-acme-shop" "$REPO"
    step "a second start opens the same session" has "$("$GROVE_BIN" project setup acme-shop --start 2>&1)" "already open"
    mkdir -p "$T/fakebin" && printf '#!/bin/sh\nfor a in "$@"; do printf "%%s\\n" "$a"; done > "%s/claude-args"\n' "$T" > "$T/fakebin/claude"
    # a copy of the row in an empty folder (the real one's pane may have Claude running already)
    s="$GROVE_HUB/projects/acme-shop/setup-probe"; mkdir -p "$s/worktree"
    for b in brief.md brief.sent.md; do [ -f "${s%-probe}-acme-shop/$b" ] && cp "${s%-probe}-acme-shop/$b" "$s/brief.md" && break; done
    sed -e 's/"setup-acme-shop"/"setup-probe"/' -e 's#setup-acme-shop/worktree#setup-probe/worktree#' "$GROVE_HUB/projects/acme-shop/setup-acme-shop/feature.json" > "$s/feature.json"
    chmod +x "$T/fakebin/claude" && PATH="$T/fakebin:$PATH" "$GROVE_BIN" agent setup-probe </dev/null >/dev/null 2>&1
    rm -rf "$s"
    step "Claude gets the repo as a folder and the brief as its prompt" python3 -c '
import sys
a = open(sys.argv[1]).read().split("\n")
i = a.index("--add-dir")
assert a[i + 1] == sys.argv[2] and a[i + 2] == "--" and a[i + 3] == "# Set up acme-shop for Grove", a[:6]' "$T/claude-args" "$REPO"
    step "closing it leaves the project's config alone" sh -c "'$GROVE_BIN' done setup-acme-shop >/dev/null 2>&1 && grep -q '\"repo\"' '$GROVE_HUB/projects/acme-shop/project.json'"
    echo '{}' > "$REPO/.grove.json"
    step "is not offered over a .grove.json" sh -c "! '$GROVE_BIN' project setup acme-shop --draft >/dev/null 2>&1"
    rm "$REPO/.grove.json"
    step "reports, as JSON, what is in flight" python3 -c '
import json, sys
d = json.loads(sys.argv[1])
assert d["project"] == "acme-shop" and d["added"] is True, d
assert [s["name"] for s in d["config"]["services"]] == ["web", "api"] and d["config"]["source"] == "starter" and all(s["free"] > 0 for s in d["config"]["services"]), d["config"]
w = {t["branch"]: t for t in d["worktrees"]}
assert sorted(w) == ["fix/login-redirect", "tester/csv-export", "tester/search-spike"], sorted(w)
csv = w["tester/csv-export"]
assert csv["dirty"] and csv["ahead"] == 2 and csv["conversation"]["title"] == "Add CSV export to orders", csv
assert w["fix/login-redirect"]["ahead"] == 1 and not w["fix/login-redirect"]["dirty"], w["fix/login-redirect"]
spike = w["tester/search-spike"]
assert spike["ahead"] == 0 and not spike["dirty"] and spike["at"] < __import__("time").time() - 30 * 86400, spike
assert [s["title"] for s in d["sessions"]] == ["Fix checkout totals rounding"], d["sessions"]' "$json"
    step "adopts nothing yet" test "$(features_n)" = 0
    step "says the same in words" has "$("$GROVE_BIN" import --project acme-shop 2>&1)" "worktrees not in Grove: 3"
    echo "bring in, with one failure (what the app's Bring in runs)"
    one="$(free_web_port)"
    web_ports "$one" "$one"  # room for one feature's web server only
    "$GROVE_BIN" adopt "$FAKE/code/acme-shop-csv-export" --project acme-shop >/dev/null 2>&1
    err="$("$GROVE_BIN" adopt "$FAKE/code/acme-shop-login-fix" --project acme-shop 2>&1 || true)"
    "$GROVE_BIN" adopt --session 11111111-2222-3333-4444-555555555555 >/dev/null 2>&1
    step "brings in what it can" test "$(features_n)" = 2
    step "says why the other failed" has "$err" "no free port for web"
    "$GROVE_BIN" fix-import --project acme-shop --record "$(python3 -c 'import json,sys; print(json.dumps([{"path": sys.argv[1], "branch": "fix/login-redirect", "error": sys.argv[2]}]))' "$FAKE/code/acme-shop-login-fix" "$err")" >/dev/null
    step "keeps the failure, for Fix with Claude" has "$("$GROVE_BIN" import --project acme-shop --json)" '"fixable": true'
    draft="$("$GROVE_BIN" fix-import --project acme-shop --draft)"
    step "drafts a brief with the error and the command to retry" python3 -c '
import sys
d = sys.argv[1]
assert "no free port for web" in d and "adopt " in d and "acme-shop-login-fix --project acme-shop" in d, d
assert "Don\x27t change code" in d and "Done when" in d, d' "$draft"
    "$GROVE_BIN" fix-import --project acme-shop --start >/dev/null 2>&1
    step "starts a Fix import session briefed with it" python3 -c '
import json, sys
f = json.load(open(sys.argv[1] + "/feature.json"))
assert f["kind"] == "session" and f["helper"] == "import" and "session" not in f, f
assert "no free port for web" in open(sys.argv[1] + "/brief.md").read()' "$GROVE_HUB/projects/acme-shop/fix-import-acme-shop"
    step "a second start opens the same session" has "$("$GROVE_BIN" fix-import --project acme-shop --start 2>&1)" "already open"
    web_ports 3001 3099  # what Claude would do: give web its range back, then retry
    "$GROVE_BIN" adopt "$FAKE/code/acme-shop-login-fix" --project acme-shop >/dev/null 2>&1
    step "a fixed item drops off the list" has "$("$GROVE_BIN" fix-import --project acme-shop --draft --json)" '"failures": \[\]'
    step "closing the Fix import session leaves the hub folder alone" sh -c "'$GROVE_BIN' done fix-import-acme-shop >/dev/null 2>&1 && test -d '$GROVE_HUB/projects/acme-shop/csv-export'"
    step "names a feature after its Claude conversation" grep -q '"title": "Add CSV export to orders"' "$GROVE_HUB/projects/acme-shop/csv-export/feature.json"
    step "gives each its own ports" test "$(cat "$GROVE_HUB"/projects/acme-shop/*/feature.json | grep -o '"web": [0-9][0-9]*' | sort -u | wc -l | tr -d ' ')" = 2
    step "copies setup into the worktrees" test -L "$FAKE/code/acme-shop-login-fix/api/.venv" -a -f "$FAKE/code/acme-shop-login-fix/web/.env.local"
    step "still offers what was left out" has "$("$GROVE_BIN" import --project acme-shop --json)" '"branch": "tester/search-spike"'
    "$GROVE_BIN" import --project acme-shop --yes >/dev/null 2>&1
    step "--yes brings in the rest" has "$("$GROVE_BIN" import "$REPO" 2>&1)" "Nothing to bring in"
    step "grove doctor is happy" has "$("$GROVE_BIN" doctor 2>&1)" "all good"
    stop_tmux
    echo
    if [ "$fails" = 0 ]; then echo "onboarding: all steps passed  (look around: HOME=$FAKE GROVE_HUB=$GROVE_HUB $GROVE_BIN ls)"
    else echo "onboarding: $fails step(s) failed"; exit 1; fi
    ;;
  app)
    if [ "$demo" = 1 ]; then sample with-conversations; export HOME="$FAKE"; else sample; fi
    export GROVE_HUB="$FAKE/.grove" GROVE_BIN="$R/cli/grove" TMUX_TMPDIR="$T/tm" GROVE_USER=tester
    mkdir -p "$GROVE_HUB/bin" && ln -sfn "$R/cli/grove" "$GROVE_HUB/bin/grove"
    case "$mode" in
      --added) "$GROVE_BIN" import "$REPO" --json >/dev/null 2>&1; export GROVE_PROJECT=acme-shop GROVE_REVIEW=1
               if [ "$fail" = 1 ]; then one="$(free_web_port)"; web_ports "$one" "$one"; fi ;;
      --imported) "$GROVE_BIN" import "$REPO" --yes >/dev/null 2>&1; export GROVE_PROJECT=acme-shop ;;
    esac
    cat <<MSG
Opening Grove on a throwaway hub ($GROVE_HUB). Your real projects are untouched.
$(case "$mode" in
  --added) echo "As if you had just added the sample: review what to bring in." ;;
  --imported) echo "The sample's worktrees are already brought in." ;;
  *) echo "Click \"Add project\" and choose: $REPO" ;;
esac)
$( [ "$demo" = 1 ] && echo "Demo: a fake home, so Claude panels here are not signed in." || echo "Claude sessions here are real (your login) and work on the sample repo only." )
When done: scripts/try-onboarding.sh clean
MSG
    npm run build >/dev/null && npx electron .
    ;;
  clean)
    stop_tmux
    wipe
    echo "removed $T"
    ;;
  *)
    sed -n 2,17p "$0"
    exit 1
    ;;
esac
