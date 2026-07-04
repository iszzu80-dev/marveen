-- 0006_dora_interview_mode_fix: fix mode CHECK constraint if the table was created with
-- old 'org'/'system' values (schema drift from pre-spec commit 262a5a2e).
-- Safe to run even if the table already has the correct constraint.
-- Transaction managed by the migrate runner (no BEGIN/COMMIT here).

DO $$
BEGIN
  -- Only migrate if table exists (it may not if 0005 was never run)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'dora_interview_sessions') THEN
    -- Drop the old constraint if it exists with old names
    ALTER TABLE dora_interview_sessions DROP CONSTRAINT IF EXISTS dora_interview_sessions_mode_check;

    -- Remap any old 'org' values to 'eligibility'
    UPDATE dora_interview_sessions SET mode = 'eligibility' WHERE mode = 'org';
    UPDATE dora_interview_sessions SET mode = 'system_scope' WHERE mode = 'system';

    -- Re-add with correct values (ADD CONSTRAINT ... IF NOT EXISTS not available pre-PG15;
    -- use the DROP+ADD pattern which is idempotent via the DROP above)
    ALTER TABLE dora_interview_sessions
      ADD CONSTRAINT dora_interview_sessions_mode_check
        CHECK (mode IN ('eligibility','system_scope'));
  END IF;
END;
$$;
