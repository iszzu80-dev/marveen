---
name: investment-decision-reminder
description: Hetfo reggeli emlekezteto Istvannak a 15M Ft befektetesi dontesrol (PRI-INV-2026-001), amig az ugy nyitva van. Ha az ugy lezarult/megtortent a befektetes, csendben marad.
---

Hétfő reggeli emlékeztető a befektetési döntésről (Istvan msg 8012: "még mindig nem csináltam meg a befektetést, hétfőn figyelmeztess").

## Eljárás
1. Nézd meg a PRI-INV-2026-001 "15 000 000 Ft befektetése" ügy státuszát:
   `python3 -c "import sqlite3;d=sqlite3.connect('/home/iszzu/marveen/store/claudeclaw.db');print(d.execute(\"SELECT status FROM personal_cases WHERE case_id='PRI-INV-2026-001'\").fetchone())"`
2. **Ha az ügy NYITOTT** (nem COMPLETED/CLOSED/ARCHIVED, azaz a befektetés még nem történt meg) -> szedd össze az OTP KONKRÉT döntési alapot, majd küldj EGY Telegram-emlékeztetőt (reply, chat_id 8942301795):
   a. Keresd meg a LEGFRISSEBB OTP modell-portfólió + kedvelt-lista leveleket (privát fiók):
      `mcp__google-private__gmail_search` query: `from:GlobalMarkets@otpbank.hu (modellportfólió OR "modell portfólió" OR "Kedvelt részvényeink") newer_than:45d`
      Olvasd el a legutóbbit (`gmail_read`), és desztilláld a KONKRÉT ajánlást: a modell-portfólió eszközosztály-súlyozásait (részvény/kötvény/készpénz/alternatív %) és/vagy a kedvelt-lista aktuális elemeit. HTML-hírlevél: a törzs szövegéből, ne a layoutból.
   b. Az emlékeztető így néz ki (max ~10 sor):
      "Hétfői emlékeztető: a 15 000 000 Ft befektetése még NYITVA (PRI-INV-2026-001). Döntési alap az OTP legfrissebb anyagából: [modell-portfólió súlyozás vagy kedvelt-lista pár konkrét elemmel]. Ez a BANK ajánlása, nem az enyém - a döntés a tiéd. Szeretnéd hogy előkészítsem valamelyik irányt, vagy egyeztetsz a privát bankároddal?"
   Ha van friss (heti pénteki) digest, hivatkozz rá.
3. **Ha az ügy LEZÁRULT** (a befektetés megtörtént) -> MARADJ CSENDBEN, és jelezd magadnak hogy ez a task kikapcsolható (a cron ne pörögjön feleslegesen).

## Buktatók
- Ez heti (hétfő), amíg a döntés meg nem születik -- NEM egyszeri. Ez szándékos: Istvan "még mindig nem csinálta meg", a heti nudge amíg nyitott a helyes. De ha ő azt mondja "elég", vagy az ügy lezárul, állítsd le (enabled:false).
- Ne adj konkrét befektetési ajánlást magadtól; a bank (OTP) tanácsát rendezed, a döntés az övé.
- Ne keverd a heti pénteki digesttel -- az a piaci áttekintés, ez a személyes döntés-nudge.

## Ellenőrzés
- Csak nyitott ügynél ír; lezártnál csendes.
- Egy rövid emlékeztető, nem ismételt spam.
