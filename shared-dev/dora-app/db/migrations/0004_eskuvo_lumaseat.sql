-- 0004_eskuvo_lumaseat: LumaSeat Phase 1 — 5 tables + RLS + indexes.
-- Esküvő seating AI core schema. Run AFTER 0001_init.sql (tenants table must exist).

-- 1. Vendégek (guests)
CREATE TABLE IF NOT EXISTS eskuvo_guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  rsvp text NOT NULL DEFAULT 'pending'
    CHECK (rsvp IN ('confirmed','pending','declined','missing')),
  "group" text NOT NULL DEFAULT 'Mutual'
    CHECK ("group" IN ('Bride','Groom','Mutual','Kids','Vendor')),
  side text NOT NULL DEFAULT 'Both'
    CHECK (side IN ('Bride','Groom','Both')),
  dietary text,                              -- 'Vegetarian'|'Vegan'|'Gluten-free'|'Nut allergy'|'Halal'|'Kids meal'
  access_needs text,
  consent_dietary boolean NOT NULL DEFAULT false,
  consent_access_needs boolean NOT NULL DEFAULT false,
  dietary_retention_until timestamptz,       -- wedding_date + 30 days (fixed)
  vip boolean NOT NULL DEFAULT false,
  child boolean NOT NULL DEFAULT false,
  notes text,
  table_id uuid,
  seat_index int,
  keep_together_with text[] NOT NULL DEFAULT '{}',
  avoid_guest_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Asztalok (tables)
CREATE TABLE IF NOT EXISTS eskuvo_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  shape text NOT NULL DEFAULT 'round'
    CHECK (shape IN ('round','long')),
  x float NOT NULL DEFAULT 0,
  y float NOT NULL DEFAULT 0,
  width float NOT NULL DEFAULT 100,
  height float NOT NULL DEFAULT 100,
  capacity int NOT NULL DEFAULT 8,
  theme text,
  state text NOT NULL DEFAULT 'incomplete'
    CHECK (state IN ('balanced','incomplete','conflict')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Add FK from guests to tables after both tables exist
ALTER TABLE eskuvo_guests ADD CONSTRAINT fk_guests_table
  FOREIGN KEY (table_id) REFERENCES eskuvo_tables(id) ON DELETE SET NULL;

-- 3. Venue objektumok (venue objects / room layout)
CREATE TABLE IF NOT EXISTS eskuvo_venue_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  label text NOT NULL,
  type text NOT NULL
    CHECK (type IN ('dance','bar','dj','entrance','emergency','corridor','toilets','stage','buffet','dessert','gift','column','wall')),
  x float NOT NULL DEFAULT 0,
  y float NOT NULL DEFAULT 0,
  width float NOT NULL DEFAULT 100,
  height float NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Konfliktus szabályok (avoid rules)
CREATE TABLE IF NOT EXISTS eskuvo_avoid_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  guest_a_id uuid NOT NULL,
  guest_b_id uuid NOT NULL,
  reason text NOT NULL,
  severity text NOT NULL DEFAULT 'hard'
    CHECK (severity IN ('soft','hard')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, guest_a_id, guest_b_id)
);

-- 5. AI ültetési javaslatok (seating proposals, append-only)
CREATE TABLE IF NOT EXISTS eskuvo_seating_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  proposal_data jsonb NOT NULL DEFAULT '{}',
  table_snapshot jsonb NOT NULL DEFAULT '[]',
  guest_snapshot jsonb NOT NULL DEFAULT '[]',
  accepted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_eskuvo_guests_tenant ON eskuvo_guests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_eskuvo_tables_tenant ON eskuvo_tables(tenant_id);
CREATE INDEX IF NOT EXISTS idx_eskuvo_venue_objects_tenant ON eskuvo_venue_objects(tenant_id);
CREATE INDEX IF NOT EXISTS idx_eskuvo_avoid_rules_tenant ON eskuvo_avoid_rules(tenant_id);
CREATE INDEX IF NOT EXISTS idx_eskuvo_seating_proposals_tenant ON eskuvo_seating_proposals(tenant_id);
CREATE INDEX IF NOT EXISTS idx_eskuvo_guests_table ON eskuvo_guests(table_id) WHERE table_id IS NOT NULL;

-- RLS: enable on all tables
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['eskuvo_guests','eskuvo_tables','eskuvo_venue_objects','eskuvo_avoid_rules','eskuvo_seating_proposals'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY IF NOT EXISTS %I_select ON %I FOR SELECT USING (tenant_id = current_setting(''app.tenant_id''))', tbl, tbl);
    EXECUTE format('CREATE POLICY IF NOT EXISTS %I_insert ON %I FOR INSERT WITH CHECK (tenant_id = current_setting(''app.tenant_id''))', tbl, tbl);
    EXECUTE format('CREATE POLICY IF NOT EXISTS %I_update ON %I FOR UPDATE USING (tenant_id = current_setting(''app.tenant_id'')) WITH CHECK (tenant_id = current_setting(''app.tenant_id''))', tbl, tbl);
    EXECUTE format('CREATE POLICY IF NOT EXISTS %I_delete ON %I FOR DELETE USING (tenant_id = current_setting(''app.tenant_id''))', tbl, tbl);
  END LOOP;
END $$;
