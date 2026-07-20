// Unit tests for data-sensitivity-gate.ts — pure logic, no I/O.
// Run: npx vitest run src/__tests__/data-sensitivity-gate.test.ts

import { describe, it, expect } from 'vitest';
import {
  classifyContent,
  evaluateDispatch,
  isProviderTrusted,
  parseTrustedProviders,
  normalizeConfig,
  type GateConfig,
} from '../data-sensitivity-gate.js';

// ---- test config -------------------------------------------------------------

const TEST_CONFIG: GateConfig = {
  mode: 'observe-only',
  enabled: true,
  auditLogRetentionDays: 90,
  restricted: [
    {
      name: 'email',
      pattern: '[\\w.+-]+@[\\w.-]+\\.[\\w]{2,}',
      description: 'Email address',
    },
    {
      name: 'api_key',
      pattern: '(?:Authorization|X-API-?Key|Bearer)[:\\s]+\\s*[A-Za-z0-9_\\-]{20,}',
      description: 'API key or bearer token',
    },
    {
      name: 'jwt',
      pattern: 'eyJ[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{10,}',
      description: 'JWT token',
    },
    {
      name: 'db_conn',
      pattern: 'postgres(?:ql)?://[^\\s]{10,}',
      description: 'DB connection string',
    },
    {
      name: 'credit_card',
      pattern: '\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b',
      description: 'Credit card number',
    },
    {
      name: 'tax_id_contextual',
      pattern: '\\b\\d{10}\\b',
      context: 'adószám|tax_id|NAV',
      description: 'Tax ID (contextual)',
    },
  ],
  internal: [
    {
      name: 'prod_db',
      pattern: 'suite-postgres-08wb',
      description: 'Production DB name',
    },
  ],
};

const TRUSTED = new Set(['claude']);

// ---- isProviderTrusted -------------------------------------------------------

describe('isProviderTrusted', () => {
  it('trusts claude-* models', () => {
    expect(isProviderTrusted('claude-opus-4-8[1m]', TRUSTED)).toBe(true);
    expect(isProviderTrusted('claude-sonnet-4-6', TRUSTED)).toBe(true);
    expect(isProviderTrusted('claude-haiku-4-5-20251001', TRUSTED)).toBe(true);
    expect(isProviderTrusted('CLAUDE-OPUS-4-8', TRUSTED)).toBe(true); // case insensitive
  });

  it('does not trust deepseek models', () => {
    expect(isProviderTrusted('deepseek-v4-pro', TRUSTED)).toBe(false);
    expect(isProviderTrusted('deepseek-v4-flash', TRUSTED)).toBe(false);
  });

  it('does not trust unknown/ollama models', () => {
    expect(isProviderTrusted('qwen-2.5', TRUSTED)).toBe(false);
    expect(isProviderTrusted('ollama', TRUSTED)).toBe(false);
  });

  it('empty model returns false', () => {
    expect(isProviderTrusted('', TRUSTED)).toBe(false);
  });
});

// ---- parseTrustedProviders ---------------------------------------------------

describe('parseTrustedProviders', () => {
  it('parses comma-separated list', () => {
    const result = parseTrustedProviders('claude,anthropic');
    expect(result.has('claude')).toBe(true);
    expect(result.has('anthropic')).toBe(true);
  });

  it('trims whitespace', () => {
    const result = parseTrustedProviders(' claude , anthropic ');
    expect(result.has('claude')).toBe(true);
    expect(result.has('anthropic')).toBe(true);
  });

  it('lowercases entries', () => {
    const result = parseTrustedProviders('Claude,ANTHROPIC');
    expect(result.has('claude')).toBe(true);
    expect(result.has('anthropic')).toBe(true);
  });

  it('defaults to claude on empty', () => {
    expect(parseTrustedProviders('').has('claude')).toBe(true);
    expect(parseTrustedProviders(undefined).has('claude')).toBe(true);
  });
});

// ---- classifyContent ---------------------------------------------------------

