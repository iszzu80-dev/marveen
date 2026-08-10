#!/usr/bin/env python3
"""Unit test for build-done-monitor/check.py: asserts the notification-sent
comment INSERT is a plain string literal with no interpolation (card d2d949c3).

Lives colocated with check.py, outside the tracked marveen repo.
Run manually after any edit to check.py:

    python3 ~/.claude/scheduled-tasks/build-done-monitor/check.test.py

WHY THIS TEST EXISTS: the comment "build-done-monitor: notification sent
(command task)" claims nothing about the card data -- it only records the
emitter's own action. Its LITERALNESS is a safety property: an f-string
that interpolates card data would silently contaminate the probe surface
(path tokens, absence words) with content from a card the monitor never
read. A literal string is structurally incapable of carrying contamination.

This test is RED-able: change the string to an f-string (add 'f' prefix)
and this test WILL fail. That is the point.
"""
import ast
import os
import sys
import unittest


_MODULE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check.py")


def _find_insert_block(source_lines):
    """Return (start_lineno, combined_text) of the kanban_comments INSERT
    statement block (may span multiple lines via implicit string joining),
    or (None, None) if not found."""
    for i, line in enumerate(source_lines):
        if "INSERT INTO kanban_comments" in line:
            # Collect the full statement: accumulate lines until we find the
            # 'build-done-monitor' marker and the closing parameters tuple.
            block_lines = [line.rstrip()]
            for j in range(i + 1, min(i + 10, len(source_lines))):
                next_line = source_lines[j]
                block_lines.append(next_line.rstrip())
                if "build-done-monitor" in next_line:
                    # Found the marker; keep collecting until the params tuple closes
                    for k in range(j + 1, min(j + 5, len(source_lines))):
                        block_lines.append(source_lines[k].rstrip())
                        if ")" in source_lines[k] and "," in source_lines[k]:
                            # The trailing params line: e.g. "(card['id'], now)"
                            return i + 1, '\n'.join(block_lines)
                    return i + 1, '\n'.join(block_lines)
            # INSERT found but no build-done-monitor marker within search window
            return None, None
    return None, None


class TestCommentLiteralSafety(unittest.TestCase):
    """Card d2d949c3: the notification-sent comment INSERT must use a plain
    string literal, never an f-string or any other interpolation form."""

    @classmethod
    def setUpClass(cls):
        with open(_MODULE_PATH) as f:
            cls.source_lines = f.readlines()
            cls.source_text = ''.join(cls.source_lines)

    def test_1_insert_statement_exists(self):
        """Sanity: the INSERT we're guarding must actually be present."""
        lineno, line = _find_insert_block(self.source_lines)
        self.assertIsNotNone(lineno, "INSERT INTO kanban_comments not found in check.py")
        self.assertIsNotNone(line)

    def test_2_no_f_string_on_insert_line(self):
        """The notification-sent INSERT must NOT use an f-string prefix.
        An f-string can interpolate card data into a comment that claims
        to only record the emitter's own action -- structural contamination."""
        lineno, line = _find_insert_block(self.source_lines)
        # Strip leading whitespace and check for f-string prefix
        stripped = line.lstrip()
        self.assertFalse(
            stripped.startswith('f"') or stripped.startswith("f'"),
            f"Line {lineno}: INSERT uses f-string -- literal safety broken. "
            f"Found: {stripped[:80]}..."
        )

    def test_3_no_format_call_on_insert_line(self):
        """The INSERT must not use .format() on the literal string."""
        lineno, line = _find_insert_block(self.source_lines)
        self.assertNotIn(".format(", line,
            f"Line {lineno}: INSERT uses .format() -- literal safety broken.")

    def test_4_no_percent_interpolation_on_insert_line(self):
        """The INSERT must not use %-formatting on the literal string."""
        lineno, line = _find_insert_block(self.source_lines)
        # % interpolation would look like: "string %s ..." % (vals)
        # The plain string '...' % would not be valid Python, but check anyway.
        self.assertNotIn("' %", line,
            f"Line {lineno}: INSERT uses %-interpolation -- literal safety broken.")

    def test_5_insert_is_plain_string_literal(self):
        """Positive check: the comment content is a plain string literal
        (with single quotes), not constructed from variables."""
        lineno, line = _find_insert_block(self.source_lines)
        # The line must contain the exact literal string
        self.assertIn(
            "'build-done-monitor: notification sent (command task)'",
            line,
            f"Line {lineno}: expected plain string literal 'build-done-monitor: "
            f"notification sent (command task)' not found."
        )

    def test_6_parse_tree_no_interpolation_in_insert_strings(self):
        """AST-level check: every string node inside the INSERT call must be
        a plain Str/Constant, never a JoinedStr (f-string). Catches an f-string
        on the PREVIOUS line that gets concatenated (implicit string join)."""
        try:
            tree = ast.parse(self.source_text)
        except SyntaxError as e:
            self.fail(f"check.py is not valid Python: {e}")

        # Find the execute() call that contains the INSERT
        class InsertFinder(ast.NodeVisitor):
            def __init__(self):
                self.insert_call = None

            def visit_Call(self, node):
                # Looking for db.execute("INSERT INTO kanban_comments ...", ...)
                if (isinstance(node.func, ast.Attribute) and
                    node.func.attr == 'execute'):
                    for arg in node.args:
                        if (isinstance(arg, ast.Constant) and
                            isinstance(arg.value, str) and
                            'INSERT INTO kanban_comments' in arg.value):
                            self.insert_call = node
                            return
                self.generic_visit(node)

        finder = InsertFinder()
        finder.visit(tree)
        self.assertIsNotNone(finder.insert_call,
            "Could not find db.execute() call with INSERT INTO kanban_comments in AST")

        # Every string argument inside the execute() call must be a plain Constant
        # (f-strings are JoinedStr in Python 3.8+, or FormattedValue inside JoinedStr)
        for arg in finder.insert_call.args:
            if isinstance(arg, ast.JoinedStr):
                self.fail(
                    f"INSERT execute() call contains an f-string (JoinedStr at "
                    f"line {arg.lineno}): literal safety broken."
                )
            # Also check keyword arguments (unlikely but complete)
        for kw in finder.insert_call.keywords:
            if isinstance(kw.value, ast.JoinedStr):
                self.fail(
                    f"INSERT execute() call contains an f-string in keyword arg "
                    f"(JoinedStr at line {kw.value.lineno}): literal safety broken."
                )


if __name__ == "__main__":
    unittest.main()
