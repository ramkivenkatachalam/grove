"""Project config layering: the repo's .grove.json under ~/.grove/projects/<name>/project.json.

Run: python3 -m unittest discover tests
"""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parent.parent / "cli" / "grove"
TMP = tempfile.TemporaryDirectory(prefix="grove-test-")
ROOT = Path(TMP.name).resolve()


def load_grove():
    """Import cli/grove with HOME and the hub in a temp folder: HUB and PROJECTS are fixed at import."""
    saved = {k: os.environ.get(k) for k in ("HOME", "GROVE_HUB", "GROVE_BIN")}
    os.environ["HOME"] = str(ROOT / "home")
    os.environ["GROVE_HUB"] = str(ROOT / "home/.grove")
    os.environ.pop("GROVE_BIN", None)
    try:
        loader = importlib.machinery.SourceFileLoader("grove_cli", str(CLI))
        spec = importlib.util.spec_from_loader("grove_cli", loader)
        mod = importlib.util.module_from_spec(spec)
        loader.exec_module(mod)
        return mod
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


(ROOT / "home").mkdir()
grove = load_grove()


def tearDownModule():
    TMP.cleanup()


SHARED = {
    "base": "origin/develop",
    "setup": {"link": ["backend/.venv"], "copy": [".env"], "run": ["make deps"]},
    "services": [{"name": "web", "dir": "frontend", "run": "npm run dev -- --port {port}", "ports": [3001, 3099]}],
    "checks": "make test",
}


class ProjectCase(unittest.TestCase):
    """A registered project per test, its repo a fresh git repo under the temp folder."""

    def setUp(self):
        self.assertTrue(str(grove.PROJECTS).startswith(str(ROOT)), "tests must never touch the real hub")
        self.name = self.id().rsplit(".", 1)[-1].replace("_", "-")
        self.repo = ROOT / "repos" / self.name
        self.repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        grove._warned.clear()

    def write(self, shared=None, mine=None, raw=None):
        if raw is not None:
            (self.repo / ".grove.json").write_text(raw)
        elif shared is not None:
            (self.repo / ".grove.json").write_text(json.dumps(shared))
        grove.write_json(grove.project_conf(self.name), {"repo": str(self.repo), **(mine or {})})

    def load(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            p = grove.project(self.name)
        return p, err.getvalue()


class ProjectLayering(ProjectCase):
    def test_shared_only(self):
        self.write(shared=SHARED)
        p, err = self.load()
        self.assertEqual(err, "")
        self.assertEqual(p["base"], "origin/develop")
        self.assertEqual(p["services"], SHARED["services"])
        self.assertEqual(p["checks"], "make test")
        self.assertEqual(p["setup"], {"link": ["backend/.venv"], "clone": [], "copy": [".env"], "run": ["make deps"]})
        self.assertEqual(p["branchPrefix"], grove.DEFAULT_PROJECT["branchPrefix"])
        self.assertEqual((p["name"], p["repo"]), (self.name, self.repo))

    def test_mine_only(self):
        self.write(mine={"base": "origin/trunk", "services": [{"name": "api", "run": "x"}], "setup": {"run": ["y"]}})
        p, err = self.load()
        self.assertEqual(err, "")
        self.assertEqual(p["base"], "origin/trunk")
        self.assertEqual(p["services"], [{"name": "api", "run": "x"}])
        self.assertEqual(p["setup"], {"link": [], "clone": [], "copy": [], "run": ["y"]})
        self.assertEqual(p["checks"], grove.DEFAULT_PROJECT["checks"])

    def test_both_mine_wins_per_top_level_key(self):
        mine_services = [{"name": "web", "dir": "frontend", "run": "pnpm dev --port {port}", "ports": [4001, 4099]}]
        self.write(shared={**SHARED, "agentNotes": "team notes"}, mine={"base": "origin/main", "services": mine_services})
        p, _ = self.load()
        self.assertEqual(p["base"], "origin/main")
        self.assertEqual(p["services"], mine_services)  # the whole list is replaced, not merged by name
        self.assertEqual(p["agentNotes"], "team notes")
        self.assertEqual(p["checks"], "make test")

    def test_setup_merged_per_sub_key_over_defaults(self):
        self.write(shared=SHARED, mine={"setup": {"copy": [".env.local"], "clone": ["node_modules"]}})
        p, _ = self.load()
        self.assertEqual(p["setup"], {
            "link": ["backend/.venv"],    # the team's
            "clone": ["node_modules"],    # mine, over the default []
            "copy": [".env.local"],       # mine replaces the team's list (no append)
            "run": ["make deps"],         # the team's
        })

    def test_grove_json_missing(self):
        self.write(mine={})
        p, err = self.load()
        self.assertEqual(err, "")
        for key in ("base", "branchPrefix", "services", "env", "labels", "checks", "agentNotes", "panels", "setup"):
            self.assertEqual(p[key], grove.DEFAULT_PROJECT[key], key)

    def test_reads_working_tree_not_a_commit(self):
        self.write(shared=SHARED)  # never committed
        p, _ = self.load()
        self.assertEqual(p["base"], "origin/develop")


class BrokenSharedConfig(ProjectCase):
    def test_invalid_json_warns_and_falls_back(self):
        self.write(raw='{"services": [', mine={"checks": "mine"})
        p, err = self.load()
        self.assertIn("warning", err)
        self.assertIn(".grove.json is not valid JSON", err)
        self.assertEqual(p["services"], [])
        self.assertEqual(p["checks"], "mine")

    def test_warns_once_per_process(self):
        self.write(raw="not json")
        _, first = self.load()
        _, second = self.load()
        self.assertTrue(first)
        self.assertEqual(second, "")

    def test_non_object_is_a_problem(self):
        self.write(raw="[1, 2]")
        p, err = self.load()
        self.assertIn("not a JSON object", err)
        self.assertEqual(p["services"], [])

    def test_doctor_reports_it(self):
        self.write(raw="{oops}")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            grove.cmd_doctor()
        lines = [ln for ln in out.getvalue().splitlines() if ".grove.json" in ln]
        self.assertTrue(any(ln.strip().startswith("✗") and "not valid JSON" in ln for ln in lines), out.getvalue())

    def test_config_summary_says_invalid(self):
        self.write(raw="{oops}")
        p, _ = self.load()
        self.assertEqual(grove.config_summary(p)["source"], "invalid")


class GrovesOwnConfig(unittest.TestCase):
    def test_parses_and_clones_node_modules(self):
        shared, problem = grove.shared_config(CLI.parent.parent)
        self.assertIsNone(problem)
        self.assertIn("node_modules", shared["setup"]["clone"])


class ProjectAdd(unittest.TestCase):
    def test_writes_only_repo_when_grove_json_exists(self):
        repo = ROOT / "repos" / "with-shared"
        repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / ".grove.json").write_text(json.dumps(SHARED))
        with contextlib.redirect_stderr(io.StringIO()):  # other tests' broken projects warn
            name = grove.add_project(repo, out=io.StringIO())
        self.assertEqual(grove.read_json(grove.project_conf(name), None), {"repo": str(repo)})

    def test_writes_starter_without_grove_json(self):
        repo = ROOT / "repos" / "bare"
        repo.mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        with contextlib.redirect_stderr(io.StringIO()):  # other tests' broken projects warn
            name = grove.add_project(repo, out=io.StringIO())
        mine = grove.read_json(grove.project_conf(name), None)
        self.assertEqual(mine["_help"], grove.STARTER_HELP)
        self.assertIn("services", mine)
        self.assertIn("setup", mine)


if __name__ == "__main__":
    unittest.main()
