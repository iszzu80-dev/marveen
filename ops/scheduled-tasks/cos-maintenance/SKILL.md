---
name: cos-maintenance
description: COS §C maintenance — store permissions, retention purge, encrypted backup + prune + restore test
---

npx tsx scripts/cos-maintenance.ts

Ez EGYETLEN determinisztikus parancs, szandekosan (F-17). Nem lista, amit
vegig kell olvasni: minden lepese szabaly, egyik sem itelet, es egy olyan
utemezett fordulo, ami elfelejt lefuttatni egy lepest, megkulonboztethetetlen
attol, ami lefuttatta es nem talalt semmit.

A szkript 1-es exit koddal all le, ha barmi elromlott, es a `problems` tomb
megmondja mi. Ha a `problems` nem ures, JELEZD Istvannak — kulonosen a
"NO BACKUP WAS MADE" sort, mert mentes nelkul nincs rollback (§25 DoD 10).

Elofeltetel: `COS_BACKUP_PASSPHRASE` a vaultban (vagy kornyezeti valtozokent).
Enelkul a futas SZANDEKOSAN bukik, nem csendben kihagyja.
