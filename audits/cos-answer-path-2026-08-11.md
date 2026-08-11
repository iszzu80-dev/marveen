# A válasz-út — mi volt elromolva 2026-08-11 estig, és mi változott

**Kinek szól:** Istvannak, és bárkinek, aki kívülről akarja megérteni, mi történt ezen az estén
anélkül, hogy tizenöt commit-üzenetet olvasna végig.

**Egy mondatban:** a rendszer kérdezett, Istvan válaszolt, és a válasza soha nem ért célba. Nem egy
hiba miatt — **négy** független ok miatt, egymás után, és mindegyik önmagában elég volt ahhoz, hogy a
válasz semmit ne csináljon. Mind a négy javítva, plusz egy ötödik, amit közben én okoztam.

---

## 1. A négy ajtó

A CoS-ben a lánc így néz ki: a Reader elolvassa az ügyet → a Writer kérdést fogalmaz → a kérdés kimegy
Istvan csatornájára → Istvan válaszol → a válasz visszaér az ügyhöz → a motor dolgozik belőle.

Az utolsó két lépés nem működött. Négy okból:

| # | Mi hiányzott | Mi volt a látszat | Commit |
|---|---|---|---|
| 1 | **Nincs hívó.** A válaszrögzítő függvénynek nulla produkciós hívója volt. | „A válasz-út megépült." | (délután, `8209e18` / `83e8706`) |
| 2 | **Nincs hivatkozás.** A válasz-esemény `source_reference` nélkül íródott, a fogyasztója pedig pontosan azon a mezőn dobja el. | A kérdés lezárult, tehát „megválaszolva". | `9600790` |
| 3 | **Nincs ébresztő.** A trigger állapot-lenyomata a `last_event_id`-t olvassa, amit **semmi nem írt** — 106 ügyből nulla. Egy csak-esemény változás nem tette futásra jogosulttá az ügyet. | `decideTrigger` → *„nothing has changed"*. | `d6ebe51` |
| 4 | **Rossz olvasatból kérdez.** Ugyanez a mező vakította az avultság-őrt is: az ügy „nem mozdult", tehát egy tíz órával korábbi olvasat frissnek látszott. | A rendszer megkérdezte Istvant arról, amit két órája megmondott. | `2cf6bc6` |

A 3. és a 4. **ugyanaz a gyökér**, két különböző műszerrel: ha az esemény nem érinti az ügy sorát,
akkor az ügy a rendszer szerint nem mozdult — és ez egyszerre teszi vakká a triggert és az őrt.

### Hogyan derült ki

Nem review-ból. Abból, hogy a 20:00-s válasz után **megkérdeztem a downstream komponenst a valódi
rekordról**: `decideTrigger(db, 'zst', <az imént megválaszolt ügy>, now)` → `shouldRun: false`.
Egy sor, és benne az egész találás. A tanulság a következő hasonló helyzetre: egy lánc javítása után
azt kell megkérdezni, **mi a következő dolog, aminek történnie kell** — és azt is ellenőrizni, az élő
adaton.

---

## 2. Az ötödik hiba: a sajátom

21:52-kor bevezettem, hogy több nyitott kérdés esetén a rendszer **ne találgassa**, melyik ügyre jött
a válasz (`9991fa7`) — mert aznap egy Wizz Air-ről szóló válasz egy NAV-ügyre került, és onnantól
minden downstream (beleértve engem) tényként kezelte a tippet.

22:00-kor élesben tüzelt a szabály: `ambiguous: 1`. És kiderült a lyuk benne: a poll megszámolta,
**előrevitte a Telegram-kurzort, és a mondat elveszett** — a Telegram nem szolgál ki újra egy
update-et. Egy órával korábban azt írtam Istvannak, hogy „az üzenet nem vész el". Csak a számláló
volt igaz.

Javítva `e22c310`: a szöveg a kurzor mozdulása **előtt** eltárolódik, az okkal együtt.

