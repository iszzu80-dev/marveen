# A hash zártsága — és a műszer, ami némán nullát adott

**Dátum:** 2026-08-14
**Státusz:** kódban, piros-igazolva

---

## 1. A lelet

A `detector_config_fingerprint` 12 fájlt fedett. A tényleges tranzitív zárt halmaz **64** volt.

| Él | Mit engedett elmozdulni a hash mögött |
|---|---|
| `intake.ts → email-ingest.ts` | claim / dedupe / kurzor — ebből lesz ügy egy üzenetből |
| `intake.ts → sensitivity.ts` | ez dönti el, mi **nem** lesz ügy |
| `intake.ts → case-store.ts`, `case-link.ts` | ügy-létrehozás és -kötés |
| `proactive/sweep.ts → fair-interleave.ts` | **detektor**-modul függősége kívül |

Az utolsó él a sajátom: én emeltem ki a `fair-interleave`-et, hogy a Reader-import ne sértse a
§15.3 határt, és nem vettem észre, hogy ezzel a sweep fairness-logikáját kitettem a hashből.

---

## 2. A hiba alakja — pontosabban, mint ahogy először leírtam

Először úgy fogalmaztam, hogy Marveen „csak a közvetlen importokat nézte". **Ez nem volt igaz, és a
pontos leírás sokkal fontosabb.**

A saját szavaival:

> *„A feloldóm egyetlen élt sem oldott fel. A repó ESM-stílusban importál, `./case-store.js`
> alakban, én meg `./case-store.js.ts`-t és `./case-store.js`-t kerestem a fatérképen. Egyik sem
> létezik, tehát minden él csendben `None` lett, és a nulla találatot zártságnak olvastam."*

Vagyis nem egy szűk ellenőrzés futott. **Egy olyan, ami semmit nem mért** — és az eredménye
bizonyítékként ment tovább.

> **„Egy hiányra épülő állítás, ami nem tud hangosan elbukni, mindig ezt fogja csinálni."**

---

## 3. Ugyanez a lyuk benne volt az ÉN ellenőrzésemben is

Ez a dokumentum lényege. A zártságot ellenőrző tesztet megírtam, piros-igazoltam hét mutánssal — és
**egyik mutáns sem a műszert támadta.**

Kipróbáltam Marveen pontos hibáját a saját kódomon: elrontottam az importfelismerő regexet úgy, hogy
semmire ne illeszkedjen.

```text
6 tesztbol 5 ZOLD.
```

A fő állítás — *„a hatókörből kifelé mutató minden él deklarált"* — **zölden átment**, mert egy
feloldó, ami nem talál éleket, üres sértés-listát ad. Egyedül a „nincs felesleges kivétel" teszt
fogta meg, **véletlenül**, és csak addig, amíg a kivétel-lista nem üres. Ha valaha mindent
hatókörbe teszünk, az ellenőrzés némán semmit nem mér.

**A javítás:** egy külön blokk, ami **előbb a műszert ellenőrzi, mint az ítéletet, amit vele
mondunk**:

- a feloldó **konkrét, ismert éleket** old fel (`intake.ts → email-ingest.ts` stb.);
- a `.js → .ts` leképzés tényleg megtörtént (nem `.js.ts` lett belőle);
- a hatókör összesen **nem nulla** élt old fel;
- minden feloldott cél **létező fájl**;
- a **neveket** is kiolvassa (enélkül az `allowed`-korlát némán megszűnik);
- a kommentben szereplő import **nem** él.

Mind a négy mutáns, ami a műszert rontja el, most piros.

**A mintázat mindkettőnknél ugyanaz volt:** a saját műszerünket nem ellenőriztük, mielőtt ítéletet
mondtunk vele. Marveen ezt magától is felismerte — a `proactive/types.ts`-nél a regexe egy
doc-kommentet olvasott importnak, és elkapta, mielőtt elküldte volna.

---

## 4. Egy név, ami hazudott

`triageRunsRan` → **`intakeBatchesOpened`**.

Marveen mérése: az `email_processing_batches` **nem** triage-futásokat számol. Az `openBatch` a
beviteli útból hívódik, batch-enként egy beemelt levélre (`batch_id = triage-private-<messageId>`).
Egy heartbeat, ami lefut és helyesen nem talál semmit, nem mozdítja.

**A viselkedés marad, csak a név javul** — és ez az ő döntése volt, jó indokkal: ha a nulla-jelöltes
heartbeatet is számolnánk, pont azt a lyukat nyitnánk vissza, ami miatt a számláló kettévált. Egy
nulla-jelöltes heartbeat nem futtatja az `intake.ts`-t.

> *„A `triageRunsRan` azt olvastatja a következő emberrel, hogy heartbeatek száma. Ha ez marad,
> valaki egyszer majd azt fogja hinni, hogy a rendszer áll, holott csak nem jött levél."*

**Következmény, ami a fagyás időzítését érinti: a fagyást nem óra dönti el, hanem az első cselekvést
igénylő levél obs 1 után.**

---

## 5. A ledger útvonala

`CALIBRATION_LEDGER_PATH = 'store/cos-ledger.db'`.

Marveennek ezt magának kellett kitalálnia, mert a script kötelező flagként kérte és nem volt
alapértelmezés. Pontosan az az alak, amiből **két ledger** lesz: az egyikbe ír az obs-script, a
másikból olvas a value gate, és mindkettő magabiztosan válaszol. Az útvonal az ő választása; itt
csak egy helyen ki van mondva, hogy ne kelljen még egyszer kitalálni.
