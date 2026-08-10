---
name: limit-revive
description: Periodikus sweep: a Claude usage-limit modalon parkolt agenseket feloldja, hogy a limit-reset utan azonnal folytassanak.
---

LIMIT-REVIVE SWEEP (executor: codeworker/Cog, DeepSeek). Cel: a Claude usage-limit modalon ("Stop and wait for limit to reset" / "Upgrade your plan" / "hit your ... limit") PARKOLT agensek feloldasa.

ADAT-SZABALY (kotelezo, mert DeepSeek-en futsz): SOHA ne ird ki / ne emeld a kontextusba egyetlen agent pane-tartalmat sem. Csak grep -q (boolean) hasznalhato; a kimeneted KIZAROLAG session-nev + szamlalo lehet. Igy nem szivarog erzekeny tartalom DeepSeek-re.

Lepesek (egyetlen bash blokk, ne echozz pane-tartalmat):
1. Sessions: tmux ls | grep -oE 'agent-[a-zA-Z0-9_-]+' | sort -u
2. Mindegyikre: out=$(tmux capture-pane -t <session> -p | tail -8); echo "$out" | grep -qiE "Stop and wait for limit to reset|Upgrade your plan|hit your.*limit" -> ha igaz: PARKOLT.
3. Parkoltnak: tmux send-keys -t <session> Enter (megerositi az elore-kivalasztott "Stop and wait" opciot -> reset utan auto-folytat). Csak ennyit echozz: "PARKED: <session>".
4. 3 mp varas utan ujra grep -q: ha mar nincs modal -> feloldva.
5. Ha 3+ agens EGYSZERRE parkolt: inter-agent uzenet marveennek (NEM Telegram, neked nincs csatornad):
   curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat /home/iszzu/marveen/store/.dashboard-token)" -d '{"from":"codeworker","to":"marveen","content":"LIMIT-REVIVE: N agens egyszerre parkolt, feloldva M."}'
6. Rovid daily-log sor (agent_id codeworker), CSAK szamokkal (hany parkolt, hany feloldva), pane-tartalom nelkul:
   curl -s -X POST http://localhost:3420/api/daily-log -H "Content-Type: application/json" -H "Authorization: Bearer $(cat /home/iszzu/marveen/store/.dashboard-token)" -d '{"agent_id":"codeworker","content":"## HH:MM limit-revive: parked=N revived=M"}'
NE nyulj a marveen-channels / marveen-worker / agent-codeworker (sajat) sessionhoz, csak a tobbi agent-* peerhez. Csendes (semmi kimenet) ha 0 parkolt.
