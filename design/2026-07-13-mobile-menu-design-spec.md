# Korszerű mobilwebes menümegoldás 2026-ban

## Ajánlott irány

**2026-ban a legkorszerűbb mobilwebes megoldás egy lebegő alsó navigációs dock, amelyből a további menüpontok egy bottom sheetben nyílnak meg.**

Nem a hagyományos jobb felső sarokban lévő hamburger menü a legerősebb alapminta, mert az elrejti a legfontosabb lehetőségeket. Az Apple továbbra is a tab bart tekinti az alkalmazások elsődleges területei közötti navigáció alapjának, a Material 3 pedig kisebb kijelzőkre navigation bart, másodlagos tartalomhoz pedig bottom sheetet ajánl.

Források:

- Apple Human Interface Guidelines – Tab bars: https://developer.apple.com/design/human-interface-guidelines/tab-bars
- Apple Human Interface Guidelines – Toolbars: https://developer.apple.com/design/human-interface-guidelines/toolbars
- Material 3 – Bottom sheets: https://m3.material.io/components/bottom-sheets/guidelines

---

## Javasolt felépítés

```text
┌─────────────────────────────┐
│ Logo              Keresés ◯ │  ← minimalista felső sáv
│                             │
│         Oldaltartalom       │
│                             │
│                             │
│  ╭───────────────────────╮  │
│  │  ⌂     ◇     ＋    ☰  │  │  ← lebegő alsó dock
│  │ Főoldal Mentés Új Menü│  │
│  ╰───────────────────────╯  │
└─────────────────────────────┘
```

### 1. Lebegő, kapszula alakú alsó menü

Legyen benne legfeljebb **3–5 elsődleges cél**:

- Főoldal
- Felfedezés vagy Termékek
- Egy kiemelt fő művelet
- Mentések vagy Kosár
- Menü vagy Profil

### Vizuális irány

- enyhén áttetsző háttér;
- finom `backdrop-filter: blur(...)`;
- nagy, 24–32 pixeles lekerekítés;
- vékony, világos keret;
- nagyon visszafogott árnyék;
- az aktív elem külön, kitöltött pill;
- rugós, 180–250 ms-os animáció.

Ez a minta most terjedő irány: több modern alkalmazás és mobilweb is a kijelző szélétől elválasztott, lebegő kapszula alakú alsó navigáció felé mozdul.

---

### 2. A „Menü” bottom sheetet nyisson

A Menü gomb ne oldalról becsúszó, keskeny hamburger-panelt nyisson, hanem alulról érkező, körülbelül **75–90% képernyőmagasságú lapot**.

```text
╭──────────────────────────────╮
│             ━                │
│ Menü                      ×  │
│                              │
│ Keresés…                     │
│                              │
│ Termékek                  ›  │
│ Megoldások                ›  │
│ Árak                         │
│ Tudásközpont               › │
│                              │
│ ───────────────────────────  │
│ Bejelentkezés                │
│ Kapcsolat                    │
╰──────────────────────────────╯
```

Ebben lehet:

- keresés;
- csoportosított másodlagos navigáció;
- kibomló almenük;
- profil és beállítások;
- nyelvválasztó;
- kevésbé fontos jogi és vállalati oldalak.

A bottom sheet természetesebb mobilos interakció, mert a hüvelykujjhoz közel jelenik meg, és jól használható másodlagos navigáció vagy kontextuális műveletek megjelenítésére.

---

## A „legszexibb” vizuális változat

Én ezt a kombinációt használnám:

**Floating glass dock + aktív pill + kontextuális középső CTA + bottom sheet**

Például:

```text
[ Főoldal ]   Keresés    ＋    Mentések    Menü
```

### Működés

- Az aktív **Főoldal** ikon és felirat együtt, színezett kapszulában jelenik meg.
- A többi elem ikon + rövid felirat.
- A középső `＋` vagy „Tervezés indítása” enyhén kiemelkedhet.
- Görgetéskor a dock 4–8 pixellel összébb húzódhat.
- A fontos navigáció ne tűnjön el teljesen.
- A tartalom finoman látszódjon mögötte.
- A szövegkontraszt maradjon biztos.

---

## Mikor ne ezt használd?

**Marketing- vagy prémium brand landing page-nél**, ahol csak 4–6 oldal van, elegánsabb lehet:

- felül balra logó;
- felül jobbra kiírt **„Menü”** szó egy animált ikonnal;
- kattintásra teljes képernyős, tipográfia-központú overlay;
- nagy menüpontok;
- képek és finom átmenetek.

Ez látványosabb, de rendszeresen használt webappban rosszabbul teljesít, mert minden navigációhoz előbb ki kell nyitni a menüt.

**Webapphoz, webshophoz, dashboardhoz vagy ügyfélportálhoz ezért a látható floating bottom dock az erősebb megoldás.**

---

## Konkrét design-specifikáció

| Elem | Javaslat |
|---|---|
| Dock magassága | 64–72 px |
| Oldalsó távolság | 12–16 px |
| Alsó távolság | `max(12px, env(safe-area-inset-bottom))` |
| Lekerekítés | 28–36 px |
| Ikon | 22–24 px |
| Felirat | 11–13 px, medium |
| Érintési terület | legalább 44×44 px |
| Elsődleges elemek | maximum 5 |
| Animáció | 180–250 ms |
| Bottom sheet | 75–90 vh |
| Háttér | 80–92%-ban fedő vagy blur |
| Aktív állapot | kitöltött pill, ne csak színváltás |

---

## Összefoglaló ajánlás

Egy modern mobilwebhez most a **lebegő alsó kapszula-navigáció + alulról nyíló részletes menü** adja a legjobb kombinációt:

- látványos;
- egykezes használatra alkalmas;
- a fontos funkciókat nem rejti el;
- prémium és korszerű vizuális érzetet ad;
- webappban és szolgáltatásoldalon is jól skálázható.
