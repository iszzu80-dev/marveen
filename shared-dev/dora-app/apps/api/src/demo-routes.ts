import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

const DEMO_TTL_DAYS = Number(process.env.DEMO_TTL_DAYS ?? 14);

// Pre-seeded demo data: 3 controls, 1 EIR, partial readiness
const DEMO_SEED = {
  tenantName: 'Demo Szervezet Zrt.',
  securityClass: 'Alap' as const,
  controls: [
    { id: 'RISK-01',   title: 'Kockázatkezelési szabályzat',         status: 'partially_satisfied' },
    { id: 'ACCESS-01', title: 'Hozzáférés-felügyeleti szabályzat',   status: 'not_started' },
    { id: 'INC-01',    title: 'Incidenskezelési terv',               status: 'satisfied' },
  ],
  eir: {
    name: 'Core Banking System (Demo)',
    type: 'core_banking',
    statusState: 'operational',
    riskLevel: 'high',
  },
};

async function seedDemoData(pool: Pool, demoTenantId: string): Promise<void> {
  // Controls seed -- stored as JSONB blob in demo_workspaces.seed_data
  // Full control/EIR tables are seeded when those domain tables exist (future sprint)
  await pool.query(
    `UPDATE demo_workspaces SET seed_data = $2::jsonb WHERE tenant_id = $1`,
    [demoTenantId, JSON.stringify({ controls: DEMO_SEED.controls, eir: DEMO_SEED.eir })],
  );
}

export async function registerDemoRoutes(app: FastifyInstance, pool: Pool): Promise<void> {

  // POST /api/dora/demo
  // Creates a demo workspace with pre-seeded data. Auth NOT required (trial).
  // Response: { demoTenantId, apiKey, expiresAt, note }
  app.post('/api/dora/demo', async (_req, reply) => {
    const demoId = `demo-${uuidv4().slice(0, 8)}`;
    const apiKey = `demo-key-${uuidv4()}`;
    const expiresAt = new Date(Date.now() + DEMO_TTL_DAYS * 24 * 3600 * 1000).toISOString();

    await pool.query(
      `INSERT INTO tenants (id, name, api_key, metadata_json, created_at)
       VALUES ($1, $2, $3, $4::jsonb, now())`,
      [demoId, DEMO_SEED.tenantName, apiKey,
       JSON.stringify({ demo: true, expiresAt, securityClass: DEMO_SEED.securityClass })],
    );

    await pool.query(
      `INSERT INTO demo_workspaces (tenant_id, expires_at) VALUES ($1, $2)`,
      [demoId, expiresAt],
    );

    await seedDemoData(pool, demoId);

    return reply.send({
      demoTenantId: demoId,
      apiKey,
      expiresAt,
      note: `Demo workspace ${DEMO_TTL_DAYS} napig aktív. Nem szükséges regisztráció.`,
    });
  });

  // GET /api/dora/demo/status?tenantId=...
  // Response: { active, expiresAt, daysRemaining }
  app.get('/api/dora/demo/status', async (req, reply) => {
    const { tenantId } = req.query as { tenantId?: string };
    if (!tenantId) return reply.code(400).send({ error: 'tenantId kötelező.' });
    const r = await pool.query(
      `SELECT expires_at FROM demo_workspaces WHERE tenant_id = $1`,
      [tenantId],
    );
    if (r.rows.length === 0) return reply.code(404).send({ error: 'Demo workspace nem található.' });
    const expiresAt = new Date(r.rows[0].expires_at);
    const daysRemaining = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000));
    return reply.send({
      active: daysRemaining > 0,
      expiresAt: expiresAt.toISOString(),
      daysRemaining,
    });
  });
}
