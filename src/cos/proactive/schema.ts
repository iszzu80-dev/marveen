// v1.4 Proactive Core — persistence (§4, §5, §7).
//
// Two tables, additive, domain-scoped, and deployed on demand rather than from
// initCosSchema. On demand because nothing in the live path touches them yet
// (§27 Stage 0), and a table that appears in production before anything writes
// to it is a table whose shape nobody has tested against real rows.
//
// The §3 rule — no parallel Case/progression subsystem — is why there is no
// status column here that duplicates a Case status, no scheduler column, and no
// claim column. A signal is not a Case and an Initiative is not a Case; when an
// Initiative needs a Case it points at one (`case_id`) and the existing Case
// machinery owns it from there.

import type Database from 'better-sqlite3'

export function ensureProactiveSchema(db: Database.Database): void {
  // ── proactive_signals (§4) ──────────────────────────────────────────
  //
  // `dedupe_key` is UNIQUE PER DOMAIN and not globally: the same external fact
  // can legitimately be a signal on both sides of the house (a shared supplier,
  // a shared deadline), and a global key would let the personal domain suppress
  // a corporate signal it is not allowed to know about. §20.3 domain separation
  // has to hold in the dedupe layer too, or the isolation is only skin deep.
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_signals (
      signal_id         TEXT PRIMARY KEY,
      domain            TEXT NOT NULL,
      signal_type       TEXT NOT NULL,
      source_refs_json  TEXT NOT NULL,
      source_event_ids_json TEXT NOT NULL,
      detected_at       INTEGER NOT NULL,
      subject_ref       TEXT,
      candidate_case_id TEXT,
      summary           TEXT NOT NULL,
      evidence_claims_json TEXT NOT NULL,
      estimated_materiality  TEXT NOT NULL,
      estimated_urgency      TEXT NOT NULL,
      estimated_actionability TEXT NOT NULL,
      candidate_deadline INTEGER,
      confidence        REAL NOT NULL,
      dedupe_key        TEXT NOT NULL,
      novelty_key       TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'DETECTED',
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      CHECK (domain IN ('personal','zst')),
      CHECK (status IN ('DETECTED','SUPPRESSED','PROMOTED','ANNOTATED')),
      CHECK (signal_type IN ('OPPORTUNITY','RISK','OBLIGATION','DEADLINE',
        'ANOMALY','STALL','CHANGE','GAP')),
      CHECK (estimated_materiality IN ('LOW','MEDIUM','HIGH','CRITICAL')),
      CHECK (estimated_urgency IN ('LOW','MEDIUM','HIGH','CRITICAL')),
      CHECK (estimated_actionability IN ('LOW','MEDIUM','HIGH'))
    )
  `)
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_psig_dedupe ON proactive_signals(domain, dedupe_key)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_psig_status ON proactive_signals(domain, status, detected_at)`)
  // §10.2 asks for a deadline index. Partial, because the overwhelming majority
  // of signals carry no deadline and an index over their NULLs is pure write
  // cost on the path that runs most often.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_psig_deadline ON proactive_signals(candidate_deadline)
           WHERE candidate_deadline IS NOT NULL`)

  // ── proactive_initiatives (§5) ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_initiatives (
      initiative_id     TEXT PRIMARY KEY,
      domain            TEXT NOT NULL,
      signal_ids_json   TEXT NOT NULL,
      initiative_type   TEXT NOT NULL,
      materiality       TEXT NOT NULL,
      urgency           TEXT NOT NULL,
      case_id           TEXT,
      desired_outcome_json TEXT NOT NULL,
      current_gap       TEXT NOT NULL,
      decision_deadline INTEGER,
      internal_safe_deadline INTEGER,
      allowed_preparation_classes_json TEXT NOT NULL,
      unresolved_requirements_json TEXT NOT NULL,
      user_interruption_required INTEGER NOT NULL DEFAULT 0,
      interruption_reason TEXT,
      state             TEXT NOT NULL DEFAULT 'QUALIFIED',
      confidence        REAL NOT NULL,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      CHECK (domain IN ('personal','zst')),
      CHECK (state IN ('QUALIFIED','LINKED_TO_CASE','PREPARING','WAITING_INTERNAL',
        'DECISION_READY','SUPPRESSED','RESOLVED'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pini_state ON proactive_initiatives(domain, state)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pini_case ON proactive_initiatives(case_id) WHERE case_id IS NOT NULL`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pini_deadline ON proactive_initiatives(decision_deadline)
           WHERE decision_deadline IS NOT NULL`)

  // ── proactive_qualifications (§6.2) ─────────────────────────────────
  //
  // Every verdict is written down, PROMOTE and SUPPRESS alike. §6.3 requires
  // suppression to be measurable and §7.2 requires the dedupe decision to be
  // replayable; a policy that only records what it let through can be evaluated
  // on precision and never on recall.
  db.exec(`
    CREATE TABLE IF NOT EXISTS proactive_qualifications (
      qualification_id  TEXT PRIMARY KEY,
      signal_id         TEXT NOT NULL,
      domain            TEXT NOT NULL,
      decision          TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      matched_case_id   TEXT,
      materiality_score REAL NOT NULL,
      urgency_score     REAL NOT NULL,
      actionability_score REAL NOT NULL,
      interruption_score REAL NOT NULL,
      confidence        REAL NOT NULL,
      decided_at        INTEGER NOT NULL,
      CHECK (decision IN ('SUPPRESS','ANNOTATE','PROMOTE'))
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pqual_signal ON proactive_qualifications(signal_id, decided_at)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pqual_decision ON proactive_qualifications(domain, decision, decided_at)`)
}
