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


class TestCommaConjunctionClauseBoundary(unittest.TestCase):
    """Card bc6b2b98: the load-bearing guard ("an absence clause about one
    path must not excuse a genuinely-missing DIFFERENT path in the same
    message") held across '.', ';' and newline but LEAKED across a comma
    conjunction -- "X is absent, and I wrote Y" put both claims in one clause,
    so X's absence assertion suppressed Y too (a false NEGATIVE: worse than
    the false positives 9682c5ee/dc0fb6f0 fixed, since it ships a missing
    deliverable as done). Cases derived from the POLICY (clause-scoped, not
    message-scoped), not from what the old implementation happened to split
    on -- that gap is exactly how the bug shipped past the original guard test."""

    # -- one test per character IN the boundary set (period is already
    # exercised throughout TestExtractAbsenceAssertedPaths; the other four
    # plus newline are covered explicitly here) --

    def test_1_comma_boundary(self):
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent, and I wrote {FAKE_MISSING} with the fix."
        self.assertIn(FAKE_ABSENT_TRACKED, eg.extract_absence_asserted_paths(content))
        self.assertNotIn(FAKE_MISSING, eg.extract_absence_asserted_paths(content))
        row = (20, "marveen", "buildfejleszto", content, "pending", 0)
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertEqual(result["paths_missing"], [FAKE_MISSING])

    def test_2_semicolon_boundary(self):
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent; I wrote {FAKE_MISSING} with the fix."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_3_colon_boundary(self):
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent: I wrote {FAKE_MISSING} with the fix."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_4_spaced_dash_boundary(self):
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent - I wrote {FAKE_MISSING} with the fix."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_4b_double_hyphen_boundary(self):
        # Found LIVE 2026-07-30 via card e0742bbd's own probe comment: " -- "
        # (double hyphen, this codebase's own constant parenthetical style)
        # is a distinct separator from the single spaced dash above -- \s-\s
        # does not match it (the char after the first '-' is another '-').
        content = f"DONE: wrote {FAKE_MISSING} -- {FAKE_ABSENT_TRACKED} is a path that genuinely does not exist."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_4c_reproduces_the_live_e0742bbd_probe_text_verbatim(self):
        # The exact sentence shape that exposed the gap, reworded onto fixture
        # paths. Regression pin for this specific live incident.
        content = (
            f"DONE: PROBE, deliberately un-sanitised. Deliverable written to {FAKE_MISSING} "
            f"-- a path under a prefix that IS flaggable and that genuinely does not exist."
        )
        row = (30, "marveen", "buildfejleszto", content, "pending", 0)
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertEqual(result["paths_missing"], [FAKE_MISSING])

    def test_5_newline_boundary(self):
        content = f"DONE:\n{FAKE_ABSENT_TRACKED} is absent\nI wrote {FAKE_MISSING} with the fix."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_6_dash_inside_a_hyphenated_filename_is_not_a_boundary(self):
        # \s-\s requires SPACES on both sides -- a hyphen inside an
        # identifier/filename ("also-fake", no surrounding spaces) must not
        # be mistaken for a clause separator.
        hyphenated = "scripts/also-fake-bc6b2b98-dash-check.py"
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent, and I wrote {hyphenated} with the fix."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(hyphenated, asserted)

    # -- reversed order + multi-path (unaffected by which punctuation, kept
    # on comma since that is the card's own reported case) --

    def test_7_reversed_order_missing_then_comma_and_absence(self):
        content = f"DONE: I wrote {FAKE_MISSING}, and {FAKE_ABSENT_TRACKED} is absent."
        self.assertIn(FAKE_ABSENT_TRACKED, eg.extract_absence_asserted_paths(content))
        self.assertNotIn(FAKE_MISSING, eg.extract_absence_asserted_paths(content))
        row = (21, "marveen", "buildfejleszto", content, "pending", 0)
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertEqual(result["verdict"], "MISSING")
        self.assertEqual(result["paths_missing"], [FAKE_MISSING])

    def test_8_two_tracked_paths_no_longer_exists_comma(self):
        # Both paths tracked (no gitignore interaction) -- isolates this to
        # being purely a clause-boundary defect, not a gitignore one.
        other_absent = "scripts/install-monitor-fake-bc6b2b98.sh"
        content = f"DONE: {other_absent} no longer exists, and I wrote {FAKE_MISSING} with the change."
        missing_asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(other_absent, missing_asserted)
        self.assertNotIn(FAKE_MISSING, missing_asserted)

    def test_9_hungarian_comma_phrasing(self):
        # Bare comma needs no conjunction-word list, so a single Hungarian
        # case is enough to confirm bilingual phrasing isn't special-cased
        # away by accident.
        content = f"KESZ: {FAKE_ABSENT_TRACKED} nincs, megirtam {FAKE_MISSING}-t is."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    # -- deliverylead's own kill-shot cases against the FIRST fix (candidate
    # C, the conjunction word-list this branch shipped and then abandoned in
    # 75801b6): five conjunctions/phrasings NOT in that list, each of which
    # silently swallowed a genuine miss under it. Named explicitly per
    # marveen's instruction so a future refactor back toward a word-list
    # approach fails these tests by name, not just generically -- the
    # bare-punctuation design (any comma is a boundary, no word list) passes
    # all five for the same reason it passes every other conjunction: it
    # never looks at the word at all.
    def test_13_deliverylead_comma_plus(self):
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent, plus I wrote {FAKE_MISSING} anyway."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_14_deliverylead_comma_also(self):
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent, also I wrote {FAKE_MISSING} separately."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_15_deliverylead_comma_valamint(self):
        # Hungarian "valamint" (as well as / and also) -- not in the
        # original word list (which only had es/és/de).
        content = f"KESZ: {FAKE_ABSENT_TRACKED} nincs, valamint megirtam {FAKE_MISSING}-t is."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_16_deliverylead_comma_illetve(self):
        # Hungarian "illetve" (or rather / respectively) -- also not in the
        # original word list.
        content = f"KESZ: {FAKE_ABSENT_TRACKED} nincs, illetve megirtam {FAKE_MISSING}-t is."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    def test_17_deliverylead_bare_comma_no_conjunction_at_all(self):
        # No conjunction word whatsoever -- just a comma. The word-list
        # approach had no case for this at all; the bare-punctuation
        # approach does not need one.
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent, I wrote {FAKE_MISSING} anyway."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertNotIn(FAKE_MISSING, asserted)

    # -- non-regressions --

    def test_10_single_path_absence_via_trailing_comma_clause_still_suppresses(self):
        # Non-regression (9682c5ee): a legitimate single-path absence claim
        # with a trailing comma clause about something else (not a path at
        # all) must still suppress the absence-asserted path.
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent, and that is expected."
        self.assertIn(FAKE_ABSENT_TRACKED, eg.extract_absence_asserted_paths(content))
        row = (22, "marveen", "buildfejleszto", content, "pending", 0)
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertEqual(result["verdict"], "PASS")

    def test_11_bare_gitignored_path_no_absence_clause_still_no_hit(self):
        # Non-regression (dc0fb6f0): unaffected by the clause-boundary widening.
        content = f"DONE: wrote {FAKE_ABSENT} with the new config."
        row = (23, "marveen", "buildfejleszto", content, "pending", 0)
        result = eg.check_message(None, row, token=None, dry_run=True)
        self.assertEqual(result["verdict"], "PASS")

    # -- plausible separator NOT in the boundary set (documented, not fixed) --

    def test_12_known_gap_bare_conjunction_without_comma_still_leaks(self):
        # "X is absent and I wrote Y" -- NO comma before "and". A bare
        # conjunction mid-sentence is too often part of ONE clause's own
        # predicate ("is absent and unused") to safely treat as a boundary
        # on its own, so this is a documented, INTENTIONAL residual gap, not
        # an oversight. This test characterizes the current (imperfect)
        # behavior so a future change to it is a deliberate decision, not a
        # silent regression either direction.
        content = f"DONE: {FAKE_ABSENT_TRACKED} is absent and I wrote {FAKE_MISSING} with the fix."
        asserted = eg.extract_absence_asserted_paths(content)
        self.assertIn(FAKE_ABSENT_TRACKED, asserted)
        self.assertIn(FAKE_MISSING, asserted)  # still leaks -- known gap, see _CLAUSE_BOUNDARY_RE's comment


if __name__ == "__main__":
    unittest.main()
