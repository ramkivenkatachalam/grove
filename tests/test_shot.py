"""grove shot: where screenshots go, and what gets typed at Claude's prompt.

Run: python3 -m unittest discover tests
"""
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_project_config import load_grove

grove = load_grove()


class Shot(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.f = {"name": "feat", "project": "p", "path": str(self.tmp / "wt")}
        patches = [
            mock.patch.object(grove, "PROJECTS", self.tmp / "projects"),
            mock.patch.object(grove, "feature", lambda name: self.f),
            mock.patch.object(grove, "type_into_claude", self.typed),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.sent = []
        self.image = self.tmp / "in.png"
        self.image.write_bytes(b"\x89PNG fake")

    def typed(self, f, text, enter):
        self.sent.append((text, enter))

    def shot(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            grove.cmd_shot(list(args))
        return out.getvalue().strip()

    def test_file_is_kept_in_shots_and_pasted_without_enter(self):
        self.shot("feat", str(self.image))
        [(text, enter)] = self.sent
        saved = Path(text.strip())
        self.assertEqual(saved.parent, self.tmp / "projects/p/feat/shots")
        self.assertEqual(saved.read_bytes(), b"\x89PNG fake")
        self.assertTrue(text.endswith(" "))
        self.assertFalse(enter)

    def test_note_sends_it(self):
        self.shot("feat", str(self.image), "the", "button", "is", "clipped")
        [(text, enter)] = self.sent
        self.assertTrue(text.endswith(".png the button is clipped"))
        self.assertTrue(enter)

    def test_print_only_prints(self):
        out = self.shot("feat", str(self.image), "--print")
        self.assertEqual(self.sent, [])
        self.assertTrue(Path(out).is_file())

    def test_names_do_not_collide(self):
        a = grove.shot_path(self.f)
        a.write_bytes(b"x")
        self.assertNotEqual(grove.shot_path(self.f), a)

    def test_not_an_image(self):
        txt = self.tmp / "notes.txt"
        txt.write_text("hi")
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.shot("feat", str(txt))

    def test_cancelled_capture(self):
        with mock.patch.object(grove, "run", return_value=None), mock.patch.object(grove.shutil, "which", return_value="/x"), \
                self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
            grove.cmd_shot(["feat"])
        self.assertEqual(self.sent, [])


if __name__ == "__main__":
    unittest.main()
