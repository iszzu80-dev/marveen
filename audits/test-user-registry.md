# Test-User Registry — Marveen fleet

**Cél:** minden termék TESZT tenant/user-eit egy helyen nyilvántartani, hogy soha ne legyen "test vagy valós adat?" bizonytalanság (a 2026-07-13/14 JWT-tenant incidens fő oka pont ez volt). Istvan direktíva 2026-07-14.

## ÁLLANDÓ SZABÁLY (fleet-wide)
Mostantól **MINDEN** agent (marveen, qa/Falcon, uat/Scout, devops, bárki) által létrehozott TESZT tenant/user AZONNAL ide kerül. Egy nem-regisztrált test tenant = szabálysértés. A production/valós tenantok NEM kerülnek ide (ez kizárólag a test-adat provenance-nyilvántartása).

## 1. Canonical login test userek (termékenként, perzisztens)
A reset (2026-07-14) utáni tiszta baseline. Ezekkel lehet belépni a demókon túl a valós app-flow-ba.

| Termék | Landing | Tenant-id | Email | Jelszó | Létrehozva | Megjegyzés |
|--------|---------|-----------|-------|--------|-----------|------------|
| MikroKönyv | mikrokonyv-landing.onrender.com | af0244c5-6930-4c0a-b429-b2327f90b472 | teszt-mk-1784007403@marveen.local | store/test-user-creds.json | 2026-07-14 | canonical, admin-provision |
| QuickQuote | quickquote-landing.onrender.com | 7e3e8fd0-2c2e-441b-be53-7786d64504b7 | teszt-qq-1784007403@marveen.local | store/test-user-creds.json | 2026-07-14 | canonical, admin-provision |
| Zsibongó/Bölcsi | bolcsi-landing.onrender.com | 026cc4bcf990 | teszt-zsibongo-1784007404@marveen.local | store/test-user-creds.json | 2026-07-14 | canonical, admin-provision |
| Eskuvő | eskuvo-landing.onrender.com | 24e3889d-f65f-48da-9805-c7830db1c103 | teszt-eskuvo-1784007468@marveen.local | store/test-user-creds.json | 2026-07-14 | canonical, direct owner-insert, login-smoke 200 OK |
| DORA | dora-web.onrender.com | n/a (zero-auth demo) | n/a | n/a | - | public demo, nincs login |
| ZST Rádió | zstradio-landing.onrender.com | n/a (umbrella hub) | n/a | n/a | - | hub, az 5 aldomainre linkel, nincs saját app-login |

**Jelszavak:** NEM a git-be — a `store/test-user-creds.json` (chmod 600, gitignored) tartalmazza; Istvan a DM-jén kapta.
**Infra-jegyzet:** a PLATFORM_ADMIN_KEY hiányzott a suite-api-n, devops generálta+beállította a provisioninghoz (2026-07-14) -- új secret a suite-api Render-envben.

## 2. Fleet / QA / UAT test tenantok (append-only, standing rule)
Minden agent-generált test tenant ide (a reset ELŐTTI 1145 mind törölve; innen tiszta lap).

| Dátum | Agent | Termék | Tenant-id / azonosító | Cél (qa-smoke / uat-walk / probe / ...) |
|-------|-------|--------|----------------------|------------------------------------------|
| 2026-06-24 | (landing) | MikroKönyv | waitlist: dep***@example.com | waitlist teszt-signup (landing) |
| 2026-07-09 | (landing) | MikroKönyv | waitlist: del***@example.com | waitlist teszt-signup (landing) |
| 2026-07-13 | uat/Scout | Zsibongó/Bölcsi | waitlist: r5-6c09f32a-*@example-uat-test.invalid | Bölcsi waitlist-fix verify (card 6c09f32a) |
| 2026-07-14 | Mason | (suite, throwaway zonky:5433) | smoke-tenantok (törölve) | per-termék reset-smoke, izolált lokál DB, cleanup után nincs |

---
*Provenance-marker: minden itt szereplő tenant TESZT-adat. A registry az egyetlen forrás annak eldöntésére, mi test vs valós.*
