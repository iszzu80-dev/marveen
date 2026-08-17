#!/usr/bin/env python3
"""Regression tests for the Clean Replay Gmail corpus exporter.

Run: python3 -m unittest discover -s tests -p 'test_*.py'

These cover the three body cases the exporter must keep apart (Istvan,
2026-08-17) and the attachment manifest. They are deliberately written against
the exporter's own functions with hand-built provider payloads: no network, no
credentials, no mailbox.
"""
import importlib.util, json, os, unittest

EXPORTER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "scripts", "cos-replay-export-gmail.py")
_spec = importlib.util.spec_from_file_location("cos_replay_export_gmail", EXPORTER)
X = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(X)


def msg(**over):
    """A provider message as the full-thread read tool returns it."""
    base = {
        "id": "m1", "threadId": "t1", "labelIds": ["INBOX"],
        "internalDate": "1786000000000",
        "from": "a@b.hu", "to": "c@d.hu", "subject": "targy",
        "snippet": "elonezet szoveg",
        "body": "valodi levelszoveg",
        "attachments": [],
        "bodyEvidence": {"textPartsWithContent": 1, "textPartsFetchedByAttachmentId": 0,
                         "textPartsUnreadable": 0, "renderedTextLength": 17, "textless": False},
    }
    base.update(over)
    return base


class BodyCases(unittest.TestCase):
    def test_ordinary_text_mail_keeps_its_body(self):
        n = X._normalize("private", msg())
        self.assertEqual(n["bodyText"], "valodi levelszoveg")
        self.assertEqual(n["bodyPresence"], "TEXT")

    def test_textless_mail_is_accepted_only_with_proof(self):
        """Attachment-only mail (DMARC zip, captionless photo): empty body is a FACT."""
        n = X._normalize("zst", msg(
            body="",
            bodyEvidence={"textPartsWithContent": 0, "textPartsFetchedByAttachmentId": 0,
                          "textPartsUnreadable": 0, "renderedTextLength": 0, "textless": True},
            attachments=[{"filename": "report.zip", "mimeType": "application/zip",
                          "sizeBytes": 801, "sha256": "ab" * 32, "sha256Status": "COMPUTED"}]))
        self.assertEqual(n["bodyText"], "")
        self.assertEqual(n["bodyPresence"], "TEXTLESS_PROVEN")

    def test_unreadable_text_part_still_fails_closed(self):
        """A real parser failure must NOT pass as 'this letter has no text'."""
        with self.assertRaises(RuntimeError) as e:
            X._normalize("private", msg(
                body="",
                bodyEvidence={"textPartsWithContent": 1, "textPartsFetchedByAttachmentId": 0,
                              "textPartsUnreadable": 1, "renderedTextLength": 0, "textless": False}))
        self.assertIn("NOT proven", str(e.exception))

    def test_reader_without_evidence_fails_closed(self):
        """An older read tool cannot silently license an empty body."""
        m = msg(body="")
        del m["bodyEvidence"]
        with self.assertRaises(RuntimeError) as e:
            X._normalize("private", m)
        self.assertIn("no bodyEvidence", str(e.exception))

    def test_snippet_is_never_a_body_substitute(self):
        m = msg(body="", snippet="ez csak elonezet")
        m["bodyEvidence"] = {"textPartsWithContent": 1, "textPartsFetchedByAttachmentId": 0,
                             "textPartsUnreadable": 1, "renderedTextLength": 0, "textless": False}
        with self.assertRaises(RuntimeError):
            X._normalize("private", m)

    def test_textless_claim_with_unread_part_is_rejected(self):
        """textless=True and an unread text part contradict each other: trust neither."""
        with self.assertRaises(RuntimeError):
            X._normalize("private", msg(
                body="",
                bodyEvidence={"textPartsWithContent": 2, "textPartsFetchedByAttachmentId": 0,
                              "textPartsUnreadable": 2, "renderedTextLength": 0, "textless": True}))


class AttachmentManifest(unittest.TestCase):
    def test_manifest_carries_real_metadata(self):
        n = X._normalize("private", msg(attachments=[
            {"filename": "foto.jpg", "mimeType": "image/jpeg", "sizeBytes": 2050416,
             "attachmentId": "ANGjdJ-rotates-every-call",
             "sha256": "cd" * 32, "sha256Status": "COMPUTED"}]))
        self.assertEqual(len(n["attachments"]), 1)
        a = n["attachments"][0]
        self.assertEqual((a["filename"], a["mimeType"], a["sizeBytes"]),
                         ("foto.jpg", "image/jpeg", 2050416))
        self.assertEqual(a["sha256"], "cd" * 32)
        self.assertNotIn("attachmentId", a, "rotating id must not be stored in the corpus")

    def test_missing_attachment_metadata_fails_closed(self):
        """`attachments: []` must mean 'asked and none', never 'never asked'."""
        m = msg()
        del m["attachments"]
        with self.assertRaises(RuntimeError) as e:
            X._normalize("private", m)
        self.assertIn("no attachment metadata", str(e.exception))

    def test_attachment_without_filename_is_rejected(self):
        with self.assertRaises(RuntimeError):
            X._normalize("private", msg(attachments=[{"mimeType": "image/png", "sizeBytes": 10}]))

    def test_unhashed_attachment_reports_its_status(self):
        n = X._normalize("private", msg(attachments=[
            {"filename": "a.pdf", "mimeType": "application/pdf", "sizeBytes": 12,
             "sha256": None, "sha256Status": "UNAVAILABLE: HTTP 404"}]))
        self.assertIsNone(n["attachments"][0]["sha256"])
        self.assertIn("UNAVAILABLE", n["attachments"][0]["sha256Status"])


class ProviderErrors(unittest.TestCase):
    def test_iserror_surfaces_the_provider_text(self):
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True,
                          "content": [{"type": "text", "text": "error: 429 rate limit exceeded"}]})
        self.assertIn("429", str(e.exception))

    def test_iserror_without_detail_says_so(self):
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": []})
        self.assertIn("no detail returned", str(e.exception))


class DetailArgs(unittest.TestCase):
    TOOL = {"name": "gmail_get_thread", "inputSchema": {"type": "object", "properties": {
        "thread_id": {"type": "string"}, "attachment_sha256": {"type": "boolean"}}}}

    def test_sha256_flag_passed_only_when_requested(self):
        self.assertEqual(X._detail_args(self.TOOL, "m1", "t1", False), {"thread_id": "t1"})
        self.assertEqual(X._detail_args(self.TOOL, "m1", "t1", True),
                         {"thread_id": "t1", "attachment_sha256": True})

    def test_tool_without_sha256_support_gets_no_unknown_argument(self):
        tool = {"name": "gmail_get_thread", "inputSchema": {"type": "object",
                "properties": {"thread_id": {"type": "string"}}}}
        self.assertEqual(X._detail_args(tool, "m1", "t1", True), {"thread_id": "t1"})


if __name__ == "__main__":
    unittest.main()
