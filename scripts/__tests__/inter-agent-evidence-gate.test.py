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
from unittest import mock

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "inter-agent-evidence-gate.py",
)

_spec = importlib.util.spec_from_file_location("evidence_gate", _MODULE_PATH)
eg = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(eg)  # type: ignore[union-attr]

FAKE_MISSING = "scripts/also-fake-9682c5ee.py"
# card dc0fb6f0 (git check-ignore filter): every 9682c5ee test below originally
# used this SAME store/-prefixed constant. Once the check-ignore filter shipped,
# a store/ path is UNCONDITIONALLY excused regardless of clause content, which
# masked what the 9682c5ee tests exist to prove (clause-scoping, independent of
# directory). Split in two: FAKE_ABSENT_TRACKED (below, a tracked/non-ignored
# path) is now used by every pre-existing 9682c5ee test unchanged in assertions
# -- only the path's directory changed, from store/ to scripts/. FAKE_ABSENT
# stays store/-prefixed and is used ONLY by TestGitignoreFilter, which needs a
# genuinely gitignored path to test the new rule.
FAKE_ABSENT_TRACKED = "scripts/nonexistent-fixture-9682c5ee.py"
FAKE_ABSENT = "store/nonexistent-fixture-9682c5ee.json"


class TestExtractAbsenceAssertedPaths(unittest.TestCase):
    def test_the_real_production_sentence(self):
        # card 9682c5ee's own trigger, reworded onto a fixture path.
        content = (
            "DONE: the model-fallback runner is inert only because "
            f"{FAKE_ABSENT_TRACKED} is absent."
        )
        self.assertIn(FAKE_ABSENT_TRACKED, eg.extract_absence_asserted_paths(content))

    def test_does_not_exist_phrasing(self):
        content = f"DONE: {FAKE_ABSENT_TRACKED} does not exist on this install."
        self.assertIn(FAKE_ABSENT_TRACKED, eg.extract_absence_asserted_paths(content))

    def test_no_path_positional_phrasing(self):
        content = f"DONE: there is no {FAKE_ABSENT_TRACKED} in this checkout."
        self.assertIn(FAKE_ABSENT_TRACKED, eg.extract_absence_asserted_paths(content))

    def test_hungarian_nincs(self):
        content = f"KESZ: a {FAKE_ABSENT_TRACKED} nincs, ez szandekos."
        self.assertIn(FAKE_ABSENT_TRACKED, eg.extract_absence_asserted_paths(content))

    def test_absence_word_elsewhere_does_not_cover_a_different_path(self):
        # An absence word in one clause must not blanket-suppress an unrelated
        # path claimed (but missing) in another clause.
        content = (
            f"DONE: {FAKE_ABSENT_TRACKED} is absent by design. "
            f"Also wrote {FAKE_MISSING} with the new logic."
        )
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_same_path_absent_then_claimed_is_not_suppressed(self):
        # Load-bearing: the SAME path text appears once in an absence clause
        # and once in a claim clause -- must not be suppressed, since the
        # claim clause is asserting it WAS delivered.
        content = (
            f"DONE: {FAKE_ABSENT_TRACKED} is absent by design. "
            f"Later: wrote {FAKE_ABSENT_TRACKED} with the fix."
        )
        self.assertNotIn(FAKE_ABSENT_TRACKED, eg.extract_absence_asserted_paths(content))


class TestCheckMessageAbsenceGuard(unittest.TestCase):
    """The 3 guard tests requested on card 9682c5ee, at check_message() level."""

    def test_1_absence_asserted_path_produces_no_missing_hit(self):
        row = (
            1, "marveen", "buildfejleszto",
            f"DONE: the model-fallback runner is inert only because {FAKE_ABSENT_TRACKED} is absent.",
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
            f"DONE: {FAKE_ABSENT_TRACKED} is absent by design. Later: wrote {FAKE_ABSENT_TRACKED} with the fix.",
            "pending", 0,
        )
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertIn(FAKE_ABSENT_TRACKED, result["paths_missing"])

    def test_2b_unrelated_missing_path_still_produces_a_hit(self):
        row = (
            3, "marveen", "buildfejleszto",
            f"DONE: {FAKE_ABSENT_TRACKED} is absent by design. Also wrote {FAKE_MISSING} with the new logic.",
            "pending", 0,
        )
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertIn(FAKE_MISSING, result["paths_missing"])
        self.assertNotIn(FAKE_ABSENT_TRACKED, result["paths_missing"])

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


class TestGitignoreFilter(unittest.TestCase):
    """Card dc0fb6f0: a gitignored path (store/ per .gitignore) can never be
    a committed deliverable, structurally -- complements 9682c5ee's clause
    scoping, does not replace it."""

    def test_1_gitignored_path_with_no_absence_wording_produces_no_hit(self):
        # No absence clause at all -- only check-ignore should excuse this,
        # proving the two guards (9682c5ee, dc0fb6f0) are independent.
        row = (10, "marveen", "buildfejleszto", f"DONE: wrote {FAKE_ABSENT} with the new config.", "pending", 0)
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "PASS")
        self.assertEqual(result["paths_missing"], [])

    def test_2_tracked_but_missing_path_still_produces_a_hit(self):
        # Load-bearing: the filter must not become a blanket pass. FAKE_MISSING
        # is under scripts/ (tracked), not store/ (ignored).
        row = (11, "marveen", "buildfejleszto", f"DONE: wrote {FAKE_MISSING} with the fix.", "pending", 0)
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertIn(FAKE_MISSING, result["paths_missing"])

    def test_3_clause_scoping_from_9682c5ee_is_unchanged(self):
        content = f"DONE: the model-fallback runner is inert only because {FAKE_ABSENT} is absent."
        self.assertIn(FAKE_ABSENT, eg.extract_absence_asserted_paths(content))

    def test_4_git_check_ignore_error_fails_open_not_closed(self):
        # If git itself errors (missing binary, not a repo, timeout), the
        # filter must return EMPTY -- i.e. check everything normally -- never
        # silently excuse every path. Fail-closed here would hide every real
        # miss at once, which is worse than the rule not firing.
        with mock.patch.object(eg.subprocess, "run", side_effect=OSError("git not found")):
            result = eg.gitignored_paths([FAKE_ABSENT, FAKE_MISSING])
        self.assertEqual(result, set())
        # End to end: a store/ path that check-ignore would normally excuse
        # must still surface as MISSING once check-ignore itself is broken.
        # No absence wording here, so clause-scoping does not save it either.
        with mock.patch.object(eg.subprocess, "run", side_effect=OSError("git not found")):
            row = (12, "marveen", "buildfejleszto", f"DONE: wrote {FAKE_ABSENT} with the new config.", "pending", 0)
            result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertIsNotNone(result)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertIn(FAKE_ABSENT, result["paths_missing"])

    def test_5_bad_exit_code_also_fails_open(self):
        # Exit code 128 (not-a-repo / usage error) must ALSO fail open, not
        # just a raised exception -- git check-ignore does not always throw.
        fake = mock.Mock(returncode=128, stdout="")
        with mock.patch.object(eg.subprocess, "run", return_value=fake):
            result = eg.gitignored_paths([FAKE_ABSENT])
        self.assertEqual(result, set())


if __name__ == "__main__":
    unittest.main()
