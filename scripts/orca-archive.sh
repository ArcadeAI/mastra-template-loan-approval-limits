#!/usr/bin/env bash
# Orca repo archive hook — runs when a worktree is torn down.
#
# Releases this worktree's port block so it returns to circulation immediately
# rather than waiting to be reaped as stale. Reviewer worktrees are recreated
# fresh every round, so blocks churn fast; without this the range leaks.
#
# Wire it up in the Orca app: Repo settings -> hooks -> archive script:
#   bash scripts/orca-archive.sh
set -euo pipefail

WORKTREE="$(pwd -P)"
CLAIMS="${XDG_CACHE_HOME:-$HOME/.cache}/mastra-contextual-governance/portblocks"
[ -d "$CLAIMS" ] || exit 0

for f in "$CLAIMS"/*; do
  [ -f "$f" ] || continue
  if [ "$(cat "$f")" = "$WORKTREE" ]; then
    rm -f "$f"
    echo "orca-archive: released CG_PORT_BASE=$(basename "$f")"
  fi
done
