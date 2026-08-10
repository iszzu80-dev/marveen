---
name: kanban-audit
description: 4 óránkénti kanban-tábla audit. Tisztítás (7+ napos done archiválás) + beakadt task-ok számon kérése (előző audit óta nem mozdult in_progress -> ping az assignee-nek).
---

# Kanban 4 órás audit

## Mikor fut
- 8:00, 12:00, 16:00, 20:00 (kanban-audit cron 0 8,12,16,20)

## Autonómia-szint (config-vezérelt, KÖTELEZŐ ELŐSZÖR)

Olvasd be: `jq -r '.categories[]|select(.key=="kanban_archive_done" or .key=="kanban_stuck_nudge")|"\(.key) \(.level)"' /home/iszzu/marveen/store/autonomy-config.json`

A két kategória szintje szabályozza a 2. és 4. lépést:
- **`kanban_archive_done`** (2. lépés): level 3 → archiváld magától (alapért). level 2 → NE archiválj, Telegramon javasold ("X db 7+ napos done archiválásra vár, mehet?") és várj jóváhagyást. level 1 → csak jelezd a számot.
- **`kanban_stuck_nudge`** (4. lépés): level 3 → pingeld az assignee-t magától, és CSAK 2 eredménytelen audit-kör után eszkalálj a tulajdonoshoz (Istvan) (a komment-történetből látod hányszor pingelted). level 2 → ne pingelj magadtól, Telegramon javasold a tulajdonosnak (Istvan). level 1 → csak listázd a beakadt taskokat.

Ha a config hiányzik vagy a kulcs nincs benne → default level 3 (régi viselkedés).

## Eljárás

1. **State-fájl beolvasás**: `store/kanban-audit-state.json` tartalmazza `last_audit_at` Unix timestampet. Első futáskor null -> ne pingelj senkit, csak állítsd be a state-et.

2. **Tisztítás**: 7+ napos done kártyák archiválása:
   ```bash
   sqlite3 /home/iszzu/marveen/store/claudeclaw.db "UPDATE kanban_cards SET archived_at=unixepoch() WHERE status='done' AND archived_at IS NULL AND updated_at < strftime('%s','now','-7 days')"
   ```

3. **Beakadt task detection** (előző audit óta nem mozdult): in_progress kártyák amik `updated_at < last_audit_at`. **KIZÁRVA az EPIC-konténerek**: egy epic strukturálisan mindig stale-nek látszik, mert a haladás a GYEREK-kártyákon történik, nem rajta -> a pingelése busywork. Epic = (a) van legalább egy gyereke (`id IN (SELECT parent_id ...)`), VAGY (b) a címe tartalmazza `(epic)`. Ezeket NE jelezd stuck-ként; a gyerek-kártyák frissessége adja a valós jelet.
   ```bash
   # FIGYELEM: a hoszton nincs sqlite3 CLI -> python3 sqlite3 modullal futtasd (lasd lent).
   LAST=$(jq -r .last_audit_at store/kanban-audit-state.json 2>/dev/null || echo 0)
   sqlite3 store/claudeclaw.db "SELECT id, title, assignee, ROUND((strftime('%s','now')-updated_at)/3600.0,1) as hours_stale FROM kanban_cards WHERE status='in_progress' AND archived_at IS NULL AND updated_at < $LAST AND id NOT IN (SELECT parent_id FROM kanban_cards WHERE parent_id IS NOT NULL) AND title NOT LIKE '%(epic)%' ORDER BY hours_stale DESC"
   ```
   Python-ekvivalens (sqlite3 CLI hianyzik): `import sqlite3; db=sqlite3.connect('store/claudeclaw.db')` majd ugyanez a WHERE (epic-kizarassal).

4. **Beakadt task -> ping**: minden beakadt kártyához küldj inter-agent message-t az assignee-nek (kivéve marveen-nek és üres assignee-nek):
   ```
   "Kanban-audit: a {card_id} ({title}) {hours_stale}h-ja in_progress mozgás nélkül (előző audit óta). Frissítsd a státuszt (done/waiting) vagy adj komment-et hogy mit blokkol."
   ```

