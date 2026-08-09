# Design briefek — Istvan vizuál-készítéshez (2026-07-04)

A színek a LIVE landingekből, hogy a vizuál illeszkedjen a meglévő arculathoz. Deliverable formátum mindenhol: SVG (ha megy) VAGY PNG transzparens háttérrel, min. 1024px; logónál kérek egy négyzetes (app-ikon) + egy vízszintes (wordmark) változatot.

## A) Termék-logók / brand-mark (5 termék)

### 1. MikroKönyv
- Mi: NAV-kcompatibilis számlázás/könyvelés mikrovállalkozásoknak. Egyszerű, megbízható, magyar.
- Szín: accent **#1a9e8f** (teal-zöld), hover #148070. Semleges alap (fehér/sötétszürke szöveg).
- Irány: letisztult, bizalmi, "fintech-lite". Szimbólum-ötlet: stilizált könyv/pipa/számla-ív a teal-ből; NE aranyos, NE gyerekes.
- Kerülendő: túl sok részlet, gradiens-orgia, klipart-ikon.

### 2. QuickQuote
- Mi: gyors szakipari árajánlat (fotó/hang → becslés). Energikus, gyors, terepen használható.
- Szín: accent **#e85c2e** (narancs), sötét #c94c22, tint #fdf1ed.
- Irány: lendületes, "action". Szimbólum-ötlet: villám / gyors-pipa / árcímke a narancsból. Vastag, magabiztos wordmark.
- Kerülendő: túl elegáns/vékony vonalak (ez egy dolgos, terepi termék).

### 3. Bölcsi / Zsibongó
- Mi: bölcsőde-menedzsment (jelenlét, KENYSZI, MÁK, szülői kommunikáció) a fenntartónak/dolgozóknak. Meleg, gondoskodó, DE profi (nem infantilis).
- Szín: lágy pasztell paletta (mentazöld #e7f3ef, krém #fff5e3). Primer accent: javaslom egy meleg mentazöld/borostyán párost (pontos hexet Muse tokens.css-ből megerősítem).
- Irány: barátságos, lekerekített, de rendezett. Szimbólum-ötlet: stilizált csörgő/nap/kéz-a-kézben, letisztultan. "Zsibongó" = nyüzsgés, de vizuálisan nyugodt.
- Kerülendő: rikító primer színek, sok rajzfilm-elem.

### 4. Esküvő / LumaSeat
- Mi: AI ültetésrendező + vendor-CRM esküvőkhöz (pár + szolgáltató). Elegáns, romantikus, prémium.
- Szín: blush/rózsa paletta (#fdf6f2, #fce4e8). Finom arany vagy mélyebb rózsa accentnek.
- Irány: prémium, letisztult-elegáns, editorial. Szimbólum-ötlet: stilizált kerek asztal + székek felülnézetből (a seating-lényeg), vagy fény-motívum (Luma). Vékony, kifinomult tipográfia illik.
- Kerülendő: közhelyes szív/gyűrű klipart, túl "olcsó esküvős".

### 5. DORA
- Mi: DORA/NIS2 megfelelőségi evidence-OS auditoroknak/tanácsadóknak, magyar OSCAL-exporttal. Professzionális, regtech, enterprise.
- Szín: accent **#06b6d4** (cyan). Sötét navy/szürke alap.
- Irány: komoly, technikai, bizalmi (auditor-piac). Szimbólum-ötlet: pajzs/pipa/dokumentum-réteg a cyanből, geometrikus. Erős, stabil wordmark.
- Kerülendő: playful elemek, meleg színek (ez B2B compliance).

## B) GTM / social vizuál (a leggyorsabban hasznos)

### 6. MikroKönyv launch — FB poszt + changelog OG-kép (SÜRGŐS, publikálásra vár)
- Cél: a most kiküldésre váró MK changelog + FB poszt vizuálja.
- Formátumok: (a) FB/social poszt-kép 1200x630, (b) OG-kép ugyanaz a méret a landinghez.
- Tartalom: MikroKönyv logó + rövid value-headline ("NAV-számla percek alatt" jellegű, a végleges copy Heraldnál van), teal #1a9e8f arculat, tiszta háttér.
- Irány: 1 fő üzenet, nagy olvasható szöveg, sok whitespace. Mobilon is olvasható legyen.

### 7. Újrahasznosítható social-template (mind az 5 termékre)
- Cél: egy sablon (1200x630), amibe termékenként cserélhető a logó + accent-szín + headline, hogy minden launchhoz gyorsan legyen megosztható kép.
- Deliverable: 1 sablon + az 5 accent-szín variáció, vagy egy szerkeszthető alap.

---
Prioritás, ha időd véges: **6 (MK launch-kép, mert publikálásra vár) → 5 termék-logó (1-5) → 7 (sablon)**. Ahogy visszaküldöd, bekötöm a landingekbe/GTM-be és Muse-nak adom a finomítást.
