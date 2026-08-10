# CONTROL_RULE_DELIVERY_PATH_RECOVERY — 1. és 2. lépés (read-only felderítés)

**Dátum:** 2026-07-19
**Kártya:** 15598797
**Státusz:** felderítés KÉSZ, gyökérok AZONOSÍTVA és BIZONYÍTVA. Írás nem történt.
**Készítette:** marveen

---

## VERDIKT

**A szabály-kézbesítés bizonyítottan lyukas, és a lyuk pontos alakja megvan.**

`agents/marveen/CLAUDE.md` **soha nem töltődik be**. Nem azért, mert hiányzik, hanem mert
egy olyan könyvtárba került, ami a fő ágens munkakönyvtára **alatt** van, nem fölötte.
A CLAUDE.md öröklés fölfelé sétál — lefelé soha.

---

## 1. Melyik ágens mit tölt be — futásidőből mérve

A `cwd`-t a futó processzek `/proc/<pid>/cwd` symlinkjéből olvastam ki, nem konfigból.

| Ágens | tényleges cwd | öröklési lánc |
|---|---|---|
| mind a 15 flotta-ágens | `/home/iszzu/marveen/agents/<név>/` | `agents/<név>/CLAUDE.md` **+** `/home/iszzu/marveen/CLAUDE.md` |
| **marveen (fő)** | `/home/iszzu/marveen` | **csak** `/home/iszzu/marveen/CLAUDE.md` |

A flotta-ágenseknél a mechanizmus **működik**: a saját leírójuk és a root is betöltődik.
A hiba kizárólag a fő ágenst érinti.

## 2. `agents/marveen/CLAUDE.md` — a konkrét eset

**Létezik:** 28 sor, 1489 bájt. Két érdemi szekciója van: egy nyitott, meg nem erősített
tétel, és a `Render API kulcs` szekció.

**Soha nem töltődik be.** A fő ágens cwd-je `/home/iszzu/marveen`; az `agents/marveen/`
ennek **gyermeke**. Az öröklés a cwd-től fölfelé halad, tehát ez a fájl definíció szerint
kívül esik a láncon.

**Load receipt — futásidejű, nem lemez-alapú.** A saját session-ömbe ténylegesen injektált
kontextus a `/home/iszzu/marveen/CLAUDE.md`-t tartalmazza, és **nem** tartalmazza az
`agents/marveen/CLAUDE.md`-t. Ez közvetlen megfigyelés a betöltött kontextuson, nem
következtetés a könyvtárszerkezetből. Ez volt a kikötés: *a fájl létezése nem bizonyíték*.

## 3. Hogyan keletkezett — és miért nem vette észre senki

`865e3596` (2026-07-12) helyesen ismerte fel, hogy a root `CLAUDE.md` **minden** ágens
számára öröklődik, tehát a Render-kulcs útvonala onnan minden build-ágenshez eljut — pont
az ellenkezője a szándéknak. A javítás: kivenni a rootból, és `agents/marveen/CLAUDE.md`-be
tenni, abban a hitben, hogy azt csak marveen látja.

**A hit téves volt, és a kódbázis saját modellje mondja ki, miért.**
`src/web/main-agent.ts` kommentje szó szerint: a fő ágensre azért kell külön életciklus,
mert *"it has **no `agents/<name>` dir** and no `agent-<name>` session"*. A fájl tehát olyan
könyvtárba került, amiről az architektúra kimondja, hogy a fő ágens esetében nem létezik.

**És a root fájl maga is hedge-el.** A 127. sor így szól: *"nézd meg
agents/marveen/CLAUDE.md-t, **ha az létezik és a saját session-öd betölti** — ha nem biztos
benne, kérdezd devops-ot vagy deliverylead-et"*. Ez a mondat a bizonyíték arra, hogy a
kézbesítést **soha nem ellenőrizte senki**: a szerző tudta, hogy bizonytalan, és tartalék
útvonalat írt helyette ahelyett, hogy megmérte volna.

## 4. Tartalom-ellenőrzés (a vak visszamásolás elleni kikötés)

A saját kikötésem szerint a szabályt nem másolom vissza ellenőrzés nélkül:

- **Titok-érték nincs benne.** Nulla magas-entrópiájú sor; útvonal-hivatkozás és egy nyitott
  tétel, nem kulcs. A kézbesítési hiba tehát **nem** okozott titok-elvesztést.
- **Felülíró owner-döntést nem találtam** erre a szabályra.
- **Ellentmondó aktív példány:** a root 127. sora hivatkozik rá; ez a hivatkozás pontatlanná
  válik, ha a fájl marad, ahol van.

## 5. Amit ez a felderítés NEM állít

- Nem állítom, hogy a flotta-ágensek leírói is hibásan töltődnek — azoknál a lánc helyes.
- Nem mértem meg, hogy a launcher rossz `cwd` esetén fail-closed-e. Ez a következő negatív
  teszt, és előre jeleztem: ha kiderül, hogy csendben új rejtett névteret hoz létre, az
  **RETURN_FOR_FIX / BLOCKED**, nem "javítva" — a rossz cwd elkerülése a hiba elrejtése lenne.
- Nem írtam semmit. Ez a szakasz kizárólag olvasás volt.

## 6. Következő lépés — döntést igényel, mielőtt bármit írok

Három lehetséges alak, és nem magamtól választok:

1. **A fájl megszűnik**, tartalma a rootba kerül vissza — de akkor újra minden ágens látja,
   ami az eredeti hibát hozza vissza.
2. **A fő ágens cwd-je** `agents/marveen/`-re változik — így az öröklés helyreáll, de ez a
   `marveen-channels` életciklust érinti, és a kód szerint a fő ágensnek szándékosan nincs
   ilyen könyvtára.
3. **A root hivatkozása megszűnik**, és a fájl marad nem-betöltődőként, dokumentáltan halott.
   Ez a legkisebb változtatás, és megszünteti a hamis tekintélyt, de nem kézbesíti a szabályt.

A 2. a valódi javítás, az 1. visszalépés, a 3. csak a félrevezetést szünteti meg.

---

**Az általánosítható tanulság, ami túlmutat ezen a fájlon:** egy szabályfájl megléte semmit
nem mond arról, hogy eljut-e a címzetthez. A flottában bármely leíró kézbesítése csak akkor
igazolt, ha a **betöltött kontextusban** látszik — nem akkor, ha a lemezen ott van.
