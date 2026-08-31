#!/usr/bin/env python3
"""
Watch directories for the events that make a file vanish, and say WHEN.

Built for the 2026-08-31 run-20 failure: `cos-eligibility-denominator` walked
src/ and scripts/, saw `src/web/memory-pressure-monitor.ts` in the directory
listing, and then got ENOENT opening it -- in a suite run where the file existed
before and after. No mechanism could be established by reading the code, and the
owner's instruction was explicit: do not guess, find out.

This is the instrument. inotify via ctypes, because this host has no
inotifywait, no strace, and no python inotify module. Polling was rejected: a
rename is atomic and effectively instantaneous, so a poll loop would miss the
exact window that matters.

Usage:
  scripts/fs-event-watch.py <dir> [<dir> ...] > events.log

Logs one line per event with a monotonic-ish wall timestamp, the watched
directory, the event names and the filename. Only the events that can produce an
ENOENT on a previously-listed name are requested: DELETE, MOVED_FROM, CREATE,
MOVED_TO, plus DELETE_SELF / MOVE_SELF for the directory itself.
"""
import ctypes, ctypes.util, os, struct, sys, time

IN_CREATE      = 0x00000100
IN_DELETE      = 0x00000200
IN_DELETE_SELF = 0x00000400
IN_MOVED_FROM  = 0x00000040
IN_MOVED_TO    = 0x00000080
IN_MOVE_SELF   = 0x00000800
MASK = IN_CREATE | IN_DELETE | IN_DELETE_SELF | IN_MOVED_FROM | IN_MOVED_TO | IN_MOVE_SELF

NAMES = [
    (IN_CREATE, 'CREATE'), (IN_DELETE, 'DELETE'), (IN_DELETE_SELF, 'DELETE_SELF'),
    (IN_MOVED_FROM, 'MOVED_FROM'), (IN_MOVED_TO, 'MOVED_TO'), (IN_MOVE_SELF, 'MOVE_SELF'),
]

def main(dirs):
    libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
    fd = libc.inotify_init()
    if fd < 0:
        raise OSError(ctypes.get_errno(), 'inotify_init failed')

    watches = {}
    for d in dirs:
        wd = libc.inotify_add_watch(fd, os.fsencode(d), MASK)
        if wd < 0:
            print(f'WATCH-FAILED {d} errno={ctypes.get_errno()}', flush=True)
            continue
        watches[wd] = d
        print(f'WATCHING {d}', flush=True)
    if not watches:
        return 1

    HDR = struct.calcsize('iIII')
    buf = b''
    while True:
        chunk = os.read(fd, 8192)
        if not chunk:
            break
        buf += chunk
        while len(buf) >= HDR:
            wd, mask, cookie, length = struct.unpack('iIII', buf[:HDR])
            if len(buf) < HDR + length:
                break
            name = buf[HDR:HDR + length].rstrip(b'\0').decode('utf-8', 'replace')
            buf = buf[HDR + length:]
            evs = '|'.join(n for bit, n in NAMES if mask & bit) or f'0x{mask:x}'
            # Timestamp AFTER decoding, so the line is written as close to the
            # event's arrival as the process can manage.
            print(f'{time.strftime("%H:%M:%S")}.{int(time.time()*1000)%1000:03d} '
                  f'{watches.get(wd, "?")} {evs} cookie={cookie} {name}', flush=True)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(2)
    sys.exit(main(sys.argv[1:]) or 0)
