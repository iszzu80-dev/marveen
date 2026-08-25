# Rollback and forward-fix runbook (MIP-v1.0 §8.8)

```text
Scope:  the Marveen local install — dashboard service, COS cycle, store
Status: three layers, two of them exercised by an automated drill, one by
        practice and NOT by me (see the last column and §4)
```

A rollback runbook that has never been run is a belief. So every step below says
what proves it, and where nothing proves it, it says that instead.

| layer | what goes wrong | rollback | proven by |
|---|---|---|---|
| CODE | a bad build reaches the running dashboard | previous `dist` snapshot or `git reset --hard` + rebuild + restart | practice (existing `dist.pre-*` snapshots) — **not exercised in this packet** |
| DATA | the store is corrupt, or a migration went wrong | restore the newest encrypted backup + the policy bundle | `scripts/w14-restore-drill.ts` + `w14-restore-drill.test.ts` |
| BEHAVIOUR | a newly rolled-out behaviour misbehaves | the canary aborts it — automatically on a failed run, or by hand | `src/cos/canary.ts` + `w14-canary.test.ts` |

---

## 1. CODE — a bad build

The dashboard is a systemd user service running the COMPILED `dist/index.js`,
so "live" means `dist`, not the branch.

```bash
systemctl --user status marveen-dashboard.service      # what is running
ls -d ~/marveen/dist.pre-*                             # previous snapshots
```

**Roll back to a snapshot:**

```bash
cd ~/marveen
mv dist dist.bad-$(date +%Y%m%dT%H%M%S)
cp -r dist.pre-<sha>-<stamp> dist
systemctl --user restart marveen-dashboard.service
until curl -s -o /dev/null -w '%{http_code}' localhost:3420/api/kanban | grep -qE '200|401'; do sleep 1; done
```

**Or roll back the source and rebuild** (the path the go-live skill documents):

```bash
git reset --hard <pre-merge-HEAD> && npm run build && systemctl --user restart marveen-dashboard.service
```

Two things the operator must expect, both measured before:

- the restart **logs Istvan's browser session out**; send the re-auth link
  afterwards (`http://localhost:3420/?token=$(cat store/.dashboard-token)`,
  expanded, not as a literal command);
- the heavy `/api/costs/*` endpoints can hang for ~12s after a restart while
  SQLite checkpoints the WAL. That is not a failed rollback. Wait, re-test.

**Never** boot-smoke-test `dist/index.js` on the live port first: it takes the
port and the pidfile from the running service and kills it (~15s outage,
2026-08-08).

## 2. DATA — a corrupt store or a bad migration

```bash
COS_BACKUP_PASSPHRASE=... npx tsx scripts/w14-restore-drill.ts        # rehearse first
COS_BACKUP_PASSPHRASE=... npx tsx scripts/w14-restore-drill.ts --keep # keep the restored copy
```

The drill runs §8.3's six steps against a COPY and never writes to the live
store: fresh backup → clean target → restore (database AND policy files) →
consistency (integrity, row counts vs source) → smoke tests on real read paths →
measured RPO/RTO. Exit 0 means the restore path works today.

**To actually restore**, with the service stopped:

```bash
systemctl --user stop marveen-dashboard.service
cp store/claudeclaw.db store/claudeclaw.db.before-restore-$(date +%s)   # keep the evidence
# database
npx tsx -e "import{restoreEncryptedBackup}from'./src/cos/backup.js';import{writeFileSync}from'node:fs';\
writeFileSync('store/claudeclaw.db',restoreEncryptedBackup({encPath:'<backup-...db.enc>',passphrase:process.env.COS_BACKUP_PASSPHRASE}))"
# policy files — the rules, which the database backup does NOT carry
npx tsx -e "import{restorePolicyBackup}from'./src/cos/backup.js';\
console.log(restorePolicyBackup({encPath:'<policy-....json.enc>',passphrase:process.env.COS_BACKUP_PASSPHRASE,targetDir:'store'}))"
systemctl --user restart marveen-dashboard.service
```

**RPO is the age of the newest backup** — the daily job runs at 04:30, so up to
24 hours of case state can be lost in a full restore. The drill prints the
measured value; do not quote this paragraph instead of running it.

## 3. BEHAVIOUR — a new critical behaviour misbehaves

A canary'd feature aborts itself on the first `FAILED` or `PARTIAL` run (§8.5,
and `PARTIAL` means it acted without verification — §8.7). An aborted canary
does **zero** work until a human clears it.

```bash
# what is under canary, and what state it is in
npx tsx -e "import{initDatabase,getDb}from'./src/db.js';import{canaryStatus}from'./src/cos/canary.js';\
initDatabase();console.log(canaryStatus(getDb(),'cos-goal-enrichment-disclosure'))"

# clear an abort deliberately (a human act; nothing automatic calls this)
npx tsx -e "import{initDatabase,getDb}from'./src/db.js';import{resumeCanary}from'./src/cos/canary.js';\
initDatabase();console.log(resumeCanary(getDb(),'cos-goal-enrichment-disclosure',Math.floor(Date.now()/1000)))"
```

## 4. What is NOT proven here, and why

**The CODE rollback was not exercised in this packet.** Running it means
restarting Istvan's live dashboard in the middle of the night, and a rollback
drill that causes the outage it prevents is not a drill. The evidence that the
path works is practice — the `dist.pre-*` snapshots exist because it has been
done — and that is weaker than the other two layers, which have automated
drills. Closing it properly means one deliberate rehearsal in a quiet window,
with Istvan told beforehand.

**Forward-fix is the default for a behaviour bug**, not rollback: the canary
already stops the behaviour, so the system is safe while the fix is written. Roll
the CODE back only when the running build is broken for everyone — a rollback
that also removes three days of unrelated fixes is rarely the smaller loss.
