import Fastify from 'fastify';
import { Pool } from 'pg';
import { registerInterviewRoutes } from './dora/interview-routes.js';
import { registerDemoRoutes } from './demo-routes.js';

export async function buildServer() {
  const app = Fastify({ logger: true });

  const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : null;

  // Simple auth: Bearer token = tenantId (demo-grade, no API key table).
  // For the DORA demo env the tenant creates their workspace via POST /api/dora/demo which
  // returns demoTenantId; that ID is used directly as the Bearer token for subsequent calls.
  // Public endpoints (POST /api/dora/demo, GET /health) skip auth.
  const PUBLIC_PATHS = new Set(['/api/dora/demo', '/health']);
  app.addHook('preHandler', async (req, reply) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0]!)) return;
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) {
      reply.code(401).send({ error: 'Authorization Bearer token szükséges.' });
      return;
    }
    (req as unknown as { tenantId: string }).tenantId = token;
  });

  if (pool) {
    await registerInterviewRoutes(app, pool);
    await registerDemoRoutes(app, pool);
  }

  return app;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = Number(process.env.PORT ?? 3000);
  buildServer().then(app => app.listen({ port, host: '0.0.0.0' }));
}
