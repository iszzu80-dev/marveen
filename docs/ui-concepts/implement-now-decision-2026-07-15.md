# UI/UX koncepció triázs — döntés + implement-most csomag (2026-07-15)

Forrás: Istvan 3 UI/UX koncepció-dokumentuma (Zsibongó, MikroKönyv, QuickQuote),
kód-alapú triázs (uxuidesigner per-termék). Istvan döntése (TG 5397, "Ok"):
**az "implement most" készlet mehet mindhárom termékre, a futó programokba foldeolva.
A flagship P1 buildeket egyelőre NEM indítjuk (külön Istvan-go kell rájuk). A skipeket kihagyjuk.**

Ownership: deliverylead sequenceli a futó programokba (MK onboarding/mobil, QQ P0, Zsibongó P0).
Build: uxuidesigner (spec/visual) + frontend. Minden termék proto+business floor felett marad.

---

## ZSIBONGÓ — implement most

1. **Nav konszolidáció 16→6 menü.** A jelenlegi lapos, ~16 elemes menüt csoportosítsd
   6 fő területbe (pl. Napi működés / Gyermekek / Munkatársak / Pénzügy / Megfelelés / Beállítások).
   A ritka/setup-funkciók (onboarding, import) NE legyenek első szintű menük.
2. **Globális kontextus-header (telephely-váltó).** Fejléc-szintű, mindig látható aktív-telephely
   jelző + váltó, hogy a felhasználó ne vigyen véletlenül rossz telephelyre adatot. Több-telephelyes
   intézménynél ez adatintegritási kérdés, nem csak kényelem.
3. **Onboarding + import a Beállítások alá.** Ezek setup-műveletek, nem napi funkciók → ki a fő navból.
4. **Jelenlét-képernyő polish.** A napi jelenlét/attendance a leggyakrabban használt képernyő —
   gyorsabb be/kilépés-rögzítés, tisztább napi áttekintés.
5. **Ikon + címke státusz (ne csak szín).** Minden státusz-jelzés kapjon ikont/címkét is a szín mellé
   (akadálymentesség + gyors szkennelhetőség).

Flagship P1 (PARKOLT, nem indul): egységes "teendő"-modell + cockpit (új adatmodell+API+UI).
Skip: dokumentum-workspace/versioning, compliance-naptár, push/offline.
Már él/épül (ne építsd újra): szerepkör-split, e-képviselő-szűkítés, helyettes, gyógyszer, pénzügy-rename.

---

## MIKROKÖNYV — implement most

1. **AAM + átalányadó keret vizuális sávok.** Az alanyi adómentesség (AAM) éves keret és az átalányadó
   bevételi keret kihasználtságát mutasd progress-bar-ral (mennyi van meg / mennyi a limit),
   ne csak nyers szám. Ez a termék fő value-propja (nyugalom/áttekintés).
2. **Főoldal "most félreteendő" hero + "következő teendő" kártya + felső státuszsáv.**
   A főoldal ne funkció-lista legyen, hanem állapot: a legfontosabb szám (mennyit tegyél most félre)
   hero-ként, alatta a következő konkrét teendő kártya, felül egy kompakt státuszsáv.
3. **KATA / Nyugdíj / Chat ki a desktop-főmenüből.** Ezek másodlagos funkciók → almenübe/settingsbe,
   hogy a fő navigáció a napi adó-workflow-ra fókuszáljon.
4. **Bizonytalansági címkék egységesítése.** Ahol becslés/assumption van (nem valós adatból számolt),
   egységes, emberi címke ("becslés — fejezd be a beállítást a pontos értékért"), konzisztensen.

Flagship P1 (PARKOLT): kivétel-alapú per-számla "befolyt?" tracking (DB+API+UI).
Skip: Petrol színpaletta (ez fleet-szintű brand-döntés = Lumen, NEM MK-scope), bankszinkron+forgatókönyv (P2/P3).
In-flight (ne duplikáld): onboarding-gate (kész), mobil-fix, accountant-mátrix.
FONTOS: az "assumption-szám üres fióknak" gap-et az implement-most #2+#4 fedi le (üres-állapot + címke).

---

## QUICKQUOTE — implement most

1. **Baráti ár-forrás badge.** A jelenlegi "confidence" jelölés helyett emberi forrás-badge:
   *Saját ár* / *QQ-referencia* / *Felhasználó-adta*. A felhasználó lássa HONNAN jött az ár, ne egy
   absztrakt konfidencia-százalékot.
2. **Teendő-központ főoldal.** A főoldal a nyitott ajánlatok/teendők köré épüljön (mi vár válaszra,
   mit kell utánkövetni), ne statikus funkció-lista.
3. **"Ezt az árat legközelebb is?" (inkrementális saját-ár).** Ajánlat-készítéskor, ha a felhasználó
   kézzel ad meg egy árat, ajánld fel az elmentését saját árként — így a saját ártár organikusan épül,
   teljes "Saját árak" modul nélkül (az a flagship P1).
4. **Ügyfél-oldali "Mit tartalmaz / Nem tartalmazza" + PDF/hívás gomb.** A kiküldött ajánlat ügyfél-nézete
   kapjon explicit tartalom/kizárás szekciót + PDF-letöltés és hívás CTA.
5. **Send-flow de-jargon + dupla menü lapítás + diktálás fő-CTA.** A küldési folyamatból tűnjön el minden
   fejlesztői szivárgás (ne látszódjon "dev mód / backend / mock"); a dupla Ajánlat/Áttekintés menüt
   laposítsd egybe; a hangdiktálás legyen elsődleges CTA (nem eldugott opció).

Flagship P1 (PARKOLT): dinamikus tisztázó-kérdés motor + teljes "Saját árak" modul.
Skip: teljes teal/petrol restyle, természetes-nyelvű template-mód, elfogadás OTP/e-sign.
Gated/kész (ne nyúlj hozzá): iOS-voice, ár-status-enum, foto-estimate, email (Istvan-infra), Billingo (P1).

---

## Sequencing note deliverylead-nek

- Ezek UI-restrukturálás + polish tételek — a FUTÓ programokba foldeolva menjenek, ne külön streamként.
- Minden termék MARADJON a business-scope + proto floor felett (standing rule).
- A flagship P1-ek (Zsibongó teendő-modell / MK befolyt-tracking / QQ tisztázó-motor + Saját árak)
  külön Istvan-go-t igényelnek — NE indítsd őket ezzel a csomaggal.
- Deploy/land: a szokásos empirikus gate (served frontend verify, nem csak "done" kártya).
