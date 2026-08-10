---
name: personal-case-wake
description: COS ugy-ebresztes (spec 14 personal-case-wake) -- esedekes ugyek belso koeree, kulso muvelet nelkul
---

npx tsx scripts/cos-cycle.ts

EGYETLEN parancs, szandekosan (F-17, review 2026-08-10). Korabban ez a fajl NEGY
kulon `npx tsx` sort sorolt fel, es a lancot az tartotta ossze, hogy a modell
vegigolvassa oket tiz percenkent. A spec §21 zarosora: "nincs prompt-only kesz".
Az ok pontosan ez: minden lepes SZABALY, egyik sem itelet, es egy fordulo, ami a
negybol harmat futtat le, megkulonboztethetetlen attol, amelyik mind a negyet
lefuttatta es nem talalt semmit. A hiba nemasaga be van epitve.

A runner sorrendben futtatja a negy lepest, egy lepes hibaja nem allitja meg a
tobbit, es a vegen egyetlen JSON-t ad `problems` tombbel.

MIT KELL TENNED A KIMENETTEL:
- `problems` URES -> maradj csendben, kesz. Ez a normalis eset.
- `problems` NEM ures -> nezd meg mi bukott. A runner az exit koddal is jelzi.
  KULON figyelj arra, ha egy lepes 0-val ter vissza, de `failed:true`-t ir
  (pl. "no interpreter configured") -- a runner ezt is a `problems`-ba teszi,
  mert kulonben egy nem-mukodo ertelmezo "minden rendben"-kent latszana.
- Ha valami tobb cikluson at ugyanugy bukik, szolj Istvannak. Egy ismetlodo
  hiba, amit senki nem lat, ugyanaz mint a nema hiba.
