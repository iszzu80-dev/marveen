# COS code review remediation — mind a 18 találás, tételesen

**Dátum:** 2026-08-10 | **Ág:** `cos-review-fixes-2026-08-10` (`develop` @ `60fabf6`-ról)
**Forrás:** `audits/cos-teljes-code-review-2026-08-10.md` (18 találás, 5 P0)
**Kérés:** Istvan — "állj neki az összes hibának a reviewben és dokumentáltan, committolva"

**Kapu minden commitra:** `npx tsc --noEmit` tiszta, és a 90 COS + progression
teszt-fájl futtatva. Végállapot: **978 passed / 2 skipped**.

**Egy állandó piros, ami nem az enyém:** `cos-progression-mc-view.test.ts`, 12
hiba, `Cannot find module 'jsdom'`. A `jsdom` szerepel a `package.json`
devDependencies-ben és nincs telepítve ebben a környezetben. Lemértem: a
változtatásaim ELŐTT is pontosan ugyanaz a 12. Nem javítottam, mert egy hiányzó
csomag telepítése nem az én döntésem.

---

## A 18 találás

| # | Súly | Állapot | Commit |
|---|---|---|---|
| F-1 | P0 | KÉSZ | `bb39c97` |
| F-2 | P0 | KÉSZ | `b0ac6c9` |
| F-3 | P0 | KÉSZ | `74aee81` |
| F-4 | P0 | KÉSZ | `2d0f6a3` |
| F-5 | P0 | KÉSZ | `2d0f6a3` |
| F-6 | P1 | KÉSZ, korlátozással | `396f043` |
| F-7 | P1 | KÉSZ | `9994ff3` |
| F-8 | P1 | KÉSZ | `869645f` |
| F-9 | P1 | KÉSZ | `79ec04d` |
| F-10 | P1 | KÉSZ (marker), RÉSZBEN (browser) | `2a0e4f2` |
| F-11 | P1 | KÉSZ | `2a0e4f2` |
| F-12 | P1 | KÉSZ, gyengébb bizonyítékkal | `11e50ae` |
| F-13 | P2 | KÉSZ | `858a31a` |
| F-14 | P2 | KÉSZ | `869645f` |
| F-15 | P2 | KÉSZ | `858a31a` |
| F-16 | P2 | KÉSZ | `858a31a` |
| F-17 | P2 | KÉSZ, nem élesítve | `9e3221d` |
| F-18 | P3 | KÉSZ | `9e3221d` |
| §C (9. javaslat) | — | KÉSZ, kikapcsolva | `523045b` |
| Módszertani javaslat | — | KÉSZ | `9e3221d` |
| §16 szöveg (12. javaslat) | — | KÉSZ | ez a commit |

---

## Amit NEM oldottam meg, és miért

**F-10 browser-adapter fele.** A marker-kapu bekötve. A browser-kapu nincs, mert
nincs mihez kötni: produkciós browser-adapter nem létezik. Egy kapu, amit egy nem
létező komponens elé teszek, nem véd semmit, viszont úgy néz ki, mintha védene.
Amikor az első browser-adapter megszületik, `assessBrowserAdapter` ugyanoda való,
ahová a marker-bizonyíték került: a mód emelésének előfeltételébe.

**§16 radar adatmodell.** A review két opciót adott: vagy a modell kiegészítése,
vagy a lezárt auditok szövegének javítása. A másodikat választottam, mert a Slice
4 nyitva van és a hiányzó mezők valódi termék-döntéseket hordoznak (mely
kereskedők, milyen ország, milyen garancia), amiket nem én hozok meg. Az
`audits/cos-spec-full-chapter-audit-2026-08-09.md` összesítője javítva.

**A 3 piros CostOps teszt.** A review említi őket, nem COS, nem néztem meg.

**A 20 meglévő idegen-kulcs sértés.** Lásd lent.

---

## Amit menet közben találtam, és nem volt benne a review-ban

Ezek a saját munka melléktermékei. Mindegyik azért került elő, mert a javítás
kikényszerítette, hogy egy addig soha nem használt út tényleg lefusson.

**1. Séma-sorrend, háromszor.** Három `ensureColumns` hívás a tábla LÉTREHOZÁSA
ELŐTT állt, `if a tábla létezik` őrrel: a ZST-ledger oszlopai, a ZST jóváhagyási
boríték, és majdnem a ZST scope-oszlopok is. Mindhárom néma üresjárat volt minden
friss adatbázison. Az elsőt az fogta meg, hogy egyetlen végrehajtó írja mindkét
ledgert, tehát minden ZST-küldés `no such column`-nal bukott.

**2. Egy táblának két definíciója.** Az `email_processing` kétszer szerepel a
sémában, ~120 sor különbséggel, és a KÉSŐBBI nyer, mert a korábbit egy migráció
átnevezi. Aki a korábbit javítja, semmit nem javít. Ez történt velem is: az F-8
állapot-bővítés először a rossz definícióba került, és a tesztek a régi
megszorításon maradtak pirosak.

