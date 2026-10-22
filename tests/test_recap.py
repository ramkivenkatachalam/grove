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

    def test_risks_keep_known_kinds_and_take_strings(self):
        r = grove.shape_recap({"risks": [{"kind": "rollout", "text": "index migration runs before deploy."},
                                         {"kind": "vibes", "text": "odd kind"}, "plain string", {"kind": "reach"}],
                               "focus": ["a", "b", "c", "d"], "unverified": ["no manual run"]}, {})
        self.assertEqual(r["risks"], [{"kind": "rollout", "text": "index migration runs before deploy"},
                                      {"kind": "reach", "text": "odd kind"}, {"kind": "reach", "text": "plain string"}])
        self.assertEqual(r["focus"], ["a", "b", "c"])
        self.assertEqual(r["unverified"], ["no manual run"])

    def test_change_needs_both_sides_and_approach_must_be_text(self):
        r = grove.shape_recap({"change": {"before": "any user read any file"}, "approach": ["not", "text"]}, {})
        self.assertEqual((r["change"], r["approach"], r["example"]), (None, "", ""))
        r = grove.shape_recap({"change": {"before": "open", "after": "tenant only"}, "approach": "one gate."}, {})
        self.assertEqual((r["change"], r["approach"]), ({"before": "open", "after": "tenant only"}, "one gate"))

    def test_nothing_shown_means_empty_review_sections(self):
        r = grove.shape_recap({}, {})
        self.assertEqual([r[k] for k in ("risks", "focus", "unverified", "change", "approach", "example")],
                         [[], [], [], None, "", ""])

    def test_diagram_keeps_only_edges_between_its_nodes(self):
        d = grove.shape_diagram({"nodes": [{"id": "a", "label": "CLI"}, {"id": "b", "label": "recap.json"}, {"id": "a", "label": "dup"}],
                                 "edges": [{"from": "a", "to": "b", "label": "writes"}, {"from": "a", "to": "z"}, {"from": "b", "to": "b"}]})
        self.assertEqual(d, {"nodes": [{"id": "a", "label": "CLI"}, {"id": "b", "label": "recap.json"}],
                             "edges": [{"from": "a", "to": "b", "label": "writes"}]})
        self.assertIsNone(grove.shape_diagram({"nodes": [{"id": "a", "label": "alone"}], "edges": []}))
        self.assertIsNone(grove.shape_diagram(None))


class Markdown(unittest.TestCase):
    FULL = {
        "summary": "Storage downloads scoped to the caller's tenant",
        "why": ["Any logged-in user could read another tenant's files"],
        "change": {"before": "any storage URL read", "after": "own tenant only"},
        "approach": "One gate in front of every download route",
        "example": "customer 5283 reads file_uploads/5283/x.pdf, not file_uploads/6000/x.pdf",
        "decisions": [{"choice": "url as str", "why": "matches stored runs"}],
        "diagram": {"nodes": [{"id": "a", "label": "parse URL"}, {"id": "b", "label": "403"}, {"id": "c", "label": "staff"}],
                    "edges": [{"from": "a", "to": "b", "label": "fail"}]},
        "validation": [{"check": "router tests", "result": "pass"}, {"check": "deploy", "result": "todo"}],
        "unverified": ["no manual run against staging"],
        "risks": [{"kind": "rollout", "text": "index migration must run first"}],
        "focus": ["the staff bypass"],
        "tasks": [{"text": "merge", "state": "todo"}, {"text": "write gate", "state": "done"}],
        "blockers": [],
    }

    def test_four_sections_in_order(self):
        md = grove.recap_markdown(self.FULL, [{"file": "1.png", "caption": "403 for another tenant"}])
        heads = [ln for ln in md.splitlines() if ln.startswith("## ")]
        self.assertEqual(heads, ["## Why", "## Approach", "## How we know it works", "## Risks and reviewer focus", "## Still to do"])
        for want in ("**Before:** any storage URL read.", "parse URL --fail--> 403\nstaff\n", "Example: customer 5283",
                     "- url as str — matches stored runs", "✅ passed: router tests", "⬜ not run yet: deploy",
                     "📷 Screenshot: 403 for another tenant", "Not verified:\n- no manual run against staging.",
                     "**Rollout:** index migration must run first.", "1. the staff bypass.", "- [ ] merge"):
            self.assertIn(want, md)
        self.assertNotIn("write gate", md)

    def test_old_recap_still_prints_and_gaps_say_so(self):
        md = grove.recap_markdown({"goal": "g", "summary": "does a thing", "why": ["w"], "done": ["x"]}, [])
        self.assertIn("## Approach\ndoes a thing.", md)
        self.assertIn("## How we know it works\n_Nothing recorded yet._", md)
        self.assertIn("_None found in the work so far._", md)
        self.assertNotIn("Still to do", md)


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
