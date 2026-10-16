"""`grove update`: where Grove's checkout stands against its upstream, and when the app needs a rebuild.

Run: python3 -m unittest discover tests
"""
import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_project_config import load_grove

grove = load_grove()


def git(cwd, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main",
                           "-C", str(cwd), *args], text=True, capture_output=True, check=True).stdout.strip()


def commit(repo, path, text):
    (repo / path).parent.mkdir(parents=True, exist_ok=True)
    (repo / path).write_text(text)
    git(repo, "add", path)
    git(repo, "commit", "-qm", f"edit {path}")
    return git(repo, "rev-parse", "HEAD")


class Update(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.origin, self.upstream, self.checkout = root / "origin.git", root / "upstream", root / "checkout"
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", str(self.origin)], check=True)
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.upstream)], check=True, capture_output=True)
        commit(self.upstream, "main.js", "v1")
        commit(self.upstream, "cli/grove", "v1")
        git(self.upstream, "push", "-q", "origin", "HEAD:main")
        subprocess.run(["git", "clone", "-q", str(self.origin), str(self.checkout)], check=True, capture_output=True)
        self.app = root / "Grove.app"
        patches = [mock.patch.object(grove, "REPO", self.checkout), mock.patch.object(grove, "APP_BUNDLE", self.app)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)

    def install_app(self, commit_sha):
        res = self.app / "Contents/Resources/app"
        res.mkdir(parents=True, exist_ok=True)
        if commit_sha:
            (res / "version.json").write_text(json.dumps({"commit": commit_sha}))

    def push(self, path, text):
        sha = commit(self.upstream, path, text)
        git(self.upstream, "push", "-q", "origin", "HEAD:main")
        return sha

    def quiet(self, args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            grove.cmd_update(args)
        return out.getvalue()

    def test_up_to_date(self):
        self.install_app(git(self.checkout, "rev-parse", "HEAD"))
        s = grove.update_state()
        self.assertEqual((s["behind"], s["appStale"], s["available"], s["blocked"]), (0, False, False, None))

    def test_cli_only_change_pulls_without_rebuilding(self):
        self.install_app(git(self.checkout, "rev-parse", "HEAD"))
        sha = self.push("cli/grove", "v2")
        s = grove.update_state()
        self.assertEqual((s["behind"], s["appStale"], s["available"]), (1, False, True))
        with mock.patch.object(grove, "rebuild_app") as rebuild:
            out = self.quiet([])
        rebuild.assert_not_called()
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), sha)
        self.assertIn("app: up to date", out)

    def test_app_change_rebuilds(self):
        self.install_app(git(self.checkout, "rev-parse", "HEAD"))
        self.push("main.js", "v2")
        with mock.patch.object(grove, "rebuild_app") as rebuild:
            self.quiet(["--relaunch"])
        rebuild.assert_called_once()
        self.assertTrue(rebuild.call_args.kwargs["relaunch"])

    def test_unstamped_app_is_stale(self):
        self.install_app(None)
        s = grove.update_state()
        self.assertTrue(s["appStale"])
        self.assertTrue(s["available"])

    def test_no_app_installed_is_never_stale(self):
        self.assertFalse(grove.update_state()["appStale"])

    def test_local_changes_block(self):
        self.install_app(git(self.checkout, "rev-parse", "HEAD"))
        self.push("cli/grove", "v2")
        (self.checkout / "main.js").write_text("local edit")
        s = grove.update_state()
        self.assertIn("uncommitted", s["blocked"])
        self.assertFalse(s["available"])
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            grove.cmd_update([])

    def test_local_commits_block(self):
        self.push("cli/grove", "v2")
        commit(self.checkout, "notes.txt", "mine")
        s = grove.update_state()
        self.assertEqual((s["ahead"], s["behind"]), (1, 1))
        self.assertIn("local commit", s["blocked"])

    def test_no_upstream_blocks(self):
        git(self.checkout, "checkout", "-qb", "topic")
        self.assertIn("no upstream", grove.update_state()["blocked"])

    def test_auto_setting(self):
        self.quiet(["--auto", "on"])
        self.assertTrue(grove.update_state(fetch=False)["auto"])
        self.quiet(["--auto", "off"])
        self.assertFalse(grove.update_state(fetch=False)["auto"])


if __name__ == "__main__":
    unittest.main()