**A „fail closed" csak akkor védelem, ha a visszatartott dolog tényleg megmarad.**

---

## 3. Ami mellékesen kiderült, és többet ért a keresésnél

**A Gmail-konnektor csak `text/plain` részeket szedett ki.** Egy HTML-only levél így **üres törzzsel**
érkezett — nem hibával, hanem úgy, mintha a levél nem mondana semmit. Mérés: a 25 tárolt e-mail
szálból **4 fejléc-only** (16%), és ezek közül kettőről kérdezett a rendszer aznap este.

Javítva (`mcp-servers/google-*-mcp.py`): ha nincs sima szöveg, a HTML-ből olvasunk ki.
**Visszamenőleg is működik** — és az első visszaolvasott levél megmutatta, hogy a Valencia→Málaga
autóbérlés **augusztus 8. óta le van foglalva**. Vagyis egy hetek óta nyitottnak látszó tulajdonosi
döntés valójában meg volt hozva, csak nem tudtuk elolvasni.

**Egy stíluslap nem tartalom** (`8c00b90`): egy 25 KB-os HTML levélből a 4000 karakteres keret a CSS-re
ment el, a lényeg (foglalási dátumok, széfkód, kötelező check-in) a végén volt, tehát kimaradt. A
markup mostantól a méret-vágás előtt tűnik el.

**A ciklus tisztának mondta magát** (`83717a6`): a hibafigyelő csak a `failed: true` mezőt nézte,
miközben három lépés `failures` tömbben jelenti a per-tételes hibákat. Egy kézbesítetlen ügy-kérdés
így „a ciklus rendben" alá került.

---

## 4. Ami nem hiba volt, csak zaj

**Egy ügy három kérdést küldött húsz perc alatt.** Külön-külön mindhárom védhető; együtt egy ügy, ami
tíz percenként szól. A meglévő plafon ezt nem fogta meg, mert az a **sort** korlátozza (öt nyitott
kérdés), nem a **rátát**. Javítva `f12c720`: egy ügy hat órán belül nem küld új kérdést az utolsó
megválaszolatlan kérdése után — kivéve ha a tulajdonos válaszolt (az azonnal felold), vagy ha egy
nyitott kérdés újrafogalmazásáról van szó (az nem növeli a sort).

---

## 5. Amit ez nem old meg

Kimondva, hogy a dokumentum ne látsszon többnek, mint ami:

- **A per-ügy vakság megmarad.** A context-builder egy ügy saját adatait tölti be, tehát egy másik
  ügyre mutató hivatkozás a gépnek olvashatatlan. Ezért kellett az öt Reláció-ügy döntését ügyenként,
  **önmagában érthető** formában kiírni. Kártya: `4c6695d9`.
- **A már tárolt négy fejléc-only dokumentum tartalma továbbra is hiányzik** — a konnektor-javítás
  csak az ezután beolvasott leveleket érinti. Kártya: `6192068e`.
- **A kérdés-sor a legfrissebb OLVASÁS sorrendjében választ, nem a határidő szerint.** Emiatt a
  plafon megtelhet a legkevésbé sürgős kérdésekkel, miközben lejárt határidejű ügyek várnak. Kártya:
  `0d2121a9`.
- **Melyik eseményosztály ébresszen fel egy ügyet** — ma csak a tulajdonosi válasz teszi. A motor
  saját futás-eseményeire ébreszteni futás-sokszorozó lenne. Kártya: `eaddbad7`.

---

## 6. Bizonyítás

Minden fenti javításhoz teszt tartozik, és **minden új állítást pirosra járattam** a javítás
kikapcsolásával — nem elég, hogy zöld, azt kell tudni, hogy tud piros lenni. A teljes készlet ma este
5878 zöld; a három bukó fájl (hiányzó `jsdom`, installer ERR-trap, scheduler retry) a változtatások
**előtt is ugyanígy bukott**, ezt külön lemértem, nem feltételeztem.
