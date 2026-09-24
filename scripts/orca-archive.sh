#!/usr/bin/env bash
# Orca repo archive hook — runs when a worktree is torn down.
#
# Two jobs:
#   1. Release this worktree's port block, so it returns to circulation
#      immediately rather than waiting to be reaped as stale. Reviewer
#      worktrees are recreated fresh every round, so blocks churn fast; without
#      this the range leaks.
#   2. Stop every process still running from this worktree (#9). Eight `bun`
#      stubs spawned by #4's test harnesses outlived their worktree, still
#      listening on ephemeral ports after the directory was deleted, and had
#      to be found and stopped by hand. A process belongs to the worktree when
#      its working directory is inside it or its command line names a path
#      inside it. This hook's own ancestors are spared: Orca runs it from the
#      worktree.
#
# Wire it up in the Orca app: Repo settings -> hooks -> archive script:
#   bash scripts/orca-archive.sh
#
# test/orca-archive.test.ts runs it against a throwaway worktree.
set -euo pipefail

WORKTREE="$(pwd -P)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
# This repo's claims since #9, and the stage demo's directory this hook used
# before. Only a claim naming this worktree is removed from either.
for CLAIMS in "$CACHE/mastra-template-loan-approval-limits/portblocks" \
  "$CACHE/mastra-contextual-governance/portblocks"; do
  [ -d "$CLAIMS" ] || continue
  for f in "$CLAIMS"/*; do
    [ -f "$f" ] || continue
    if [ "$(cat "$f")" = "$WORKTREE" ]; then
      rm -f "$f"
      echo "orca-archive: released CG_PORT_BASE=$(basename "$f") in $CLAIMS"
    fi
  done
done

# --- Processes still running from the worktree ------------------------------

# This shell and every process above it: Orca, and whatever shell it ran us in.
spared=" $$ "
pid=$$
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  [ -n "$pid" ] && spared="$spared$pid "
done

inside() {  # is this path the worktree, or under it?
  [ "$1" = "$WORKTREE" ] || [ "${1#"$WORKTREE"/}" != "$1" ]
}

candidates() {
  # Working directory inside the worktree. lsof on macOS; /proc where there is
  # one and no lsof.
  if command -v lsof >/dev/null 2>&1; then
    lsof -w -a -d cwd -Fpn 2>/dev/null | awk '/^p/ { pid = substr($0, 2) } /^n/ { print pid "\t" substr($0, 2) }' |
      while IFS="$(printf '\t')" read -r p dir; do
        if inside "$dir"; then echo "$p"; fi
      done
  elif [ -d /proc ]; then
    for d in /proc/[0-9]*; do
      dir="$(readlink "$d/cwd" 2>/dev/null || true)"
      if [ -n "$dir" ] && inside "$dir"; then echo "${d#/proc/}"; fi
    done
  fi
  # A command line naming a path inside the worktree: `bun /…/scripts/identity.ts`
  # run from anywhere.
  ps axww -o pid= -o command= 2>/dev/null | while read -r p cmd; do
    case "$cmd" in
      *"$WORKTREE/"*) echo "$p" ;;
    esac
  done
}

targets=""
for p in $(candidates | sort -un); do
  case "$spared" in *" $p "*) continue ;; esac
  # The pipelines above ran in this worktree too, and have exited since.
  kill -0 "$p" 2>/dev/null || continue
  targets="$targets $p"
done

if [ -n "$targets" ]; then
  for p in $targets; do
    echo "orca-archive: stopping $p: $(ps -o command= -p "$p" 2>/dev/null | cut -c1-160 || true)"
    kill -TERM "$p" 2>/dev/null || true
  done
  # Five seconds to exit on their own, then SIGKILL whatever is left.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    alive=""
    for p in $targets; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && break
    sleep 0.5
  done
  for p in $alive; do
    echo "orca-archive: $p ignored SIGTERM; sending SIGKILL"
    kill -KILL "$p" 2>/dev/null || true
  done
fi
