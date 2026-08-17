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
