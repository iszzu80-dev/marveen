// Data-sensitivity dispatch gate — deterministic, token-free, fail-safe.
//
// Classifies content into sensitivity categories and decides whether a
// given provider is trusted to receive it. No LLM, no side effects, no
// I/O — pure logic, dependency-free, trivially testable.
//
// Design (Istvan-approved 2026-07-17, card 6bf535bf):
//   - Classify by TASK/CONTENT, not by agent role
//   - V1 categories: public / internal / restricted
//   - Anthropic/Claude = TRUSTED (all categories OK)
//   - DeepSeek/hosted = NEVER for restricted
//   - FAIL-SAFE: unknown → restricted
//   - Observe-only/dry-run FIRST, enforce after canary validation

export type SensitivityCategory = 'public' | 'internal' | 'restricted';

export interface SensitivityPattern {
  name: string;
  pattern: string;       // JS regex source (no flags — we add 'gi')
  description: string;
  context?: string;      // optional: co-occurring keyword within 100 chars
}

export interface GateConfig {
  mode: 'off' | 'observe-only' | 'enforce';
  enabled: boolean;
  auditLogRetentionDays: number;
  restricted: SensitivityPattern[];
  internal: SensitivityPattern[];
}

export type GateVerdict = 'allow' | 'would_block' | 'block';

export interface GateResult {
  verdict: GateVerdict;
  category: SensitivityCategory;
  matchedPatterns: string[];
  reason: string;
}

// Default patterns shipped in code so the gate has teeth even before
// store/data-sensitivity-gate.json is provisioned. Site operators can
// override via the store file; these are the factory defaults.
const DEFAULT_RESTRICTED: SensitivityPattern[] = [
  { name: 'email', pattern: '[\\w.+-]+@[\\w.-]+\\.[\\w]{2,}', description: 'Email address' },
  { name: 'api_key_header', pattern: '(?:Authorization|X-API-?Key|Bearer)[:\\s]+\\s*[A-Za-z0-9_\\-]{20,}', description: 'API key or bearer token in header format' },
  { name: 'jwt_token', pattern: 'eyJ[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{20,}\\.[A-Za-z0-9_\\-]{10,}', description: 'JWT token (base64url-encoded header.payload.signature)' },
  { name: 'db_connection_string', pattern: '(?:postgres(?:ql)?|mysql|mongodb|redis)://[^\\s]{10,}', description: 'Database connection string' },
  { name: 'render_api_key', pattern: 'rnd_[A-Za-z0-9]{20,}', description: 'Render API key prefix' },
  { name: 'private_key_pem', pattern: '-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----', description: 'PEM-encoded private key block' },
  { name: 'dash_bearer_token', pattern: 'Bearer\\s+[A-Za-z0-9_\\-]{20,}', description: 'Bearer token (dashboard / API auth header)' },
  { name: 'credit_card_number', pattern: '\\b\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}[\\s-]?\\d{4}\\b', description: 'Credit/debit card number (16-digit pattern)' },
  { name: 'hungarian_taj', pattern: '\\b\\d{3}\\s?\\d{3}\\s?\\d{3}\\b', context: 'taj|társadalombiztosítás|TB|social.security|OEP|NEAK|egészség', description: 'Hungarian TAJ number (9 digits near health/insurance context)' },
  { name: 'hungarian_tax_id', pattern: '\\b\\d{10}\\b', context: 'adószám|tax.id|adó|NAV|tax.number|tax_?id', description: 'Hungarian tax ID (10-digit number near tax context)' },
];

const DEFAULT_INTERNAL: SensitivityPattern[] = [
  { name: 'prod_db_name', pattern: 'suite-postgres-08wb|suite-postgres|production\\s+(?:db|database|postgres)', description: 'Production database name references' },
  { name: 'secret_key_name', pattern: 'DEEPSEEK_API_KEY|RENDER_API_KEY|DATABASE_URL_RUNTIME|ANTHROPIC_AUTH_TOKEN', description: 'Secret env-var or credential key name references' },
  { name: 'vault_path', pattern: 'store/vault\\.json|store/\\.dashboard-token|secrets\\.token_hex', description: 'Vault or secret-store path references' },
  { name: 'real_tenant_id', pattern: 'tenant_id\\s*[=:]\\s*[\'"]?[a-f0-9]{8,}[\'"]?', description: 'Real-looking tenant UUID reference' },
];

const DEFAULT_CONFIG: GateConfig = {
  mode: 'observe-only',
  enabled: true,
  auditLogRetentionDays: 90,
  restricted: DEFAULT_RESTRICTED,
  internal: DEFAULT_INTERNAL,
};

// ---- provider trust -----------------------------------------------------------

