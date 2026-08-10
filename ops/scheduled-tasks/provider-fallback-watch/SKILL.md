---
name: provider-fallback-watch
description: Automatic provider-dry failover and recovery for the agent fleet. Runs LLM-free every 10 minutes; switches stalled agents to the fallback model and brings them back automatically once the primary provider recovers.
---

# Provider-dry failover + recovery

Executor: a deterministic Python script (`check.py`), NOT an LLM prompt -- it runs
every 10 minutes and must be cheap and predictable.

## Why it exists
2026-08-08: the DeepSeek balance hit 402 and every agent on it stopped SILENTLY.
Ten agents dead, one fix short of a milestone, discovered only because a human
read a tmux pane. The pre-existing capacity-routing floor only covered the
opposite direction (Claude quota exhausted -> DeepSeek).

## What it does
1. FAILOVER -- moves an agent to the fallback model only when TWO independent
   signals agree: its recent pane shows the provider error AND the provider is
   really dry (balance below floor, or unknown). Idle agents are never moved.
2. RECOVERY -- once the balance is back, reverts ONE agent (canary) and lets the
   NEXT run judge it by whether it stalled again. Only then are the rest
   reverted. This is what makes the proof a REAL call rather than a balance
   number: a freshly topped-up balance can still throw a transient 402.
3. EARLY WARNING -- one Telegram message when the balance drops below the warn
   threshold but before anything has stopped. Re-arms after recovery.
4. BLAST-RADIUS CAP -- above MAX_AUTO_FAILOVER simultaneously-stalled agents it
   alerts instead of switching, because a fleet-wide outage is an owner decision.

## Buktatók
- **A pane-grep ONMAGABAN nem bizonyitek.** Ezt eles-elott, teszteles kozben
  fogtam meg: a helyreallas utan ket TELJESEN EGESZSEGES agens pane-jeben ott
  maradt a korabbi 402 a scrollbackben -- pusztan erre armolva a watcher
  atvaltotta volna oket a draga modellre. Ezert (a) csak az utolso par sort
  nezi, (b) a balance-szal korrelal. Ket fuggetlen jel kell.
- Az egyenleg-szam ONMAGABAN sem eleg a visszavaltashoz (tranziens 402 friss
  feltoltes utan) -- ezert a canary + kovetkezo-ciklus bizonyitas.
- Soha ne echozd a pane TARTALMAT (erzekeny lehet); csak boolean grep.
- A visszavaltas legalabb olyan fontos mint a failover: a failover lathato es
  surgos, a visszavaltas lathatatlan -> ha kimarad, csendben szivarog a penz.

## Ellenorzes
- Egeszseges flottan: NEMA, nulla config-valtozas, nincs state-fajl.
- Scenario-proof (7 eset) a fejlesztes soran lefuttatva: dry+stalled -> failover;
  stale-402+healthy-balance -> semmi; cap-folott -> csak riasztas; recovery ->
  canary; canary-ok -> tobbi vissza; canary-elakad -> visszateszi; alacsony
  balance -> egyszeri figyelmeztetes.
