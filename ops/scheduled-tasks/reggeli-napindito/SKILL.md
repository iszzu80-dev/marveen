---
name: reggeli-napindito
description: Reggeli összefoglaló: email, naptár, AI hírek, plus Dream Engine top-of-message
---

Reggeli napindítót a CLAUDE.md formátum szerint. A beállított csatornára (chat_id: 0).

**FONTOS — Dream Engine override**: a napindító ELEJÉRE (még az email/naptár szekciók ELŐTT) tedd be a `/home/iszzu/marveen/DREAM.md` fájl tartalmából az 5 bucket-et — `💡 Skill-javaslatok`, `🧹 Memória-egészség`, `🎯 Top-3 holnapi javaslat`, `🌐 External opportunity`, `🛠 Skill-flotta health`. Ha a DREAM.md nem létezik vagy üres (pl. a Dream Engine valamiért nem futott le), kihagyod ezt a szekciót.

A `cat /home/iszzu/marveen/DREAM.md` parancs visszaadja a tartalmat, abból emeld ki a kulcs-szekciókat MarkdownV2-formátumra escape-elve.

A többi szekció (email, naptár, AI hírek) maradnak a CLAUDE.md-ben leírt formátum szerint.

**🗂 CHIEF OF STAFF (COS) szekció -- CSAK a fő-ágensnél (marveen)** (Istvan 2026-08-06: a Personal Chief of Staff mostantól a Marveen COS-ban él, a ChatGPT-oldal leállítva -- lásd [[chatgpt-cos-drive-migration-executed]]). A naptár szekció UTÁN tegyél be egy "🗂 CHIEF OF STAFF" szekciót, ami a napi ügy-áttekintőt hozza. Adatot a live DB-ből, a domain-rétegen át (NE nyers SQL-lel találgass státuszt):
```
node -e '
const D=require("/home/iszzu/marveen/node_modules/better-sqlite3"); const db=new D("/home/iszzu/marveen/store/claudeclaw.db",{readonly:true});
const cs=require("/home/iszzu/marveen/dist/cos/case-store.js");
const now=Math.floor(Date.now()/1000);
const today=cs.listTodayCases(db, now+2*86400);
const dec=today.filter(r=>["AWAITING_SELECTION","AWAITING_APPROVAL"].includes(r.status));
const due=today.filter(r=>r.due_at&&r.due_at<=now+2*86400);
const attn=today.filter(r=>["RECOVERY_REQUIRED","INFO_REQUIRED","CALL_REQUIRED","FOLLOW_UP_DUE"].includes(r.status));
const f=t=>t?new Date(t*1000).toISOString().slice(0,10):"";
console.log("DECISIONS_PENDING:"); dec.slice(0,6).forEach(r=>console.log(` ${r.priority} ${r.title} [${r.case_id}]`));
console.log("DUE_SOON:"); due.slice(0,6).forEach(r=>console.log(` ${r.priority} ${f(r.due_at)} ${r.title}`));
console.log("NEEDS_ATTENTION:"); attn.slice(0,6).forEach(r=>console.log(` ${r.priority} ${r.status} ${r.title}`));
console.log(`TOTALS: today=${today.length} decisions=${dec.length} due48h=${due.length} attention=${attn.length}`);
'
```
Formázd 3 rövid al-blokkba (⚖️ Döntésre vár, ⏰ Hamarosan lejár, ⚠️ Figyelmet igényel), max 4-5 tétel/blokk, a többit "+N további". Ha mindhárom üres, hagyd ki a COS szekciót. NE küldj semmit senkinek a nevében (read-only áttekintő).

**🏢 ZST szekció -- CSAK a fő-ágensnél (marveen)** (2026-08-06, ZST CoS Slice 1 él): a személyes COS szekció UTÁN, KÜLÖN "🏢 ZST RADIO" al-szekcióban hozd a céges ügyeket a `zst_cases`-ből -- SOHA ne keverd a személyes ügyekkel. A ZST namespace kezdetben üres, ahogy érdemi céges levél érkezik, úgy töltődik. Ugyanaz a lekérdezés, de a ZST case-store-ral és a ZST attention-státuszokkal:
```
node -e '
const D=require("/home/iszzu/marveen/node_modules/better-sqlite3"); const db=new D("/home/iszzu/marveen/store/claudeclaw.db",{readonly:true});
const z=require("/home/iszzu/marveen/dist/cos/zst-case-store.js");
const now=Math.floor(Date.now()/1000);
const today=z.listTodayZstCases(db, now+2*86400);
const dec=today.filter(r=>["AWAITING_SELECTION","AWAITING_APPROVAL"].includes(r.status));
const due=today.filter(r=>r.due_at&&r.due_at<=now+2*86400);
const attn=today.filter(r=>["RECOVERY_REQUIRED","INFORMATION_REQUIRED","CALL_REQUIRED","FOLLOW_UP_DUE","REVIEW_REQUIRED","AWAITING_INTERNAL_INPUT"].includes(r.status));
console.log("ZST today="+today.length+" decisions="+dec.length+" due48h="+due.length+" attention="+attn.length);
today.slice(0,8).forEach(r=>console.log(` ${r.priority} ${r.status} ${r.title} [${r.case_id}]`));
'
```
Ha a ZST namespace üres (today=0), HAGYD KI teljesen a ZST szekciót (ne írj "nincs ZST ügy"-et). Read-only, semmit nem küldesz a cég nevében.

**AI hírek szekció -- CSAK a fő-ágensnél (marveen)**: ha NEM a fő-ágensként futsz (azaz sub-agentként), HAGYD KI az "🤖 AI HÍREK" szekciót -- sub-agenteknek nem releváns. Az email és naptár szekció marad mindenkinél.

**📻 ZST RADIO EMAIL szekció (Istvan 2026-07-04 kérése) -- CSAK a fő-ágensnél (marveen)**: az iszzu80 email szekció UTÁN tegyél be egy külön "📻 ZST RADIO" szekciót a google-zst Gmail read-only accountból (`mcp__google-zst__gmail_search`, query `newer_than:12h` vagy `newer_than:1d`). Szűrd a zajt (PostHog/marketing/hírlevél) -- CSAK a cselekvést igénylő/érdemi leveleket hozd: könyvelő (relacio/ÁFA), Google Workspace fizetés/fiók, üzleti partner-szálak (pl. Panos Zepos, Géza Szayer), hatósági (NAV/NMHH). Ha nincs érdemi ZST-levél, hagyd ki a szekciót. Ez a ZST Radio Kft. cég-postaládája -- ugyanolyan triage mint az iszzu80-nál.