// Read from env TRUSTED_PROVIDERS (comma-separated provider prefixes).
// Model prefix claude-* matches "claude" → trusted. Everything else → non-trusted.
// Callers inject the resolved trusted set so this stays pure.
export function isProviderTrusted(
  modelName: string,
  trustedPrefixes: Set<string>,
): boolean {
  const lower = modelName.toLowerCase();
  for (const prefix of trustedPrefixes) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

// Parse TRUSTED_PROVIDERS env var. Callers do the env read; this stays pure.
export function parseTrustedProviders(raw: string | undefined): Set<string> {
  if (!raw || !raw.trim()) return new Set(['claude']); // safe default
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

// ---- content classification --------------------------------------------------

function compilePatterns(
  patterns: SensitivityPattern[],
): Array<{ name: string; re: RegExp; contextRe?: RegExp }> {
  return patterns.map((p) => {
    try {
      return {
        name: p.name,
        re: new RegExp(p.pattern, 'gi'),
        contextRe: p.context ? new RegExp(p.context, 'gi') : undefined,
      };
    } catch {
      // Invalid regex in config — skip this pattern (logged by caller).
      return { name: p.name, re: /(?!)/, contextRe: undefined }; // never matches
    }
  });
}

// Check if a context keyword appears within ~100 chars of a regex match.
// This reduces false positives on bare number patterns (e.g. 10-digit
// strings that only trigger when near "adoszam" or "tax").
function contextNearMatch(
  content: string,
  matchIndex: number,
  contextRe: RegExp,
): boolean {
  const windowStart = Math.max(0, matchIndex - 100);
  const windowEnd = Math.min(content.length, matchIndex + 100);
  const window = content.slice(windowStart, windowEnd);
  return contextRe.test(window);
}

export function classifyContent(
  content: string,
  config: GateConfig,
): { category: SensitivityCategory; matchedPatterns: string[] } {
  const restrictedCompiled = compilePatterns(config.restricted);
  const internalCompiled = compilePatterns(config.internal);

  const matchedRestricted: string[] = [];
  const matchedInternal: string[] = [];

  // Check restricted patterns first (higher severity).
  for (const { name, re, contextRe } of restrictedCompiled) {
    re.lastIndex = 0; // reset global regex state
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (contextRe && !contextNearMatch(content, m.index, contextRe)) {
        continue; // context keyword not nearby — skip this match
      }
      if (!matchedRestricted.includes(name)) {
        matchedRestricted.push(name);
      }
      // One match per pattern is enough for classification.
      break;
    }
  }

  if (matchedRestricted.length > 0) {
    return { category: 'restricted', matchedPatterns: matchedRestricted };
  }

  // Check internal patterns.
  for (const { name, re, contextRe } of internalCompiled) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (contextRe && !contextNearMatch(content, m.index, contextRe)) {
        continue;
      }
      if (!matchedInternal.includes(name)) {
        matchedInternal.push(name);
      }
      break;
    }
  }

  if (matchedInternal.length > 0) {
    return { category: 'internal', matchedPatterns: matchedInternal };
  }

  return { category: 'public', matchedPatterns: [] };
}

// ---- dispatch evaluation ------------------------------------------------------

const ALLOWED_CATEGORIES_FOR_UNTRUSTED = new Set<SensitivityCategory>([
  'public',
]);

export function evaluateDispatch(
  content: string,
  targetModel: string,
  config: GateConfig,
  trustedPrefixes: Set<string>,
): GateResult {
  // Gate fully disabled — allow everything.
  if (!config.enabled || config.mode === 'off') {
    return {
      verdict: 'allow',
      category: 'public',
      matchedPatterns: [],
      reason: 'gate disabled',
    };
  }

  const trusted = isProviderTrusted(targetModel, trustedPrefixes);

  // Trusted providers can receive anything — no classification needed.
  if (trusted) {
    return {
      verdict: 'allow',
      category: 'public',
      matchedPatterns: [],
      reason: `trusted provider (model=${targetModel})`,
    };
  }

  // Non-trusted provider — classify content.
  const { category, matchedPatterns } = classifyContent(content, config);

  // FAIL-SAFE: unknown category → treat as restricted.
  // (classifyContent never returns unknown, but defensive check.)
  const effectiveCategory: SensitivityCategory =
    category === 'public' || category === 'internal' || category === 'restricted'
      ? category
      : 'restricted';

  if (ALLOWED_CATEGORIES_FOR_UNTRUSTED.has(effectiveCategory)) {
    return {
      verdict: 'allow',
      category: effectiveCategory,
      matchedPatterns,
      reason: `content=${effectiveCategory}, non-trusted provider OK for this category`,
    };
  }

  // restricted/internal content → non-trusted provider → BLOCK (or would_block).
  const verdict = config.mode === 'enforce' ? 'block' : 'would_block';

  return {
    verdict,
    category: effectiveCategory,
    matchedPatterns,
    reason: `content=${effectiveCategory}, non-trusted provider (${targetModel}) — ${verdict}`,
  };
}

// ---- config normalization ----------------------------------------------------

export function normalizeConfig(raw: unknown): GateConfig {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const config: GateConfig = { ...DEFAULT_CONFIG };

  if (typeof o.mode === 'string' && ['off', 'observe-only', 'enforce'].includes(o.mode)) {
    config.mode = o.mode as GateConfig['mode'];
  }
  if (typeof o.enabled === 'boolean') {
    config.enabled = o.enabled;
  }
  if (typeof o.auditLogRetentionDays === 'number' && Number.isFinite(o.auditLogRetentionDays)) {
    config.auditLogRetentionDays = Math.max(1, Math.floor(o.auditLogRetentionDays));
  }
  // Validate and normalize patterns.
  if (Array.isArray(o.restricted)) {
    config.restricted = normalizePatterns(o.restricted);
  }
  if (Array.isArray(o.internal)) {
    config.internal = normalizePatterns(o.internal);
  }

  return config;
}

function normalizePatterns(raw: unknown): SensitivityPattern[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (p): p is Record<string, unknown> =>
        p && typeof p === 'object' && typeof (p as any).name === 'string' && typeof (p as any).pattern === 'string',
    )
    .map((p) => ({
      name: String(p.name).trim(),
      pattern: String(p.pattern),
      description: typeof p.description === 'string' ? p.description : '',
      context: typeof p.context === 'string' ? String(p.context) : undefined,
    }))
    .filter((p) => p.name.length > 0 && p.pattern.length > 0);
}
