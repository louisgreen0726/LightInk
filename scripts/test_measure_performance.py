#!/usr/bin/env python3
"""Unit tests for the pure helpers in scripts/measure_performance.py.

Run with:  python -m unittest scripts.test_measure_performance -v
       or:  python scripts/test_measure_performance.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import measure_performance as mp  # noqa: E402


class TestGenerateBigMarkdown(unittest.TestCase):
    def test_reaches_target_word_count(self):
        doc = mp.generate_big_markdown(10_000)
        self.assertGreaterEqual(mp.word_count(doc), 10_000)

    def test_contains_gfm_structures(self):
        doc = mp.generate_big_markdown(1_000)
        self.assertIn("```rust", doc)
        self.assertIn("| col a | col b |", doc)
        self.assertIn("## ", doc)


class TestWordCount(unittest.TestCase):
    def test_strips_fenced_code(self):
        self.assertEqual(mp.word_count("hello ```\nsome code here\n``` world"), 2)

    def test_strips_inline_code(self):
        self.assertEqual(mp.word_count("a `b c` d"), 2)

    def test_empty(self):
        self.assertEqual(mp.word_count(""), 0)


class TestParseWindowsCsv(unittest.TestCase):
    SAMPLE = (
        '"ProcessId","ParentProcessId","WorkingSetSize","PrivatePageCount"\r\n'
        '"100","4","1048576","524288"\r\n'
        '"200","100","2097152","1048576"\r\n'
        '"300","100","",""\r\n'
    )

    def test_parses_rows_and_skips_bad(self):
        rows = mp.parse_windows_process_csv(self.SAMPLE)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0].pid, 100)
        self.assertEqual(rows[1].ws_bytes, 2097152)
        self.assertEqual(rows[1].priv_bytes, 1048576)
        # empty WorkingSetSize/PrivatePageCount degrade to 0, not a parse error
        self.assertEqual(rows[2].ws_bytes, 0)
        self.assertEqual(rows[2].priv_bytes, 0)


class TestParsePsTable(unittest.TestCase):
    def test_parses(self):
        rows = mp.parse_ps_table("  1   0 1024\n 200   1 2048\njunk line\n")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1].ws_bytes, 2048 * 1024)


class TestTreeRss(unittest.TestCase):
    def setUp(self):
        self.rows = [
            mp.ProcRow(pid=1, ppid=0, ws_bytes=10, priv_bytes=5),
            mp.ProcRow(pid=2, ppid=1, ws_bytes=20, priv_bytes=10),
            mp.ProcRow(pid=3, ppid=1, ws_bytes=30, priv_bytes=15),
            mp.ProcRow(pid=4, ppid=2, ws_bytes=40, priv_bytes=20),
            mp.ProcRow(pid=5, ppid=9, ws_bytes=50, priv_bytes=25),  # unrelated
        ]

    def test_sums_descendants_only(self):
        mem = mp.tree_memory(self.rows, 1)
        self.assertEqual(mem.ws_bytes, 100)
        self.assertEqual(mem.priv_bytes, 50)
        self.assertEqual(mem.proc_count, 4)
        self.assertEqual(mem.root_ws_bytes, 10)
        self.assertEqual(mem.root_priv_bytes, 5)

    def test_unknown_root(self):
        mem = mp.tree_memory(self.rows, 999)
        self.assertEqual((mem.ws_bytes, mem.proc_count), (0, 0))

    def test_cycle_safe(self):
        rows = self.rows + [mp.ProcRow(pid=1, ppid=4, ws_bytes=10, priv_bytes=5)]
        mem = mp.tree_memory(rows, 1)
        self.assertGreaterEqual(mem.ws_bytes, 100)


if __name__ == "__main__":
    unittest.main()
