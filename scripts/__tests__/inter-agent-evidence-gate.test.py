#!/usr/bin/env python3
"""Unit tests for scripts/inter-agent-evidence-gate.py.

Covers the pure-logic pieces around card 9682c5ee: a path whose OWN clause
asserts it does not exist must not be counted as a missing deliverable, but
an absence word appearing anywhere in a long message must not excuse an
unrelated claimed-but-missing path (clause-scoped, not message-scoped).

No DB, no network: check_message() is exercised with db=None for messages
that carry no kanban #ref (lookup_kanban_card is then never reached).
"""
import importlib.util
import os
import unittest

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "inter-agent-evidence-gate.py",
)

_spec = importlib.util.spec_from_file_location("evidence_gate", _MODULE_PATH)
eg = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(eg)  # type: ignore[union-attr]

FAKE_ABSENT = "store/nonexistent-fixture-9682c5ee.json"
FAKE_MISSING = "scripts/also-fake-9682c5ee.py"


class TestExtractAbsenceAssertedPaths(unittest.TestCase):
    def test_the_real_production_sentence(self):
        # card 9682c5ee's own trigger, reworded onto a fixture path.
        content = (
            "DONE: the model-fallback runner is inert only because "
            f"{FAKE_ABSENT} is absent."
        )
        self.assertIn(FAKE_ABSENT, eg.extract_absence_asserted_paths(content))

    def test_does_not_exist_phrasing(self):
        content = f"DONE: {FAKE_ABSENT} does not exist on this install."
        self.assertIn(FAKE_ABSENT, eg.extract_absence_asserted_paths(content))

    def test_no_path_positional_phrasing(self):
        content = f"DONE: there is no {FAKE_ABSENT} in this checkout."
        self.assertIn(FAKE_ABSENT, eg.extract_absence_asserted_paths(content))

    def test_hungarian_nincs(self):
        content = f"KESZ: a {FAKE_ABSENT} nincs, ez szandekos."
        self.assertIn(FAKE_ABSENT, eg.extract_absence_asserted_paths(content))

    def test_absence_word_elsewhere_does_not_cover_a_different_path(self):
        # An absence word in one clause must not blanket-suppress an unrelated
        # path claimed (but missing) in another clause.
        content = (
            f"DONE: {FAKE_ABSENT} is absent by design. "
            f"Also wrote {FAKE_MISSING} with the new logic."
        )
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_same_path_absent_then_claimed_is_not_suppressed(self):
        # Load-bearing: the SAME path text appears once in an absence clause
        # and once in a claim clause -- must not be suppressed, since the
        # claim clause is asserting it WAS delivered.
        content = (
            f"DONE: {FAKE_ABSENT} is absent by design. "
            f"Later: wrote {FAKE_ABSENT} with the fix."
        )
        self.assertNotIn(FAKE_ABSENT, eg.extract_absence_asserted_paths(content))


class TestCheckMessageAbsenceGuard(unittest.TestCase):
    """The 3 guard tests requested on card 9682c5ee, at check_message() level."""

    def test_1_absence_asserted_path_produces_no_missing_hit(self):
        row = (
            1, "marveen", "buildfejleszto",
            f"DONE: the model-fallback runner is inert only because {FAKE_ABSENT} is absent.",
            "pending", 0,
        )
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "PASS")
        self.assertEqual(result["paths_missing"], [])

    def test_2_wrote_same_path_still_produces_a_hit(self):
        # Load-bearing: an absence word anywhere in the message must not
        # excuse a later clause claiming the SAME path was delivered.
        row = (
            2, "marveen", "buildfejleszto",
            f"DONE: {FAKE_ABSENT} is absent by design. Later: wrote {FAKE_ABSENT} with the fix.",
            "pending", 0,
        )
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertIn(FAKE_ABSENT, result["paths_missing"])

    def test_2b_unrelated_missing_path_still_produces_a_hit(self):
        row = (
            3, "marveen", "buildfejleszto",
            f"DONE: {FAKE_ABSENT} is absent by design. Also wrote {FAKE_MISSING} with the new logic.",
            "pending", 0,
        )
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertIn(FAKE_MISSING, result["paths_missing"])
        self.assertNotIn(FAKE_ABSENT, result["paths_missing"])

    def test_3_url_stripping_still_unaffected_by_absence_scan(self):
        row = (
            4, "marveen", "buildfishy",
            f"DONE: deployed https://suite-web-08wb.onrender.com/assets/index-abc123.js, wrote {FAKE_MISSING}",
            "pending", 0,
        )
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertEqual(result["paths_missing"], [FAKE_MISSING])


if __name__ == "__main__":
    unittest.main()
