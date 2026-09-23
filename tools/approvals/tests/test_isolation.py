"""A forker who wants no Python deletes this directory, and nothing breaks.

That is an acceptance criterion, so it is a test rather than a claim. Two
directions, and both matter:

  * nothing under `apps/` or `packages/` reaches *into* this toolkit, so
    deleting it cannot break the services or the shared packages;
  * nothing in this toolkit's *runtime* reaches out of it, so it can be lifted
    into another repo whole.

The tests do reach out — they read the cross-language routing cases under
`packages/policy-schema/contract/`, deliberately, because agreement with the
TypeScript router is the thing worth checking. That direction is safe: the
JSON has another reader and survives this directory's deletion.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
TOOLKIT = REPO_ROOT / "tools" / "approvals"
RUNTIME = TOOLKIT / "approvals"

#: Everything a copy of the repo does not need in order to answer "does
#: deleting this directory break anything". Skipping these is what keeps the
#: copy under a second instead of minutes.
NOT_WORTH_COPYING = shutil.ignore_patterns(
    ".git", "node_modules", ".venv", "__pycache__", ".next", "dist",
    ".pytest_cache", "*.db", ".turbo",
)


def _sources(root: Path, suffixes: tuple[str, ...]) -> list[Path]:
    skip = {"node_modules", ".venv", "__pycache__", ".next", "dist", ".git"}
    return [
        path
        for path in root.rglob("*")
        if path.suffix in suffixes
        and path.is_file()
        and not any(part in skip for part in path.parts)
    ]


class TestNothingReachesIn:
    def test_no_typescript_imports_this_toolkit(self) -> None:
        # An import or a require, not a mention: a comment naming the toolkit
        # is documentation and survives its deletion intact.
        reaches_in = re.compile(r"""(?:from|import|require\()\s*['"][^'"]*tools/approvals""")
        offenders = [
            str(path.relative_to(REPO_ROOT))
            for directory in (REPO_ROOT / "apps", REPO_ROOT / "packages")
            for path in _sources(directory, (".ts", ".tsx"))
            if reaches_in.search(path.read_text(encoding="utf-8"))
        ]
        assert offenders == [], offenders

    def test_it_is_not_a_bun_workspace(self) -> None:
        # Deleting a workspace member breaks `bun install`. This is not one.
        manifest = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        assert not any("tools" in pattern for pattern in manifest["workspaces"])

    def test_it_is_not_a_render_service(self) -> None:
        # It ships with `arcade deploy`; a blueprint entry would make deleting
        # the directory a failed sync.
        blueprint = (REPO_ROOT / "render.yaml").read_text(encoding="utf-8")
        # Comments in the blueprint say why it is absent; those are the point.
        declarations = [
            line
            for line in blueprint.splitlines()
            if "tools/approvals" in line and not line.lstrip().startswith("#")
        ]
        assert declarations == [], declarations

    def test_it_carries_no_package_manifest_the_workspace_could_pick_up(self) -> None:
        assert not (TOOLKIT / "package.json").exists()


class TestNothingReachesOut:
    def test_the_runtime_imports_only_itself_and_its_declared_dependencies(self) -> None:
        allowed_prefixes = (
            "approvals.",
            "arcade_core",
            "arcade_mcp_server",
            "httpx",
        )
        stdlib = {"__future__", "enum", "os", "math", "dataclasses", "typing", "sys", "json"}
        for path in _sources(RUNTIME, (".py",)):
            for line in path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if not stripped.startswith(("import ", "from ")):
                    continue
                module = stripped.split()[1]
                assert module in stdlib or module.startswith(allowed_prefixes), (
                    f"{path.relative_to(REPO_ROOT)}: {stripped}"
                )

    def test_the_runtime_reads_no_file_outside_this_directory(self) -> None:
        # A fixture path into packages/ would make the deployed toolkit depend
        # on a repo layout it does not ship with.
        for path in _sources(RUNTIME, (".py",)):
            source = path.read_text(encoding="utf-8")
            assert "parents[" not in source, path.relative_to(REPO_ROOT)
            assert "open(" not in source, path.relative_to(REPO_ROOT)


class TestDeletingItActuallyWorks:
    """Copy the repo, delete the directory, and check what is left.

    Every test above reasons about the repo as it stands. This one performs the
    act the criterion describes — `rm -rf tools/approvals` — against a throwaway
    copy, and then asks the questions that would actually go wrong. Reasoning
    about a deletion and doing it are not the same evidence, and CI entering a
    directory that is no longer there is exactly the failure the reasoning
    missed once already.

    Under a second: the copy skips `.git`, `node_modules` and `.venv`.
    """

    @staticmethod
    def _repo_without_the_toolkit(destination: Path) -> Path:
        shutil.copytree(REPO_ROOT, destination, ignore=NOT_WORTH_COPYING, symlinks=True)
        shutil.rmtree(destination / "tools" / "approvals")
        return destination

    def test_ci_discovers_the_remaining_toolkits_and_not_this_one(self) -> None:
        # The job that used to name `approvals` in its matrix. CI and this test
        # run the same script, so neither can drift from the other.
        with tempfile.TemporaryDirectory(prefix="cg-forked-") as tmp:
            forked = self._repo_without_the_toolkit(Path(tmp) / "repo")

            before = json.loads(
                subprocess.run(
                    ["bash", "scripts/list-toolkits.sh"],
                    cwd=REPO_ROOT, capture_output=True, text=True, check=True,
                ).stdout
            )
            after = json.loads(
                subprocess.run(
                    ["bash", "scripts/list-toolkits.sh"],
                    cwd=forked, capture_output=True, text=True, check=True,
                ).stdout
            )

        assert "approvals" in before
        assert "approvals" not in after
        # And it still finds the toolkit that is left, rather than going empty
        # and quietly running nothing.
        assert after == sorted(set(before) - {"approvals"})
        assert after, "discovery must still find tools/loan"

    def test_no_workflow_names_the_deleted_path(self) -> None:
        directory = REPO_ROOT / ".github" / "workflows"
        workflows = sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")])
        assert workflows, "no workflows found; this test would pass vacuously"
        offenders = [
            f"{path.name}:{number}: {line.strip()}"
            for path in workflows
            for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
            # Comments explain why it is absent; those survive its deletion.
            if not line.lstrip().startswith("#")
            and ("tools/approvals" in line or "approvals" in _matrix_names(line))
        ]
        assert offenders == [], offenders

    def test_nothing_under_apps_or_packages_still_points_at_it(self) -> None:
        reaches_in = re.compile(r"""(?:from|import|require\()\s*['"][^'"]*tools/approvals""")
        with tempfile.TemporaryDirectory(prefix="cg-forked-") as tmp:
            forked = self._repo_without_the_toolkit(Path(tmp) / "repo")
            offenders = [
                str(path.relative_to(forked))
                for directory in (forked / "apps", forked / "packages")
                for path in _sources(directory, (".ts", ".tsx"))
                if reaches_in.search(path.read_text(encoding="utf-8"))
            ]
        assert offenders == [], offenders

    def test_the_shared_routing_cases_survive_because_they_live_elsewhere(self) -> None:
        # The one file this toolkit's tests read from outside their own tree.
        # It has another reader — the TypeScript router's test — so deleting
        # this directory must not take it with them.
        with tempfile.TemporaryDirectory(prefix="cg-forked-") as tmp:
            forked = self._repo_without_the_toolkit(Path(tmp) / "repo")
            cases = (
                forked / "packages" / "policy-schema" / "contract"
                / "approver-routing-cases.json"
            )
            assert cases.is_file()
            assert json.loads(cases.read_text(encoding="utf-8"))["cases"]
            assert not (forked / "tools" / "approvals").exists()


def _matrix_names(line: str) -> str:
    """The names in a `toolkit: [a, b]` style matrix line, or an empty string.

    A workflow may say `tools/${{ matrix.toolkit }}` — that is fine, because
    the matrix is discovered. What must not appear is the name itself.
    """
    match = re.search(r"toolkit:\s*\[([^\]]*)\]", line)
    return match.group(1) if match else ""
