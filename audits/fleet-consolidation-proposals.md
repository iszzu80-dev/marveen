# Fleet szerep-konszolidáció: részletes terv (Sentinel/Steward, Broker/Bursar)

2026-07-06. Istvan kérése (3130): a 2. és 3. jelöltet írjam le részletesen. Az 1. (Mason/Anvil) már végrehajtva (egyforma leíró, mindkettő megmarad, dupla build-sáv).

Elv: NEM minden átfedés redundancia. Két agens akkor vonható össze, ha (a) ugyanazt a kompetenciát gyakorolják, ÉS (b) ugyanabból az adatforrásból dolgoznak, ÉS (c) nincs jogi/adó/biztonsági ok a szétválasztásra. Ha a szétválasztásnak valódi oka van, a helyes lépés a LEÍRÓ egységesítése két példány megtartásával (Mason/Anvil-minta), nem az összevonás.

---

## 2. Sentinel + Steward -> ÖSSZEVONÁS (javaslat: MERGE)

### Jelenlegi állapot
- **Sentinel**: Istvan privát e-mail + naptár triage asszisztense. Fontos/kezeletlen e-mailek, határidők, fizetési emlékeztetők, szerződéses/szolgáltatói értesítések, naptár-konfliktusok azonosítása, választervezet.
- **Steward**: Istvan Üröm/ház projektmenedzser asszisztense. Az ingatlannal, kivitelezőkkel, vállalkozókkal kapcsolatos ügyek nyilvántartása: szereplő, ügytípus, státusz, utolsó válasz, ígéret, következő lépés, határidő, kockázat, döntés-igény.

### Átfedés-elemzés
- **Mechanika azonos**: mindkettő input-figyelés -> ügy/thread-követés -> határidő + döntés-igény kiemelés -> választervezet. Ez ugyanaz a képesség.
- **Adatforrás azonos**: a ház-projekt e-mailjei UGYANABBA a privát inboxba érkeznek, amit Sentinel amúgy is triage-el. Vagyis Sentinel már LÁTJA a ház-emaileket, Steward pedig a részhalmazukat mélyebben újra-feldolgozza. Ez dupla-feldolgozás ugyanazon az adaton.
- **Különbség**: Steward mélyebb, per-ügy ledgert vezet (kivitelezőnként státusz/ígéret/határidő). Ez nem külön KÉPESSÉG, hanem a triage-mechanika egy mélyebb alkalmazása egy adott domainre.

### Miért védhető mégis a külön lét (ellenérv)
- A ház-projekt valódi, folyamatos munkateher (több kivitelező, határidők, pénzmozgás). Egy általános inbox-agensbe olvasztva a ház-ügyek elveszhetnek a általános triage-zajban.
- Ellen-ellenérv: egy dedikált HÁZ-LANE-nel (perzisztens nézet) ez elkerülhető. A ledger-struktúra megmarad, csak egy agens birtokolja a teljes privát inboxot.

### Javaslat: MERGE Sentinelbe
Egy "Istvan privát inbox + naptár + ház-projekt ügykövető" agens (Sentinel), a ház-tracking explicit, perzisztens lane-ként. Megtartjuk a Steward-féle per-ügy ledger struktúrát mint a Sentinel egyik modulját.
- Nyereség: -1 agens, megszűnik a ház-emailek dupla-feldolgozása, egy tulajdonosa van a privát inboxnak (nincs "ki triage-eli ezt" kétely).
- Migráció: (1) Steward ház-ledger struktúrája + memóriái átemelése Sentinel deliverables/memory alá, (2) Sentinel leíró kibővítése a ház-lane felelősséggel, (3) Steward stop + archiválás, (4) Sentinel restart, (5) egy heartbeat-ciklus a ház-lane verifikálására.
- Kockázat: alacsony. Ugyanaz a személy, ugyanaz az inbox, deepseek-modell mindkettő. Reverzibilis (Steward config archiválva, nem törölve).

---

## 3. Broker + Bursar -> KÜLÖN MARAD, de EGYSÉGES LEÍRÓ (javaslat: NO MERGE)

### Jelenlegi állapot
- **Broker**: Istvan privát pénzügyi tanácsadó asszisztense. Számlák, fizetési határidők, bankkivonat read-only elemzés, költségkategóriák, befektetés/részvény/állampapír/alap elemzés.
- **Bursar**: Istvan ZST Radio Kft. cég-ügyviteli asszisztense. KIZÁRÓLAG a cég ügyei, a személyestől elkülönítve.

### Átfedés-elemzés
- **Mechanika azonos**: mindkettő számla/határidő-követés, kivitel-elemzés, összefoglaló. Ugyanaz a kompetencia.
- **Adatforrás KÜLÖNBÖZŐ**: Broker a személyes számlákat/kivonatokat, Bursar a ZST cég számláit/kivonatait nézi. Nem ugyanaz az adat.
- **Jogi/adó szeparáció**: a személyes és céges könyvelés NEM keveredhet. Külön könyvelő (Reláció KFT a cégnek), külön adóalany, külön bankszámlák. Ha egy céges számla személyesként (vagy fordítva) kategorizálódik, az valódi könyvelési/adó-hiba.

### Miért NE vond össze
Az 1. és 2. jelölttel ellentétben itt a szétválasztás nem kozmetikai, hanem VALÓDI domain-határ (jogi/adó). Egy agens kontextusában a két könyvelés keveredésének kockázata reális, és a hibája drága. A szétválasztás itt FEATURE, nem redundancia.

### Javaslat: külön példány, EGYSÉGES leíró (Mason/Anvil-minta)
Ne vond össze, de a két leírót tedd egyformává (ugyanaz a pénzügyi-asszisztens képesség-készlet, ugyanaz a viselkedés), scope-paraméterrel: Broker = personal-scope, Bursar = company-scope. Így konzisztensen viselkednek (ugyanaz a számla-követés/kivonat-elemzés/összefoglaló minőség), de a kemény személyes/céges adat-partíció megmarad.
- Nyereség: konzisztens viselkedés + karbantarthatóság (egy kánon-leíró, két scope), a szeparáció sértetlen. Nincs agens-megtakarítás, de nem is ez a cél itt.
- Ez pontosan az a minta, amit a Mason/Anvil-nál alkalmaztunk.

---

## Összegzés / döntés Istvannak
| Jelölt | Javaslat | Agens-nettó | Ok |
|--------|----------|-------------|-----|
| Sentinel + Steward | MERGE Sentinelbe (ház-lane) | -1 | Azonos adatforrás (egy inbox), dupla-feldolgozás |
| Broker + Bursar | KÜLÖN marad, egységes leíró | 0 | Jogi/adó személyes-céges partíció = feature |

Döntés kell: az összevonás (Sentinel/Steward) végrehajtható-e? A Broker/Bursar egységesítés (nem-összevonás) alacsony kockázatú, azt GO nélkül is meg tudom csinálni ha kéred.
