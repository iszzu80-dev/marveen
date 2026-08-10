---
name: zst-weekly-review
description: Heti hetfoi ZST uzleti operativ review (Slice 6 proaktiv). A ZST CoS-bol osszesiti a nyitott ugyeket, dontesre varokat, lejaro szerzodeseket/licenceket es a penzugyi statuszt egy tomor Telegram-riportba. Read-only, semmit nem kuld a ceg neveben.
---

Heti (hétfő reggeli) ZST üzleti operatív review. Cél: egy hét eleji kép a céges CoS-ról. Read-only, csak összesít.

## Eljárás
1. Szedd össze a ZST adatot a meglévő endpointokból (Bearer token store/.dashboard-token):
   - `curl -s -H "Authorization: Bearer $(cat $HOME/marveen/store/.dashboard-token)" http://localhost:3420/api/cos/zst-today` -> mai/aktív ügyek
   - `curl -s -H "Authorization: Bearer $(cat $HOME/marveen/store/.dashboard-token)" http://localhost:3420/api/cos/zst-due` -> lejáró szerződések (megújítás/felmondási ablak), licenc 30/60/90 nap, kötelezettségek, döntésre váró opportunity-k
   - `curl -s -H "Authorization: Bearer $(cat $HOME/marveen/store/.dashboard-token)" http://localhost:3420/api/cos/zst-business` -> üzleti összesítők (számlák, szerződések, vendorok, stb. count)
2. Ha kell részletesebb bontás, közvetlen olvasás a live DB-ből (read-only): zst_cases státusz/típus szerint, zst_invoices fizetetlen, zst_contracts lejárat közeli.
3. Írj EGY tömör Telegram-riportot (reply, chat_id 8942301795), sima szöveg, kb.:
   - 🏢 ZST heti review (dátum)
   - ⚖️ Döntésre vár: az AWAITING_APPROVAL/SELECTION ügyek (max 5, +N további)
   - ⏰ Hamarosan lejár: szerződés-megújítás / felmondási ablak / licenc 30-90 nap
   - 📄 Nyitott ügyek típus szerint (1 sor)
   - 💰 Pénzügy: fizetetlen számlák száma/összege ha van (megjegyzés: a pontos összegek a NAV-bekötés után lesznek teljesek)
   - 🧭 Mire figyelj: 1-2 mondat a hét legfontosabb teendőjéről
   Max ~12 sor. Ha minden üres/nyugodt -> rövid "csendes hét a ZST-n" sor elég.

## Buktatok
- Read-only: SOHA ne kuldj/valaszolj emailt a ceg neveben ebbol a taskbol. Ez csak riport.
- A penzugyi OSSZEGEK jelenleg hianyosak (a szamla-PDF-ekbol nem megbizhato, a NAV-bekotes elott) -> ha osszeget irsz, jelezd hogy becsles/hianyos, ne allitsd teljesnek.
- A ZST namespace sose keveredik a szemelyessel -- csak zst_ tablakbol dolgozz.

## Ellenorzes
- A riport a valos zst_ adatbol jon.
- Semmi kuldes/kifele hato muvelet nem tortent.
