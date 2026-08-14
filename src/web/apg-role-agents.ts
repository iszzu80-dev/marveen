// APG 1.9 §11.2 -- the bridge that lets the UI projection name a producer
// without the projection reaching across the sidecar boundary itself.
//
// ui-projection.ts is READ-ONLY against the APG kernel sidecar and says so in
// its first line; the `dispatches` table it would need lives in Marveen's own
// DB. So the projection declares an injection point (ProjectionRoleDeps) and
// this module is the one place that fills it, from costops/dispatch.ts's
// resolveCardRoleAgents.
//
// Fault isolation matches the rest of the measurement stack (createDispatchSafe,
// resolveDispatchIdentitySafe): a role lookup is ATTRIBUTION, so a DB fault
// degrades the field to null and the work-item list still renders. A projection
// that 500s because it could not name a producer would be a worse outcome than
// one that honestly says it does not know.

import type { ProjectionRoleDeps } from '../apg/ui-projection.js'
import { getDb } from '../db.js'
import { resolveCardRoleAgents } from '../costops/dispatch.js'
import { logger } from '../logger.js'

export function dispatchRoleDeps(): ProjectionRoleDeps {
  return {
    roleAgentsFor: (kanbanCardId: string) => {
      try {
        return resolveCardRoleAgents(getDb(), kanbanCardId)
      } catch (err) {
        logger.warn({ err, kanbanCardId }, 'apg role agents: dispatch store unreadable')
        return { producer: null, verifier: null, owner: null }
      }
    },
  }
}
