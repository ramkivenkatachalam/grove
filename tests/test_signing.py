"""scripts/signing-identity.sh: makes the local code-signing identity once, in a throwaway keychain here
(never the login keychain), and finds it again on re-runs.

Run: python3 -m unittest discover tests
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/signing-identity.sh"


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("security"), "needs macOS security(1)")
class SigningIdentity(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.kc = str(Path(self.tmp.name) / "test.keychain-db")
        subprocess.run(["security", "create-keychain", "-p", "test", self.kc], check=True)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(subprocess.run, ["security", "delete-keychain", self.kc], capture_output=True)
        subprocess.run(["security", "unlock-keychain", "-p", "test", self.kc], check=True)
        self.env = {**os.environ, "GROVE_SIGNING_KEYCHAIN": self.kc}

    def script(self, *args):
        return subprocess.run([str(SCRIPT), *args], env=self.env, text=True, capture_output=True)

    def test_print_without_identity_fails_and_creates_nothing(self):
        self.assertEqual(self.script("--print").returncode, 1)
        self.assertEqual(self.script("--print").returncode, 1)

    def test_creates_once_then_reuses(self):
        first = self.script("--no-trust")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("created", first.stdout)
        sha = self.script("--print").stdout.strip()
        self.assertRegex(sha, r"^[0-9A-F]{40}$")
        again = self.script("--no-trust")
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("already", again.stdout)
        self.assertEqual(self.script("--print").stdout.strip(), sha)
        found = subprocess.run(["security", "find-identity", "-p", "codesigning", self.kc],
                               text=True, capture_output=True).stdout
        self.assertEqual(found.count('"Grove Local Signing"'), 1, found)


if __name__ == "__main__":
    unittest.main()
