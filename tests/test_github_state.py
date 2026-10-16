"""GitHub state per project: PRs, bot findings and the gh account live in each project's folder.

Run: python3 -m unittest discover tests
"""
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

CLI = Path(__file__).resolve().parent.parent / "cli" / "grove"


def load_grove(home: Path):
    """Import cli/grove with HOME and the hub in a temp folder: HUB and PROJECTS are fixed at import."""
    saved = {k: os.environ.get(k) for k in ("HOME", "GROVE_HUB", "GROVE_BIN")}
    os.environ["HOME"], os.environ["GROVE_HUB"] = str(home), str(home / ".grove")
    os.environ.pop("GROVE_BIN", None)
    try:
        loader = importlib.machinery.SourceFileLoader("grove_cli_gh", str(CLI))
        mod = importlib.util.module_from_spec(importlib.util.spec_from_loader("grove_cli_gh", loader))
        loader.exec_module(mod)
        return mod
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def pr(number, branch, state="OPEN"):
    return {"number": number, "headRefName": branch, "state": state, "isDraft": False, "url": f"u/{number}",
            "statusCheckRollup": [], "reviewDecision": "", "updatedAt": "2026-10-14T00:00:00Z"}


class GithubState(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="grove-gh-test-")
        root = Path(self.tmp.name).resolve()
        (root / "home").mkdir()
        self.grove = g = load_grove(root / "home")
        self.assertTrue(str(g.HUB).startswith(str(root)), "tests must never touch the real hub")
        for name in ("acme", "zeta"):
            repo = root / "repos" / name
            repo.mkdir(parents=True)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            g.write_json(g.project_conf(name), {"repo": str(repo)})
            # one feature per project, both on the same branch name
            g.write_json(g.PROJECTS / name / f"f-{name}" / "feature.json",
                         {"name": f"f-{name}", "project": name, "branch": "me/fix", "path": str(repo)})

    def tearDown(self):
        self.tmp.cleanup()

    def feature(self, name):
        return self.grove.read_json(self.grove.PROJECTS / name / f"f-{name}" / "feature.json", None)

    def fake_gh(self, lists, fail=(), heads=None):
        """gh as a fake: `lists` answers `pr list` per project, `heads` answers `pr list --head <branch>`."""
        self.calls = []

        def gh(p, args):
            self.calls.append(args)
            if args[0] == "pr":
                if p["name"] in fail:
                    return subprocess.CompletedProcess(args, 1, "", "warning\nHTTP 401: Bad credentials\n")
                if "--head" in args:
                    branch = args[args.index("--head") + 1]
                    return subprocess.CompletedProcess(args, 0, json.dumps((heads or {}).get(branch, [])), "")
                return subprocess.CompletedProcess(args, 0, json.dumps(lists.get(p["name"], [])), "")
            return subprocess.CompletedProcess(args, 0, "", "")  # bot comments: none
        self.grove.gh = gh

    def committed_feature(self, name):
        """The feature's repo with a commit that main does not have, as after a squash merge."""
        f = self.feature(name)
        git = ["git", "-C", f["path"], "-c", "user.name=t", "-c", "user.email=t@t"]
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "base"], check=True)
        subprocess.run([*git, "branch", "-M", "main"], check=True)
        subprocess.run([*git, "checkout", "-q", "-b", "me/fix"], check=True)
        subprocess.run([*git, "commit", "-q", "--allow-empty", "-m", "work"], check=True)
        return f

    def test_same_branch_in_two_repos_keeps_both(self):
        g = self.grove
        self.fake_gh({"acme": [pr(5, "me/fix")], "zeta": [pr(99, "me/fix")]})
        self.assertEqual(g.pr_sync(force=True), 2)
        self.assertEqual(g.pr_for(self.feature("acme"))["number"], 5)
        self.assertEqual(g.pr_for(self.feature("zeta"))["number"], 99)
        self.assertEqual(set(g.read_json(g.prs_file("acme"), {})), {"fetchedAt", "byBranch"})

    def test_a_fresh_cache_is_not_refetched(self):
        g = self.grove
        g.write_json(g.prs_file("acme"), {"fetchedAt": time.time(), "byBranch": {"me/fix": {"number": 1}}})
        self.fake_gh({"acme": [pr(5, "me/fix")], "zeta": []})
        g.pr_sync()
        self.assertEqual(g.pr_for(self.feature("acme"))["number"], 1)

    def test_an_unreachable_repo_keeps_what_was_known(self):
        g = self.grove
        g.write_json(g.prs_file("zeta"), {"fetchedAt": 0, "byBranch": {"me/fix": {"number": 99}}})
        self.fake_gh({"acme": [pr(5, "me/fix")]}, fail={"zeta"})
        g.pr_sync()
        self.assertEqual(g.pr_for(self.feature("zeta"))["number"], 99)
        self.assertGreater(g.read_json(g.prs_file("zeta"), {})["fetchedAt"], 0)

    def test_a_failed_fetch_is_marked_stale_until_one_succeeds(self):
        g = self.grove
        g.write_json(g.prs_file("zeta"), {"fetchedAt": 0, "byBranch": {"me/fix": {"number": 99}}})
        self.fake_gh({}, fail={"zeta"})
        g.pr_sync(only="zeta")
        self.assertEqual(g.pr_error("zeta"), "HTTP 401: Bad credentials")
        g.pr_sync(only="zeta")  # throttled: still stale, gh not called again
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(g.pr_error("zeta"), "HTTP 401: Bad credentials")
        self.fake_gh({"zeta": [pr(99, "me/fix", "MERGED")]})
        g.pr_sync(force=True, only="zeta")
        self.assertIsNone(g.pr_error("zeta"))
        self.assertEqual(g.pr_for(self.feature("zeta"))["state"], "MERGED")

    def test_a_branch_off_a_full_page_is_looked_up_by_name(self):
        g = self.grove
        page = [pr(1000 + i, f"me/other-{i}", "MERGED") for i in range(g.PR_LIMIT)]
        self.fake_gh({"acme": page}, heads={"me/fix": [pr(7, "me/fix", "MERGED")]})
        g.pr_sync(force=True, only="acme")
        self.assertEqual(g.pr_for(self.feature("acme"))["number"], 7)
        self.assertEqual([a[a.index("--head") + 1] for a in self.calls if "--head" in a], ["me/fix"])

    def test_a_short_page_is_complete(self):
        g = self.grove
        self.fake_gh({"acme": [pr(5, "me/other")]}, heads={"me/fix": [pr(7, "me/fix")]})
        g.pr_sync(force=True, only="acme")
        self.assertIsNone(g.pr_for(self.feature("acme")))
        self.assertFalse(any("--head" in a for a in self.calls))

    def test_closing_rechecks_a_pr_saved_as_open(self):
        g = self.grove
        f = self.committed_feature("acme")
        # fetched a moment ago, before the squash merge: inside PR_TTL, so a normal refresh would skip it
        g.write_json(g.prs_file("acme"), {"fetchedAt": time.time(), "byBranch": {"me/fix": {"number": 5, "state": "OPEN"}}})
        self.fake_gh({"acme": [pr(5, "me/fix", "MERGED")]})
        self.assertEqual(g.unfinished(f), [])
        self.assertEqual(g.pr_for(f)["state"], "MERGED")

    def test_closing_still_refuses_a_pr_that_is_open(self):
        g = self.grove
        f = self.committed_feature("acme")
        g.write_json(g.prs_file("acme"), {"fetchedAt": time.time(), "byBranch": {"me/fix": {"number": 5, "state": "OPEN"}}})
        self.fake_gh({"acme": [pr(5, "me/fix", "OPEN")]})
        self.assertEqual(g.unfinished(f), ["pull request #5 is still open"])

    def test_findings_are_kept_per_project(self):
        g = self.grove
        self.fake_gh({})
        g.new_findings(g.project("acme"), 5, "t1")
        g.new_findings(g.project("zeta"), 5, "t2")
        self.assertEqual(g.read_json(g.findings_file("acme"), {})["5"]["updatedAt"], "t1")
        self.assertEqual(g.read_json(g.findings_file("zeta"), {})["5"]["updatedAt"], "t2")

    def test_legacy_top_level_files_are_split_once(self):
        g = self.grove
        g.write_json(g.LEGACY_PRS, {
            "fetchedAt": 123, "accounts": {"acme": "work-account", "gone": "x"},
            "byBranch": {"me/a": {"number": 1, "project": "acme"}, "me/z": {"number": 2, "project": "zeta"},
                         "me/old": {"number": 3}}})
        g.write_json(g.LEGACY_FEEDBACK, {"acme#1": {"handled": [7], "pending": [], "updatedAt": "t"},
                                         "4": {"handled": [], "pending": [], "updatedAt": "t"}})
        g.split_legacy_github_state()
        self.assertFalse(g.LEGACY_PRS.exists())
        self.assertFalse(g.LEGACY_FEEDBACK.exists())
        self.assertEqual(g.read_json(g.prs_file("acme"), None), {"fetchedAt": 123, "byBranch": {"me/a": {"number": 1}}})
        self.assertEqual(g.read_json(g.prs_file("zeta"), None), {"fetchedAt": 123, "byBranch": {"me/z": {"number": 2}}})
        self.assertEqual(g.read_json(g.github_file("acme"), None), {"account": "work-account"})
        self.assertFalse(g.github_file("zeta").exists())
        self.assertFalse((g.PROJECTS / "gone").exists())
        self.assertEqual(g.read_json(g.findings_file("acme"), None), {"1": {"handled": [7], "pending": [], "updatedAt": "t"}})
        g.split_legacy_github_state()  # nothing left to do
        self.assertEqual(g.read_json(g.prs_file("acme"), None)["byBranch"], {"me/a": {"number": 1}})

    def test_gh_account_is_read_from_the_project(self):
        g = self.grove
        g.write_json(g.github_file("acme"), {"account": "work-account"})
        g.gh_token = lambda user: "token" if user == "work-account" else ""
        self.assertEqual(g.gh_user(g.project("acme")), "work-account")


if __name__ == "__main__":
    unittest.main()