describe('classifyContent', () => {
  it('classifies plain text as public', () => {
    const result = classifyContent('Build a React component for the dashboard', TEST_CONFIG);
    expect(result.category).toBe('public');
    expect(result.matchedPatterns).toEqual([]);
  });

  it('classifies empty content as public', () => {
    const result = classifyContent('', TEST_CONFIG);
    expect(result.category).toBe('public');
  });

  it('detects email as restricted', () => {
    const result = classifyContent('Contact user@example.com for details', TEST_CONFIG);
    expect(result.category).toBe('restricted');
    expect(result.matchedPatterns).toContain('email');
  });

  it('detects API key header as restricted', () => {
    const result = classifyContent('Authorization: rnd_abc123def456ghijklmnopqrstuv', TEST_CONFIG);
    expect(result.category).toBe('restricted');
    expect(result.matchedPatterns).toContain('api_key');
  });

  it('detects JWT token as restricted', () => {
    const result = classifyContent(
      'Here is the token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      TEST_CONFIG,
    );
    expect(result.category).toBe('restricted');
    expect(result.matchedPatterns).toContain('jwt');
  });

  it('detects DB connection string as restricted', () => {
    const result = classifyContent('Connect to postgresql://user:pass@host:5432/db', TEST_CONFIG);
    expect(result.category).toBe('restricted');
    expect(result.matchedPatterns).toContain('db_conn');
  });

  it('detects credit card number as restricted', () => {
    const result = classifyContent('Card: 4111-1111-1111-1111 expires 12/28', TEST_CONFIG);
    expect(result.category).toBe('restricted');
    expect(result.matchedPatterns).toContain('credit_card');
  });

  it('detects tax ID with context keyword', () => {
    const result = classifyContent('Az adószám: 1234567890 ellenőrizve', TEST_CONFIG);
    expect(result.category).toBe('restricted');
    expect(result.matchedPatterns).toContain('tax_id_contextual');
  });

  it('does NOT flag 10-digit number without tax context', () => {
    const result = classifyContent('The port number is 1234567890 for this service', TEST_CONFIG);
    // Should NOT match tax_id_contextual because no "adószám|tax_id|NAV" nearby
    expect(result.matchedPatterns).not.toContain('tax_id_contextual');
  });

  it('detects prod DB name as internal', () => {
    const result = classifyContent('Deploy to suite-postgres-08wb tonight', TEST_CONFIG);
    expect(result.category).toBe('internal');
    expect(result.matchedPatterns).toContain('prod_db');
  });

  it('restricted beats internal (higher severity)', () => {
    const result = classifyContent(
      'Deploy to suite-postgres-08wb, admin@example.com is the contact',
      TEST_CONFIG,
    );
    expect(result.category).toBe('restricted');
    expect(result.matchedPatterns).toContain('email');
  });

  it('multiple restricted patterns all reported', () => {
    const result = classifyContent(
      'Email admin@example.com with token Bearer abcdefghijklmnopqrstuvwxyz123',
      TEST_CONFIG,
    );
    expect(result.category).toBe('restricted');
    expect(result.matchedPatterns).toContain('email');
    expect(result.matchedPatterns).toContain('api_key');
  });
});

// ---- evaluateDispatch --------------------------------------------------------

describe('evaluateDispatch', () => {
  it('allows public content on non-trusted provider', () => {
    const result = evaluateDispatch(
      'Build a React component',
      'deepseek-v4-pro',
      TEST_CONFIG,
      TRUSTED,
    );
    expect(result.verdict).toBe('allow');
    expect(result.category).toBe('public');
  });

  it('allows restricted content on trusted provider (Claude)', () => {
    const result = evaluateDispatch(
      'Email admin@example.com about the deploy',
      'claude-opus-4-8[1m]',
      TEST_CONFIG,
      TRUSTED,
    );
    expect(result.verdict).toBe('allow');
  });

  it('would_block restricted content on DeepSeek (observe-only)', () => {
    const result = evaluateDispatch(
      'Email admin@example.com with the API key',
      'deepseek-v4-pro',
      TEST_CONFIG,
      TRUSTED,
    );
    expect(result.verdict).toBe('would_block');
    expect(result.category).toBe('restricted');
  });

  it('blocks restricted content on DeepSeek in enforce mode', () => {
    const enforceConfig: GateConfig = { ...TEST_CONFIG, mode: 'enforce' };
    const result = evaluateDispatch(
      'Here is the JWT: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
      'deepseek-v4-pro',
      enforceConfig,
      TRUSTED,
    );
    expect(result.verdict).toBe('block');
  });

  it('allows everything when gate is disabled', () => {
    const offConfig: GateConfig = { ...TEST_CONFIG, enabled: false };
    const result = evaluateDispatch(
      'Email admin@example.com with secret key',
      'deepseek-v4-pro',
      offConfig,
      TRUSTED,
    );
    expect(result.verdict).toBe('allow');
  });

  it('allows everything in off mode', () => {
    const offConfig: GateConfig = { ...TEST_CONFIG, mode: 'off' };
    const result = evaluateDispatch(
      'Secret: postgresql://user:pass@host/db',
      'deepseek-v4-pro',
      offConfig,
      TRUSTED,
    );
    expect(result.verdict).toBe('allow');
  });

  it('allows internal content on trusted provider', () => {
    const result = evaluateDispatch(
      'Backup suite-postgres-08wb before migration',
      'claude-sonnet-4-6',
      TEST_CONFIG,
      TRUSTED,
    );
    expect(result.verdict).toBe('allow');
  });

  it('would_block internal content on DeepSeek', () => {
    const result = evaluateDispatch(
      'Backup suite-postgres-08wb before migration',
      'deepseek-v4-flash',
      TEST_CONFIG,
      TRUSTED,
    );
    // internal is not in ALLOWED_CATEGORIES_FOR_UNTRUSTED
    expect(result.verdict).toBe('would_block');
    expect(result.category).toBe('internal');
  });

  it('handles empty content safely', () => {
    const result = evaluateDispatch('', 'deepseek-v4-pro', TEST_CONFIG, TRUSTED);
    expect(result.verdict).toBe('allow');
    expect(result.category).toBe('public');
  });

  it('unknown model on trusted list still passes', () => {
    // multi-provider: "claude" and "anthropic" both trusted
    const multi = new Set(['claude', 'anthropic']);
    const result = evaluateDispatch(
      'Email admin@example.com',
      'anthropic-claude-sonnet-4-6',
      TEST_CONFIG,
      multi,
    );
    expect(result.verdict).toBe('allow');
  });
});

