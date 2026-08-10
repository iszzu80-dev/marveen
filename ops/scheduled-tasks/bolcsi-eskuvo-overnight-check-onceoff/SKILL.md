---
name: bolcsi-eskuvo-overnight-check-onceoff
description: Egyszeri (07-01 08:11 CEST) ellenorzo kor bolcsi/eskuvo agentekre
---

Ellenorzo kor: nezd meg Mason, Pixel, Cog, QA (Falcon) tmux pane-jeit (nincs-e 100% context, nincs-e stuck/idle felbehagyott munka), a kanban-dispatcher visszatert-e a normal 30 perces utemre (store/schedule-last-run.json), es hogy a bolcsi/eskuvo kartyak (a4fa1195, a979448c, da156ea0, es a QA-gate f635e802/97c5db62-re) haladnak-e. Ha minden rendben, csendben maradj (ne zavard Istvant hajnalban feleslegesen), csak ha tenyleg talalsz elakadast (100% context, stuck agent, felbehagyott kartya), akkor jelezz neki Telegramon. Ez egy egyszeri feladat -- utana kapcsold ki (enabled:false PUT /api/schedules/bolcsi-eskuvo-overnight-check-onceoff).
