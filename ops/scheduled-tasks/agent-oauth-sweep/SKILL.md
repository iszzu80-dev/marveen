---
name: agent-oauth-sweep
description: OAuth wall detekció: 30 percenként ellenőrzi melyik ágens ragadt be a claude.ai bejelentkezési képernyőre
---

AGENT OAUTH SWEEP. Cél: minden agent-* tmux pane-en ellenőrizd hogy OAuth wall-on ragadt-e (claude.ai bejelentkezési képernyő).

Lépések (egyetlen bash blokkban, ne echozz pane-tartalmat):
1. sessions=$(tmux ls 2>/dev/null | grep -oE "agent-[a-zA-Z0-9_-]+" | sort -u)
2. Minden session-re: tmux capture-pane -t <session> -p 2>/dev/null | tail -15 | grep -q "oauth/authorize" && echo "OAUTH: <session>"
3. Ha találsz OAuth wall-on ragadt agenst: küldj Telegram értesítést az inter-agent API-n keresztül:
   curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat /home/iszzu/marveen/store/.dashboard-token)" -d "{\"from\":\"marveen\",\"to\":\"marveen\",\"content\":\"OAUTH WALL: <session-lista> -- tmux attach -t <session> kell a bejelentkezéshez\"}"
   Majd Telegram-on szólj Istvannak (reply tool, chat_id 8942301795): melyik agent(ek) ragadtak el OAuth wall-on, mit kell tenni (tmux attach + böngésző + kod visszaillesztés).
4. Ha 0 OAuth wall: csendes (semmi kimenet, semmi értesítés).
5. Napi log csak ha találtál valamit: curl -s -X POST http://localhost:3420/api/daily-log -H "Content-Type: application/json" -H "Authorization: Bearer $(cat /home/iszzu/marveen/store/.dashboard-token)" -d "{\"agent_id\":\"marveen\",\"content\":\"## HH:MM oauth-sweep: wall=N agent(ek): <lista>\"}"

FONTOS: Ne echozz pane-tartalmat a kimenetbe. Csak session-neveket és számlálókat.
