"""`scripts/list-toolkits.sh`, the script CI's toolkit matrix is built from.

It lives outside this toolkit, and it is tested from inside it for one reason:
this is the directory the script exists to make deletable. If discovery breaks
for a repo with no toolkits, it breaks for exactly the forker the arrangement
is meant to serve — and it breaks in CI, where nobody is watching a shell.

That is not hypothetical. Round 2 of this PR's review measured it: the previous
version printed `[]` and then **exited 1**, because `ls` failing on a glob with
no match is expected and `pipefail` reported it as the pipeline's status. The
output was right and the status was wrong, which is the shape of bug that a
test asserting only stdout would have waved through. So every case here asserts
both.

The other half matters as much. A discovery step that answers `[]` when it
could not look is a matrix that silently tests nothing, and a matrix that tests
nothing is indistinguishable from one that passed. Empty is an answer; failing
to look is an error.
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "list-toolkits.sh"


def a_tree(root: Path, toolkits: list[str], *, make_tools_dir: bool = True) -> Path:
    """A miniature repo: the real script, and a `tools/` we control."""
    (root / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / "scripts" / "list-toolkits.sh")
    if make_tools_dir:
        (root / "tools").mkdir()
    for name in toolkits:
        (root / "tools" / name).mkdir()
        (root / "tools" / name / "pyproject.toml").write_text(
            f'[project]\nname = "{name}"\nversion = "0.0.0"\n', encoding="utf-8"
        )
    return root


def run(cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "scripts/list-toolkits.sh"], cwd=cwd, capture_output=True, text=True
    )


class TestItFindsWhatIsThere:
    def test_the_real_repo_lists_both_toolkits(self) -> None:
        # Not a fixture: if this ever disagrees with the directory listing, the
        # cases below are testing a script the repo does not actually use.
        result = run(REPO_ROOT)
        assert result.returncode == 0, result.stderr
        on_disk = sorted(p.parent.name for p in (REPO_ROOT / "tools").glob("*/pyproject.toml"))
        assert json.loads(result.stdout) == on_disk

    @pytest.mark.parametrize(
        ("toolkits", "expected"),
        [
            pytest.param([], [], id="zero toolkits"),
            pytest.param(["loan"], ["loan"], id="one toolkit"),
            pytest.param(["loan", "approvals"], ["approvals", "loan"], id="two toolkits"),
        ],
    )
    def test_output_and_exit_status(
        self, tmp_path: Path, toolkits: list[str], expected: list[str]
    ) -> None:
        result = run(a_tree(tmp_path / "repo", toolkits))

        # Both, always. The bug this file exists for had the right output.
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == expected
        assert result.stdout.strip() == json.dumps(expected, separators=(",", ":"))

    def test_zero_toolkits_is_an_empty_array_not_an_empty_string(
        self, tmp_path: Path
    ) -> None:
        # `fromJSON("")` is a workflow error; `fromJSON("[]")` is an empty list
        # the job's `if:` can branch on.
        result = run(a_tree(tmp_path / "repo", []))
        assert result.stdout.strip() == "[]"
        assert result.returncode == 0

    def test_a_missing_tools_directory_is_empty_rather_than_an_error(
        self, tmp_path: Path
    ) -> None:
        # The forker who deleted the lot, `tools/` included.
        result = run(a_tree(tmp_path / "repo", [], make_tools_dir=False))
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "[]"

    def test_a_directory_without_a_manifest_is_not_a_toolkit(self, tmp_path: Path) -> None:
        root = a_tree(tmp_path / "repo", ["loan"])
        (root / "tools" / "notes").mkdir()
        (root / "tools" / "notes" / "README.md").write_text("not a toolkit", encoding="utf-8")

        result = run(root)
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == ["loan"]

    def test_the_order_does_not_depend_on_the_filesystem(self, tmp_path: Path) -> None:
        first = run(a_tree(tmp_path / "a", ["zeta", "alpha", "middle"]))
        second = run(a_tree(tmp_path / "b", ["middle", "zeta", "alpha"]))
        assert json.loads(first.stdout) == ["alpha", "middle", "zeta"]
        assert first.stdout == second.stdout


class TestItStillFailsLoudly:
    """Empty is an answer. Not being able to look is not."""

    def test_a_manifest_with_no_project_table_is_an_error(self, tmp_path: Path) -> None:
        # Empty or truncated: the directory looks like a toolkit and describes
        # no project. Reporting it as absent would drop a real toolkit from the
        # matrix silently. Whether the manifest is *valid* is uv's question,
        # asked one step later in the same job.
        root = a_tree(tmp_path / "repo", ["loan"])
        (root / "tools" / "loan" / "pyproject.toml").write_text("", encoding="utf-8")

        result = run(root)
        assert result.returncode != 0
        assert "no [project] table" in result.stderr
        assert "tools/loan/pyproject.toml" in result.stderr

    @pytest.mark.skipif(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        reason="root ignores the permission bits these cases depend on",
    )
    def test_an_unreadable_manifest_is_an_error(self, tmp_path: Path) -> None:
        root = a_tree(tmp_path / "repo", ["loan"])
        manifest = root / "tools" / "loan" / "pyproject.toml"
        manifest.chmod(0o000)
        try:
            result = run(root)
        finally:
            manifest.chmod(stat.S_IRUSR | stat.S_IWUSR)

        assert result.returncode != 0
        assert "not readable" in result.stderr

    @pytest.mark.skipif(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        reason="root ignores the permission bits these cases depend on",
    )
    def test_an_unreadable_tools_directory_is_an_error_not_an_empty_list(
        self, tmp_path: Path
    ) -> None:
        # The important one. Without the explicit check, the glob expands to
        # nothing and the script confidently answers `[]` — the right answer to
        # a question it was never able to ask.
        root = a_tree(tmp_path / "repo", ["loan"])
        tools = root / "tools"
        tools.chmod(0o000)
        try:
            result = run(root)
        finally:
            tools.chmod(stat.S_IRWXU)

        assert result.returncode != 0
        assert result.stdout.strip() != "[]"
        assert "not readable" in result.stderr

    def test_a_tools_that_is_a_file_is_an_error(self, tmp_path: Path) -> None:
        root = a_tree(tmp_path / "repo", [], make_tools_dir=False)
        (root / "tools").write_text("not a directory", encoding="utf-8")

        result = run(root)
        assert result.returncode != 0
        assert "not a directory" in result.stderr


class TestTheWorkflowConsumesItSafely:
    def test_command_substitution_under_the_actions_shell_survives_zero_toolkits(
        self, tmp_path: Path
    ) -> None:
        # GitHub runs `run:` blocks under `bash -e -o pipefail`, so the failure
        # round 2 found surfaced as the *step* failing, not just the script.
        # This is that step, reproduced.
        root = a_tree(tmp_path / "repo", [])
        result = subprocess.run(
            ["bash", "-eo", "pipefail", "-c", 'toolkits="$(bash scripts/list-toolkits.sh)"; echo "$toolkits"'],
            cwd=root,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == "[]"

    def test_the_workflow_skips_the_matrix_job_when_the_list_is_empty(self) -> None:
        # An empty matrix is rejected by GitHub outright, so `[]` has to reach a
        # skipped job rather than a constructed one. Pinned here because the
        # only other place it is visible is a workflow run nobody triggers
        # until a forker deletes the last toolkit.
        workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        assert "needs.discover-toolkits.outputs.any == 'true'" in workflow
        assert "fromJSON(needs.discover-toolkits.outputs.toolkits)" in workflow
