#!/usr/bin/env python3
"""Regression tests for the Clean Replay Gmail corpus exporter.

Run: python3 -m unittest discover -s tests -p 'test_*.py'

They cover the body trichotomy (TEXT / TEXTLESS_PROVEN / stop), the attachment
manifest, and the sanitised provider-error surface. Written against the
exporter's own functions with hand-built provider payloads: no network, no
credentials, no mailbox.
"""
import importlib.util, json, os, unittest

EXPORTER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "scripts", "cos-replay-export-gmail.py")
_spec = importlib.util.spec_from_file_location("cos_replay_export_gmail", EXPORTER)
X = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(X)


def evidence(**over):
    base = {"mimeTreeFullyWalked": True, "mimePartsWalked": 1, "mimeRootType": "text/plain",
            "textPartsWithContent": 1, "textPartsUnreadable": 0,
            "renderedTextLength": 17, "textless": False}
    base.update(over)
    return base


def msg(**over):
    """A provider message as the full-thread read tool returns it."""
    base = {
        "id": "m1", "threadId": "t1", "labelIds": ["INBOX"],
        "internalDate": "1786000000000",
        "from": "a@b.hu", "to": "c@d.hu", "subject": "targy",
        "snippet": "elonezet szoveg",
        "body": "valodi levelszoveg",
        "attachments": [],
        "bodyEvidence": evidence(),
    }
    base.update(over)
    return base


TEXTLESS = dict(mimePartsWalked=4, textPartsWithContent=0, textPartsUnreadable=0,
                renderedTextLength=0, textless=True)


class BodyCases(unittest.TestCase):
    def test_normal_text_mail_is_TEXT_and_byte_for_byte_unchanged(self):
        body = "Kedves Istvan,\r\n\r\nket sor, tabbal\tés ékezettel.\r\n-- \r\nX"
        n = X._normalize("private", msg(body=body))
        self.assertEqual(n["bodyText"], body)
        self.assertEqual(n["bodyPresence"], "TEXT")

    def test_attachment_only_dmarc_is_TEXTLESS_PROVEN(self):
        n = X._normalize("zst", msg(
            body="",
            bodyEvidence=evidence(mimeRootType="application/zip", **TEXTLESS),
            attachments=[{"filename": "report.zip", "mimeType": "application/zip",
                          "sizeBytes": 801, "sha256": None, "sha256Status": "NOT_REQUESTED"}]))
        self.assertEqual((n["bodyText"], n["bodyPresence"]), ("", "TEXTLESS_PROVEN"))

    def test_whitespace_plain_plus_empty_html_plus_image_is_TEXTLESS_PROVEN(self):
        """The measured 2026-08-17 case: text/plain '\\r\\n', empty div, one photo."""
        n = X._normalize("private", msg(
            body="",
            bodyEvidence=evidence(mimeRootType="multipart/mixed", mimePartsWalked=5,
                                  textPartsWithContent=2, textPartsUnreadable=0,
                                  renderedTextLength=0, textless=True),
            attachments=[{"filename": "20260623_174809.jpg", "mimeType": "image/jpeg",
                          "sizeBytes": 2050416, "sha256": None, "sha256Status": "NOT_REQUESTED"}]))
        self.assertEqual(n["bodyPresence"], "TEXTLESS_PROVEN")

    def test_unreadable_text_part_stops_the_export(self):
        """A text part we did not read is NOT 'this letter has no text'."""
        with self.assertRaises(RuntimeError) as e:
            X._normalize("private", msg(
                body="", bodyEvidence=evidence(textPartsWithContent=1, textPartsUnreadable=1,
                                               renderedTextLength=0, textless=False)))
        self.assertIn("NOT proven", str(e.exception))

    def test_partial_mime_walk_cannot_prove_textlessness(self):
        with self.assertRaises(RuntimeError) as e:
            X._normalize("private", msg(
                body="", bodyEvidence=evidence(mimeTreeFullyWalked=False, **TEXTLESS)))
        self.assertIn("complete MIME walk", str(e.exception))

    def test_reader_without_evidence_stops_the_export(self):
        m = msg(body="")
        del m["bodyEvidence"]
        with self.assertRaises(RuntimeError) as e:
            X._normalize("private", m)
        self.assertIn("no bodyEvidence", str(e.exception))

    def test_snippet_is_never_a_body_substitute(self):
        m = msg(body="", snippet="ez csak elonezet",
                bodyEvidence=evidence(textPartsUnreadable=1, renderedTextLength=0, textless=False))
        with self.assertRaises(RuntimeError):
            X._normalize("private", m)

    def test_contradictory_evidence_is_rejected(self):
        """textless=True together with an unread text part: trust neither."""
        with self.assertRaises(RuntimeError):
            X._normalize("private", msg(
                body="", bodyEvidence=evidence(textPartsWithContent=2, textPartsUnreadable=2,
                                               renderedTextLength=0, textless=True)))