// ---- normalizeConfig ---------------------------------------------------------

describe('normalizeConfig', () => {
  it('returns defaults for empty input', () => {
    const config = normalizeConfig({});
    expect(config.mode).toBe('observe-only');
    expect(config.enabled).toBe(true);
    // Factory defaults ship 10 restricted + 4 internal patterns; empty input
    // does NOT mean empty patterns — it means "use the code defaults."
    expect(config.restricted.length).toBeGreaterThanOrEqual(1);
    expect(config.internal.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects invalid patterns gracefully', () => {
    const config = normalizeConfig({
      restricted: [
        { name: 'ok', pattern: '\\d+' },
        { bad: 'no pattern field' },          // missing pattern -> dropped
        { name: '', pattern: '' },             // empty -> dropped
        'not an object',                       // not object -> dropped
      ],
    });
    expect(config.restricted).toHaveLength(1);
    expect(config.restricted[0].name).toBe('ok');
  });

  it('rejects invalid mode values', () => {
    const config = normalizeConfig({ mode: 'aggressive' });
    expect(config.mode).toBe('observe-only'); // default
  });

  it('accepts valid mode values', () => {
    expect(normalizeConfig({ mode: 'off' }).mode).toBe('off');
    expect(normalizeConfig({ mode: 'observe-only' }).mode).toBe('observe-only');
    expect(normalizeConfig({ mode: 'enforce' }).mode).toBe('enforce');
  });
});

// ---- regression: common false-positive scenarios -----------------------------

describe('false-positive resistance', () => {
  it('code with hex hashes is not flagged', () => {
    const result = classifyContent(
      'commit b3f4b3678fc62febf64a3894283cfa4620156e2c on branch main',
      TEST_CONFIG,
    );
    expect(result.category).toBe('public');
  });

  it('normal task description is public', () => {
    const result = classifyContent(
      'Build a kanban board with drag-and-drop and PostgreSQL persistence',
      TEST_CONFIG,
    );
    expect(result.category).toBe('public');
  });

  it('inter-agent message without secrets is public', () => {
    const result = classifyContent(
      'Checker exits 0 -- all tenant-scoped tables have ENABLE ROW LEVEL SECURITY.',
      TEST_CONFIG,
    );
    expect(result.category).toBe('public');
  });

  it('10-digit port number without tax context is not flagged', () => {
    const result = classifyContent(
      'The service listens on port 8080 and the PID is 1234567890',
      TEST_CONFIG,
    );
    expect(result.matchedPatterns).not.toContain('tax_id_contextual');
  });

  it('ISO date ranges do NOT false-positive on credit card pattern', () => {
    // Date format "2024-01-01" has digit groups 4-2-2, not 4-4-4-4.
    // The credit card pattern correctly requires 4-digit groups and skips these.
    const result = classifyContent(
      'Period: 2024-01-01 to 2026-12-31',
      TEST_CONFIG,
    );
    expect(result.category).toBe('public');
  });
});
