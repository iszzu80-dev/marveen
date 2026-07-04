import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { InterviewService } from './interview-service.js';
import { getQuestionsForMode } from '../../../../packages/core/src/dora/interview-questions.js';

export async function registerInterviewRoutes(app: FastifyInstance, pool: Pool): Promise<void> {
  const svc = new InterviewService(pool);

  // POST /api/dora/interview/start
  // Body: { mode: 'eligibility' | 'system_scope' }
  // Response: { sessionId, mode, currentQuestion }
  app.post('/api/dora/interview/start', async (req, reply) => {
    const { tenantId } = req as unknown as { tenantId: string };
    const body = (req.body ?? {}) as { mode?: string };
    if (!body.mode || !['eligibility', 'system_scope'].includes(body.mode)) {
      return reply.code(400).send({ error: 'mode (eligibility|system_scope) kötelező.' });
    }
    const mode = body.mode as 'eligibility' | 'system_scope';
    const session = await svc.startInterview(tenantId, mode);
    const questions = getQuestionsForMode(mode);
    return reply.send({
      sessionId: session.id,
      mode: session.mode,
      currentQuestion: questions[session.currentQuestionId],
    });
  });

  // POST /api/dora/interview/answer
  // Body: { sessionId, value: string | string[] }
  // Response: { completed, nextQuestion?, outcome?, nextSessionId? }
  app.post('/api/dora/interview/answer', async (req, reply) => {
    const { tenantId } = req as unknown as { tenantId: string };
    const body = (req.body ?? {}) as { sessionId?: string; value?: unknown };
    if (!body.sessionId || body.value === undefined) {
      return reply.code(400).send({ error: 'sessionId + value kötelező.' });
    }
    // Normalize value: JSON numbers/booleans become strings so option matching is safe.
    const rawValue = body.value;
    const value: string | string[] = Array.isArray(rawValue)
      ? (rawValue as unknown[]).map((v) => String(v))
      : String(rawValue);
    try {
      const result = await svc.answer(body.sessionId, tenantId, value);
      // When eligibility completes and system_scope auto-starts, result.session is the NEW
      // system_scope session (in_progress). The outcome carries the eligibility result.
      const autoStarted = result.outcome?.nextMode != null;
      return reply.send({
        completed: !autoStarted && result.session.status === 'completed',
        sessionId: result.session.id,
        nextQuestion: result.nextQuestion ?? null,
        outcome: result.outcome ?? null,
        // Explicit signal to the frontend that a new mode session has been auto-created.
        autoStartedMode: autoStarted ? result.outcome!.nextMode : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return reply.code(404).send({ error: msg });
      if (msg.includes('completed')) return reply.code(409).send({ error: msg });
      throw err;
    }
  });

  // GET /api/dora/interview/state?sessionId=...
  // Response: InterviewSession + currentQuestion
  app.get('/api/dora/interview/state', async (req, reply) => {
    const { tenantId } = req as unknown as { tenantId: string };
    const { sessionId } = (req.query as { sessionId?: string });
    if (!sessionId) return reply.code(400).send({ error: 'sessionId kötelező.' });
    const session = await svc.getState(sessionId, tenantId);
    if (!session) return reply.code(404).send({ error: 'Session not found.' });
    const questions = getQuestionsForMode(session.mode);
    return reply.send({
      ...session,
      currentQuestion: questions[session.currentQuestionId] ?? null,
    });
  });
}
