---
name: test-tenant-registry-standing-rule
description: All agent-created test tenants must be registered in audits/test-user-registry.md
metadata:
  type: feedback
---

Istvan standing rule (2026-07-14, via deliverylead msg_id:14080): every agent-created test tenant/user must be registered in `audits/test-user-registry.md` immediately with: product, tenant-id, identifier, purpose, date. An unregistered test tenant is a rule violation. Applies to all agents (devops, qa, fullstackfejleszto, buildfejleszto, architect, scout, etc.).

**Why:** Prevent orphan test data accumulation. The JWT contamination incident (fb9488ea) showed what happens when test tenants proliferate without tracking -- 1145 test tenants had to be catalogued retroactively.

**How to apply:** After creating any test tenant, append a row to audits/test-user-registry.md before doing anything else. Format: `| product | tenant-id | identifier (who created it) | purpose | date |`
