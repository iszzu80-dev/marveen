---
name: product-radar-websearch
description: Napi szeles webes keresés a termek-radar tetelekre (barmelyik magyar webshop lehet a forras); csak celar-ala ajanlatnal pingel Telegramra.
---

Termek-radar NAPI szeles webes keresese. A cel: barmelyik magyar webshopban felbukkano JO AJANLATOT elkapni a figyelt termekekre. Read-only, semmit nem vasarolsz.

## 1. Aktiv termek-tetelek beolvasasa
```
python3 -c "import sqlite3,json; d=sqlite3.connect('/home/iszzu/marveen/store/claudeclaw.db'); [print(r[0],'|',r[1],'| cel=',r[2],r[3],'|',r[4]) for r in d.execute(\"SELECT radar_id,label,target_price,currency,query FROM radar_items WHERE kind='PRODUCT' AND status IN ('ACTIVE','HIT') ORDER BY radar_id\")]"
```
A `query` JSON-ben van `terms` (keresoszo), `mustMatch` (mind szerepeljen a nevben), `excludeTerms` (egyik se) -- ezekkel dontsd el hogy egy talalat A JO termek-e (ne egy tartozek/hasonlo).

## 2. Termékenkent SZELES webes keresés
Minden tetelre WebSearch: `<label> ár` (pl. "On Cloud 6 futócipő ár", "OLYMP férfi ing ár", "HOFF Banks cipő ár"). Magyar webshopok jönnek (INTERSPORT, ecipo, Modivo, Answear, Mountex, futobolt, Alza, eMAG, stb.).
- A talalatokbol keresd meg a LEGOLCSOBB, HITELES ajanlatot a JO termekre (mustMatch/excludeTerms szerint), magyar shopban, HUF-ban.
- Ha az arat a talalati osszefoglalobol nem tudod biztosan, nyisd meg a shop termekoldalat es olvasd ki (`curl -s -A "Mozilla/5.0 ... Chrome/126" "<url>"` -> a `<script type="application/ld+json">` `offers.price`-a, vagy a lathato ar). Bongeszo-UA kell.
- Csak azt az arat vedd amit VALOBAN latsz a JO termekre. Ha nincs hiteles magyar ajanlat -> hagyd ki a tetelt (NE talalj ki arat, ne rögzits tartozekot/hasonlot).

## 3. Rögzites a radarba (a kozos write-primitiv)
Minden megtalalt legjobb arra:
```
node /home/iszzu/marveen/scripts/radar-web-record.mjs <radar_id> <arMajorHUF> "<shop>" "<url>"
```
A kimenet JSON: `hit` (ar <= celar?), `notify.should` (erdemes-e szolni, dedupolva a tegnapi ugyanolyan ajanlatra), `bestPrice`. A per-shop dedup miatt ugyanaz a shop-ar nem pingel ujra naponta; egy UJ, olcsobb shop igen.

## 4. Telegram CSAK ha van jo ajanlat
Gyujtsd ossze azokat ahol `notify.should=true` (celar ala ment egy UJ ajanlat). Ha van legalabb egy -> EGY osszevont Telegram uzenet (reply tool, chat_id 8942301795), sima szoveg, tetelenkent 1 sor: termek, ar, shop, link, cel. Ha nincs egy sem -> MARADJ CSENDBEN (ez a normalis eset, ne pingelj "nincs ajanlat"-ot).

## Buktatok
- A WebSearch neha kulfoldi/rossz-termek talalatot is dob -> a mustMatch/excludeTerms + jozan esz szuri (On Cloud CIPO, ne HyperX Cloud fejhallgato; OLYMP ING, ne olajbogyo).
- Ne rögzits arat ha bizonytalan a termek-egyezes vagy a penznem nem HUF. Inkabb kihagyod (oszinte 0), mint hamis ar.
- A helper a LIVE DB-be ir (ez a radar dolga); a `notify.should` mar dedupolt, ne kuldj sajat kezuleg duplikalt riasztast.
- `hit=true` de `notify.should=false` -> ezt a shop-ajanlatot mar jelezted korabban, NE pingelj ujra.

## Ellenorzes
- Minden aktiv tetelre vagy rögzitettel egy arat, vagy tudatosan kihagytad (nincs hiteles ajanlat).
- Ha pingeltel, minden sorhoz van valos shop-link es ar <= celar.
