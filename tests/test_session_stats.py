"""The status line's session stats: what Claude Code sends, kept in stats.json and shown in one line.

Run: python3 -m unittest discover tests
"""
import contextlib
import io
import json
import sys
import unittest
from unittest import mock

from test_project_config import ROOT, load_grove

grove = load_grove()

FULL = {
    "session_id": "abc",
    "version": "2.1.0",
    "model": {"id": "claude-opus-5-5", "display_name": "Opus 5.5"},
    "output_style": {"name": "default"},
    "cost": {"total_cost_usd": 1.234, "total_duration_ms": 754000, "total_api_duration_ms": 300000,
             "total_lines_added": 120, "total_lines_removed": 30},
    "context_window": {"total_input_tokens": 500000, "total_output_tokens": 20000, "context_window_size": 200000,
                       "current_usage": {"input_tokens": 4000, "output_tokens": 900,
                                         "cache_creation_input_tokens": 10000, "cache_read_input_tokens": 70000}},
    "rate_limits": {"five_hour": {"used_percentage": 12, "resets_at": 1760000000}},
}


class SessionStats(unittest.TestCase):
    def test_full_payload(self):
        s = grove.session_stats(FULL)
        self.assertEqual(s["model"], "Opus 5.5")
        self.assertEqual(s["context"]["used"], 84000)
        self.assertEqual(s["context"]["percent"], 42.0)
        self.assertEqual(s["context"]["parts"]["cacheRead"], 70000)
        self.assertEqual(s["rateLimits"], [{"label": "5-hour", "percent": 12, "resetsAt": 1760000000}])
        self.assertEqual(grove.stats_line(s), "Opus 5.5 · ctx 84k/200k (42%) · $1.23 · 12m · +120 −30")

    def test_reported_percentage_wins(self):
        data = {**FULL, "context_window": {**FULL["context_window"], "used_percentage": 85}}
        self.assertIn("(85%, near limit)", grove.stats_line(grove.session_stats(data)))

    def test_old_payload_keeps_model_and_cost(self):
        s = grove.session_stats({"model": {"display_name": "Sonnet"}, "cost": {"total_cost_usd": 0.5}})
        self.assertIsNone(s["context"]["used"])
        self.assertEqual(grove.stats_line(s), "Sonnet · $0.50")
        self.assertEqual(grove.stats_line(grove.session_stats({})), "")

    def test_statusline_writes_stats_once(self):
        path = ROOT / "repo-wt"
        f = {"name": "feat", "project": "p", "path": str(path)}
        grove.write_json(grove.PROJECTS / "p/feat/feature.json", f)
        data = {**FULL, "workspace": {"current_dir": str(path)}}
        stats = grove.PROJECTS / "p/feat/stats.json"

        def run():
            out = io.StringIO()
            with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(data))), \
                    mock.patch.object(grove, "ui_mode", return_value="app"), contextlib.redirect_stdout(out):
                grove.cmd_statusline()
            return out.getvalue()

        self.assertIn("ctx 84k/200k", run())
        self.assertEqual(json.loads(stats.read_text())["context"]["used"], 84000)
        before = stats.stat().st_mtime_ns
        run()
        self.assertEqual(stats.stat().st_mtime_ns, before, "unchanged stats are not rewritten")


if __name__ == "__main__":
    unittest.main()
