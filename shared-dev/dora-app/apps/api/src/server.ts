import Fastify from 'fastify';
import { Pool } from 'pg';
import { registerInterviewRoutes } from './dora/interview-routes.js';
import { registerDemoRoutes } from './demo-routes.js';

export async function buildServer() {
  const app = Fastify({ logger: true });

  const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : null;

  // TODO: register auth middleware (tenant API key → req.tenantId)
  // Platform middleware (KMS, S3, audit-log) wired here.

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
