---
name: kanban-archive-heti
description: Heti kanban housekeeping: done kartyak archivalasa + export logba
---

KANBAN HOUSEKEEPING (csendes, heartbeat). Cel: a done kartyak ne terheljek az aktiv viewet, de semmi ne vesszen el. Lepesek python3-mal (sqlite3 modul, NEM CLI), DB: store/claudeclaw.db: (1) Export: a status=done ES archived_at IS NULL kartyakat (>7 napos updated_at) fuzd hozza/ird ki egy emberi-olvashato logba: deliverables/kanban-archive/done-<ISO-datum>.md (cim+leiras+kommentek+datumok, projekt szerint csoportositva). (2) Archivalas: UPDATE kanban_cards SET archived_at=unixepoch() WHERE status=done AND archived_at IS NULL AND updated_at < strftime(%s,now,-7 days). Az utolso 7 nap done-ja LATHATO marad. (3) NE torolj soha, csak archived_at-et allits. (4) Csendes: csak akkor irj Telegramot ha hiba van; egyebkent egy rovid daily-log sor (hany kartya archivalva).
