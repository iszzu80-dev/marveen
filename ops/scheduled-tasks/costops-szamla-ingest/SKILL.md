---
name: costops-szamla-ingest
description: Heti szamla-beszedes mindket Gmail fiokbol a CostOps-ba (read-only Gmail, actual_invoice ingest)
---

CostOps szamla-ingest sweep (heti). CSENDES heartbeat: csak akkor irj Telegramon, ha UJ szamlat talaltal, vagy anomaliat.

1) date Bash elobb. Olvasd el a ~/.claude/skills/costops-invoice-ingest/SKILL.md-t es kovesd.
2) fx: python3 -c "import json;print(json.load(open('store/costops-render-pricing.json'))['fx_usd_huf'])"
3) MINDKET Gmail fiokon fuss vegig, szuk, celzott keresessel (read-only, NE olvass szeles mailboxot):
   MAGAN (mcp__google-private__gmail_search):
     - from:stripe.com newer_than:14d   (Render itt szamlaz: "Your receipt from Render Services")
     - (from:openai.com OR from:anthropic.com OR from:deepseek.com) (receipt OR invoice OR charged OR funded) newer_than:14d
     - (from:googleplay-noreply@google.com OR subject:"Google Play") (receipt OR nyugta OR subscription) newer_than:14d
   CEGES (mcp__google-zst__gmail_search):
     - (from:stripe.com OR from:openai.com OR from:anthropic.com OR from:render.com) (receipt OR invoice) newer_than:14d
     - from:google.com (Workspace OR payments) newer_than:14d
   MEGJEGYZES (JAVITVA 2026-07-20): a 07-19-i note azt mondta, a ceges ZST fiokban NULLA infra-szamla van es eleg ritkabban nezni. EZ MAR NEM IGAZ -- az uj Anthropic Max 5x elofizetes (EUR 90/ho) a istvan.szabo@zstradio.com cimre szamlaz, tehat a CEGES fiokba. Mindket fiokot azonos gyakorisaggal nezd. A Google Workspace fizetesi problemat tovabbra is MINDIG jelezd.
   TOVABBA: a CostOps NEM tud EUR-t befogadni (email-ingest.ts toHuf() csak HUF/USD, EUR-ra null-t ad; nincs fx_eur_huf a configban). Kartya: 08b2ff9e. Ha EUR szamlat talalsz, NE talalj ki arfolyamot es NE vidd be kezi HUF sorkent -- jelezd.
4) gmail_read a talalatokra, vedd ki: osszeg, penznem, honap (nyugta datuma = cash basis), message id.
5) POST /api/costs/email-ingest a meglevo source_id-kkel: render-hosting, openai-api, openai-chatgpt, anthropic-max, anthropic-pro, deepseek-api. Uj source_id-t NE talalj ki.
6) Verifikald: GET /api/costs/summary -- valtozott-e, nincs-e duplikatum.
7) CSENDBEN maradj, ha nincs uj szamla. Irj Telegramon, ha: uj szamla bekerult, vagy egy szamla erdemben elter az elozo havitol, vagy fizetesi hiba/lemondas-ertesito erkezett.

FIGYELEM (ismert hiba, 2026-07-19): az actual_invoice es a provider_api azonos megbizhatosagi szinten (tier 4) van, es holtversenynel a motor a REGEBBI sort tartja meg, nem a frissebbet. Ezert egy ujonnan beirt szamla latszolag bekerul a forras sorba, de az operational_spend-be nem. Ha ezt latod, NE javitgasd a ledgert -- jelezd.