class AttachmentManifest(unittest.TestCase):
    def test_real_metadata_reaches_the_manifest(self):
        n = X._normalize("private", msg(attachments=[
            {"filename": "foto.jpg", "mimeType": "image/jpeg", "sizeBytes": 2050416,
             "attachmentId": "ANGjdJ-rotates-every-call",
             "sha256": "cd" * 32, "sha256Status": "COMPUTED"}]))
        a = n["attachments"][0]
        self.assertEqual((a["filename"], a["mimeType"], a["sizeBytes"]),
                         ("foto.jpg", "image/jpeg", 2050416))
        self.assertEqual(a["sha256"], "cd" * 32)
        self.assertNotIn("attachmentId", a, "rotating id must not be stored in the corpus")

    def test_missing_attachment_field_stops_the_export(self):
        """`attachments: []` must mean 'asked and none', never 'never asked'."""
        m = msg()
        del m["attachments"]
        with self.assertRaises(RuntimeError) as e:
            X._normalize("private", m)
        self.assertIn("no attachment metadata", str(e.exception))

    def test_attachment_without_filename_is_rejected(self):
        with self.assertRaises(RuntimeError):
            X._normalize("private", msg(attachments=[{"mimeType": "image/png", "sizeBytes": 10}]))

    def test_unhashed_attachment_states_why(self):
        n = X._normalize("private", msg(attachments=[
            {"filename": "a.pdf", "mimeType": "application/pdf", "sizeBytes": 12,
             "sha256": None, "sha256Status": "UNAVAILABLE: HTTP 404"}]))
        self.assertIsNone(n["attachments"][0]["sha256"])
        self.assertIn("UNAVAILABLE", n["attachments"][0]["sha256Status"])

    def test_metadata_manifest_stands_without_any_hash(self):
        n = X._normalize("zst", msg(attachments=[
            {"filename": "szamla.pdf", "mimeType": "application/pdf", "sizeBytes": 91234,
             "sha256": None, "sha256Status": "NOT_REQUESTED"}]))
        a = n["attachments"][0]
        self.assertTrue(a["filename"] and a["mimeType"] and a["sizeBytes"])
        self.assertIsNone(a["sha256"])


class ProviderErrors(unittest.TestCase):
    def test_rate_limit_is_named_not_just_flagged(self):
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [
                {"type": "text", "text": "error: 429 rateLimitExceeded for user"}]})
        m = str(e.exception)
        self.assertIn("status=429", m)
        self.assertIn("class=ratelimitexceeded", m)

    def test_auth_failure_is_distinguishable_from_rate_limit(self):
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [
                {"type": "text", "text": "error: 401 invalid_grant: token expired"}]})
        m = str(e.exception)
        self.assertIn("status=401", m)
        self.assertIn("invalid_grant", m)

    def test_credentials_never_reach_the_message(self):
        leaky = ('error: 403 {"Authorization": "Bearer ya29.A0ARrdaM-VERYLONGTOKENVALUE12345", '
                 '"refresh_token": "1//04abcdefghijklmnop", "user": "iszzu80@gmail.com"}')
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [{"type": "text", "text": leaky}]})
        m = str(e.exception)
        self.assertIn("status=403", m)
        for secret in ("ya29.A0ARrdaM", "VERYLONGTOKENVALUE12345", "1//04abcdefghijklmnop",
                       "iszzu80@gmail.com"):
            self.assertNotIn(secret, m)

    def test_body_text_is_not_carried_into_the_error(self):
        body = "Kedves Istvan, a szamla osszege 240000 Ft, kerlek utald at"
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [
                {"type": "text", "text": "error: 500 backend error while reading " + body * 20}]})
        self.assertLess(len(str(e.exception)), 320, "sanitised error must stay short")

    def test_empty_detail_says_it_is_blind(self):
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": []})
        self.assertIn("NO detail", str(e.exception))


class DetailArgs(unittest.TestCase):
    TOOL = {"name": "gmail_get_thread", "inputSchema": {"type": "object", "properties": {
        "thread_id": {"type": "string"}, "attachment_sha256": {"type": "boolean"}}}}

    def test_hash_flag_passed_only_when_requested(self):
        self.assertEqual(X._detail_args(self.TOOL, "m1", "t1", False), {"thread_id": "t1"})
        self.assertEqual(X._detail_args(self.TOOL, "m1", "t1", True),
                         {"thread_id": "t1", "attachment_sha256": True})

    def test_tool_without_hash_support_gets_no_unknown_argument(self):
        tool = {"name": "gmail_get_thread", "inputSchema": {"type": "object",
                "properties": {"thread_id": {"type": "string"}}}}
        self.assertEqual(X._detail_args(tool, "m1", "t1", True), {"thread_id": "t1"})


if __name__ == "__main__":
    unittest.main()
