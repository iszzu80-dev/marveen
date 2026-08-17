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
        """The connector's HTTP failure shape: {"error": <code>, "detail": ...}."""
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [
                {"type": "text", "text": '{"error": 429, "detail": "rateLimitExceeded for user"}'}]})
        m = str(e.exception)
        self.assertIn("httpStatus=429", m)
        self.assertIn("class=ratelimitexceeded", m)

    def test_auth_failure_is_distinguishable_from_rate_limit(self):
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [
                {"type": "text", "text": '{"error": 401, "detail": "invalid_grant: token expired"}'}]})
        m = str(e.exception)
        self.assertIn("httpStatus=401", m)
        self.assertIn("invalid_grant", m)

    def test_network_outage_is_not_dressed_up_as_an_http_status(self):
        """MEASURED 2026-08-17: the Personal export died here, and the first
        sanitiser called errno 101 `status=101` -- a number that looks exactly
        like a valid HTTP code and sends the reader after the wrong fault."""
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [
                {"type": "text",
                 "text": "error: <urlopen error [Errno 101] Network is unreachable>"}]})
        m = str(e.exception)
        self.assertNotIn("httpStatus", m)
        self.assertIn("errno=101", m)
        self.assertIn("Network is unreachable", m)

    def test_explicit_http_marker_still_yields_a_status(self):
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [
                {"type": "text", "text": "HTTP 503 backend error, try later"}]})
        self.assertIn("httpStatus=503", str(e.exception))

    def test_credentials_never_reach_the_message(self):
        leaky = ('{"error": 403, "detail": {"Authorization": "Bearer ya29.A0ARrdaM-VERYLONGTOKENVALUE12345", '
                 '"refresh_token": "1//04abcdefghijklmnop", "user": "iszzu80@gmail.com"}')
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [{"type": "text", "text": leaky}]})
        m = str(e.exception)
        self.assertIn("httpStatus=403", m)
        for secret in ("ya29.A0ARrdaM", "VERYLONGTOKENVALUE12345", "1//04abcdefghijklmnop",
                       "iszzu80@gmail.com"):
            self.assertNotIn(secret, m)

    def test_bare_opaque_token_is_redacted_without_a_naming_key(self):
        """A secret does not have to be labelled to be a secret: Gmail echoes raw
        attachment/page tokens into error text with no key in front of them."""
        raw = "ANGjdJ8jW1gwXAGbu9Y8cjMcCpRLuxgA1o8DKddXAldpc5dAoiNgFWtAH6gfOZJBqd4vEz"
        with self.assertRaises(RuntimeError) as e:
            X._tool_text({"isError": True, "content": [
                {"type": "text", "text": f'{{"error": 404, "detail": "not found while fetching {raw}"}}'}]})
        m = str(e.exception)
        self.assertIn("httpStatus=404", m)
        self.assertNotIn(raw, m)
        self.assertIn("redacted", m)

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


class TransportRetry(unittest.TestCase):
    """Istvan's GO of 2026-08-17: retry the proven transient network fault, and
    only that one. Waits are captured, never actually slept through."""

    def setUp(self):
        X.RETRY_EVENTS.clear()
        self.slept = []
        self._real_sleep = X._SLEEP
        X._SLEEP = self.slept.append

    def tearDown(self):
        X._SLEEP = self._real_sleep
        X.RETRY_EVENTS.clear()

    @staticmethod
    def _network_error():
        return RuntimeError("MCP tool reported isError=true: errno=101; message=error: "
                            "<urlopen error [Errno 101] Network is unreachable>")

    def test_one_failure_then_success_costs_exactly_one_retry(self):
        calls = []

        def fn():
            calls.append(1)
            if len(calls) == 1:
                raise self._network_error()
            return {"ok": True}

        self.assertEqual(X._with_transport_retry("private", "gmail_get_thread", fn), {"ok": True})
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(X.RETRY_EVENTS), 1)
        self.assertEqual(self.slept, [5])
        ev = X.RETRY_EVENTS[0]
        self.assertEqual((ev["account"], ev["operation"], ev["attempt"], ev["errno"]),
                         ("private", "gmail_get_thread", 1, 101))
        self.assertTrue(ev["at"].endswith("+00:00"), "evidence needs a timestamp")

    def test_three_consecutive_network_failures_fail_closed(self):
        calls = []

        def fn():
            calls.append(1)
            raise self._network_error()

        with self.assertRaises(RuntimeError):
            X._with_transport_retry("zst", "gmail_search", fn)
        self.assertEqual(len(calls), 4, "one original attempt plus three retries")
        self.assertEqual(len(X.RETRY_EVENTS), 3)
        self.assertEqual(self.slept, [5, 15, 30])

    def test_auth_http_and_rate_limit_get_no_retry(self):
        for msg in ("MCP tool reported isError=true: httpStatus=401; message=invalid_grant",
                    "MCP tool reported isError=true: httpStatus=429; message=rateLimitExceeded",
                    "MCP tool reported isError=true: httpStatus=403; message=permission denied",
                    "source completeness gate: empty bodyText without TEXTLESS_PROVEN"):
            X.RETRY_EVENTS.clear(); self.slept.clear()
            calls = []

            def fn(_m=msg):
                calls.append(1)
                raise RuntimeError(_m)

            with self.assertRaises(RuntimeError):
                X._with_transport_retry("private", "gmail_get_thread", fn)
            self.assertEqual(len(calls), 1, f"must not retry: {msg}")
            self.assertEqual(X.RETRY_EVENTS, [])
            self.assertEqual(self.slept, [])

    def test_retry_does_not_duplicate_message_or_thread_data(self):
        """A retried thread read re-delivers the same messages; the corpus keys
        them by messageId, so the second delivery adds nothing."""
        thread = [dict(msg(), id="m1"), dict(msg(), id="m2")]
        messages = {}
        X._merge_messages(messages, "private", thread)
        X._merge_messages(messages, "private", thread)  # the retry
        self.assertEqual(sorted(messages), ["m1", "m2"])
        self.assertEqual(len({m["threadId"] for m in messages.values()}), 1)
