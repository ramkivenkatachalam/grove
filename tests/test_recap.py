"""grove recap and grove proof: the summary's shape, whatever the model replies, and kept screenshots.

Run: python3 -m unittest discover tests
"""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_project_config import load_grove

grove = load_grove()


class ShapeRecap(unittest.TestCase):
    def test_tasks_sorted_done_doing_todo_with_one_doing(self):
        r = grove.shape_recap({"tasks": [
            {"text": "write tests", "state": "todo"},
            {"text": "schema", "state": "done"},
            {"text": "renderer", "state": "doing"},
            {"text": "cli", "state": "doing"},
            {"text": "odd", "state": "maybe"},
            {"state": "done"},
        ]}, {})
        self.assertEqual([(t["text"], t["state"]) for t in r["tasks"]],
                         [("schema", "done"), ("renderer", "doing"), ("write tests", "todo"), ("cli", "todo"), ("odd", "todo")])
        # older readers (the retro, the header) still get done / now / next
        self.assertEqual((r["done"], r["now"], r["next"]), (["schema"], "renderer", ["write tests", "cli", "odd"]))

    def test_decisions_take_strings_or_objects(self):
        r = grove.shape_recap({"decisions": ["plain one.", {"choice": "svg by hand", "why": "no new deps"}, {"why": "no choice"}]}, {})
        self.assertEqual(r["decisions"], [{"choice": "plain one", "why": ""}, {"choice": "svg by hand", "why": "no new deps"}])

    def test_validation_results_are_known_words(self):
        r = grove.shape_recap({"validation": [{"check": "unit tests", "result": "pass"}, {"check": "screenshot", "result": "ok"}]}, {})
        self.assertEqual([c["result"] for c in r["validation"]], ["pass", "todo"])

    def test_goal_falls_back_to_the_previous_one(self):
        self.assertEqual(grove.shape_recap({}, {"goal": "old goal"})["goal"], "old goal")
        self.assertEqual(grove.shape_recap({"diagram": "boxes"}, {})["diagram"], None)

    def test_diagram_keeps_only_edges_between_its_nodes(self):
        d = grove.shape_diagram({"nodes": [{"id": "a", "label": "CLI"}, {"id": "b", "label": "recap.json"}, {"id": "a", "label": "dup"}],
                                 "edges": [{"from": "a", "to": "b", "label": "writes"}, {"from": "a", "to": "z"}, {"from": "b", "to": "b"}]})
        self.assertEqual(d, {"nodes": [{"id": "a", "label": "CLI"}, {"id": "b", "label": "recap.json"}],
                             "edges": [{"from": "a", "to": "b", "label": "writes"}]})
        self.assertIsNone(grove.shape_diagram({"nodes": [{"id": "a", "label": "alone"}], "edges": []}))
        self.assertIsNone(grove.shape_diagram(None))


class Proof(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.f = {"name": "feat", "project": "p", "path": str(self.tmp / "wt")}
        for p in (mock.patch.object(grove, "PROJECTS", self.tmp / "projects"),
                  mock.patch.object(grove, "feature", lambda name: self.f)):
            p.start()
            self.addCleanup(p.stop)
        self.image = self.tmp / "in.png"
        self.image.write_bytes(b"\x89PNG fake")

    def proof(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            grove.cmd_proof(list(args))
        return out.getvalue().strip()

    def test_kept_with_caption_and_listed(self):
        self.proof("feat", str(self.image), "summary", "tab", "with", "diagram")
        self.proof("feat", str(self.image))
        rows = grove.proof_list(self.f)
        self.assertEqual([r["caption"] for r in rows], ["summary tab with diagram", ""])
        self.assertNotEqual(rows[0]["file"], rows[1]["file"])
        self.assertTrue((self.tmp / "projects/p/feat/proof" / rows[0]["file"]).is_file())
        self.assertEqual(json.loads(self.proof("feat", "--ls", "--json")), rows)

    def test_missing_files_drop_out_of_the_list(self):
        self.proof("feat", str(self.image), "one")
        (self.tmp / "projects/p/feat/proof" / grove.proof_list(self.f)[0]["file"]).unlink()
        self.assertEqual(grove.proof_list(self.f), [])

    def test_rejects_non_images_and_no_source(self):
        txt = self.tmp / "notes.txt"
        txt.write_text("hi")
        for args in (["feat", str(txt)], ["feat"], ["feat", "just", "words"]):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                self.proof(*args)


if __name__ == "__main__":
    unittest.main()
