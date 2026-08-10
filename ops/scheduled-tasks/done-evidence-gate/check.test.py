#!/usr/bin/env python3
"""Unit tests for check.py (the CARD-reopening evidence gate, card bb5d8108).

Lives colocated with check.py, OUTSIDE the tracked marveen repo, by the same
design as check.py itself (2026-07-04 header note: kept out of the repo so it
never diverges from official upstream). This means scripts/run-script-tests.sh
does NOT discover this file -- run it manually after any edit to check.py:

    python3 ~/.claude/scheduled-tasks/done-evidence-gate/check.test.py

Tests only the PURE decision function (compute_missing) and its inputs
(resolve, extract_candidates, _flaggable) -- never main(), which connects to
the live kanban DB and would mutate real card status merely by running.
Importing check.py itself is safe: its DB-touching code is guarded behind
`if __name__ == '__main__'` (card bb5d8108 also fixed this -- previously it
was bare module-level code that ran on import).
"""
import importlib.util
import os
import unittest
from unittest import mock

_MODULE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check.py")
_spec = importlib.util.spec_from_file_location("done_evidence_gate_check", _MODULE_PATH)
check = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(check)  # type: ignore[union-attr]

# Genuinely non-existent, real prefixes (store/ is wholesale gitignored;
# scripts/ is tracked and not ignored) -- deterministic regardless of what
# else exists on this box.
FAKE_STORE_PATH = "store/nonexistent-fixture-bb5d8108.json"
FAKE_TRACKED_MISSING = "scripts/also-fake-bb5d8108.py"


class TestComputeMissing(unittest.TestCase):
    def test_1_gitignored_path_produces_no_hit(self):
        # Card dc0fb6f0's rule, ported: a store/ path can never be a
        # committed deliverable, regardless of card-comment wording.
        text = f"DONE: wrote {FAKE_STORE_PATH} with the new config."
        missing = check.compute_missing([FAKE_STORE_PATH], text)
        self.assertEqual(missing, [])

    def test_2_tracked_but_missing_path_still_reopens(self):
        # Load-bearing: the gitignore filter must not become a blanket pass.
        text = f"DONE: wrote {FAKE_TRACKED_MISSING} with the fix."
        missing = check.compute_missing([FAKE_TRACKED_MISSING], text)
        self.assertEqual(missing, [FAKE_TRACKED_MISSING])

    def test_3_absence_asserted_tracked_path_produces_no_hit(self):
        # Card 9682c5ee's rule, ported: a TRACKED path whose own clause
        # asserts it does not exist (a true statement, e.g. about a deleted
        # file) must not reopen the card forever.
        text = f"DONE: the runner is inert only because {FAKE_TRACKED_MISSING} is absent."
        missing = check.compute_missing([FAKE_TRACKED_MISSING], text)
        self.assertEqual(missing, [])

    def test_4_absence_word_elsewhere_does_not_excuse_a_different_missing_path(self):
        # Load-bearing (clause-scoping half): an absence word about one path
        # must not blanket-excuse an unrelated genuinely-missing path.
        other = "scripts/also-fake-bb5d8108-second.py"
        text = f"DONE: {FAKE_TRACKED_MISSING} is absent by design. Also wrote {other} with the new logic."
        missing = check.compute_missing([FAKE_TRACKED_MISSING, other], text)
        self.assertEqual(missing, [other])

    def test_5_gitignore_helper_import_failure_fails_open(self):
        # If the sibling script cannot be imported (moved, renamed, syntax
        # error), _load_evidence_gate_helpers() must return a no-op stand-in
        # that EXCLUDES NOTHING -- never one that blanket-excuses every path.
        with mock.patch("importlib.util.spec_from_file_location", side_effect=OSError("no such file")):
            gitignored_fn, absence_fn = check._load_evidence_gate_helpers()
        self.assertEqual(gitignored_fn([FAKE_STORE_PATH]), set())
        self.assertEqual(absence_fn("anything"), set())
        # And end to end: with the broken (no-op) helper wired in, the
        # store/ path that check-ignore would normally excuse must still
        # surface as missing -- fail open, not fail closed.
        with mock.patch.object(check, "_gitignored_paths", gitignored_fn):
            missing = check.compute_missing([FAKE_STORE_PATH], "DONE: wrote it")
        self.assertEqual(missing, [FAKE_STORE_PATH])


