---
name: financial-advisor-digest
description: Heti pénteki pénzügyi tanácsadó összefoglaló az OTP Global Markets kutatási levelekből (privát CoS). A bank tanácsát desztillálja, kiemeli a döntést igénylőt, a 15M befektetés-ügyhöz kötve. Nem ad saját ajánlást, nem kereskedik.
---

Heti pénzügyi tanácsadó vonal (privát CoS). A cél: az OTP Global Markets kutatási folyamot, amit Istvan nem olvas el, HETI desztillátummá tömöríteni. Read-only, semmi pénzügyi művelet.

## Eljárás
1. **Szedd össze a hét OTP-leveleit** (privát fiók):
   `mcp__google-private__gmail_search` query: `from:GlobalMarkets@otpbank.hu newer_than:8d`
   (A nyugdíjpénztár, noreply@nyp.otppenztarak.eu NEM ide tartozik -- az admin, ne vedd be.)
2. **Olvasd el a lényegeseket** (`mcp__google-private__gmail_read` message id-val). HTML-hírlevelek: a törzs `<p>`/`<td>` szövegéből desztillálj, ne a layout-táblákból. Típusok és MIT emelj ki:
   - **Kereskedési ötletek** (nyit/zár) -> a KONKRÉT ötlet: instrumentum, irány, nyitás vagy zárás + eredmény. Ez a legfontosabb jel.
   - **Kedvelt részvényeink** -> mi került BE / KI a listáról.
   - **Modell portfólió / PB modellportfólió** -> súlyozás-változás, be/kiszállás.
   - **Piaci körkép / Kitekintő / technikai toplista** -> 1 mondat a piaci nézetről + a kiemelt téma/szektor.
3. **Tárold** a leveleket a dokumentum-tárolóba (opcionális, ha van melléklet/PDF): `scripts/cos-attachment-ingest.py private <id>` -- a kutatás-PDF-ek így megnyithatók maradnak.
4. **Írj EGY tömör Telegram-összefoglalót** (reply, chat_id 8942301795), sima szöveg, kb. ilyen szerkezet:
   - 📈 Piaci nézet: 1-2 mondat (OTP heti fókusz).
   - 🎯 Kereskedési ötletek: új/zárt tételek 1 sorban (instrumentum + irány + státusz).
   - ⭐ Kedvelt-lista / modell-portfólió változások.
   - 🧭 Neked: mi kér DÖNTÉST (kösd a PRI-INV-2026-001 "15 000 000 Ft befektetése" ügyhöz, ha releváns).
   Max ~12 sor. A cél a desztillátum, ne másold be a leveleket.
5. **ŐSZINTE HATÁR minden digestben implicit**: te NEM vagy engedélyes pénzügyi tanácsadó. A BANK tanácsát rendezed, nem találsz ki sajátot, és SOHA nem kereskedsz/cselekszel. A döntés Istvané.

## SÜRGŐS kivétel (Istvan msg 8011: "jelezz ha valami olyan van amit azonnal kellene csinálni")
Ha a hét leveleiben van IDŐÉRZÉKENY tétel -- egy kereskedési ötlet szűk belépési/kilépési ablakkal, egy határidős esemény, egy "most cselekedj" jellegű jelzés -- azt NE várd meg péntekig a rendszeres futásban: ha a heti futás ilyet talál, a digest ELEJÉRE tedd "⚠️ SÜRGŐS:" sorral. (A napi email-triage is elkaphatja élesben; ha ott egy OTP-levél nyilván idő-kritikus, azt azonnal jelezd, ne várj a péntekre.)

## Buktatók
- A HTML-hírlevél nyers törzse tele van layout-táblával; a valódi szöveg a bevezető (`Tisztelt Partnerünk!`) UTÁN jön. A snippet a lead-mondatot adja; ha kell a részlet, a teljes body-ból szűrd a prózát.
- Egy publikus otpbank.hu link megnyitható (curl/quarantine-reader); a bejelentkezéshez kötött privát banki portál NEM -- ne ígérd hogy onnan olvasol.
- Ne keverd a nyugdíjpénztár-értesítőket (tagdíj/adójóváírás) a tanáccsal -- azok külön, admin.
- Ha egy héten NINCS érdemi OTP-levél, rövid "csendes hét" sor elég, ne gyárts tartalmat.

## Ellenőrzés
- A digest a TÉNYLEGES levelekből jön (idézhető ötlet/lista-változás), nem kитalált.
- Sürgős tétel a tetején, ⚠️-vel; egyébként a rendes szerkezet.
- Semmi pénzügyi művelet nem történt.
