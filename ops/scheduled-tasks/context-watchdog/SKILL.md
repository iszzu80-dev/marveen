---
name: context-watchdog
description: 30 percenkent, azonnali (1. talalatra) riasztas agent context-saturation-re. Kulon feladat a health-watchdog-tol, mert a context-teltseg nem transiens hiba.
---

CONTEXT WATCHDOG (read-only, silent unless issue).

NOTE: type=command (lasd task-config.json) -- a valos logika check.sh-ban van, ez a fajl csak dokumentacio, nem LLM-prompt.

Ellenorzes: minden agent-* tmux pane utolso 15 sora, minta: "100% context used|context.*full|context limit|auto-?compact required".

Miert failThreshold=1 (nem 2, mint a health-watchdog-nal):
context-saturation NEM javul magatol a kovetkezo tick-ig -- ha most 100%, 30 perc mulva is 100% lesz (vagy rosszabb). A 2-utes minta a flaky (auth/network) hibakhoz valo, ahol ertelme van megvarni egy megerositest mielott riasztunk. Itt nincs ertelme varni: azonnal jelezni kell, hogy legyen ido reagalni (fresh restart / handoff) mielott az agent tenylegesen elakad.

Lasd meg: ~/marveen/releases/scheduled-scripts-current/dispatch-guard.sh (pinned, ld. card d3f9fd90) -- ez a PROAKTIV oldal (uj feladat kiosztasa ELOTT ellenorzi a cel-agent pane-jet, es ha CTX_SAT-ot lat, eloszor recovery-t (fresh restart) csinal, csak utana engedi a dispatch-ot). A context-watchdog a REAKTIV/passziv oldal (mar futo, dispatch nelkuli allapotokat is elkapja).
