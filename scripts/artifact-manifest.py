#!/usr/bin/env python3
"""Compute (and optionally write) the identity of a built artifact directory.

WHY THIS EXISTS (Istvan, 2026-09-06, P0 release-integrity):

    "PIN DECLARES, ARTIFACT PROVES."

On 2026-09-06 I ran a plain `npx tsc` in the live checkout to prepare a cutover.
It replaced `dist/` with a build of a DIFFERENT commit while the pin went on
declaring the old one. Twenty minutes later the release gate ran and returned
`problems: []`, exit 0 -- because its first check compares two DECLARED values,
`activationCandidateSha` from the pin against `.release-sha` in the release
directory. Both are statements about what the runtime SHOULD be. Neither is a
measurement of what it IS. The deployed artifact was never hashed at all.

A pin can only ever declare. Something has to measure, and that is this file.

THE IDENTITY. sha256 over the sorted lines `<sha256-of-file>  <relative-path>`
for every regular file in the tree, one per line, LF-terminated. Sorted by path,
so the value does not depend on directory order. It covers content AND layout: a
renamed file changes it, a deleted file changes it, an added file changes it.

The manifest file itself is excluded, because a hash cannot contain itself.
Symlinks are excluded too and counted separately -- a symlink's target is not
read here, so silently folding one in would hash a name and call it content.

DELIBERATELY NOT INCLUDED: mtimes and permissions. Two builds of the same source
must produce the same identity, or every rebuild looks like drift and the check
stops meaning anything. Freshness is a SEPARATE question, and the guard asks it
separately (a dist file newer than the running process is drift even when the
hash matches, because the process is then running something else).
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

MANIFEST_NAME = ".artifact-manifest.json"


def tree_identity(root: str) -> tuple[str, int, int]:
    """Return (treeHash, fileCount, symlinkCount) for the directory `root`."""
    entries: list[str] = []
    symlinks = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames.sort()
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root)
            if rel == MANIFEST_NAME:
                continue
            if os.path.islink(full):
                symlinks += 1
                continue
            h = hashlib.sha256()
            with open(full, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            entries.append(f"{h.hexdigest()}  {rel}")
    entries.sort()
    joined = "".join(e + "\n" for e in entries)
    return hashlib.sha256(joined.encode()).hexdigest(), len(entries), symlinks


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: artifact-manifest.py <dist-dir> [--write <release-sha>]", file=sys.stderr)
        return 2
    root = argv[1]
    if not os.path.isdir(root):
        print(json.dumps({"error": f"not a directory: {root}"}), file=sys.stderr)
        return 2

    tree_hash, count, symlinks = tree_identity(root)

    if "--write" in argv:
        i = argv.index("--write")
        if i + 1 >= len(argv):
            print(json.dumps({"error": "--write needs a release sha"}), file=sys.stderr)
            return 2
        release_sha = argv[i + 1]
        manifest = {
            "releaseSha": release_sha,
            "treeHash": tree_hash,
            "fileCount": count,
            "symlinkCount": symlinks,
            "note": (
                "The identity of THIS directory, measured. The pin declares which "
                "artifact should be deployed; this says which one is. Recompute with "
                "scripts/artifact-manifest.py <dir> and compare -- never trust this "
                "file alone, since anything that can edit the tree can edit it too. "
                "It is the ARTIFACT'S claim; the pin holds the RELEASE's claim, and "
                "the gate requires both to agree with a fresh measurement."
            ),
        }
        with open(os.path.join(root, MANIFEST_NAME), "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=1)
            fh.write("\n")
        print(json.dumps({"wrote": os.path.join(root, MANIFEST_NAME), **{k: manifest[k] for k in ("releaseSha", "treeHash", "fileCount", "symlinkCount")}}))
        return 0

    print(json.dumps({"treeHash": tree_hash, "fileCount": count, "symlinkCount": symlinks}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