5. **State-fájl frissítés** (a futás VÉGÉN): `store/kanban-audit-state.json` -> `{"last_audit_at": <current Unix timestamp>}`.

6. **Delegálatlan kártyák**: in_progress/waiting/planned amiknek assignee NULL/üres -> log + Telegram csak akkor ha 3+ ilyen van.

7. **Telegram csak akkor írj ha**:
   - 3+ beakadt task van (kritikus)
   - Új blokker (waiting > 48h)
   - Egyébként csendben (heartbeat-stílus)

## OWNER-HOLD GATE (2026-07-20, aba4e7ce incident utan)

Mielott barmilyen automatizalt statusz-valtoztatast vegzel (waiting->planned atsorolas, dispatch, stb.), KOTELEZO ellenorizni:

a) **Aktiv fleet HOLD**: ha letezik olyan `waiting` statuszu kartya ami FLEET HOLD-kent az egesz flottat tartja (pl. df4c3455), a HOLD altal erintett kartyakat SKIP-peld. NE minositsd at oket.

b) **`owner-held` label (e2b19cbd)**: ha a kartyan rajta van ez a label, az azt jelenti hogy Istvan explicit PARKOLTA. SKIP, NE minositsd at. Ha a sweep ugy talalja hogy egy `owner-held` kartyat at KELLENE minositenie, eszkalalj Marveen-nek.

c) **`istvan-dontes` + `needs_istvan` label**: ha mindketto rajta van, Istvan-dontesre var -> SKIP.

EZ A GATE MEGELOZI a 2026-07-12-i incidenst: egy automatikus sweep "No blocker found" alapon waiting->planned-be tett egy kartyat amit Istvan explicit PARKOLT, es a feature 3 nappal kesobb elesitve lett az o tudta nelkul. Egy owner hold NEM technikai blokker -- egy utasitas. A sweep nem irhatja felul.

## Buktatók
- **Friss `updated_at` NEM bizonyitja, hogy dolgozik rajta valaki.** Egy koordinator tomeges dispatch-e (2026-07-20 19:30, deliverylead: 20 kartya 0 -> in_progress) minden erintett kartyanak friss updated_at-et ad, igy a stuck-detektor a KOVETKEZO korben vak marad rajuk, utana viszont egyszerre jelzi mindet. A frissesseg a dispatch idejet meri, nem a munkaet.
- **Ping elott ellenorizd hogy az assignee EL-E.** `tmux ls` (vagy `/api/agents` runningSince). Egy allo agensnek kuldott inter-agent uzenet nem ebreszt fel senkit, csak zajt csinal es hamis "megpingeltem" nyomot hagy a komment-tortenetben, ami alapjan 2 kor utan eszkalalnal Istvan-hez egy nem-letezo valaszhianyra. Ha az assignee nem fut: NE pingelj, hanem a kartya nem-vegrehajtott allapotat jelezd a riportban, es a DISPATCHERT szolitsd meg, ne a halott agenst.
- Az "előző audit óta nem mozdult" feltétel azt jelenti: `updated_at < last_audit_at`. NE használj abszolút 24h-os küszöböt.
- Ne archiválj done-t ha <7 nap (a felhasználó még látni akarja).
- NE pingelj saját magadat (skip ha assignee='marveen').
- Ne re-pingelj 4 órán belül ugyanazt: a state-fájlban tárolt `last_audit_at` automatikusan kezeli ezt.
- Első futáskor (state-fájl üres) -> ne pingelj, csak inicializáld a state-et.
- A státuszváltozás (in_progress -> done) is updated_at frissítést jelent, így a következő audit nem fogja megfogni a most-még-aktív taskokat.
- **Owner-hold gate (aba4e7ce)**: MINDEN automatizalt statusz-valtoztatas elott ellenorizd a fenti OWNER-HOLD GATE szekciot. Egy `owner-held` label-es kartyat SOHA ne sorolj at automatikusan.

## Ellenőrzés
- A state-fájl frissült a futás végén.
- Inter-agent message-ek sikeresek (200 response).
