#!/usr/bin/env bash
# Every Python toolkit under tools/, as a JSON array of directory names.
#
#   $ bash scripts/list-toolkits.sh
#   ["approvals","loan"]
#
# CI's `toolkits` job feeds its matrix from this instead of listing names.
# A hardcoded matrix is a job that cds into a directory a forker deleted:
# `tools/approvals` is meant to be deletable — a forker who wants no Python
# removes it and substitutes their own tools — and a workflow that still names
# it turns that supported act into red CI.
#
# `tools/approvals/tests/test_toolkit_discovery.py` runs this script against
# temporary trees with zero, one and two toolkits and asserts both the output
# and the exit status; `test_isolation.py` runs it against a copy of this repo
# with `tools/approvals` actually deleted. Both callers and CI run this one
# file, which is the point: a workflow with its own inline copy of the logic
# can drift from the tests that prove the logic.
#
# ---------------------------------------------------------------------------
# Finding nothing is an answer. Failing is not.
#
# The forker this script exists for is the one who deletes every toolkit, so
# "no toolkits" has to be `[]` and exit 0 — anything else fails discovery for
# exactly the person the arrangement is meant to serve. It emphatically must
# still fail on a *real* error, because a discovery step that answers `[]` when
# it could not look is a matrix that silently tests nothing, which is
# indistinguishable from a matrix that passed.
#
# So: a missing `tools/` is empty, and a `tools/` that cannot be read is an
# error. `set -e` is on and no status is swallowed.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."

fail() {
  echo "list-toolkits: $*" >&2
  exit 1
}

# Stated rather than discovered halfway through. Every GitHub runner and every
# machine that can run this repo's two Python toolkits has it; a minimal
# container might not, and "python3: command not found" three lines later is a
# worse message than this one.
command -v python3 >/dev/null 2>&1 || fail "python3 is required to encode the JSON output"

# No `tools/` at all is the forker who deleted the lot. Empty, not an error.
if [ ! -e tools ]; then
  echo '[]'
  exit 0
fi

# But a `tools/` that exists and cannot be listed is a real failure. Without
# this, the glob below would quietly expand to nothing and report `[]` — the
# right answer to a question we were never able to ask.
[ -d tools ] || fail "tools exists but is not a directory"
[ -r tools ] && [ -x tools ] || fail "tools is not readable"

# nullglob, so no match yields an empty loop rather than the literal pattern.
# This is what replaces the `ls` whose expected no-match failure, under
# pipefail, made "no toolkits" exit 1.
shopt -s nullglob

names=()
for manifest in tools/*/pyproject.toml; do
  [ -r "$manifest" ] || fail "$manifest is not readable"
  # A shallow check on purpose. Whether the manifest is *valid* is uv's
  # question, asked one step later in the same CI job and answered loudly; a
  # second opinion here could only disagree with it. What this catches is the
  # manifest that is empty or truncated — a file that exists, so the directory
  # looks like a toolkit, but describes no project at all.
  grep -q '^\[project\]' "$manifest" || fail "$manifest has no [project] table"
  names+=("$(basename "$(dirname "$manifest")")")
done

# Sorted, so the matrix order does not depend on the filesystem. Encoded by
# json.dumps rather than by hand: a directory name is attacker-controlled in
# no meaningful sense here, but hand-rolled JSON quoting is how a list with an
# apostrophe in it becomes a syntax error in a workflow.
#
# `${names[@]+...}` is for bash 3.2 under `set -u`, where expanding an empty
# array is itself an error. macOS still ships 3.2 and the tests run there.
printf '%s\n' ${names[@]+"${names[@]}"} |
  LC_ALL=C sort |
  python3 -c 'import json,sys; print(json.dumps([l.strip() for l in sys.stdin if l.strip()], separators=(",", ":")))'
