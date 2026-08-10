---
name: personal-gmail-delta
description: Orankenti bejovo levelfigyeles mindket Google fiokbol (spec 14 personal-gmail-delta), csak valodi teendot pingel Telegramra
---

Email-triage heartbeat (mindket Google fiok, read-only).

1. Futtasd (pinned release, NEM a megosztott checkout scripts/ -- card d3f9fd90, egy branch-valtas mashol ne vakitsa el ezt a heartbeatet):
   timeout 150 env MARVEEN_REPO_ROOT="$HOME/marveen" python3 "$HOME/marveen/releases/scheduled-scripts-current/email-triage-fetch.py" --window 4d
   A script mar kiszurte a determinisztikus zajt (hirlevel/promo/dmarc/biztonsagi ertesito) es a mar egyszer jelentett leveleket.

2. ELOSZOR AZ 'errors' MEZOT NEZD, NE A CANDIDATES-T. Ha az `errors` lista NEM ures, akkor egy vagy tobb fiok NEM LETT ELLENORIZVE -- ilyenkor a 0 jelolt NEM azt jelenti hogy nincs teendo, hanem hogy vakok vagyunk arra a fiokra. ILYENKOR KOTELEZO SZOLNI Istvannak, meg ha nincs is jelolt: mondd meg MELYIK fiok esett ki, mit jelent (nincs email-figyeles arra a fiokra), es mi kell a javitashoz (server_error eseten jellemzoen lejart refresh_token -> bongeszos consent kell tole). Egy nema figyelo-rendszer rosszabb mint a semmi, mert azt hiszi az ember hogy figyeli.

3. Ha nincs error ES a candidates lista URES -> MARADJ CSENDBEN, ne irj Telegramra, kesz. (Ez a normalis eset.)

4. Ha van candidate, dontsd el EGYENKENT hogy VALODI TEENDO-e Istvannak (a gmail-personal-action-triage skill szabalyai szerint):
   TEENDO: foglalas/szallas ahol a labda nala van, arajanlat amire valaszolni kell, hivatalos NAV/DAP/onkormanyzat irat, tartozas/szamla ami dontest kver, szemelyes szal konkret kerdessel, barmi hataridos.
   NEM TEENDO: rendszer-ertesito, automatikus visszaigazolas amire nem kell reagalni, reklam ami atcsuszott, sajat maganak tovabbitott level.
   Ha egy level alapjan nem eldontheto, olvasd el: python3 mcp-servers/google-<private|zst>-mcp.py stdio hivassal gmail_read a message id-val.

5. Ha van VALODI teendo -> EGY osszevont Telegram uzenet a reply toolal (chat_id 8942301795), sima szoveg:
   - fiokonkent csoportositva, ugyenkent 1-2 mondat: KI irt, MI kell, KINEL a labda
   - ne masold be a teljes levelet, csak a lenyeget
   Ha nincs valodi teendo -> NE irj semmit.

