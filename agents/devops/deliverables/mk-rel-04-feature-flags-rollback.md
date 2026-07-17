# MK-REL-04: Feature Flags & Rollback — Implementation Notes

Card: 00b8f30b
Date: 2026-07-17
Branch: devops/message-router-hardening

## What was built

### Feature flag module (`apps/api/src/mk-feature-flags.ts`)
Two env-var controlled runtime feature gates:

| Flag | Default | What it gates |
|---|---|---|
| `MK_ATALANY_ENABLED` | `true` | `POST /api/mk/estimate`, `POST /api/mk/ledger` |
| `MK_KATA_ENABLED` | `true` | KATA sections in `POST /api/mk/kata-compare`, `POST /api/mk/ledger` |

Absent env var = enabled (fully backward compatible). Set to `"false"` to disable.

### Route integration
- **`POST /api/mk/estimate`** (line 442): Early return `blocked:true` with `FEATURE_DISABLED` if `MK_ATALANY_ENABLED=false`. Frontend already handles `blocked:true` (eligibility gate uses the same shape).
- **`POST /api/mk/kata-compare`** (line 906): When `MK_KATA_ENABLED=false`, KATA section is skipped entirely (`comparison:null`, `kataEligibility.eligible:false`). The atalanyado-only path is unaffected — this IS the independent-shipping guarantee.
- **`POST /api/mk/ledger`** (line 680): Same pattern — atalanyado blocked if `MK_ATALANY_ENABLED=false`, KATA comparison omitted if `MK_KATA_ENABLED=false`.

### Committed to marveen-suite `main`
- `20f09fd` — Feature flag module + route integration
- `69e08c4` — CI golden suite script (MK-REL-01)
- `9f5d4b8` — GitHub Actions workflow (MK-REL-01)
- **Not yet pushed** — blocked by P0 deploy incident (619917f5)

## Rollback Procedure

### Scenario A: Átalányadó regression (MK-QA-04 or parity tests)

**Instant rollback (no code deploy):**
```bash
# Set the env var on the Render API service
source ~/marveen/.env && source ~/marveen/agents/devops/.env.render
curl -X PUT "https://api.render.com/v1/services/srv-d90l7o00697c73crvkvg/env-vars/MK_ATALANY_ENABLED" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value":"false"}'

# Deploy the service (env var change alone may not trigger deploy)
curl -X POST "https://api.render.com/v1/services/srv-d90l7o00697c73crvkvg/deploys" \
  -H "Authorization: Bearer $RENDER_API_KEY"
```

**Effect:** All MK estimate/ledger endpoints return `blocked:true`. The Statusz dashboard shows "átmenetileg nem elérhető". No tax numbers are shown, no data is lost.

**Recovery:** Set `MK_ATALANY_ENABLED=true` and re-deploy.

### Scenario B: KATA regression only

**Instant rollback (no code deploy):**
```bash
curl -X PUT "https://api.render.com/v1/services/srv-d90l7o00697c73crvkvg/env-vars/MK_KATA_ENABLED" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"value":"false"}'
```

**Effect:** KATA comparison sections return `null`. Átalányadó core is UNAFFECTED. This is the whole point of separate flags (Decision A).

**Recovery:** Set `MK_KATA_ENABLED=true` and re-deploy.

### Scenario C: Full rollback to previous deploy

```bash
# Find the last successful deploy commit
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/srv-d90l7o00697c73crvkvg/deploys?limit=10" \
  | python3 -c "import json,sys; [print(d['deploy']['commit']['id'][:8],d['deploy']['status']) for d in json.load(sys.stdin)]"

# Trigger a manual deploy of the previous good commit
# (Render picks up the commit from the service's configured branch)
# Or: use git revert on the suite repo and push
```

### Rollback test checklist (post-P0, pre-launch)
1. [ ] Set `MK_ATALANY_ENABLED=false` on staging → verify `/api/mk/estimate` returns blocked
2. [ ] Set `MK_KATA_ENABLED=false` → verify `/api/mk/kata-compare` returns atalanyado-only
3. [ ] Set both back to `true` → verify full functionality restored
4. [ ] Confirm frontend handles `blocked:true` and `comparison:null` gracefully

## Env var setup (post-P0)
Add to suite-api-08wb Render service:
```
MK_ATALANY_ENABLED=true
MK_KATA_ENABLED=true
```
