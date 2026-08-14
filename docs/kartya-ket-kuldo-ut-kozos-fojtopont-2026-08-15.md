# Kártya: a két küldő út közös fojtópontja

**Állapot:** javasolt · **Prioritás:** high · **Készítette:** Claude, 2026-08-15
**Mérés helye:** `/home/user/marveen-private`, ág `develop`, HEAD `200ac0f`, tiszta fa

---

## Egy mondatban

Minden új kimenő védelem a **személyes** úton születik meg, és a **vállalati**
út egy külön kódúton, később, esetleg megkapja. Négy példány van rá, a legutóbbi
ma esti. Ez már nem négy hiba, hanem a két küldő út szerkezete.

## A négy példány, méréssel

| # | a védelem | személyes út | vállalati út |
|---|---|---|---|
| 1 | autonómia-fokozat (§22) | `dispatch-gate.ts` óta | *„the corporate one **never did**"* — `zst-send.ts:304` saját kommentje |
| 2 | `PLANNED` napi jelzés | `outbound-alert.ts:90,95` — `FROM outbound_ledger` | a `zst_outbound_ledger` (`schema.ts:1221`) **nincs lekérdezve** |
| 3 | `OUTBOUND_DRAFTED` esemény | `send-flow.ts:183` | `zst-send.ts`-ben **nulla** `appendCaseEvent` |
| 4 | **az ötödik mód kapuja** | `send-flow.ts:115` `mayCompose`, `:251` `mayApprove` | **egyik sem** |

A negyedik mérése, a teljes `zst-send.ts` fájlon:

```
grep -cE "mayApprove|mayCompose|appendCaseEvent|OutboundOrigin"  src/cos/zst-send.ts
0
```

A kettes mérése (hermetikus DB): egy `PLANNED` sor a `zst_outbound_ledger`-ben →
`buildPlannedDigest(...).count === 0`. A jelzés hallgat.

## Miért fontos, és mennyire sürgős

**Nem élő sebezhetőség.** Ma semmi nem állít `external_shadow`-t vagy `live`-ot
(a `setProgressionEnabled`-nek nulla produkciós hívója van), és a ZST
jóváhagyást ember indítja. A négyből egyik sem tud ma kárt okozni.

**De ez pontosan az a fajta, ami a bevezetés napján válik éleivé.** Az ötödik
mód egész célja, hogy fék legyen arra a napra, amikor az automatikus jóváhagyás
megérkezik. Ma **egy kerékre** került fék, és a hiánya nem hibaüzenetként fog
jelentkezni, hanem egy elment levélként.

## A jó hír: a közös mechanizmus MÁR MEGVAN

Ez nem újratervezés. A kapu-modul már domain-paraméteres:

```
outbound-mode-gate.ts:101  progressionModeOf(db, domain, caseId)
outbound-mode-gate.ts:120  mayCompose(db, domain, caseId, origin)
outbound-mode-gate.ts:163  mayApprove(db, domain, caseId, initiator)
```

és a `case_progression_state` sémája `CHECK (domain IN ('personal','zst'))`.
Vagyis a `'zst'` **már ma is átadható**. A hiány nem a mechanizmusban van, hanem
abban, hogy a `zst-send.ts` sosem hívja meg.

**A munka tehát nem „építsünk közös fojtópontot", hanem „kössük be a meglévőt a
másik úton is" — plusz egy őr, ami az ötödik elcsúszást megakadályozza.**

## A feladat

### 1. Bekötés (a négy példány)

- `draftZstSend` (`zst-send.ts:58`) kapjon `origin`-t, és hívja a
  `mayCompose(db, 'zst', …)`-t
- `approveZstSend` (`zst-send.ts:149`) kapjon `initiatedBy`-t, és hívja a
  `mayApprove(db, 'zst', …)`-t
- `draftZstSend` írjon `OUTBOUND_DRAFTED` eseményt a ZST ügy idővonalára
- `buildPlannedDigest` olvassa **mindkét** ledgert, és a kimenetben legyen
  megkülönböztethető, melyik névtérből jön egy sor

### 2. AZ ŐR — ez a kártya fontosabbik fele

A négy bekötés egy nap alatt megvan. Az igazi kérdés az, hogy **mi akadályozza
meg az ötödiket.**

Álló ellenőrzés, ami a két utat egymáshoz méri, nem egy listához. Alak, ami a
kódbázisban már bevált (`STANDING: no assertion may rest on error_code alone`,
`progression-v131-events-and-assertions.test.ts:359`): olvassa a két modul
forrását, és állítsa, hogy amit a személyes út meghív a kapu-modulból, azt a
vállalati is meghívja.

```ts
it('STANDING: a ket kuldo ut ugyanazokat a kapukat hivja', () => {
  const personal = readFileSync('src/cos/send-flow.ts', 'utf8')
  const corporate = readFileSync('src/cos/zst-send.ts', 'utf8')
  for (const gate of ['mayCompose', 'mayApprove', 'appendCaseEvent']) {
    if (personal.includes(gate)) {
      expect(corporate, `${gate} a szemelyes uton megvan, a vallalatin nem`)
        .toContain(gate)
    }
  }
})
```

**Pozitív kontroll kell hozzá**, különben egy üres kapu-lista mellett is zöld:
a teszt állítsa, hogy a vizsgált nevek közül legalább kettő tényleg megvan a
személyes úton — máskülönben az őr akkor is hallgat, ha valaki elgépeli a
neveket.

**Ez a forma szándékosan durva.** Nem azt méri, hogy a két út *helyesen*
használja a kaput, csak azt, hogy egyáltalán meghívja. Egy finomabb, viselkedési
paritás-teszt (ugyanaz a forgatókönyv mindkét úton, ugyanaz az elutasítás) jobb
lenne — de a durva változat ma megírható, és a mai négy elcsúszásból négyet
elkapott volna.

## Elfogadási feltételek

1. A négy bekötés megvan, és mindegyikhez tartozik RED-bizonyítás (a kapu
   kiiktatása pontosan a hozzá tartozó tesztet viszi pirosra).
2. Az álló ellenőrzés létezik, és **bizonyítottan piros**, ha bármelyik kaput
   kiveszik a vállalati útból.
3. Az álló ellenőrzésnek van pozitív kontrollja.
4. A `PLANNED` jelzés mérése: egy ZST `PLANNED` sor **megjelenik** a
   kimenetben, névtérrel megkülönböztetve.
5. Nincs regresszió: a személyes út söprése ugyanazokat a skipeket adja, mint
   ma (`no_prior_conversation`, `not_overdue`, `already_drafted`,
   `ball_not_with_them`).

## Amit ez a kártya NEM old meg

A `dispatch-gate.ts` (személyes) és az `evaluateZstSendGate` (`zst-send.ts:291`)
továbbra is **két külön kapu-implementáció** marad, csak a mód-rétegben lesznek
egyformák. A két kapu összevonása külön, nagyobb munka — ez a kártya azt a
kérdést nem nyitja meg, csak azt éri el, hogy a mai és a következő védelem
mindkét úton egyszerre érkezzen meg.
