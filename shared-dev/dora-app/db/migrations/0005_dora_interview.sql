-- 0005_dora_interview: interview sessions + demo workspaces
-- RLS: every tenant sees only their own interview sessions.

CREATE TABLE IF NOT EXISTS dora_interview_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode                TEXT NOT NULL CHECK (mode IN ('eligibility','system_scope')),
  status              TEXT NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('in_progress','completed','abandoned')),
  current_question_id TEXT NOT NULL,
  answers             JSONB NOT NULL DEFAULT '[]',
  outcome             JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

ALTER TABLE dora_interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dora_interview_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY dora_interview_sessions_tenant ON dora_interview_sessions
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE INDEX IF NOT EXISTS idx_dora_interview_tenant ON dora_interview_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_dora_interview_status ON dora_interview_sessions(tenant_id, status);

-- Demo workspaces (expiry tracking + seed blob)
CREATE TABLE IF NOT EXISTS demo_workspaces (
  tenant_id   TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  seed_data   JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cleanup: demo_workspaces WHERE expires_at < now() → DELETE tenant CASCADE (napi cron job)
-- DEMO_TTL_DAYS configurable via env; default 14.
