#!/usr/bin/env bash
# Orca repo setup hook — runs once per worktree, before any worker starts.
#
# Two jobs:
#   1. Claim a block of ports no other live worktree holds, and write them to
#      an untracked .env.local.
#   2. Install dependencies. One `bun install` at the root covers every
#      workspace, the identity provider (lib/identity/provider) included.
#
# Wire it up in the Orca app: Repo settings -> hooks -> setup script:
#   bash scripts/orca-setup.sh
# Set the repo's setup policy to wait-for-setup, not start-immediately: an
# agent that begins before the install finishes runs `bun test` against a
# half-installed tree, gets "Cannot find module 'better-auth'", reads it as a
# broken repo, and starts fixing what is not wrong.
#
# Idempotent: re-running keeps the block this worktree already holds.
#
# Why a block and not a port. This project runs four services — web, hooks,
# loan-app, idp — and they all read the same `PORT` variable, so a worktree
# needs four distinct values plus the cross-service host strings derived from
# them. Range 4560-4719 in blocks of 10 gives 16 blocks against a steady-state
# need of 8: four implementer worktrees, which persist through review, plus one
# reviewer worktree each. It deliberately clears outreach-library's hook, which
# owns 4321-4380 on this machine.
#
# This repo's own claims directory AND its own range (#9). The hook came over
# from the stage demo claiming 4400-4559 in
# ~/.cache/mastra-contextual-governance/portblocks, and on 2026-09-24 ten of
# those sixteen blocks were the stage demo's stale claims. A directory of our
# own stops either repo reaping or releasing the other's claims; a range of our
# own is what stops both claiming the same block, because a claim is only a
# file and neither hook reads the other's. 4560-4719 sits directly above the
# stage demo's 4400-4559. test/orca-setup.test.ts holds both.
set -euo pipefail

WORKTREE="$(pwd -P)"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}"
CLAIMS="$CACHE/mastra-template-loan-approval-limits/portblocks"
# Where this hook claimed before #9. Only ever read to release a claim this
# worktree itself holds there; every other file in it is the stage demo's.
LEGACY_CLAIMS="$CACHE/mastra-contextual-governance/portblocks"
ENVFILE="$WORKTREE/.env.local"
BLOCK=10
BASE_MIN=4560
BASE_MAX=4710

mkdir -p "$CLAIMS"