5b. COS-UGY LETREHOZAS (a valodi teendokbol): minden candidate-hez amit a 4-ben VALODI TEENDONEK iteltel, POST-old a COS intake-re, hogy a Mission Controlon (localhost:3420) is ugy legyen, ne csak Telegram-uzenet. A zajt NE POST-old.
   curl -s -X POST http://localhost:3420/api/cos/intake -H "Content-Type: application/json" -H "Authorization: Bearer $(cat $HOME/marveen/store/.dashboard-token)" -d '{"accountId":"<candidate.account: private|zst>","messageId":"<candidate.id>","threadId":"<thread ha van, kulonben hagyd el>","subject":"<subject>","from":"<from>","snippet":"<snippet>","actionable":true,"caseType":"<HOME_REPAIR|QUOTE|ADMIN|TRAVEL|FINANCE|CALL|EMAIL>","title":"<rovid cim>","direction":"INBOUND"}'
   A valasz outcome: CASE_CREATED (uj ugy) / LINKED_DUPLICATE (meglevo szalhoz kotve) / ALREADY_PROCESSED (mar volt). IDEMPOTENS per (fiok, uzenet) -- nyugodtan ujrafuttathato, nem csinal duplikatumot. A caseType-ot es title-t TE iteld meg a levelbol.
   **ZST-FIOK ROUTING (Slice 1, 2026-08-06):** az intake mostmar a `accountId` szerint routol -- `accountId:"zst"` eseten a level a ZST vallalati case-engine-be (zst_cases) megy, NEM personal_cases-be (connector identity = scope hatar, a ket namespace sose keveredik). Ezert ZST-fiokos candidate-nel a caseType a ZST tipuskeszletbol valasszd (NE a szemelyesbol): `ACCOUNTING|INVOICE_INCOMING|INVOICE_OUTGOING|BANK_RECONCILIATION|COMPANY_ADMIN|REGULATORY_DEADLINE|CONTRACT|VENDOR|PROCUREMENT|LICENSE_SUBSCRIPTION|PARTNER|COMMERCIAL_OPPORTUNITY|PRODUCT_DECISION|PRODUCT_MILESTONE|DOCUMENT_REQUEST|LEGAL_DATA_PROTECTION|GENERAL_OPERATION`. Opcionalisan add at `"workspace":"PRODUCT_LAB"`-ot ha a level termek-vonatkozasu (Marveen/QuickQuote/Zsibongo/webes termek), egyebkent OPERATIONS az alapertelmezett. A ZST valodi-teendo szures szigorubb es uzleti: konyveloi/NAV/hatosagi hatarido, bejovo/kimeno szamla ami dontest/fizetest igenyel, szerzodes/megujitas, partner/pilot megkereses, vendor/licenc ugy -- a ZST-marketinget (pl. konferencia-meghivo) NE POST-old.
   IRANY: a fetch minden candidate-hez ad egy "direction" mezot ("INBOUND" = bejovo, "OUTBOUND" = ALTALAD kuldott, Sent). Ezt POST-old at valtozatlanul az intake "direction" mezojebe. OUTBOUND eseten add meg a "to" cimzettet is (a candidate-ben ott van ha az MCP visszaadta, kulonben gmail_read-bol) -> WAITING_EXTERNAL ugy lesz follow-uppal (figyeli jon-e valasz). OUTBOUND-nal a VALODI-TEENDO szures szigorubb: csak az az altalad kuldott level ugy, ahol a labda MOSTMAR a masik felnel van es szamit hogy valaszol-e (arajanlat-keres, foglalas-kerdes, hivatalos beadvany) -- egy egyszeru "koszi"/nyugtazo valaszt NE POST-olj.
   Ez a hid TISZTA: a COS nem tudja mi a triage belseje, csak kap egy triageelt levelet. A read-only Gmail-olvasast NEM duplikaljuk.

5c. MELLEKLET-TAROLAS (P2): minden candidate-nel amihez a 5b-ben ugyet hoztal letre (CASE_CREATED VAGY LINKED_DUPLICATE -> van caseId a valaszban), ha a levelnek lehet mellekelte (szamla-PDF, foto, szerzodes, banki kivonat), told le es tarold a kozos dokumentum-taroloba:
   python3 "$HOME/marveen/scripts/cos-attachment-ingest.py" <private|zst> <candidate.id> <caseId>
   Ez read-only tolti le a Gmail-mellekleteket es a /api/cos/documents-en at content-cimzetten eltarolja + az ugyhoz koti. Idempotens (sha-dedup), nyugodtan ujrafuttathato. BEJOVO ES KIMENO (Sent) levelre is fut -- ha te KEZZEL kuldtel egy szamlat/iratot egy partnernek, a kimeno mellekletet is eltaroljuk. A JSON valaszban {stored,duplicate,skipped}. Ha 0 stored, nincs csatolmany (pl. szamlazz.hu-portal link) -- ez rendben van, ne eroltesd. Titkot/hitelesito adatot tartalmazo mellekletet NE tarolj shareable-kent (a store default UNKNOWN + nem-megoszthato, ez a helyes).

6. VEGUL KOTELEZO, akar irtal akar nem: jelold le az OSSZES most megitelt candidate id-t, hogy ne jojjenek elo ujra:
   env MARVEEN_REPO_ROOT="$HOME/marveen" python3 "$HOME/marveen/releases/scheduled-scripts-current/email-triage-fetch.py" --mark id1,id2,id3
   (Ezt a jelentett ES az elvetett levelekre is futtatni kell, kulonben 3 orank\ent ujra megiteled oket.)

Elso futasnal (first_run=true) lehet nagyobb backlog: csak a tenylegesen NYITOTT ugyeket jelentsd, ne az egesz elmult heti postat.

Guardrail: read-only, soha ne valaszolj/kuldj emailt, soha ne logold a hitelesito adatokat.