**3. A CHECK-bővítés élesben elszállt.** A friss adatbázison működő
tábla-újraépítés a valódi store másolatán `FOREIGN KEY constraint failed`-del
bukott: a modern SQLite az átnevezéskor átírja a MÁSIK tábla hivatkozását. Két
pragma kell hozzá, és mindkettő a tranzakción KÍVÜL, mert a `foreign_keys`
változtatását a SQLite tranzakción belül csendben eldobja — ami úgy nézne ki,
mintha működne.

**4. A store-ban 20 idegen-kulcs sértés van, és nem én okoztam.** A rebuild utáni
integritás-ellenőrzés kiütötte őket: `zst_email_processing` 10, `zst_case_events`
10. Érintetlen másolaton is megvannak, tehát régebbiek. A migráció ezért
alapállapotot vesz fel és csak az ÚJ sértésekre bukik; más árváira nem lehet
minden jövőbeli migrációt megállítani. **Ez nyitva marad, külön kell megnézni.**

**5. A lejárat a valós órához hasonlított.** A kapu nem adta tovább a `now`-t,
így a jóváhagyás lejáratát a fali óra döntötte el, miközben a küldés minden más
időbélyege a hívótól jön. Addig volt ártalmatlan, amíg a lejárati mező mindig
üres volt.

**6. Az egy darabos kampány-korlát az első küldést utasította el.** A számláló
beleszámolta azt a sort is, amit épp engedélyezni akart.

Az 5. és a 6. ugyanannak a mintának a két fele, és ez a nap fő tanulsága: **egy
korlát, amit soha semmi nem állít be, egy korlát, amit soha semmi nem tesztel.**
Mindkettő évek óta ott ült volna csendben, és abban a pillanatban vált
láthatóvá, amikor a mezőt először kitöltötte valami.

**7. /tmp megtelt.** A mentés-teszt a visszaállítási próbát a tmpfs-re írta; a
store 165 MB, a /tmp 5,4 GB és eleve 91%-on állt. A próba a mentés mellé került.

---

## Amit a javításokról KI KELL mondani

**F-6 ma egyetlen küldést sem blokkol.** Az érzékenységi szint most igaz, de a
profil, amit ez az út deklarál, minden szinten engedélyezett. A kapu akkor fog
blokkolni, ha valaha más profilt deklarál. Egy tesztet írtam rá, ami elbukna, ha
a javítás egyszerűen mindent felminősítene.

**F-7 önbevallás, nem bizonyíték.** A hívó kijelenti, hogy kiértékelte a kaput.
Hazudhat. Amit nyer: az engedély nem néma alapértelmezés többé.

**F-12 gyengébb bizonyíték.** A szolgáltatói azonosító azt bizonyítja, hogy az
üzenet létezik, nem azt, hogy a törzse a jóváhagyott. A marker-kör mindkettőt
bizonyítja, és marad az elsődleges út. De egy gyengébb bizonyíték is több, mint
egy sor, amit soha semmi nem tud lezárni.

**F-17 nincs élesítve.** A determinisztikus futtató megvan és lefutott, de az ÉLŐ
ütemezett feladat (`~/.claude/scheduled-tasks/`) továbbra is a négy külön
parancsot sorolja, mert az élő rendszer a fő checkoutból fut, ahol ez az ág még
nincs bent. A repóbeli másolat frissítve. Merge után egy lépés.

**§C ki van kapcsolva.** A karbantartó szkript végigfut és a visszaállítási
próbát is elvégzi, de az ütemezés `enabled:false`, mert a `COS_BACKUP_PASSPHRASE`
nincs a vaultban. Egy mentési feladat kulcs nélkül minden éjjel hangosan bukna:
helyes viselkedés, haszontalan zaj. Egy titok kell hozzá, és az Istvan döntése.

---

## Meglévő tesztek, amiket át kellett írnom

Tizenkettő, mindegyik a commit-üzenetében külön kiírva. Nem apróság: egy teszt
átírása a legolcsóbb módja annak, hogy valaki eltüntessen egy hibát, ezért
mindegyiknél ott áll, mit állított azelőtt és miért volt az rossz.

A többségük **a hibát rögzítette követelményként**: hogy a köteg-sorbaállító
visszaadjon még soha el nem küldött levelet; hogy a ciklus KIKÜLDJE azokat; hogy
egy meg nem jelölt levél `SOURCE_COMMITTED`-nek számítson; hogy egy helyi
elgépelés `OUTCOME_UNKNOWN` legyen. Ezek nem "elromlott" tesztek voltak, hanem
pontosan leírták, mit csinál a rendszer — csak azt senki nem kérdezte meg, hogy
azt kell-e csinálnia.

A többi legitim: a vállalati teszteknek most be kell állítaniuk az autonómia-
fokozatot (a személyes teszteknek mindig is kellett — ez az aszimmetria VOLT a
hiba), és két helyen bizonyítékot kell rögzíteni, mielőtt írási módba emelnek egy
csatornát.