# A worktree set up before #9 holds a block in the stage demo's pool. Give it
# back: this worktree claims from its own range below.
if [ -d "$LEGACY_CLAIMS" ]; then
  for f in "$LEGACY_CLAIMS"/*; do
    [ -f "$f" ] || continue
    if [ "$(cat "$f")" = "$WORKTREE" ]; then
      rm -f "$f"
      echo "orca-setup: released legacy claim $(basename "$f") in $LEGACY_CLAIMS"
    fi
  done
fi

listening() {  # is anything bound to this port right now?
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  fi
}

block_free() {  # every port in the block unbound by anyone, Orca or not
  local base="$1" i
  for ((i = 0; i < BLOCK; i++)); do
    listening "$((base + i))" && return 1
  done
  return 0
}

claim_owner() { [ -f "$CLAIMS/$1" ] && cat "$CLAIMS/$1" || true; }

# A claim whose worktree directory is gone is stale. Orca removes worktrees on
# `worktree rm`, so this is how blocks come back into circulation when the
# archive hook did not get to run.
reap_stale() {
  local owner
  owner="$(claim_owner "$1")"
  if [ -n "$owner" ] && [ ! -d "$owner" ]; then
    rm -f "$CLAIMS/$1"
  fi
}

# Already hold a block? Keep it, so re-running setup is a no-op.
if [ -f "$ENVFILE" ]; then
  existing="$(sed -n 's/^CG_PORT_BASE=\([0-9]\{1,\}\)$/\1/p' "$ENVFILE" | head -1)"
  if [ -n "$existing" ] && [ "$(claim_owner "$existing")" = "$WORKTREE" ]; then
    echo "orca-setup: keeping CG_PORT_BASE=$existing"
    BASE="$existing"
  fi
fi

if [ -z "${BASE:-}" ]; then
  for b in $(seq "$BASE_MIN" "$BLOCK" "$BASE_MAX"); do
    reap_stale "$b"
    [ -e "$CLAIMS/$b" ] && continue
    block_free "$b" || continue
    # noclobber makes this create-or-fail, which is the atomic bit: two workers
    # starting at the same instant cannot both win the same block.
    if (set -o noclobber; printf '%s\n' "$WORKTREE" > "$CLAIMS/$b") 2>/dev/null; then
      BASE="$b"
      echo "orca-setup: claimed CG_PORT_BASE=$BASE"
      break
    fi
  done
fi

if [ -z "${BASE:-}" ]; then
  echo "orca-setup: no free block in $BASE_MIN-$((BASE_MAX + BLOCK - 1))." >&2
  echo "orca-setup: stale claims live in $CLAIMS — remove any whose worktree is gone." >&2
  exit 1
fi

WEB=$((BASE + 0)); HOOKS=$((BASE + 1)); LOAN=$((BASE + 2)); IDP=$((BASE + 3))
# Mastra Studio (`bun run studio`, #8). Offset 5, clear of the four above and of
# offset 4, which nothing uses yet. Without it Studio takes Mastra's own default,
# 4111, and every worktree on the machine would ask for the same port.
STUDIO=$((BASE + 5))

# All four services read the same `PORT` variable, so one shared file cannot
# carry all four values — the first service to load it would take the port
# meant for another. Bun loads `.env.local` from the *current working
# directory*, and `bun run --cwd apps/<svc> dev` sets that to the service's own
# directory, so each service gets its own file with its own PORT. Verified:
# `PORT` in `apps/hooks/.env.local` is what the hooks service binds.
#
# The web app is the exception since #3: it lives at the repo root, so its
# PORT goes in the root file below rather than in a file of its own.
#
# A shell-level `PORT="${CG_PORT_HOOKS:-8081}" bun run ...` does NOT work and
# was tried first: Bun injects .env into the script's process, not into the
# shell that expands `${...}`, so the default always won.
#
# All of these are untracked — .gitignore's `.env.local` matches at any depth.
shared() {
  cat <<ENVEOF
# Host-form, matching .env.example: consumers add the scheme. One host since
# #6: the control plane (#4), the loan API (#5, under /bank) and the identity
# provider (#6) are all the app, on the app's port, and so is the issuer.
# IDENTITY_HOST and CONTROL_PLANE_HOST are unset on purpose: both default to
# the app's own listener. CG_PORT_HOOKS, CG_PORT_LOAN_APP and CG_PORT_IDP stay
# claimed in the block and nothing binds them.
APP_PUBLIC_HOST=localhost:$WEB
ENVEOF
}

# The root file documents the block, gives root-level `bun test` the
# cross-service hosts, and since #3 carries the app's PORT, because the app is
# the root and `bun scripts/next.ts dev` loads this file.
#
# That PORT does not reach the other three services. `bun run dev:hooks` loads
# this file into the Bun process running the script, not into the shell it
# spawns, so `bun run --cwd apps/hooks dev` starts without a PORT in its
# environment and reads apps/hooks/.env.local's. Measured on #3 with a root
# `.env.local` and a child directory holding a different PORT: the child
# printed its own. (It is the same Bun behaviour the note above found the hard
# way.) `bun test` loads neither file: Bun skips `.env.local` under
# `NODE_ENV=test`.
{
  echo "# Written by scripts/orca-setup.sh. Do not edit; setup rewrites it."
  echo "# This worktree owns ports $BASE-$((BASE + BLOCK - 1))."
  echo "# PORT is the app's, which lives at the root. Every service is part of it since #6."
  echo "PORT=$WEB"
  echo "CG_PORT_BASE=$BASE"
  echo "CG_PORT_WEB=$WEB"
  echo "CG_PORT_HOOKS=$HOOKS"
  echo "CG_PORT_LOAN_APP=$LOAN"
  echo "CG_PORT_IDP=$IDP"
  echo "CG_PORT_STUDIO=$STUDIO"
  echo "# Mastra Studio's port. \`mastra dev\` loads this file, and \`src/mastra/index.ts\`"
  echo "# binds STUDIO_PORT rather than PORT, which is the app's."
  echo "STUDIO_PORT=$STUDIO"
  echo
  shared
} > "$ENVFILE"

if command -v bun >/dev/null 2>&1; then
  echo "orca-setup: bun install"
  bun install
fi

echo "orca-setup: ready — ports $BASE-$((BASE + BLOCK - 1)) (web $WEB, hooks $HOOKS, loan-app $LOAN, idp $IDP, studio $STUDIO)"
