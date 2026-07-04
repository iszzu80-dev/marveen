// Session state machine + DB persistence. Stateless between calls (session from DB).
import { Pool, type PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  getQuestionsForMode,
  getStartId,
} from '../../../../packages/core/src/dora/interview-questions.js';
import type {
  InterviewMode,
  InterviewSession,
  InterviewAnswer,
  InterviewOutcome,
} from '../../../../packages/core/src/dora/interview-types.js';

export class InterviewService {
  constructor(private pool: Pool) {}

  // Runs fn inside a transaction with app.tenant_id set for FORCE RLS policies.
  private async withRls<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async startInterview(tenantId: string, mode: InterviewMode): Promise<InterviewSession> {
    const id = uuidv4();
    const startId = getStartId(mode);
    const now = new Date().toISOString();

    await this.withRls(tenantId, async (c) => {
      await c.query(
        `INSERT INTO dora_interview_sessions
           (id, tenant_id, mode, status, current_question_id, answers, created_at)
         VALUES ($1, $2, $3, 'in_progress', $4, '[]'::jsonb, now())`,
        [id, tenantId, mode, startId],
      );
    });

    return {
      id, tenantId, mode, status: 'in_progress',
      currentQuestionId: startId,
      answers: [], createdAt: now,
    };
  }

  async getState(sessionId: string, tenantId: string): Promise<InterviewSession | null> {
    const r = await this.withRls(tenantId, (c) =>
      c.query(`SELECT * FROM dora_interview_sessions WHERE id = $1 AND tenant_id = $2`, [sessionId, tenantId]),
    );
    if (r.rows.length === 0) return null;
    return this._rowToSession(r.rows[0]);
  }

  async answer(
    sessionId: string,
    tenantId: string,
    value: string | string[],
  ): Promise<{ session: InterviewSession; nextQuestion?: object; outcome?: InterviewOutcome }> {
    const session = await this.getState(sessionId, tenantId);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'in_progress') throw new Error('Session already completed');

    const questions = getQuestionsForMode(session.mode);
    const current = questions[session.currentQuestionId];
    if (!current) throw new Error(`Unknown question: ${session.currentQuestionId}`);

    // Normalize to strings (guards against numeric values from JSON body)
    const selectedValues = (Array.isArray(value) ? value : [value]).map(String);

    const answer: InterviewAnswer = {
      questionId: current.id,
      value: selectedValues.length === 1 ? selectedValues[0]! : selectedValues,
      answeredAt: new Date().toISOString(),
    };
    const answers = [...session.answers, answer];

    let nextId: string | undefined;
    let outcome: InterviewOutcome | undefined;

    for (const opt of (current.options ?? [])) {
      if (selectedValues.includes(opt.value)) {
        if (opt.terminatesWith) { outcome = opt.terminatesWith; break; }
        if (opt.nextId) { nextId = opt.nextId; break; }
      }
    }
    if (!outcome && !nextId) nextId = current.defaultNextId;
    if (current.terminal && !outcome) {
      outcome = { inScope: true, reasoning: 'Interjú befejezve.' };
    }

    const status = outcome ? 'completed' : 'in_progress';
    const nextQuestionId = outcome ? session.currentQuestionId : (nextId ?? session.currentQuestionId);

    await this.withRls(tenantId, async (c) => {
      await c.query(
        `UPDATE dora_interview_sessions
         SET answers = $1::jsonb, current_question_id = $2, status = $3,
             outcome = $4::jsonb, completed_at = $5
         WHERE id = $6 AND tenant_id = $7`,
        [
          JSON.stringify(answers),
          nextQuestionId,
          status,
          outcome ? JSON.stringify(outcome) : null,
          outcome ? new Date().toISOString() : null,
          sessionId, tenantId,
        ],
      );
    });

    // Completed + nextMode → auto-start next mode session
    if (outcome?.nextMode) {
      const nextSession = await this.startInterview(tenantId, outcome.nextMode);
      const nextQuestions = getQuestionsForMode(outcome.nextMode);
      return {
        session: nextSession,
        nextQuestion: nextQuestions[nextSession.currentQuestionId],
        outcome,
      };
    }

    const updatedSession = await this.getState(sessionId, tenantId);
    const nextQuestion = nextId ? questions[nextId] : undefined;
    return { session: updatedSession!, nextQuestion, outcome };
  }

  private _rowToSession(row: Record<string, unknown>): InterviewSession {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      mode: row.mode as InterviewMode,
      status: row.status as InterviewSession['status'],
      currentQuestionId: row.current_question_id as string,
      answers: row.answers as InterviewAnswer[],
      outcome: row.outcome as InterviewOutcome | undefined,
      createdAt: (row.created_at as Date).toISOString(),
      completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : undefined,
    };
  }
}
