# CostOps v1.0.1 — Simplify+Trust UX/IA Plan

**Card:** 9bf1b085
**Date:** 2026-07-13
**Author:** Muse (uxuidesigner)
**Status:** FINAL — Marveen context received and incorporated (msg #13764)
**Screenshots:** `audits/costops-screenshots/` (22 captures, 3 viewports)

---

## §1 — Screenshot Inventory

All screenshots taken 2026-07-13 against live `http://localhost:3420/#costs-v2` (branch `local/costops-live-dashboard`).

| # | File | Viewport | What it shows |
|---|------|----------|---------------|
| 1 | `desktop-01-full-homepage.png` | 1440×900 | Full scroll of #costs-v2 |
| 2a | `desktop-02a-past-mom-card.png` | 1440×900 | "Változás előző hónaphoz" card (+90 226,8 HUF, 1/9 provider tracked) |
| 2b | `desktop-02b-past-changes-detail.png` | 1440×900 | Movers list: anthropic +49k, other +27k, openai +8990, render +4014, deepseek +1198 |
| 2c | `desktop-02c-past-reconciliation.png` | 1440×900 | Reconciliation note + June baseline caveat |
| 3a | `desktop-03a-mtd-card.png` | 1440×900 | "Aktuális havi költés" card (99 216,8 HUF) |
| 3b | `desktop-03b-mtd-drill-accordion.png` | 1440×900 | AI/LLM category expanded → anthropic → 3 sources (Claude Max 40 359, Claude API 17 655, Claude Pro —) |
| 4a | `desktop-04a-forecast-card.png` | 1440×900 | "Várható hó végi költés" card (100 946,55 HUF, fix/kézi alapon) |
| 4b | `desktop-04b-budget-card.png` | 1440×900 | "Budget státusz" card (49.6% used, forecast 50.5%) |
| 5 | `desktop-05-cost-table.png` | 1440×900 | "Egységes tételtábla" (17 rows, 8 columns: Provider/Tétel/Kategória/MTD/Forecast/Alap/Forrás/Eredeti deviza) |
| 6 | `desktop-06-entitlements.png` | 1440×900 | "Csomagok és keretek" table (7 rows: Claude Pro/Max, ChatGPT Plus, Heti limit×2, deepseek egyenleg, Workspace fizetés) |
| 7 | `desktop-07-token-model-detail.png` | 1440×900 | deepseek source row: API 3,33 USD · becsült árf. 1198,8 HUF |
| 8 | `desktop-08-manual-entry.png` | 1440×900 | "Kézi rögzítés" form: cost entry + entitlement entry fields |
| L1 | `laptop-01-full-homepage.png` | 1024×768 | Full page at laptop |
| L2 | `laptop-02-cards-row.png` | 1024×768 | Card row at 1024px — cards wrap or shrink |
| L3 | `laptop-03-entitlements.png` | 1024×768 | Entitlement table at laptop |
| L4 | `laptop-04-trend.png` | 1024×768 | 6-month trend chart at laptop |
| M9a | `mobile-09a-home-top.png` | 390×844 | Top of mobile view (month selector + cards) |
| M9b | `mobile-09b-home-cards.png` | 390×844 | Cards scrolled into view |
| M9c | `mobile-09c-home-full.png` | 390×844 | Full page scroll |
| M10a | `mobile-10a-line-item-expanded.png` | 390×844 | AI/LLM category + anthropic provider expanded on mobile |
| M10b | `mobile-10b-entitlements.png` | 390×844 | Entitlement table on mobile |

---

## §2 — Current UX Problems (AS-IS Diagnosis)

### §2.1 Information Hierarchy Issues

**P1 — Four undifferentiated cards.** The top row has 4 equal-weight cards (MTD / Forecast / Budget / MoM Change). None stands out as "the number you need right now." The MTD card (99 216,8 HUF) should be the anchor — it's what you've actually spent this month — but it shares visual weight with forecast and budget.

**P2 — No single "Past" card.** The design spec calls for "Prior closed month" as the first card. Instead, the current view has "Változás előző hónaphoz" (change from prior month) as the 4th card. The actual prior-month figure (8990 HUF for June) is buried in the reconciliation note and the trend chart. Users can't see at a glance what last month cost.

**P3 — Month-over-month change is misleading.** The +90 226,8 HUF (+1005%) change is technically correct but practically meaningless: June had only 1/9 providers tracked (only openai at 8990 HUF), and July has 10 providers. The reconciliation note explains this, but it's easy to miss. The big red "+90k" triggers alarm before the user reads the fine print.

**P4 — "Mi változott?" movers list conflates new providers with real growth.** Five movers are shown, but 4 of 5 are labeled "(új)" — they're new tracking, not actual spending increases. Only anthropic "(nőtt)" represents real growth. The visual treatment (all amber dots) doesn't distinguish "newly tracked" from "actually increased."

### §2.2 Data Quality & Trust Issues

**P5 — Manual/estimate dominance is not immediately visible.** The `.cv2-qual` bar says "10 providerből 1 Számla · 2 API · 6 Kézi fallback · 1 Jogosultság kell." This means 60% of providers are manual estimates and only 10% have real invoices. The current display is a single line of text — users scrolling past the cards may miss it entirely.

**P6 — "Kézi fallback" chip proliferation.** The amber "Kézi fallback" chip appears 15+ times in the accordion tree. When everything is amber, nothing is amber — the severity signal is lost. The chip doesn't distinguish between "manual entry because no API exists" (acceptable) vs "manual entry because API failed" (actionable).

**P7 — DeepSeek balance warning is buried.** The 105% blocked balance appears as one row in the 7-row entitlement table, with no visual urgency. A blocked payment method on an active provider should surface higher.

**P8 — "Nincs adat" (no data) is mixed with zeros.** Claude Pro shows "—" (no data) in the cost table, but other providers show "0 HUF." The distinction between "tracking but zero cost" and "not tracking at all" is critical for trust but visually subtle.

**P9 — fx_estimated flag is not surfaced.** DeepSeek API usage shows "3,33 USD · becsült árf." but there's no systematic indicator that this amount uses an estimated exchange rate rather than a confirmed one. The `fx_estimated` flag from the API isn't rendered.

### §2.3 Navigation & Discoverability

**P10 — Accordion-overload.** The category→provider→source tree has 7 categories, 10 providers, and 17 sources — all in nested `<details>` elements. Finding a specific line item requires expanding 3 levels. The "unified table" provides a flat alternative but is itself collapsed by default.

**P11 — Warning list dominates the viewport.** The "Teendők (12)" section with 5 visible + 7 collapsed warnings takes up significant vertical space between the cost tree and the entitlements. On mobile, warnings can push entitlements and trend entirely below the fold.

**P12 — No cross-referencing between cost and entitlement.** The cost table shows DeepSeek MTD of 1198,8 HUF. The entitlement table shows DeepSeek balance 105% blocked. These are related (blocked balance → can't spend more) but presented in separate sections with no visual link.

### §2.4 Missing Features

**P13 — No past-vs-current unified view.** The user must mentally compare: look at the MoM card (+90k), scroll to the trend chart (June bar = 8990), then scroll back to the category tree (July MTD). There's no side-by-side month comparison.

**P14 — No opportunity-cost display.** The spec requires "opportunity-cost display separate from spend." This doesn't exist in the current view at all. Marveen reports token opportunity cost is ~960k HUF MTD (Marveen ~481k, Fullstack ~479k) which DWARFS the 99k operational spend — making it critical to display separately and clearly labeled.

**P15 — Trend chart is data-poor.** Of 6 months, 4 show "nincs adat" (no data). Only June (8990) and July (99 216,8, partial) have data. The chart takes up significant space for what is essentially a 2-bar comparison.

**P16 — No data freshness timestamp.** The DeepSeek balance "105% blocked" is a STALE snapshot (pre-reload state; Istvan reloaded ~1.5h ago). No timestamp anywhere on the page to indicate when data was last synced. All data-quality judgments depend on knowing how fresh the data is.

---

## §3 — KEEP-SIMPLIFY-MERGE-MOVE-REMOVE Matrix

### KEEP (solid, unchanged)

| Element | Rationale |
|---------|-----------|
| `.cv2-cards` 4-card top row pattern | Works well as an at-a-glance summary; just needs reordering and a 5th "Past" card |
| Category→Provider→Source accordion tree | Good for detailed exploration; keep as secondary drill-down |
| Data-quality chips (Számla, API, Kézi, Nincs adat) | Strong pattern; needs color refinement but the concept is right |
| `.cv2-topbar` month selector | Clean, simple; keep as-is |
| Manual entry form | Functional, complete; just needs better section labeling |
| `.cv2-recon` reconciliation notes | Excellent trust-building pattern; keep and expand |
| Filter buttons (Mind/Teendő/Valós) | Good concept; reduce to 2 buttons for simplicity |
| Unified cost table | Excellent flat overview; make it the DEFAULT view instead of accordion |

### SIMPLIFY (keep but reduce)

| Element | Change | Rationale |
|---------|--------|-----------|
| Warnings section | Collapse to 3 most actionable; rest behind "Minden figyelmeztetés (12)" | 12 warnings = decision paralysis |
| Movers list | Show only real changes; separate "newly tracked" into a distinct "Újonnan követve" group | Conflating new vs growth is misleading |
| Filter row | Reduce from 3 buttons to 2: "Minden" / "Figyelmet igényel" | "Valós" alone doesn't help; merge with "Mind" as default |
| Month selector | Add ← → arrows for quick month navigation | Currently requires manual YYYY-MM input |
| Kézi fallback chip | Split into two variants: "Kézi (nincs API)" [gray] and "Kézi (API hiba)" [amber] | Not all manual entries are problems |

### MERGE (combine related elements)

| Elements | New unified element | Rationale |
|----------|-------------------|-----------|
| Past card + MoM change card + Trend chart | **Unified Past↔Current↔Forecast drill-down** (§6) | Single mental model for time comparison |
| Cost tree + Unified table | **Unified cost table as DEFAULT**, accordion as secondary | Table is flat and scannable; accordion is for exploration |
| Category accordion quality badges + `.cv2-qual` summary bar | **Data-quality scorecard** in top bar | Single source of truth for data health |
| DeepSeek cost row + DeepSeek entitlement row | **Linked provider card** showing both spend and balance | Related data shouldn't require scrolling between sections |

### MOVE (reposition)

| Element | From | To | Rationale |
|---------|------|----|-----------|
| Budget card | 3rd card | 4th card (after Past/MTD/Forecast) | Budget is context, not the primary number |
| Entitlement table | Below warnings | Beside or right after cost table, before warnings | Entitlements affect spend; show them together |
| Trend chart | Below entitlements | Integrated into Past↔Current↔Forecast drill-down | Trend IS the time comparison |
| Manual entry | Bottom of page | Collapsed section in top bar or separate tab | Only needed occasionally; shouldn't push content down |
| "Mi változott?" movers | Below cards | Collapsible section in Past↔Current↔Forecast drill-down | Contextual, not always-on |

### REMOVE (eliminate)

| Element | Rationale |
|---------|-----------|
| "Klasszikus nézet (v1)" toggle link | v1 is deprecated; remove the escape hatch to force v2 adoption |
| 4 "nincs adat" months from trend chart | Replace with "Adatgyűjtés folyamatban — első trend 2026-08-tól" message; don't show empty bars |
| Duplicated warnings (e.g., anthropic 545% shown twice) | De-duplicate: one warning per issue, with severity level |
| 0 HUF rows in cost table where provider has no activity | Show only active providers by default; "Minden (17)" toggle for full list |

---

## §4 — Proposed Information Architecture

```
┌──────────────────────────────────────────────────────┐
│ TOP BAR: Hónap ← 2026-07 →  [🔔 3 figyelmeztetés] [⚙]│
│ Data quality: 10% számla · 20% API · 60% kézi · 10% nincs
└──────────────────────────────────────────────────────┘

ROW 1 — 5 CARDS (equal weight, responsive grid)
┌─────────┬──────────┬──────────┬──────────┬──────────┐
│ Előző   │ Aktuális │ Várható  │ Budget   │ Adat-    │
│ lezárt  │ havi     │ hó végi  │ státusz  │ minőség  │
│ hónap   │ költés   │ költés   │          │          │
│ (jún)   │ (júl)    │ (júl)    │          │          │
│ 8990    │ 99 216,8 │ 100 946  │ 49.6%    │ 30%      │
│ HUF     │ HUF      │ HUF      │ (50.5%)  │ valós    │
└─────────┴──────────┴──────────┴──────────┴──────────┘

ROW 2 — KEY CHANGES (max 5, grouped)
┌──────────────────────────────────────────────────────┐
│ ▲ Nőtt: anthropic +49 024 HUF (Claude Max usage)     │
│ 🆕 Új követés: other +27k · openai +8990 · render    │
│    +4014 · deepseek +1198 (ezek nem valós növekedés) │
└──────────────────────────────────────────────────────┘

ROW 3 — UNIFIED COST TABLE (DEFAULT VIEW, not collapsed)
┌──────────────────────────────────────────────────────┐
│ Provider  │ Előző hó │ MTD     │ Forecast │ Forrás  │ Státusz │
│ anthropic │ 0        │ 58 014  │ 58 014   │ Kézi ⚠ │ ⚠ nőtt  │
│ openai    │ 8990     │ 8 990   │ 8 990    │ Kézi ⚠ │ ⚠ API hiba│
│ deepseek  │ 0        │ 1 199   │ 2 929*   │ API ✓   │ ✓ rendben│
│ other     │ 0        │ 27 000  │ 27 000   │ Kézi ⚠ │ 🆕      │
│ render    │ 0        │ 4 014   │ 4 014    │ Számla ✓│ ✓ rendben│
│ ...       │          │         │          │         │         │
│ ÖSSZESEN  │ 8 990   │ 99 217  │ 100 947  │ 30% valós│        │
└──────────────────────────────────────────────────────┘
* run-rate alapú; a többi kézi forecast

[▸ Részletes nézet (kategóriákra bontva)]  ← accordion fallback

ROW 4 — CSOMAGOK ÉS KERETEK (separate from operational spend)
┌──────────────────────────────────────────────────────┐
│ Csomag        │ Provider  │ Keret    │ Felhaszn.│ Státusz │
│ Claude Max    │ anthropic │ —        │ 5%       │ ✓ aktív │
│ Claude Pro    │ anthropic │ —        │ 16%      │ ✓ aktív │
│ Heti limit (C)│ anthropic │ —        │ 19%      │ ✓ ok    │
│ Heti limit (P)│ anthropic │ —        │ 2%       │ ✓ ok    │
│ ChatGPT Plus  │ openai    │ —        │ —        │ nincs adat│
│ Egyenleg      │ deepseek  │ 3,17 USD │ 105% 🔴  │ ⛔ tiltva│
│ Fizetés       │ google    │ —        │ —        │ ⚠ 21 nap│
└──────────────────────────────────────────────────────┘

ROW 5 — TREND (3-6 month, integrated with Past↔Current↔Forecast)
┌──────────────────────────────────────────────────────┐
│ Havi operatív költés — utolsó 6 hónap                 │
│ [jún: ████ 8990] [júl: █████████████ 99 217 ●]      │
│ ● = részleges (MTD)                                   │
│ febr-máj: nincs adat — első trend 2026 augusztustól   │
└──────────────────────────────────────────────────────┘

COLLAPSED BELOW (secondary):
┌──────────────────────────────────────────────────────┐
│ ▸ Minden figyelmeztetés (7)                           │
│ ▸ Opportunity cost (becsült)                          │
│ ▸ Diagnosztika / import runs / raw statuses           │
│ ▸ Kézi rögzítés (költség / keret)                     │
└──────────────────────────────────────────────────────┘

FILTERS (max 3):
  [Hónap: 2026-07 ▾]  [Provider: Mind ▾]  [Adatminőség: Mind ▾]
```

---

## §5 — Desktop & Mobile Wireframes

### Desktop (1440×900)

```
╔══════════════════════════════════════════════════════════════╗
║ Hónap: ◀ 2026-07 ▶   │ Adatminőség: 30% valós ⚠ │ [⛭]  🔔3 ║
╠══════════════════════════════════════════════════════════════╣
║ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌──────┐ ║
║ │ Előző hó │ │ Aktuális │ │ Várható  │ │ Budget │ │Adat- │ ║
║ │ (június) │ │ (júl MTD)│ │ hó vége  │ │        │ │minős.│ ║
║ │          │ │          │ │          │ │49.6% ██│ │      │ ║
║ │  8 990   │ │ 99 217   │ │ 100 947  │ │ elhaszn│ │30% ✓ │ ║
║ │  HUF     │ │  HUF     │ │  HUF     │ │előre:  │ │      │ ║
║ │ 1/9 prov│ │MTD▮      │ │fix/kézi  │ │50.5%   │ │3/10  │ ║
║ └──────────┘ └──────────┘ └──────────┘ └────────┘ └──────┘ ║
╠══════════════════════════════════════════════════════════════╣
║ ▲ Nőtt: anthropic +49 024 HUF                              ║
║ 🆕 Újonnan követve (4): other +27k · openai +8 990 · ...   ║
║ ℹ Június részleges (1/9 provider); a változások nagy része  ║
║   új követés, nem valós költségnövekedés.                   ║
╠══════════════════════════════════════════════════════════════╣
║ EGYSÉGES KÖLTSÉG TÁBLA              [▸ Kategóriákra bontva] ║
║ Provider  │Előző hó│  MTD   │Forecast│ Forrás   │Státusz   ║
║ ─────────────────────────────────────────────────────────── ║
║ anthropic │   0     │58 014  │58 014  │ Kézi ⚠  │⚠ +545%   ║
║ openai    │ 8 990   │ 8 990  │ 8 990  │ Kézi ⚠  │⚠ API hiba║
║ deepseek  │   0     │ 1 199  │ 2 929* │ API ✓   │✓ rendben  ║
║ other     │   0     │27 000  │27 000  │ Kézi ⚠  │🆕        ║
║ render    │   0     │ 4 014  │ 4 014  │ Számla ✓│✓ rendben  ║
║ ...       │         │        │        │          │          ║
║ ─────────────────────────────────────────────────────────── ║
║ ÖSSZESEN  │ 8 990   │99 217  │100 947 │ 30% ✓   │          ║
║ * run-rate becslés 3,33 USD → 2 929 HUF forecast            ║
╠══════════════════════════════════════════════════════════════╣
║ CSOMAGOK ÉS KERETEK (nem operatív költés)                   ║
║ Csomag          │Provider │Keret     │Haszn.│Státusz        ║
║ Claude Max      │anthropic│    —     │  5%  │✓ aktív        ║
║ DeepSeek egyenleg│deepseek│3,17 USD  │105%🔴│⛔ tiltva      ║
║ Google fizetés  │google   │    —     │  —   │⚠ 21 nap      ║
║ ...                                                   [▸]  ║
╠══════════════════════════════════════════════════════════════╣
║ ████████ TREND (6 hónap) ██████████████████████████████████ ║
║ [n/a][n/a][n/a][n/a][jún: █ 8990][júl: █████████ 99 217●] ║
╠══════════════════════════════════════════════════════════════╣
║ ▸ Minden figyelmeztetés (7)                                 ║
║ ▸ Opportunity cost (becsült: ~3 712 HUF kihasználatlan)     ║
║ ▸ Diagnosztika · Import runs · Raw statuses                 ║
║ ▸ Kézi rögzítés (költség / keret)                           ║
╚══════════════════════════════════════════════════════════════╝
```

### Mobile (390×844)

```
╔══════════════════════╗
║◀ 2026-07 ▶   Adat:⚠ ║
╠══════════════════════╣
║ ┌──────────────────┐ ║
║ │ Aktuális havi    │ ║
║ │ 99 217 HUF       │ ║  ← largest card, primary
║ │ MTD · júl 1-13   │ ║
║ └──────────────────┘ ║
║ ┌──────┐ ┌─────────┐ ║
║ │Előző │ │Várható  │ ║  ← 2-col grid
║ │8990  │ │100 947  │ ║
║ │HUF   │ │HUF      │ ║
║ └──────┘ └─────────┘ ║
║ ┌──────┐ ┌─────────┐ ║
║ │Budget│ │Adatmin. │ ║
║ │49.6% │ │30% ✓    │ ║
║ └──────┘ └─────────┘ ║
╠══════════════════════╣
║ ▲ anthropic +49 024  ║
║ 🆕 4 új követés      ║
╠══════════════════════╣
║ KÖLTSÉG TÁBLA        ║
║ ┌──────────────────┐ ║
║ │anthropic  58 014 ⚠│ ║
║ │openai      8 990 ⚠│ ║
║ │deepseek    1 199 ✓│ ║
║ │other      27 000 ⚠│ ║
║ │render      4 014 ✓│ ║
║ │ ...               │ ║
║ │ÖSSZESEN   99 217  │ ║
║ └──────────────────┘ ║
║ [▸ Kategóriánként]   ║
╠══════════════════════╣
║ CSOMAGOK             ║
║ deepseek ⛔ 105%     ║  ← critical: top of list on mobile
║ google    ⚠ 21 nap  ║
║ Claude Max  ✓ 5%    ║
║ ...                  ║
║                [▸]   ║
╠══════════════════════╣
║ [TREND: jún ██ 8990  ║
║  júl ████████ 99 217]║
╠══════════════════════╣
║ ▸ Figyelmeztetések   ║
║ ▸ Kézi rögzítés      ║
╚══════════════════════╝
```

---

## §6 — Unified Past↔Current↔Forecast Drill-Down

### Concept

Instead of separate cards that the user must mentally assemble, create a single "idővonal" (timeline) drill-down that shows Past → Current → Forecast as connected states:

```
┌─────────────────────────────────────────────────────────────┐
│ ◀─────────────── IDŐVONAL ──────────────────────────────▶  │
│                                                             │
│  ●──────────────●───────────────────●───────────────────●   │
│  Június         Július 1-13        Július 14-31         Aug│
│  (lezárt)       (MTD, részleges)    (előrejelzett)          │
│                                                             │
│  ┌──────────┐   ┌──────────────┐    ┌──────────────┐       │
│  │ 8 990   │──▶│ 99 217 HUF   │───▶│ 100 947 HUF  │       │
│  │ HUF     │   │ eddig ebben  │    │ várható hó   │       │
│  │ 1/9     │   │ a hónapban   │    │ végi költés  │       │
│  │ provider│   │              │    │ fix/kézi     │       │
│  │ követve │   │              │    │ alapon       │       │
│  └──────────┘   └──────────────┘    └──────────────┘       │
│                                                             │
│  [▸ Részletes összehasonlítás: június ↔ július tételenként] │
└─────────────────────────────────────────────────────────────┘
```

### Interaction

1. **Default state:** Shows 3 nodes (Past / Current / Forecast) with summary numbers
2. **Click "Részletes összehasonlítás":** Expands to a side-by-side table:
   | Provider | Június | Július MTD | Július Forecast | Változás |
   |----------|--------|------------|-----------------|----------|
   | openai   | 8 990  | 8 990      | 8 990           | 0%       |
   | anthropic| 0      | 58 014     | 58 014          | új       |
   | ...      |        |            |                 |          |
3. **Click a provider row:** Drills to source-level detail
4. **Mobile:** Timeline becomes vertical with horizontal scroll

### Click Count Delta

| Journey | Current clicks | Proposed clicks | Delta |
|---------|---------------|-----------------|-------|
| Compare June vs July | Scroll to MoM card + scroll to trend + scroll to accordion + expand ×3 (~6 actions) | Click "Összehasonlítás" (1 action) | **-5** |
| See what changed | Scroll to movers section (1 action) | Visible in Row 2 already (0 actions) | **-1** |
| Understand forecast basis | Scan accordion for forecast column (no click) | Visible in unified table (no click) | **0** |

---

## §7 — Cost-vs-Entitlement Separation

### Current Problem

The entitlement table ("Csomagok és keretek") appears below warnings — visually disconnected from the cost data. The only link is the provider name.

### Proposed Design

**Visual separator**: A clear section boundary with distinct background treatment:

```
╔══════════════════════════════════════════════════════╗
║            OPERATÍV KÖLTÉS                          ║
║  (használat alapú: API hívások, előfizetések,       ║
║   hosting, domainek)                                ║
║  [unified cost table]                               ║
╚══════════════════════════════════════════════════════╝

╔══════════════════════════════════════════════════════╗
║          CSOMAGOK ÉS KERETEK                        ║
║  (nem használat alapú: előre fizetett egyenlegek,   ║
║   limitek, workspace fizetési állapot)               ║
║  [entitlement table]                                ║
╚══════════════════════════════════════════════════════╝
```

**Cross-reference badges** on providers that appear in both:
- DeepSeek cost row: `[📦 egyenleg: 105% ⛔]` badge linking to entitlement
- DeepSeek entitlement row: `[💶 MTD: 1 199 HUF]` badge linking to cost

**Sort entitlements by severity**, not alphabetically:
1. ⛔ Blocked/Tiltva (deepseek 105%)
2. ⚠ Warning (google 21 nap)
3. ⬜ No data (ChatGPT Plus)
4. ✓ OK (Claude Max, Claude Pro, limits)

---

## §8 — Human-Readable Data-Quality Display

### Current Problem

The `.cv2-qual` bar is a single line of text: "10 providerből 1 Számla · 2 API · 6 Kézi fallback · 1 Jogosultság kell." This requires reading and mental arithmetic.

### Proposed Design: Data-Quality Scorecard

Replace the text bar with a compact visual scorecard in the top bar, and a dedicated 5th card in the top row:

**Top bar (compact) — AMOUNT-WEIGHTED:**
```
Adatminőség: ●○○○○ ~5% valós (5 213/99 217 HUF)  ·  Frissítve: 2026-07-13 02:15 CEST
```

**5th card (detailed) — AMOUNT-WEIGHTED, not count-based:**
```
┌──────────────────────┐
│ Adatminőség          │
│ (összeg szerint)     │
│                      │
│ ██ Számla      4%    │
│ ██ API         1.2%  │
│ ██████████ Kézi 50%  │
│ █████████ Becsült45% │
│                      │
│ ~5% valós adat       │
│ (99 217-ből 5 213   │
│  valós forrásból)    │
└──────────────────────┘
```

**CRITICAL: Use amount-weighted, not count-based.**
Count: 1 Számla + 2 API = 3/10 = "30% valós" ← FÉLREVEZETŐ
Amount: 4014 (invoice) + 1199 (API) = 5213/99217 = "~5% valós" ← HELYES
The headline 99 217 HUF is ~95% manual+estimate. The quality display must reflect this.

**Quality levels (simplified from current chips):**

| Chip | Color | Meaning | Example |
|------|-------|---------|---------|
| `Számla` | Green `#2ecc71` | Real invoice data | Render hosting |
| `API` | Green `#2ecc71` | Live API pull | DeepSeek API, GitHub |
| `Kézi — nincs API` | Gray `#94a3b8` | No automated source exists; manual is expected | Other SaaS, Domain |
| `Kézi — API hiba` | Amber `#e0a800` | Automated source exists but failed; needs attention | Claude Max, ChatGPT |
| `Nincs adat` | Gray `#9aa0a6` | Provider tracked but no data available | Claude Pro |
| `Jogosultság kell` | Orange `#e0854a` | Permission needed to access billing API | AWS Bedrock |

**fx_estimated indicator** (new):
- Small `~` prefix on amounts with estimated exchange rate: `~1 199 HUF` instead of `1 199 HUF`
- Tooltip: "Becsült árfolyam: 1 USD = 360,0 HUF (Render API, 2026-07-13)"

---

## §9 — Opportunity-Cost Display (Separate from Spend)

### What is "opportunity cost" in CostOps?

Two distinct categories, MUST be kept separate:

**A. Entitlement opportunity cost** (small, ~3 700 HUF/hó):
- Unused entitlements: Claude Pro 84% unused capacity
- Blocked providers: DeepSeek (when actually blocked, not stale)
- Zero-tracked providers: google, vercel, cloudflare, github

**B. Token opportunity cost** (LARGE, ~960k HUF MTD):
- Marveen: ~481 000 HUF MTD (nem számlázott token-ekvivalens)
- Fullstackfejleszto: ~479 000 HUF MTD
- Other agents: varies
- Source: `/api/costs/limits`, `not_billed`, `token_runrate`
- THIS IS NOT REAL MONEY. These are tokens consumed under flat-rate subscriptions (Claude Max, Claude Pro) that would cost this much if billed per-token.

### CRITICAL DESIGN RULE

**Token opportunity cost SOHA nem kerülhet a valós pénz-kártyák közelébe.** Ha a 99k operational spend mellett megjelenik egy "1.1M forecast" szám, a felhasználó azt hiszi 1.1M a havi költség. VALÓSÁG: 99k a költés, a token opportunity cost egy "mi lenne ha" szám, ami az előfizetésben már benne van.

### Proposed Display

```
▸ Token felhasználás (előfizetésben foglalt, nem számlázott)

  Expanded:
  ┌─────────────────────────────────────────────────────────┐
  │ NEM SZÁMLÁZOTT — előfizetésben foglalt token-ekvivalens │
  │                                                         │
  │ Ágens           │ Token ktg (ha per-token) │ Státusz     │
  │ ────────────────┼─────────────────────────┼─────────────│
  │ Marveen         │ ~481 000 HUF            │ Claude Max  │
  │ Fullstack       │ ~479 000 HUF            │ Claude Max  │
  │ UX/UI Designer  │ ~? HUF                  │ Claude Max  │
  │ ...             │                         │             │
  │ ────────────────┼─────────────────────────┼─────────────│
  │ Összesen        │ ~960 000+ HUF           │             │
  └─────────────────────────────────────────┘
  ℹ Ezek az összegek NEM valós kiadások. Azt mutatják, mennyibe
    kerülne a token-felhasználás ha per-token számláznák.
    A valós költség az előfizetési díj (Claude Max ~40 359 HUF/hó
    kézi becslés szerint), ami az operatív költség táblában van.
```

**Design rules:**
1. ALWAYS collapsed by default
2. ALWAYS labeled "NEM SZÁMLÁZOTT" / "előfizetésben foglalt"
3. NEVER on the same visual plane as the operational cost cards
4. Use a distinctly different background treatment (e.g., dotted border, muted background)
5. Per-agent breakdown with agent names from the token monitor

---

## §10 — User Journeys with Click-Count Deltas

### J1: "Mennyit költöttem ebben a hónapban?"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Open #costs-v2 | Open #costs-v2 |
| 2 | Read MTD card (99 217 HUF) | Read MTD card (99 217 HUF) — **promoted to largest card** |
| **Clicks** | **0** | **0** |

### J2: "Mennyit költöttem múlt hónapban?"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Open #costs-v2 | Open #costs-v2 |
| 2 | Read 4th card (MoM change = +90k) | Read 1st card "Előző lezárt hónap" (8990 HUF) |
| 3 | Must calculate: 99 217 − 90 227 = 8990 | **Done** |
| **Clicks** | **0 (mental math required)** | **0** |

### J3: "Hasonlítsd össze a júniust és júliust tételesen"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Scroll to trend chart | Click "Összehasonlítás" gomb |
| 2 | Note June = 8990 | Full side-by-side table visible |
| 3 | Scroll to category accordion | |
| 4 | Expand AI/LLM | |
| 5 | Expand anthropic | |
| 6 | Expand Claude Max | |
| 7 | Remember June had only openai | |
| 8 | Scroll to unified table (collapsed) | |
| 9 | Expand unified table | |
| **Clicks** | **4+ (scroll + expand)** | **1** |
| **Delta** | | **−3** |

### J4: "Miért 99 217 a havi költés és nem 100 947?"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Read MTD card | Read MTD card |
| 2 | Read forecast card | Read forecast card |
| 3 | Note forecast basis: "fix/kézi alapon" | Note forecast basis in table column |
| 4 | Scan accordion for differences | Scan table for MTD≠Forecast rows |
| 5 | Find deepseek: 1198 vs 2929 | deepseek row highlighted (run-rate differs) |
| **Clicks** | **0** | **0** (but table makes it scannable) |

### J5: "Melyik providernél van API hibás Kézi fallback?"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Scan accordion for amber chips | Filter: "Figyelmet igényel" |
| 2 | Must expand each category to see chips | Only attention-needing rows shown |
| 3 | Distinguish "nincs API" vs "API hiba" manually | Chips are color-coded: gray = no API, amber = API error |
| **Clicks** | **5-10 (expand all categories)** | **1 (filter)** |
| **Delta** | | **−4 to −9** |

### J6: "Mi a helyzet a DeepSeek egyenleggel?"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Scroll past cost accordion | DeepSeek entitlement row is sorted to TOP (blocked first) |
| 2 | Scroll past warnings | |
| 3 | Find "Csomagok és keretek" | |
| 4 | Scan 7 rows for "deepseek" | |
| **Clicks** | **0 (but scroll required)** | **0 (visible immediately in sorted entitlements)** |

### J7: "Adj hozzá egy kézi költség tételt"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Scroll to bottom of page | Click "+" in top bar |
| 2 | Expand "Kézi rögzítés" | Modal/drawer opens with form |
| 3 | Fill form | Fill form |
| 4 | Submit | Submit |
| **Clicks** | **2 + scroll** | **2** |

### J8: "Mennyire megbízhatóak ezek a számok?"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Find `.cv2-qual` text bar | Read "Adatminőség" card (5th card, always visible) |
| 2 | Read: "1 Számla · 2 API · 6 Kézi" | Visual bar: 30% green, 70% amber/gray |
| 3 | Mental calculation: 3/10 = 30% | "30% valós" shown directly |
| **Clicks** | **0** | **0** (but comprehension is instant vs requiring mental math) |

### J9: "Mi fog változni a hónap végéig?" (mobile)
| Step | Current (mobile) | Proposed (mobile) |
|------|-----------------|-------------------|
| 1 | Open #costs-v2 | Open #costs-v2 |
| 2 | Scroll past cards | Scroll to unified table |
| 3 | Touch to expand unified table | Table is default visible |
| 4 | Swipe horizontally to see forecast column | Swipe horizontally |
| **Clicks** | **1** | **0** |

### J10: "Van-e valami amivel azonnal foglalkoznom kell?"
| Step | Current | Proposed |
|------|---------|-----------|
| 1 | Scan page for red/amber | 🔔 badge in top bar shows count (3) |
| 2 | Find warnings section | Click 🔔 → jumps to prioritized warning list |
| 3 | Read 5 visible warnings | Only actionable items shown; informational collapsed |
| 4 | Expand "További 7" for rest | |
| **Clicks** | **1 (expand) + scroll** | **1 (click 🔔)** |

### Summary Click-Count Delta

| Journey | Current (clicks+scrolls) | Proposed | Delta |
|---------|--------------------------|----------|-------|
| J1: Current spend | 0 | 0 | 0 |
| J2: Past month | 0 (+ mental math) | 0 | **cognitive −1** |
| J3: Month comparison | ~6 | 1 | **−5** |
| J4: MTD vs Forecast gap | 0 | 0 | 0 |
| J5: Find API errors | ~8 | 1 | **−7** |
| J6: DeepSeek balance | 0 (+ long scroll) | 0 | **scroll eliminated** |
| J7: Add manual entry | 2 + scroll | 2 | scroll eliminated |
| J8: Data reliability | 0 (+ mental math) | 0 | **cognitive −1** |
| J9: Mobile forecast | 1 + scroll | 0 | **−1** |
| J10: Action items | 1 | 1 | 0 |

---

## §11 — Implementation Delta

### What Changes

| File | Change | Effort |
|------|--------|--------|
| `web/style.css` | Restyle `.cv2-cards` to 5-col grid; add past-card, quality-card styles; new unified table default-open; new top bar; new chip variants; mobile breakpoints | **Medium (~150 lines)** |
| `web/index.html` or JS | Reorder cards; add Past card (new API data point? or computed from trend); add quality scorecard; restructure sections per IA; add 🔔 notification badge; change filter set | **Medium (~100 lines JS)** |
| `web/script.js` (or wherever cv2 JS lives) | New sort/filter logic; new drill-down interaction; modal for manual entry; 🔔 jump-to-warnings; opportunity-cost computation | **Medium (~200 lines JS)** |
| Backend API (`/api/costs/...`) | May need new endpoint for past-month summary card; opportunity-cost calculation | **Small (if data already exists)** |

### What Does NOT Change

- **No DB schema changes** — all data is already available
- **No API gateway changes** — existing endpoints supply the data
- **No new dependencies** — pure CSS/JS
- **No auth changes** — same Bearer token
- **No `#costs` (v1) changes** — v1 is deprecated, not touched
- **No data ingestion changes** — same providers, same import pipeline

---

## §12 — Affected Files

| File | Type | Risk |
|------|------|------|
| `web/style.css` | CSS | Low — additive only, new selectors don't conflict with existing |
| `web/index.html` | HTML | Low — section reordering within `#costsV2Body` |
| `web/script.js` (or inline JS for costs-v2) | JS | Medium — filter/sort/drill-down logic changes |
| `store/` | Data | **No change** — read-only from existing SQLite |
| `server/costops-*.ts` (or equivalent backend) | Backend | Low — possible new aggregation endpoint |

---

## §13 — Acceptance Criteria

1. **AC1 — Past card:** "Előző lezárt hónap" card displays the prior month's total spend with provider coverage note (e.g., "1/9 provider követve")
2. **AC2 — 5-card top row:** Desktop shows 5 cards (Past / MTD / Forecast / Budget / Data Quality) in a single row; mobile stacks MTD as hero + 4 cards in 2×2 grid
3. **AC3 — Unified cost table is DEFAULT:** Table with Provider|Prior|MTD|Forecast|Source|Status is visible without clicking "expand"
4. **AC4 — Past↔Current↔Forecast drill-down:** Single click expands a side-by-side comparison table
5. **AC5 — Cost/entitlement clear separation:** Visual boundary (background color or border) between operational spend and packages/entitlements
6. **AC6 — Data quality scorecard:** 5th card or top-bar indicator shows "X% valós" with color-coded breakdown
7. **AC7 — Chip differentiation:** Kézi chips show "nincs API" (gray) vs "API hiba" (amber) as distinct states
8. **AC8 — Entitlement severity sort:** Blocked > Warning > No data > OK (not alphabetical)
9. **AC9 — Warning priority:** Only top 3 actionable warnings shown; rest collapsed; total count in 🔔 badge
10. **AC10 — Opportunity cost:** New collapsed section with estimated unused value
11. **AC11 — Mobile line-item:** Expandable rows work on 390px viewport with horizontal scroll for wide tables
12. **AC12 — Filter reduction:** Max 3 filters (Month / Provider / Quality) instead of current 9-dimension set
13. **AC13 — fx_estimated indicator:** `~` prefix on amounts with estimated exchange rate, with tooltip
14. **AC14 — No v1 toggle:** The "Klasszikus nézet (v1)" link is removed
15. **AC15 — Build green:** `npx vite build` succeeds with no CSS/JS warnings

---

## §14 — Rollback Plan

1. All changes are in a feature branch (`local/costops-live-dashboard` — already local-only per sprint guardrail)
2. CSS changes use new class names (`.cv2-card--past`, `.cv2-quality-scorecard`, etc.) — existing `.cv2-*` classes are untouched
3. JS changes are additive (new functions, not rewrites of existing)
4. **Rollback:** `git revert <commit>` restores previous state with zero data impact
5. **Partial rollback:** Each section is independent — can revert just the Past card while keeping the quality scorecard
6. **No DB migration** — rollback has no data consequences

---

## §15 — GO Prompt (DO NOT RUN — copyable for implementation)

```
IMPLEMENT CostOps v1.0.1 Simplify+Trust UX plan from audits/costops-v101-simplify-trust-plan.md.

BRANCH: local/costops-live-dashboard (NO push, NO PR — sprint guardrail ep b90eb930)

WHAT TO DO:
1. READ the plan document at audits/costops-v101-simplify-trust-plan.md
2. READ the current #costs-v2 implementation in web/index.html (look for #costsV2Body, .cv2-* classes)
3. READ the current CSS in web/style.css (look for .cv2-* rules)
4. IMPLEMENT the changes per §11 (Implementation Delta):
   a. CSS: 5-card grid, new card variants, chip variants, mobile breakpoints
   b. HTML: Reorder sections per §4 (Proposed IA), add Past card + Data Quality card
   c. JS: Filter/sort logic, drill-down interaction, modal manual entry, opportunity-cost section
5. BUILD: cd apps/web && npx vite build — must succeed with no warnings
6. VERIFY against §13 (Acceptance Criteria) — all 15 ACs
7. SCREENSHOT: Take before/after screenshots at 1440×900, 1024×768, 390×844
8. REPORT: What changed, what was deferred, any issues found

CONSTRAINTS:
- NO changes to store/ (SQLite)
- NO changes to API endpoints (read-only from existing data)
- NO new npm dependencies
- NO v1 (#costs) changes
- NO push, NO PR, NO deploy — local branch only

DESIGN REFERENCE: Screenshots in audits/costops-screenshots/ (22 captures)
PLAN REFERENCE: audits/costops-v101-simplify-trust-plan.md (this file)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Appendix A — Marveen Interpretation Context (msg #13764, 2026-07-13)

### A1 — Is the prior-month 8990 HUF figure representative?

**Marveen: NEM reprezentatív, INCOMPLETE.** June = egyetlen anthropic actual_invoice sor (8990 HUF), 1 line item. Hiányzik: render, openai, manual, minden más provider. July = 20 item, 5+ provider, 99 216 HUF. A +90 227 MoM delta ezért apples-to-oranges (1-provideres részleges hó vs teljes hó).

**Design mandate:** June-t JELÖLJE PARTIAL/hiányos-lefedettségként. NE mutasson ~10x MoM ugrást valós növekedésként. KEEP-honest + data-coverage-badge tétel.

### A2 — Does the MTD-99217-vs-forecast-100947 gap make sense?

**Marveen: VÁRT, DE UX-CSAPDA.** July 13-án (fél hó) egy forecast ami csak 1.7%-kal az MTD felett van, úgy néz ki mintha "a hó majdnem kész." Ok: 94 004 / 99 216 (95%) MANUAL bejegyzés = fix hó-végi összegek, NEM napi run-rate → ezekre forecast≈MTD (nincs mit extrapolálni). Csak a kis provider-derived szelet (5213, főleg DeepSeek 1198→~2928 run-rate) extrapolál valójában. A gap tehát a manual-dominancia miatt kicsi, NEM mert a hó elfogyott.

**Design mandate:** Tegye világossá MELYIK rész run-rate-forecast vs MELYIK fix-manual, különben a forecast félrevezet.

### A3 — Does manual/estimate dominance show clearly?

**Marveen: A count-badge FÉLREVEZETŐ. ÖSSZEG szerint:** actual_invoice 4014 (4%), provider_api 1199 (1.2%), manual 49 349 (50%), estimate 44 655 (45%). A headline ~95%-a manual+estimate, csak ~5% számla/API-alapú. Istvan javasolt megfogalmazása: "99 217 HUF ismert, 4% számla/API, 50% manual, 46% becsült" — ADAT-PONTOS. Az ÖSSZEG-súlyozott megfogalmazást használd, ne a count-badge-t — a count elrejti hogy a pénz 95%-a puha.

**Design mandate:** Amount-weighted quality display. "5% valós" not "30% valós" (count-based). This is a CRITICAL CORRECTION to §8.

### A4 — Is DeepSeek balance+entitlement correct?

**Marveen: STALE snapshot.** A feltöltés ELŐTTI dry állapotot tükrözi (a balance kimerült). Istvan ~1.5 órája feltöltötte a DeepSeeket, 6 agent fut rajta most tisztán. A 105%-blocked entitlement tehát data-freshness artifact, re-sync kell.

**Design mandate:** (a) Mutassa PROMINENSEN a last-synced időbélyeget. (b) Ne mutasson stale 'blocked'-ot jelen igazságként. Valós állapot: DeepSeek funded, aktív.

### A5 — Additional Caveats

**Marveen additional findings:**

**(a) manual_vs_provider_variance = -25 387:** A manual bejegyzések ~25k-val MAGASABBAK mint amit a provider-derived adat sugallna — valós diszkrepancia, surfaceld (túl-becsült manualok?).

**(b) A két LEGNAGYOBB szám a LEGPUHABB:** anthropic 58 014 (manual) + 'other' 27 000 (estimate) dominál és a legkevésbé megbízható.

**(c) Token opportunity-cost ORIASI:** Marveen ~481k + fullstack ~479k + többi MTD opportunity-cost, ami eltorpítja a 99k operational spendet. Ha valaha a pénz-kártyák közelében látszik, '1.1M forecast!'-ként üvölt. KÖTELEZŐ collapsed + világos címke: "nem számlázott / előfizetésben foglalt ekvivalens" (Istvan 8. szekció).

**(d) data_freshness timestamp:** Surfaced mint "utoljára frissítve" minden szekcióban.

### A6 — Summary of Critical Design Corrections

| Original assumption | Corrected by Marveen | Design impact |
|---------------------|---------------------|---------------|
| "30% valós" (count-based: 3/10 providers) | ~5% valós (amount-based: 4% invoice + 1.2% API) | §8 quality scorecard MUST use amount-weighted |
| Past month 8990 HUF is the baseline | June is INCOMPLETE (1 provider, 1 line item) | Past card MUST show PARTIAL/HIÁNYOS badge |
| Forecast gap small = month nearly done | Gap small because 95% is manual fixed-month-end | Forecast card MUST split run-rate vs manual portion |
| DeepSeek 105% blocked = ⛔ actionable | STALE snapshot; Istvan reloaded ~1.5h ago | Entitlement MUST show freshness timestamp; don't show stale blocked as truth |
| Opportunity cost ~3 712 HUF | Token opportunity cost is ~960k HUF (!!) | §9 MUST use "nem számlázott" label + mandatory collapsed |
| MoM +90k is growth | Apples-to-oranges: 1-provider partial vs full month | MoM MUST be caveated or hidden until June has full coverage |
| Manual entries = neutral fact | Manual entries are ~25k HIGHER than provider data suggests | Surface manual_vs_provider_variance as a trust metric |

---

*Plan document ends. Awaiting Marveen interpretation context before finalizing.*
