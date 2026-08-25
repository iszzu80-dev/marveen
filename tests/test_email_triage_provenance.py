#!/usr/bin/env python3
"""Stage 2G: the triage feeder must fingerprint what the judge actually saw.

Run: python3 -m unittest discover -s tests -p 'test_*.py'
No network, no mailbox: the helpers are pure functions over a candidate dict.
"""
import importlib.util, os, unittest

FETCH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "scripts", "email-triage-fetch.py")
_spec = importlib.util.spec_from_file_location("email_triage_fetch", FETCH)
F = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(F)

CAND = {
    "account": "zst", "id": "m1", "threadId": "t1", "direction": "INBOUND",
    "from": "relacio.kft@szamlazz.hu", "subject": "Szamla erkezett",
    "date": "Mon, 17 Aug 2026 15:14:55 +0200", "snippet": "Kerjuk a kifizetesrol gondoskodni.",
}


class SourceManifestHash(unittest.TestCase):
    def test_is_canonical_not_formatting_dependent(self):
        reordered = {k: CAND[k] for k in reversed(list(CAND))}
        self.assertEqual(F._source_manifest_hash(CAND), F._source_manifest_hash(reordered))

    def test_a_changed_snippet_changes_the_hash(self):
        other = dict(CAND, snippet=CAND["snippet"] + " (modositva)")
        self.assertNotEqual(F._source_manifest_hash(CAND), F._source_manifest_hash(other))

    def test_a_changed_subject_or_sender_changes_the_hash(self):
        for field in ("subject", "from", "id", "threadId", "direction", "date"):
            other = dict(CAND, **{field: "MAS"})
            self.assertNotEqual(F._source_manifest_hash(CAND), F._source_manifest_hash(other), field)

    def test_it_hashes_the_input_not_merely_the_identity(self):
        """A message id alone would say WHICH mail was judged, never WHAT was visible."""
        same_id_other_body = dict(CAND, snippet="teljesen mas tartalom")
        self.assertNotEqual(F._source_manifest_hash(CAND), F._source_manifest_hash(same_id_other_body))

    def test_prefixed_and_stable(self):
        h = F._source_manifest_hash(CAND)
        self.assertTrue(h.startswith("sha256:"))
        self.assertEqual(len(h), len("sha256:") + 64)
        self.assertEqual(h, F._source_manifest_hash(dict(CAND)))


class PromptFingerprint(unittest.TestCase):
    def test_is_measured_from_the_rule_files(self):
        fp = F._prompt_fingerprint()
        self.assertTrue(fp.startswith("rules:"))
        self.assertEqual(fp, F._prompt_fingerprint(), 'must be stable within a run')

    def test_it_moves_when_the_feeder_itself_changes(self):
        """The feeder's own bytes are part of the rules: the triage output shape
        is as much a rule as the prose that judges it."""
        original = open(FETCH, "rb").read()
        before = F._prompt_fingerprint()
        try:
            with open(FETCH, "ab") as fh:
                fh.write(b"\n# provenance mutation probe\n")
            self.assertNotEqual(before, F._prompt_fingerprint())
        finally:
            with open(FETCH, "wb") as fh:
                fh.write(original)
        self.assertEqual(before, F._prompt_fingerprint())


if __name__ == "__main__":
    unittest.main()


class OwnTrafficIsNoiseByOrigin(unittest.TestCase):
    """Regression fixture for the rule-order defect found by the 2026-08-17
    retrospective sweep. It lives against the NORMATIVE filter the live heartbeat
    runs — not against the sweep's own judgement file — because a rule that only
    exists in the analysis tool protects the analysis and nothing else."""

    def test_own_product_mail_is_noise_however_it_reads(self):
        for sender, subject in (
            ("QuickQuote <no-reply@mail.zstradio.com>", "Árajánlat #7AF26D83: Burkolás"),
            ("Mondigo <ajanlat@mondigo.eu>", "Árajánlat: Konnektor csere és további munkák"),
            ("hello@vidamo.eu", "Új Vidamo előregisztráció: valaki@example.com"),
        ):
            self.assertTrue(F.is_noise({"from": sender, "subject": subject, "snippet": "x"}),
                            f"own traffic must be noise: {sender}")

    def test_own_test_harness_mail_is_noise(self):
        self.assertTrue(F.is_noise({
            "from": "QuickQuote <no-reply@mail.zstradio.com>",
            "subject": "[TESZT] Árajánlat: Villanyszerelés", "snippet": "x"}))

    def test_a_real_quote_still_survives(self):
        """The exclusion must not eat the thing it sits next to."""
        self.assertFalse(F.is_noise({
            "from": "info@pellerburkolas.hu", "subject": "Árajánlat, terasz burkolat",
            "snippet": "kuldjuk az arajanlatot a teraszra"}))

    def test_authority_mail_still_survives(self):
        self.assertFalse(F.is_noise({
            "from": "ertesites@tarhely.gov.hu",
            "subject": "Átvételi értesítő (Feladó: NAV, Dokumentum: Végrehajtás)",
            "snippet": "kuldemeny erkezett a tarhelyere"}))

    def test_the_rule_is_covered_by_the_prompt_fingerprint(self):
        """The fingerprint hashes the feeder's own bytes, so this rule moves it.
        Without that, a silently edited filter would keep an old fingerprint."""
        before = F._prompt_fingerprint()
        original = open(FETCH, "rb").read()
        try:
            text = original.decode()
            mutated = text.replace('"ajanlat@mondigo.eu",', "")
            self.assertNotEqual(text, mutated, "the rule must be present to be mutated")
            with open(FETCH, "wb") as fh:
                fh.write(mutated.encode())
            self.assertNotEqual(before, F._prompt_fingerprint())
        finally:
            with open(FETCH, "wb") as fh:
                fh.write(original)
        self.assertEqual(before, F._prompt_fingerprint())
