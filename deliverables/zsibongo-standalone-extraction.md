# Zsibongo (Bolcsi) standalone extraction

Source monorepo: /home/iszzu/marveen-suite
Remote: github.com/iszzu80-dev/marveen-suite
Branch measured: card-c3991453-zsibongo-pool-active-gdpr
Measured: 2026-07-20

All paths below are relative to /home/iszzu/marveen-suite unless stated.

## Summary

| Part | Count |
|---|---|
| API source files (zsibongo-owned) | 37 |
| Web source files (zsibongo-owned) | 14 |
| Migrations (zsibongo-named) | 63 |
| Matching rollbacks present | 32 of 63 |
| Shared API modules pulled in | 10 |
| Shared package @suite/core | 140 files, 547 KB |

Zsibongo is ~31% of apps/api by bytes (577 KB of 1.88 MB) and ~33% of apps/web (493 KB of 1.48 MB).

---

## 1. API files, zsibongo-owned (37)

    apps/api/src/admin-zsibongo-outbreak-routes.ts
    apps/api/src/admin-zsibongo-provision-routes.ts
    apps/api/src/admin-zsibongo-purge-routes.ts
    apps/api/src/zsibongo-auth.ts
    apps/api/src/zsibongo-billing-routes.ts
    apps/api/src/zsibongo-billing.ts
    apps/api/src/zsibongo-billing_test.ts
    apps/api/src/zsibongo-family-daycare-capacity_test.ts
    apps/api/src/zsibongo-finance-routes.ts
    apps/api/src/zsibongo-illness-routes.ts
    apps/api/src/zsibongo-mandate-renderer.ts
    apps/api/src/zsibongo-medication-routes.ts
    apps/api/src/zsibongo-monthly-report-renderer.ts
    apps/api/src/zsibongo-monthly-report-routes.ts
    apps/api/src/zsibongo-onboarding-extract.ts
    apps/api/src/zsibongo-require-addon.ts
    apps/api/src/zsibongo-require-tier.ts
    apps/api/src/zsibongo-routes.ts
    apps/api/src/zsibongo-rule-packs.ts
    apps/api/src/zsibongo-rule-packs_test.ts
    apps/api/src/zsibongo-rule-profile.ts
    apps/api/src/zsibongo-rule-profile_test.ts
    apps/api/src/zsibongo-segito-certification.ts
    apps/api/src/zsibongo-segito-certification_test.ts
    apps/api/src/zsibongo-self-fill-gate.ts
    apps/api/src/zsibongo-service.ts
    apps/api/src/zsibongo-service_test.ts
    apps/api/src/zsibongo-sni-verification.ts
    apps/api/src/zsibongo-sni-verification_test.ts
    apps/api/src/zsibongo-substitute-routes.ts
    apps/api/src/zsibongo-taj.ts
    apps/api/src/zsibongo-taj_test.ts
    apps/api/src/jobs/zsibongo-attendance-auto-close.ts
    apps/api/src/jobs/zsibongo-outbreak-aggregation.ts
    apps/api/src/jobs/zsibongo-outbreak-aggregation_test.ts
    apps/api/src/jobs/zsibongo-ratio-alert.ts
    apps/api/src/jobs/zsibongo-retention.ts

## 2. Web files, zsibongo-owned (14)

    apps/web/src/lib/zsibongoAuth.ts
    apps/web/src/views/ZsibongoEmergencyRevokePanel.tsx
    apps/web/src/views/ZsibongoHelyettesHalozatPanel.tsx
    apps/web/src/views/ZsibongoIllnessCalcView.tsx
    apps/web/src/views/ZsibongoLoginView.tsx
    apps/web/src/views/ZsibongoMedicationView.tsx
    apps/web/src/views/ZsibongoMegbizasaimPanel.tsx
    apps/web/src/views/ZsibongoMenuEditorPanel.tsx
    apps/web/src/views/ZsibongoOnboardingImport.tsx
    apps/web/src/views/ZsibongoOnboardingWizard.tsx
    apps/web/src/views/ZsibongoProbanapWizard.tsx
    apps/web/src/views/ZsibongoSubstituteAcceptInviteView.tsx
    apps/web/src/views/ZsibongoTelephelyekPanel.tsx
    apps/web/src/views/ZsibongoView.tsx

## 3. Shared API modules that zsibongo imports (10)