class TestCategorizeCandidates(unittest.TestCase):
    """Card d2d949c3: the categorize function must derive every category from
    the actual data -- verified, gitignored, absence-asserted, non-local, and
    missing must each reflect what actually happened, not a hardcoded label."""

    def test_1_verified_path_in_verified_bucket(self):
        # A real file on disk (inside the marveen repo so git check-ignore works).
        real = os.path.join(os.path.expanduser('~'), 'marveen/scripts/inter-agent-evidence-gate.py')
        cat = check.categorize_candidates([real], "DONE: wrote inter-agent-evidence-gate.py")
        self.assertEqual(cat['verified'], [real])
        self.assertEqual(cat['missing'], [])

    def test_2_gitignored_path_in_gitignored_bucket(self):
        cat = check.categorize_candidates([FAKE_STORE_PATH], f"DONE: wrote {FAKE_STORE_PATH}")
        self.assertEqual(cat['gitignored'], [FAKE_STORE_PATH])
        self.assertEqual(cat['missing'], [])

    def test_3_absence_asserted_tracked_path_in_absence_bucket(self):
        text = f"DONE: the runner is inert only because {FAKE_TRACKED_MISSING} is absent."
        cat = check.categorize_candidates([FAKE_TRACKED_MISSING], text)
        self.assertEqual(cat['absence_asserted'], [FAKE_TRACKED_MISSING])
        self.assertEqual(cat['missing'], [])

    def test_4_genuinely_missing_path_in_missing_bucket(self):
        text = f"DONE: wrote {FAKE_TRACKED_MISSING} with the fix."
        cat = check.categorize_candidates([FAKE_TRACKED_MISSING], text)
        self.assertEqual(cat['missing'], [FAKE_TRACKED_MISSING])

    def test_5_categories_are_mutually_exclusive(self):
        # Each path appears in exactly one bucket.
        # Use a known-real file INSIDE the marveen repo (absolute path outside
        # the repo causes git check-ignore to exit 128, failing open to empty set).
        real = os.path.join(os.path.expanduser('~'), 'marveen/scripts/inter-agent-evidence-gate.py')
        other_missing = "scripts/another-fake-d2d949c3.py"
        text = (
            f"DONE: wrote {real} for testing, {FAKE_STORE_PATH} for config, "
            f"{FAKE_TRACKED_MISSING} is absent by design. Also wrote {other_missing}."
        )
        candidates = [real, FAKE_STORE_PATH, FAKE_TRACKED_MISSING, other_missing]
        cat = check.categorize_candidates(candidates, text)
        self.assertEqual(cat['verified'], [real])
        self.assertEqual(cat['gitignored'], [FAKE_STORE_PATH])
        self.assertEqual(cat['absence_asserted'], [FAKE_TRACKED_MISSING])
        self.assertEqual(cat['missing'], [other_missing])
        # Total across all buckets must equal input count
        total = sum(len(v) for v in cat.values())
        self.assertEqual(total, len(candidates))

    def test_6_absence_word_elsewhere_does_not_excuse_a_different_path(self):
        # Card bc6b2b98 / clause-scoping: an absence word in a DIFFERENT clause
        # must not pull an unrelated genuinely-missing path into the absence bucket.
        other = "scripts/also-fake-d2d949c3-second.py"
        text = f"DONE: {FAKE_TRACKED_MISSING} is absent by design. Also wrote {other} with the new logic."
        cat = check.categorize_candidates([FAKE_TRACKED_MISSING, other], text)
        self.assertEqual(cat['absence_asserted'], [FAKE_TRACKED_MISSING])
        self.assertEqual(cat['missing'], [other])


class TestFormatOkComment(unittest.TestCase):
    """Card d2d949c3: the OK comment must be DERIVED from categorized data.
    Every claim in the output maps to a specific category count -- no
    hardcoded assertion that can drift when the data changes."""

    def test_1_only_verified_paths_mentioned(self):
        cat = {'verified': ['a.py'], 'gitignored': [], 'absence_asserted': [],
               'skipped_nonlocal': [], 'missing': []}
        out = check.format_ok_comment(cat)
        self.assertIn("1 verified on disk", out)
        self.assertNotIn("gitignore", out)
        self.assertNotIn("absence", out)
        self.assertNotIn("non-local", out)

    def test_2_mixed_categories_all_appear(self):
        cat = {'verified': ['a.py'], 'gitignored': ['store/x.json'],
               'absence_asserted': ['scripts/deleted.py'], 'skipped_nonlocal': [],
               'missing': []}
        out = check.format_ok_comment(cat)
        self.assertIn("1 verified on disk", out)
        self.assertIn("1 structurally excluded (gitignore)", out)
        self.assertIn("1 absence-asserted (not checked)", out)
        self.assertNotIn("non-local", out)

    def test_3_output_changes_when_data_changes(self):
        # Load-bearing: the string must be DERIVED, not a fixed template.
        cat_a = {'verified': ['a.py'], 'gitignored': [], 'absence_asserted': [],
                 'skipped_nonlocal': [], 'missing': []}
        cat_b = {'verified': [], 'gitignored': ['store/x.json'], 'absence_asserted': [],
                 'skipped_nonlocal': [], 'missing': []}
        self.assertNotEqual(check.format_ok_comment(cat_a), check.format_ok_comment(cat_b))

    def test_4_total_matches_sum_of_parts(self):
        cat = {'verified': ['a.py', 'b.py'], 'gitignored': ['store/x.json'],
               'absence_asserted': [], 'skipped_nonlocal': ['apps/api/y.ts'],
               'missing': []}
        out = check.format_ok_comment(cat)
        self.assertIn("4 cited", out)

    def test_5_no_parts_produces_safe_fallback(self):
        cat = {'verified': [], 'gitignored': [], 'absence_asserted': [],
               'skipped_nonlocal': [], 'missing': []}
        out = check.format_ok_comment(cat)
        self.assertIn("OK", out)
        self.assertIn("done-evidence-gate", out)


if __name__ == "__main__":
    unittest.main()
