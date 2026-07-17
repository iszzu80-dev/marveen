# MK-REL-01: CI Tax Validation Gate — Implementation Notes

Card: 698dc0b8
Date: 2026-07-17
Branch: devops/message-router-hardening

## What was built

### 1. MK golden suite CI script (`scripts/ci-mk-golden.sh`)
- Location: `marveen-suite/scripts/ci-mk-golden.sh`
- Runs the 5 blocking MK test files:
  - `_test.js` — F2 engine + rule-pack tests
  - `matrix-a_test.js` — Independent golden derivations (Matrix A, by qa)
  - `deadline_test.js` — All deadline types
  - `eligibility_test.js` — KATA + átalány eligibility gates
  - `output-guard_test.js` — Chat output safety guard
- Non-zero exit (build failure) if any test regresses
- Silent mode: `bash scripts/ci-mk-golden.sh --quiet`

### 2. GitHub Actions workflow (`.github/workflows/mk-golden.yml`)
- Path-filtered: only runs on push/PR when MK source files change
- Ubuntu runner, Node 22, pnpm 9
- Build → golden suite → pass/fail
- Blocks merge via branch protection (if enabled on the repo)

### 3. Both committed to marveen-suite `main`
- `69e08c4` — CI script
- `9f5d4b8` — GitHub Actions workflow
- **Not yet pushed** — blocked by P0 deploy incident (619917f5)

## What still needs to be done

### Render build command update (POST-P0)
Once the Render account rejection is resolved, append the CI gate to the build
command for all monorepo-linked services:

```
# Current:
corepack enable && pnpm install --no-frozen-lockfile && pnpm -r build

# After:
corepack enable && pnpm install --no-frozen-lockfile && pnpm -r build && bash scripts/ci-mk-golden.sh
```

This ensures the deploy gate is active: if MK golden tests fail, the build fails
and Render does NOT deploy. This prevents the exact "validated:false stays false but
manual flip" risk from doc sec 16.

Services that need the update (all share the monorepo build command):
- suite-web-08wb (srv-d90l7o00697c73crvkvg)
- suite-api-08wb
- suite-nav-sync-08wb
- zsibongo-ratio-alert-08wb
- zsibongo-retention-08wb
- qq-follow-up-08wb

Update via Render API:
```bash
source ~/marveen/.env && source ~/marveen/agents/devops/.env.render
curl -X PUT "https://api.render.com/v1/services/SERVICE_ID" \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"serviceDetails":{"envSpecificDetails":{"buildCommand":"corepack enable && pnpm install --no-frozen-lockfile && pnpm -r build && bash scripts/ci-mk-golden.sh"}}}'
```

### Push suite repo commits
```bash
cd ~/marveen-suite && git push origin main
```

### Branch protection (optional, GitHub repo settings)
Enable "Require status checks to pass before merging" for the `mk-golden` job
on the `main` branch. This makes the CI gate block PR merges, not just deploys.

## What is NOT covered

- **MK-QA-04 leak-test suite**: This requires a running API server (route-level tests
  for `/api/mk/estimate`). Not included in the build-time CI gate — the leak test
  must be run separately (e.g., in a staging environment).
- **MK-QA-05 KATA golden suite**: Located in `agents/qa/deliverables/mk-qa-05-kata/`,
  not yet wired into the in-repo test suite. The `matrix-a_test.ts` includes KATA rows
  (K1-K7) so basic KATA coverage exists.
- **MK-QA-03 F4 göngyölített suite**: In `agents/qa/deliverables/mk-qa-03-f4/`.
  Not wired into the CI gate.
