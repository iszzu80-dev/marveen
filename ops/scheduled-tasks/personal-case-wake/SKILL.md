---
name: personal-case-wake
description: COS ugy-ebresztes (spec 14 personal-case-wake) -- esedekes ugyek belso koeree, kulso muvelet nelkul
---

npx tsx scripts/progression-heartbeat-runner.ts

Ezutan zard le a bejovo lancot is (§8 masodik fele) -- a kotegek lezarasa es a pozicio leptetese:
npx tsx scripts/cos-close-batches.ts

Vegul told le a hianyzo teljes leveleszalakat (§8 teljes thread):
npx tsx scripts/cos-fetch-threads.ts --limit 10

Vegul fogalmazz utankoveteseket a MAR FUTO levelezesekhez (owner C opcio, 2026-08-10).
Csak piszkozat keszul; minden levél Istvan jovahagyasara var. Elso megkeresest SOSEM fogalmaz.
npx tsx scripts/cos-draft-followups.ts --limit 5
