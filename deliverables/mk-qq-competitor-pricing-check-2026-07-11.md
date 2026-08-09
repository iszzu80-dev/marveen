# MK + QQ competitor pricing check (2026-07-11)

Confirmed base prices (Istvan, tg 4359): **MK 3 500 Ft/hó** (1 hó trial, single tier, no freemium) · **QQ 4 900 Ft/hó** (5 ajánlat ingyen, utána 4900).

## MK (MikroKönyv) — Hungarian bookkeeping/tax assistant for KATA/átalányadó sole proprietors

MK pozíciója: NEM számlázó és NEM könyvelő-szoftver, hanem a kettő KÖZÖTT (adó-intelligencia + continuity-loop). Ezért kétirányú ár-referencia:

**Számlázók (alsó referencia, havi, +ÁFA, éves fizetéssel):**
| Termék | Ingyenes | Belépő | Közép | Felső |
|---|---|---|---|---|
| Billingo | Free 0 | Basic ~1 500 | Standard ~3 000 / Pro ~4 500 | Business ~6 000 |
| Számlázz.hu | #free 0 | #start ~1 700 | #digital ~2 500 | #profi ~3 300 |

- KATA/átalányadó asszisztens: Billingónál Basic-től felfelé beleértve; Számlázz.hu-nál plusz-díjas add-on.

**Könyvelő-szoftver (felső referencia):**
- Kulcs-Soft: Start ~49 000 Ft+ÁFA-tól (új-ügyfél promó ~31 850). Ez más liga (könyvelőknek), nem MK-versenytárs, de a "drága vég" horgony.

**Hol ül a MK 3 500?** A számlázók középmezőnyében (Billingo Standard 3000 és Pro 4500 között), DE többet ad (adó-becslés, határidő-nudge, NAV-pull continuity-loop) amit egy tiszta számlázó nem. A pozíció védhető: "a számlázónál okosabb, a könyvelőnél (~20 000) sokkal olcsóbb". A 3 500 nem tűnik drágának ebben a mezőnyben.

## QQ (QuickQuote) — trade/szakipari árajánlat-készítő

**Magyar:**
- KöVeT (NewSoft): egyszeri vétel, nincs havidíj (építőmesteri/szakipari költségvetés).
- eKövet (NewSoft webapp): **freemium — limitált számú ajánlat ingyen** (ugyanaz a modell mint a QQ 5-ajánlat-ingyen).
- Colostok.hu: árajánlat + szerződés + teljesítésigazolás + ügyfélkezelés.
- A magyar tool-ok jellemzően EGYSZERI vétel vagy webapp; publikus havi SaaS-ár ritka.

**Nemzetközi (trade-quoting SaaS, referencia a tier-struktúrához):**
| Termék | Ár | Megjegyzés |
|---|---|---|
| Jobber | $19–149/hó | széles FSM, alsó tier 1 user |
| Tradify | Lite $47 / Pro $51 / Plus $61 **per user**/hó | trade-specifikus (villany/víz/HVAC) |

- $51/user ≈ ~15 800 Ft/user/hó. Egy 10-fős csapat ~510 USD/hó.

**Hol ül a QQ 4 900?** Jóval OLCSÓBB mint a nemzetközi per-user tool-ok (nem per-user, flat), és a magyar mezőnyben nincs sok direkt havi-SaaS versenytárs (többség egyszeri/webapp) → a QQ SaaS + AI-capture differenciált. A 4 900 flat agresszív belépő. A freemium (5 ajánlat) modellt az eKövet validálja.

## Melyik funkcióért lehet ALAPÁR FÖLÖTT kérni (premium tier / upsell) — versenytárs-minták alapján

Közös (mindkét termékre):
1. **Több felhasználó / csapat** — a klasszikus per-user upsell (Tradify/Jobber így skáláz). Single-user alap → team-tier.
2. **Magasabb kvóta** — több számla/ajánlat/nyugta/hó a base limit fölött.
3. **Integráció / API / export** — könyvelői export, webshop-integráció, Zapier/API.
4. **Márkázott / haladó output** — egyedi branding, haladó PDF-sablon.
5. **Automatizáció** — follow-up, emlékeztető, ismétlődő tételek, auto-nudge.
6. **Haladó riport / analitika**.

MK-specifikus premium-jelöltek:
- Könyvelői multi-client export / könyvelő-facing nézet (a könyvelő-portál már létezik → tier-esíthető).
- Haladó adó-optimalizáció / szimuláció (pl. KATA v2 2027 szimulátor mint Pro-feature).
- Magasabb OCR-nyugta-kvóta (az OCR-feature már kvóta-gate-elt a termékben — ez a természetes volumen-upsell, DE NEM külön ár-tier a landingen, hanem a Pro/magasabb csomag tartalma, ha lesz).

QQ-specifikus premium-jelöltek:
- Szakma-specifikus ár-sablon csomagok (több szakma / egyedi sablonok).
- Ajánlat-követés + analitika (megnyitva/elfogadva/lejárt, konverzió).
- Márkázott PDF (logó/cégadat/szín) — a "profi megjelenés", amiért a szaki fizet.
- Csapat / több felhasználó.

**Javaslat:** az alap maradjon egyszerű (MK 3 500 single-tier, QQ 4 900) a belépési súrlódás minimalizálására; a fenti premium-funkciók egy KÉSŐBBI Pro-tier magját adhatják, amikor van elég használati adat (a versenytársak mind a multi-user + kvóta + integráció + branding vonalon tieresítenek). A per-user (csapat) a legrobusztusabb upsell-tengely, mert a nemzetközi trade-SaaS teljes egészében arra épül.

## Források
- Billingo árak: billingo.hu/arak
- Billingo vs Számlázz.hu 2026: berkalkulator.com, wise.com/hu
- Kulcs-Soft: ks.hu, kulcs-soft.hu
- Magyar árajánlat-tool-ok: newsoft.hu (KöVeT/eKövet), colostok.hu
- Jobber/Tradify 2026: itqlick.com, capterra.com, selecthub.com