These are the ONLY non-zsibongo local modules the zsibongo API files import.
8 of the 10 are leaves: they import no further local module. That is what makes
this extraction tractable.

    apps/api/src/date-utils.ts            (leaf)
    apps/api/src/persistence-pg.ts        (leaf)
    apps/api/src/real-client-ip.ts        (leaf)
    apps/api/src/encryption-kms.ts        (leaf)
    apps/api/src/trial-gate.ts            (leaf)
    apps/api/src/registration-gate.ts     (leaf)
    apps/api/src/invite-auth.ts           (leaf)
    apps/api/src/auth-event-log.ts        (leaf)
    apps/api/src/shared/require-secret.ts
    apps/api/src/email/ses-client.ts

Plus the workspace package:

    packages/core/**                      (140 files, 547 KB, imported as @suite/core)

## 4. Shared WEB modules that the zsibongo views import

    apps/web/src/api.ts                   <-- 4363 lines, SHARED BY ALL 5 PRODUCTS
    apps/web/src/components/Toast.tsx
    apps/web/src/components/Modal.tsx
    apps/web/src/components/OnboardingWizard.tsx
    apps/web/src/components/MobileDock.tsx
    apps/web/src/components/IncidentsSection.tsx
    apps/web/src/lib/attendanceOutbox.ts

api.ts is the single biggest problem in the whole extraction. It is one flat
client file serving MikroKonyv, QuickQuote, DORA, Eskuvo and Zsibongo.
The 13 zsibongo views import from it.

## 5. Migrations, zsibongo-named (63)

    apps/api/db/migrations/0018_zsibongo_core.sql
    apps/api/db/migrations/0019_zsibongo_gaps.sql
    apps/api/db/migrations/0020_zsibongo_blocker_fixes.sql
    apps/api/db/migrations/0021_zsibongo_force_rls.sql
    apps/api/db/migrations/0022_zsibongo_login_lookup_fn.sql
    apps/api/db/migrations/0023_zsibongo_users_no_force_rls.sql
    apps/api/db/migrations/0024_zsibongo_force_rls_gaps.sql
    apps/api/db/migrations/0025_zsibongo_groups_site_policy_fix.sql
    apps/api/db/migrations/0027_zsibongo_billing.sql
    apps/api/db/migrations/0028_zsibongo_finance.sql
    apps/api/db/migrations/0029_zsibongo_payment_forward_compat.sql
    apps/api/db/migrations/0037_zsibongo_rls_restrictive_fix.sql
    apps/api/db/migrations/0038_zsibongo_meghatalmazott_role.sql
    apps/api/db/migrations/0040_zsibongo_login_lookup_definer.sql
    apps/api/db/migrations/0043_zsibongo_rls_ekepviselo_reissue.sql
    apps/api/db/migrations/0048_zsibongo_allergies_group_scope.sql
    apps/api/db/migrations/0050_zsibongo_consent_structure.sql
    apps/api/db/migrations/0051_zsibongo_messages.sql
    apps/api/db/migrations/0052_zsibongo_documents_group_scope.sql
    apps/api/db/migrations/0054_zsibongo_retention.sql
    apps/api/db/migrations/0055_zsibongo_parent_children.sql
    apps/api/db/migrations/0056_zsibongo_child_scope_multi_child.sql
    apps/api/db/migrations/0064_zsibongo_messages_documents_multi_child.sql
    apps/api/db/migrations/0066_zsibongo_ratio_alerts.sql
    apps/api/db/migrations/0074_zsibongo_illness_return.sql
    apps/api/db/migrations/0074_zsibongo_incidents_hardening.sql
    apps/api/db/migrations/0075_zsibongo_helyettes_halozat.sql
    apps/api/db/migrations/0075_zsibongo_medication_log.sql
    apps/api/db/migrations/0076_zsibongo_substitute_invite.sql
    apps/api/db/migrations/0077_zsibongo_pool_directory_hygiene.sql
    apps/api/db/migrations/0080_zsibongo_site_backfill.sql
    apps/api/db/migrations/0089_zsibongo_self_fill_invites.sql
    apps/api/db/migrations/0090_zsibongo_care_status_jelentkezett.sql
    apps/api/db/migrations/0091_zsibongo_staff_selffill_contact.sql
    apps/api/db/migrations/0092_zsibongo_staff_created_at.sql
    apps/api/db/migrations/0093_zsibongo_allergies_child_scope.sql
    apps/api/db/migrations/0094_zsibongo_allergy_consent.sql
    apps/api/db/migrations/0096_zsibongo_staff_selffill_notes.sql
    apps/api/db/migrations/0097_zsibongo_substitute_assignment_dedup.sql
    apps/api/db/migrations/0101_zsibongo_substitute_assignment_fields.sql
    apps/api/db/migrations/0102_zsibongo_outbreak_board.sql
    apps/api/db/migrations/0103_zsibongo_substitute_emergency_revoke.sql
    apps/api/db/migrations/0104_zsibongo_shift_swap_requests.sql
    apps/api/db/migrations/0111_zsibongo_letszam_matrix.sql
    apps/api/db/migrations/0112_zsibongo_szolgaltatast_nyujto_szemely.sql
    apps/api/db/migrations/0113_zsibongo_service_form_split.sql
    apps/api/db/migrations/0115_zsibongo_substitute_compliance.sql
    apps/api/db/migrations/0116_zsibongo_substitute_followups.sql
    apps/api/db/migrations/0117_zsibongo_tiered_pricing.sql
    apps/api/db/migrations/0127_zsibongo_segito_certification.sql
    apps/api/db/migrations/0128_zsibongo_segito_certificate_type_enum.sql
    apps/api/db/migrations/0129_zsibongo_sni_determination_verification.sql
    apps/api/db/migrations/0130_zsibongo_offline_resilience.sql
    apps/api/db/migrations/0134_zsibongo_rule_profile.sql
    apps/api/db/migrations/0135_zsibongo_attendance_period_close.sql
    apps/api/db/migrations/0136_zsibongo_jogviszony.sql
    apps/api/db/migrations/0137_zsibongo_rule_profile_signoff.sql
    apps/api/db/migrations/0138_zsibongo_jogviszony_type.sql
    apps/api/db/migrations/0148_zsibongo_attendance_correction.sql
    apps/api/db/migrations/0149_zsibongo_attendance_correction_escalation.sql
    apps/api/db/migrations/0155_zsibongo_attendance_edit_log.sql
    apps/api/db/migrations/0156_zsibongo_pool_active_default_false.sql
    apps/api/db/migrations/0157_zsibongo_pool_active_backfill.sql

Plus the base migration, which creates tenants and users, both of which
zsibongo depends on:

    apps/api/db/migrations/0001_init.sql

0001_init also creates invoices, payment_marks, quotes and nav_credentials.
Those belong to MikroKonyv and QuickQuote. Drop them from the extracted copy.

Rollbacks that exist for zsibongo migrations (32 of 63):

    apps/api/db/migrations/rollbacks/0038_rollback.sql
    apps/api/db/migrations/rollbacks/0040_rollback.sql
    apps/api/db/migrations/rollbacks/0043_rollback.sql
    apps/api/db/migrations/rollbacks/0066_rollback.sql
    apps/api/db/migrations/rollbacks/0074_rollback.sql
    apps/api/db/migrations/rollbacks/0075_rollback.sql
    apps/api/db/migrations/rollbacks/0076_rollback.sql
    apps/api/db/migrations/rollbacks/0077_rollback.sql
    apps/api/db/migrations/rollbacks/0089_rollback.sql
    apps/api/db/migrations/rollbacks/0090_rollback.sql
    apps/api/db/migrations/rollbacks/0091_rollback.sql
    apps/api/db/migrations/rollbacks/0092_rollback.sql
    apps/api/db/migrations/rollbacks/0093_rollback.sql
    apps/api/db/migrations/rollbacks/0094_rollback.sql
    apps/api/db/migrations/rollbacks/0096_rollback.sql
    apps/api/db/migrations/rollbacks/0097_rollback.sql
    apps/api/db/migrations/rollbacks/0101_rollback.sql
    apps/api/db/migrations/rollbacks/0102_rollback.sql
    apps/api/db/migrations/rollbacks/0103_rollback.sql
    apps/api/db/migrations/rollbacks/0104_rollback.sql
    apps/api/db/migrations/rollbacks/0111_rollback.sql
    apps/api/db/migrations/rollbacks/0112_rollback.sql
    apps/api/db/migrations/rollbacks/0113_rollback.sql
    apps/api/db/migrations/rollbacks/0115_rollback.sql
    apps/api/db/migrations/rollbacks/0116_rollback.sql
    apps/api/db/migrations/rollbacks/0117_rollback.sql
    apps/api/db/migrations/rollbacks/0127_rollback.sql
    apps/api/db/migrations/rollbacks/0128_rollback.sql
    apps/api/db/migrations/rollbacks/0129_rollback.sql
    apps/api/db/migrations/rollbacks/0130_rollback.sql
    apps/api/db/migrations/rollbacks/0156_rollback.sql
    apps/api/db/migrations/rollbacks/0157_rollback.sql

Note the duplicate prefixes in the source: 0074 and 0075 each appear twice
(0074_zsibongo_illness_return + 0074_zsibongo_incidents_hardening,
0075_zsibongo_helyettes_halozat + 0075_zsibongo_medication_log).
Any renumbering has to preserve the real apply order, not sort by filename.

Table set zsibongo actually touches: 49 tables. 48 are prefixed zsibongo_,
the 49th is the shared `tenants` table.

## 6. Wiring in server.ts

    apps/api/src/server.ts

41 zsibongo references. The imports live at lines 373-388, and the route
registration block is at lines 3822-3828:

    app.register(zsibongoRoutes, { pool, llmProvider, audit })
    app.register(zsibongoBillingRoutes, { pool })
    app.register(zsibongoFinanceRoutes, { pool })
    app.register(zsibongoMonthlyReportRoutes, { pool })
    app.register(zsibongoIllnessRoutes, { pool })
    app.register(zsibongoSubstituteRoutes, { pool })
    app.register(zsibongoMedicationRoutes, { pool })

Plus registerZsibongoAuthRoutes and the three mountAdminZsibongo* calls.
Do NOT copy server.ts wholesale. Write a new zsibongo-only bootstrap that
keeps the shared middleware (auth, tenant/RLS, rate limit, multipart) and
registers only the above.

## 7. Config files to base the new repo on

    package.json            (root, pnpm workspace)
    pnpm-workspace.yaml
    pnpm-lock.yaml
    turbo.json
    render.yaml             (deploy config, prune to zsibongo services)
    apps/api/package.json
    apps/api/tsconfig.json
    apps/web/package.json
    apps/web/tsconfig.json
    apps/web/vite.config.ts
    apps/web/index.html

API runtime deps actually needed by zsibongo: fastify, pg, @suite/core,
jsonwebtoken, pdfkit, @aws-sdk/client-kms, @aws-sdk/client-ses,
@fastify/multipart, @fastify/rate-limit, archiver, qrcode.
Probably NOT needed: @anthropic-ai/sdk, sharp, tesseract.js, posthog-node.
Verify before dropping: zsibongo-onboarding-extract.ts may use the LLM/OCR path.

Web deps: react, react-dom, posthog-js.

## 8. Tests

apps/api/package.json runs tests as a flat `node dist/X_test.js && ...` chain.
The zsibongo ones in that chain:

    zsibongo-taj_test
    zsibongo-family-daycare-capacity_test
    zsibongo-rule-packs_test
    zsibongo-billing_test
    zsibongo-sni-verification_test
    zsibongo-rule-profile_test
    zsibongo-segito-certification_test
    zsibongo-service_test
    jobs/zsibongo-outbreak-aggregation_test
    auth-middleware_test          (shared, keep)

---

## 9. THE PROMPT

Paste everything below into Claude Code, started in an EMPTY directory.

---BEGIN PROMPT---

You are extracting one product out of a pnpm monorepo into a standalone,
working repository. Do not guess at structure: read the source repo first.

SOURCE (read-only, never write to it):
  /home/iszzu/marveen-suite
  Use the branch card-c3991453-zsibongo-pool-active-gdpr.
  That branch is 3 commits ahead of main and 3 behind. Read from it, but
  before you finish, diff against origin/main and tell me anything you
  skipped because it only exists on one side.

TARGET: the current empty directory. New git repo, single initial commit.

WHAT TO EXTRACT: the Zsibongo product (a Hungarian nursery/daycare
management platform, marketed as "Bolcsi"). It is a Fastify + Postgres API,
a React/Vite SPA, and a set of SQL migrations.

GOAL: `pnpm install && pnpm build && pnpm test` must pass in the new repo,
and the API must boot against a Postgres with the migrations applied.
A repo that merely contains the files is a FAILURE. It has to build.

STEP 1 - INVENTORY
Confirm these counts yourself before copying anything. If a number differs,
stop and tell me rather than proceeding on my numbers:
  - apps/api/src/*zsibongo*.ts plus apps/api/src/jobs/*zsibongo*.ts = 37 files
  - apps/web/src/**/*Zsibongo* plus lib/zsibongoAuth.ts = 14 files
  - apps/api/db/migrations/*zsibongo*.sql = 63 files
  - 49 database tables referenced, 48 prefixed zsibongo_, plus `tenants`

STEP 2 - API
Copy the 37 zsibongo API files.
Copy these 10 shared modules they depend on. 8 are leaves with no further
local imports, so they come across clean:
  date-utils.ts, persistence-pg.ts, real-client-ip.ts, encryption-kms.ts,
  trial-gate.ts, registration-gate.ts, invite-auth.ts, auth-event-log.ts,
  shared/require-secret.ts, email/ses-client.ts
Copy packages/core wholesale as the @suite/core workspace package. Do not
try to tree-shake it in this pass.
Then resolve the import closure: keep following imports until nothing is
missing. If a module drags in another product (mk-*, qq-*, eskuvo-*,
dora-*), stop and tell me instead of copying that product in.

STEP 3 - SERVER BOOTSTRAP
Do not copy apps/api/src/server.ts. It is ~3900 lines serving five products.
Write a new server.ts that keeps the shared plumbing (pg pool, auth
middleware, tenant/RLS context, rate limit, multipart, error handling) and
registers ONLY:
  zsibongoRoutes, zsibongoBillingRoutes, zsibongoFinanceRoutes,
  zsibongoMonthlyReportRoutes, zsibongoIllnessRoutes,
  zsibongoSubstituteRoutes, zsibongoMedicationRoutes,
  registerZsibongoAuthRoutes,
  mountAdminZsibongoPurgeRoutes, mountAdminZsibongoOutbreakRoutes,
  mountAdminZsibongoProvisionRoutes
Read the original registration block at server.ts lines 3822-3828 and the
imports at 373-388 to get the exact options each one takes.

STEP 4 - WEB
Copy the 14 zsibongo view files and these shared ones:
  components/Toast.tsx, Modal.tsx, OnboardingWizard.tsx, MobileDock.tsx,
  IncidentsSection.tsx, lib/attendanceOutbox.ts
apps/web/src/api.ts is 4363 lines shared across all five products. Copy it,
then delete every export no zsibongo file imports. Work from the actual
import list in the 14 files, not from name prefixes. After pruning, tsc must
still pass. Tell me how many lines you removed.
Build a minimal App/router that mounts ZsibongoLoginView and ZsibongoView as
the entry points.

STEP 5 - MIGRATIONS
Copy the 63 zsibongo migrations plus 0001_init.sql.
From your copy of 0001_init, remove the invoices, payment_marks, quotes and
nav_credentials tables. They belong to other products. Keep tenants and users.
Renumber everything to a clean 0001-up sequence.
CRITICAL: 0074 and 0075 each appear TWICE in the source. Preserve real apply
order, do not sort by filename. Get the true order from git log on the files
if the numbering is ambiguous.
Carry the 32 existing rollbacks across and renumber them to match.
Then verify: apply the full chain to an empty Postgres and confirm all 49
tables exist and every FK resolves. If a zsibongo migration references a
table created by a non-zsibongo migration you did not copy, that is a real
finding. Report it, do not paper over it.

STEP 6 - CONFIG
New root package.json, pnpm-workspace.yaml, turbo.json, plus per-app
package.json and tsconfig. Base them on the originals.
API deps to keep: fastify, pg, @suite/core, jsonwebtoken, pdfkit,
@aws-sdk/client-kms, @aws-sdk/client-ses, @fastify/multipart,
@fastify/rate-limit, archiver, qrcode.
Check whether zsibongo-onboarding-extract.ts needs @anthropic-ai/sdk,
sharp or tesseract.js before you drop them.
Web deps: react, react-dom, posthog-js.
Replace the flat `node dist/X_test.js && ...` test chain with one that runs
only the zsibongo tests plus auth-middleware_test.
Write a .env.example listing every env var the code reads. Put NO real
values in it. Do not copy any .env file from the source repo.

STEP 7 - PROVE IT
Run and show me the output of:
  pnpm install
  pnpm build
  pnpm test
  tsc --noEmit in both apps
Then start the API against a local Postgres with the migrations applied and
curl one real zsibongo endpoint. Paste the response.
Do not tell me it is done until all of that is green. If something cannot be
made green, say exactly what and why, and leave it failing rather than
stubbing it out or deleting the test.

STEP 8 - WRITE IT DOWN
README.md covering: what the product is, how to run it locally, the env vars,
how to apply migrations, and the test command.
EXTRACTION-NOTES.md covering: what you changed versus the monorepo, what you
pruned from api.ts and 0001_init, the migration renumbering map old -> new,
and anything you could not cleanly separate.

RULES
- Never write to /home/iszzu/marveen-suite. Read only.
- No secrets, tokens or connection strings in the new repo.
- If a decision is genuinely ambiguous, ask me. Do not guess and move on.
- Do not create a GitHub repo or push. I will do that after I review it.

---END PROMPT---
