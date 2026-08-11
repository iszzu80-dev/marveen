// P2-C: the dispatch IDENTITY columns are actually POPULATED.
//
// The gap these tests close: P2-A created `dispatches` with model_profile,
// configured_model, runtime_model, provider, auth_profile and billing_mode, and
// threaded a dispatch_id from every origin -- but no origin ever wrote those
// columns. A real live row (agent fullstackfejleszto, source 'message') read:
//
//   model_profile NULL configured_model NULL runtime_model NULL
//   provider NULL      auth_profile NULL     billing_mode NULL
//
// so spec 7.5's grouping of cost_per_accepted_task by agent / modelProfile /
// model / provider / billingMode could only group by `agent`. Every guard below
// is written to be able to go RED: the origin assertions fail if the stamping is
// removed from that origin, the provider assertions fail if a second/hardcoded
// provider mapping replaces deriveProvider, the billing assertions fail if the
// mode is ever derived from the provider NAME, and the fault-isolation
// assertions fail if the try/catch around the resolver is removed.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initDatabase, getDb } from '../db.js';
import { DEFAULT_AGENT_MODEL } from '../config.js';
import { createDispatch, recordOutcome, costPerAcceptedTask, loadBillingMap, resolveBillingMode, } from '../costops/dispatch.js';
import { deriveProvider } from '../costops/pricing.js';
import { resolveDispatchIdentity, resolveDispatchIdentitySafe, resolveAuthProfile, configDirIdentifier, UNRESOLVED_DISPATCH_IDENTITY, HOST_DEFAULT_AUTH_PROFILE, defaultDispatchIdentityDeps, } from '../costops/dispatch-identity.js';
import { resolveAgentModelDetailed, readAgentModelProfile } from '../web/agent-config.js';
import { resolveAgentConfigDir } from '../web/claude-plans.js';
const read = (rel) => readFileSync(join(__dirname, rel), 'utf-8');
const KANBAN = read('../web/routes/kanban.ts');
const ROUTER = read('../web/message-router.ts');
const SCHEDULE = read('../web/schedule-runner.ts');
const WORKER = read('../web/agent-worker.ts');
const IDENTITY = read('../costops/dispatch-identity.ts');
const HOME = '/home/fixture';
/** Fully injected deps -- no fs, no real agent dirs. */
function deps(over = {}) {
    return {
        resolveModel: () => ({ model: 'claude-opus-4-8', source: 'explicit_model' }),
        readModelProfile: () => null,
        resolveConfigDir: () => ({ configDir: null, planId: null, planUnresolved: false }),
        deriveProvider,
        loadBillingMap: () => null,
        homeDir: HOME,
        ...over,
    };
}
// ---------------------------------------------------------------------------
// 1. every origin stamps the identity columns
// ---------------------------------------------------------------------------
describe('P2-C: every dispatch origin stamps the identity columns', () => {
    it('kanban stamps from the TARGET agent', () => {
        expect(KANBAN).toMatch(/import \{ resolveDispatchIdentitySafe \} from '\.\.\/\.\.\/costops\/dispatch-identity\.js'/);
        expect(KANBAN).toMatch(/createDispatchSafe\(getDb\(\), \{[\s\S]{0,400}?\.\.\.resolveDispatchIdentitySafe\(target\),/);
    });
    it('the inter-agent router stamps from the RECEIVING agent (the one that burns the tokens)', () => {
        expect(ROUTER).toMatch(/import \{ resolveDispatchIdentitySafe \} from '\.\.\/costops\/dispatch-identity\.js'/);
        expect(ROUTER).toMatch(/createDispatchSafe\(getDb\(\), \{[\s\S]{0,400}?\.\.\.resolveDispatchIdentitySafe\(msg\.to_agent\),/);
    });
    it('the scheduler stamps from the target agent', () => {
        expect(SCHEDULE).toMatch(/import \{ resolveDispatchIdentitySafe \} from '\.\.\/costops\/dispatch-identity\.js'/);
        expect(SCHEDULE).toMatch(/createDispatchSafe\(getDb\(\), \{[\s\S]{0,400}?\.\.\.resolveDispatchIdentitySafe\(agentName\),/);
    });
    it('the reinject path reuses the SAME dispatch row, so it needs no second stamp', () => {
        // Exactly one mint in the scheduler: origin (e) reinjection passes the same
        // dispatchId through. A second createDispatchSafe here would mean the
        // swallowed-Enter retry is being counted as a new work package.
        expect(SCHEDULE.match(/createDispatchSafe\(/g)?.length).toBe(1);
        expect(SCHEDULE).toMatch(/sendPromptToSession\(session, fullPrompt, host, \{ waitForIdle: false, dispatchId \}\)/);
    });
    it('the worker stamps its OWN launched model + config dir, not the main agent id alone', () => {
        expect(WORKER).toMatch(/import \{ resolveDispatchIdentitySafe \} from '\.\.\/costops\/dispatch-identity\.js'/);
        expect(WORKER).toMatch(/\.\.\.resolveDispatchIdentitySafe\(MAIN_AGENT_ID, \{[\s\S]{0,200}?configuredModel: WORKER_MODEL,[\s\S]{0,200}?configDir: ctx\.configDir,/);
        // Resolving the worker's identity from MAIN_AGENT_ID alone would stamp the
        // MAIN pane's model + login onto worker requests; that mistake must stay out.
        expect(WORKER).not.toMatch(/resolveDispatchIdentitySafe\(MAIN_AGENT_ID\)/);
    });
    it('stamping rides inside the existing createDispatchSafe fault isolation at every origin', () => {
        // The spread is an ARGUMENT of createDispatchSafe, never a separate
        // unprotected statement before the send.
        for (const src of [KANBAN, ROUTER, SCHEDULE, WORKER]) {
            const spreads = src.match(/\.\.\.resolveDispatchIdentitySafe\(/g)?.length ?? 0;
            expect(spreads).toBe(1);
            expect(src).toMatch(/createDispatchSafe\(getDb\(\), \{[\s\S]{0,600}?\.\.\.resolveDispatchIdentitySafe\(/);
        }
    });
});
// ---------------------------------------------------------------------------
// 2. model + profile come from the Phase 1 resolver
// ---------------------------------------------------------------------------
describe('P2-C: configured_model / model_profile reuse the Phase 1 resolver', () => {
    it('wires resolveAgentModelDetailed + readAgentModelProfile as the default deps (no second resolver)', () => {
        expect(defaultDispatchIdentityDeps().resolveModel).toBe(resolveAgentModelDetailed);
        expect(defaultDispatchIdentityDeps().readModelProfile).toBe(readAgentModelProfile);
        expect(defaultDispatchIdentityDeps().resolveConfigDir).toBe(resolveAgentConfigDir);
    });
    it('takes the resolved model as configured_model', () => {
        const id = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: 'claude-sonnet-5', source: 'explicit_model' }),
        }));
        expect(id.configuredModel).toBe('claude-sonnet-5');
        expect(id.modelProfile).toBeNull();
    });
    it('stamps model_profile when the profile was HONOURED', () => {
        const id = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: 'claude-sonnet-5', source: 'model_profile' }),
            readModelProfile: () => 'build_strong',
        }));
        expect(id.modelProfile).toBe('build_strong');
        expect(id.configuredModel).toBe('claude-sonnet-5');
    });
    it('leaves model_profile NULL when the configured profile could NOT be honoured', () => {
        // Broken/missing map: the agent runs on the install default, so attributing
        // this cost to the named profile would misreport which profile it ran on.
        const id = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: DEFAULT_AGENT_MODEL, source: 'default', error: 'model_profile_map_missing' }),
            readModelProfile: () => 'build_strong',
        }));
        expect(id.modelProfile).toBeNull();
        expect(id.configuredModel).toBe(DEFAULT_AGENT_MODEL);
    });
});
// ---------------------------------------------------------------------------
// 3. Phase 2 invariant: configured === runtime (no runtime routing exists yet)
// ---------------------------------------------------------------------------
describe('P2-C: Phase 2 has NO runtime routing, so runtime_model === configured_model', () => {
    for (const model of ['claude-opus-4-8[1m]', 'claude-sonnet-5', 'deepseek-v4-pro']) {
        it(`holds for ${model}`, () => {
            const id = resolveDispatchIdentity('a', {}, deps({
                resolveModel: () => ({ model, source: 'explicit_model' }),
            }));
            expect(id.runtimeModel).toBe(id.configuredModel);
            expect(id.runtimeModel).toBe(model);
        });
    }
    it('holds for the worker override path too', () => {
        const id = resolveDispatchIdentity('main', { configuredModel: 'claude-haiku-4-5' }, deps());
        expect(id.configuredModel).toBe('claude-haiku-4-5');
        expect(id.runtimeModel).toBe('claude-haiku-4-5');
    });
    it('derives runtime_model in exactly ONE place, unconditionally (no routing branch)', () => {
        // A Phase-3 style router would need a second assignment or a conditional; a
        // single unconditional `runtimeModel: configuredModel` is the whole story.
        expect(IDENTITY.match(/runtimeModel: configuredModel/g)?.length).toBe(1);
        expect(IDENTITY.match(/runtimeModel:/g)?.length).toBe(3); // interface + sentinel + the assignment
    });
});
// ---------------------------------------------------------------------------
// 4. provider comes from deriveProvider -- never a second mapping
// ---------------------------------------------------------------------------
describe('P2-C: provider comes from pricing.ts deriveProvider', () => {
    it('uses the pricing.ts export BY REFERENCE (a duplicate mapping would fail this)', () => {
        expect(defaultDispatchIdentityDeps().deriveProvider).toBe(deriveProvider);
    });
    it('returns whatever the injected deriveProvider says -- not a hardcoded string', () => {
        const id = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: 'claude-opus-4-8', source: 'explicit_model' }),
            deriveProvider: () => 'p2c-sentinel-provider',
        }));
        expect(id.provider).toBe('p2c-sentinel-provider');
    });
    it('passes the CONFIGURED model into it (so an anthropic id is not classified from the agent name)', () => {
        const seen = [];
        resolveDispatchIdentity('deepseek-agent', {}, deps({
            resolveModel: () => ({ model: 'deepseek-v4-pro', source: 'explicit_model' }),
            deriveProvider: (m) => { seen.push(m); return deriveProvider(m); },
        }));
        expect(seen).toEqual(['deepseek-v4-pro']);
    });
    it('carries no provider-name table of its own', () => {
        // deriveProvider's regex vocabulary must exist in exactly one module.
        expect(IDENTITY).not.toMatch(/'anthropic'|'openai'|'deepseek'|'google'|'xai'|'mistral'|'meta'/);
    });
});
// ---------------------------------------------------------------------------
// 5. auth_profile
// ---------------------------------------------------------------------------
describe('P2-C: auth_profile reads the launcher-owned per-agent login binding', () => {
    it('is the named plan id when the agent has a resolved plan', () => {
        const p = resolveAuthProfile('a', {
            resolveConfigDir: () => ({ configDir: `${HOME}/.claude-team`, planId: 'company-team', planUnresolved: false }),
            homeDir: HOME,
        });
        expect(p).toBe('plan:company-team');
    });
    it('is the home-relative config dir when only the raw claudeConfigDir is set', () => {
        const p = resolveAuthProfile('a', {
            resolveConfigDir: () => ({ configDir: `${HOME}/.claude-personal`, planId: null, planUnresolved: false }),
            homeDir: HOME,
        });
        expect(p).toBe('configdir:.claude-personal');
    });
    it('falls back to the raw dir (not the dangling id) when the plan no longer resolves', () => {
        const p = resolveAuthProfile('a', {
            resolveConfigDir: () => ({ configDir: `${HOME}/.claude-personal`, planId: null, planUnresolved: true }),
            homeDir: HOME,
        });
        expect(p).toBe('configdir:.claude-personal');
    });
    it('is the host-default constant when the agent binds no plan and no config dir', () => {
        const p = resolveAuthProfile('a', {
            resolveConfigDir: () => ({ configDir: null, planId: null, planUnresolved: false }),
            homeDir: HOME,
        });
        expect(p).toBe(HOST_DEFAULT_AUTH_PROFILE);
    });
    it('never stores an absolute path (no OS username reaches the DB)', () => {
        for (const dir of [`${HOME}/.claude-personal`, `${HOME}/.marveen-worker/.claude-config`, HOME, '/var/lib/claude-x']) {
            const ident = configDirIdentifier(dir, HOME);
            expect(ident).not.toContain(HOME);
            expect(ident.startsWith('/')).toBe(false);
        }
    });
    it('keeps the two worker logins distinct (home-relative, not basename)', () => {
        expect(configDirIdentifier(`${HOME}/.marveen-worker/.claude-config`, HOME))
            .toBe('.marveen-worker/.claude-config');
        expect(configDirIdentifier(`${HOME}/.marveen-worker-fast/.claude-config`, HOME))
            .toBe('.marveen-worker-fast/.claude-config');
        expect(configDirIdentifier(HOME, HOME)).toBe('home');
        // Outside $HOME: deliberately lossy basename rather than an absolute path.
        expect(configDirIdentifier('/var/lib/claude-x', HOME)).toBe('claude-x');
    });
    it('honours an origin-supplied config dir (the worker\'s isolated login)', () => {
        const id = resolveDispatchIdentity('main', { configDir: `${HOME}/.marveen-worker/.claude-config` }, deps({
            // The AGENT would resolve to a different login; the override must win.
            resolveConfigDir: () => ({ configDir: `${HOME}/.claude-personal`, planId: null, planUnresolved: false }),
        }));
        expect(id.authProfile).toBe('configdir:.marveen-worker/.claude-config');
    });
});
// ---------------------------------------------------------------------------
// 6. billing_mode is config-driven, never a provider-name heuristic
// ---------------------------------------------------------------------------
describe('P2-C: billing_mode is resolved from the billing map only', () => {
    const map = {
        version: 1,
        entries: [{ provider: 'anthropic', auth_profile: 'plan:company-team', billing_mode: 'subscription_included' }],
    };
    it("is 'unknown' with no billing map at all", () => {
        const id = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: 'claude-opus-4-8', source: 'explicit_model' }),
            resolveConfigDir: () => ({ configDir: null, planId: 'company-team', planUnresolved: false }),
            loadBillingMap: () => null,
        }));
        expect(id.provider).toBe('anthropic');
        expect(id.authProfile).toBe('plan:company-team');
        // A well-known provider name must NOT buy a free/included mode.
        expect(id.billingMode).toBe('unknown');
    });
    it('is the CONFIGURED value when the (provider, auth_profile) pair is mapped', () => {
        const id = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: 'claude-opus-4-8', source: 'explicit_model' }),
            resolveConfigDir: () => ({ configDir: null, planId: 'company-team', planUnresolved: false }),
            loadBillingMap: () => map,
        }));
        expect(id.billingMode).toBe('subscription_included');
    });
    it("is 'unknown' for the SAME provider on an unmapped auth_profile (not provider-name derived)", () => {
        // This is the guard: a provider-name heuristic would answer
        // 'subscription_included' here because the provider is still 'anthropic'.
        const id = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: 'claude-opus-4-8', source: 'explicit_model' }),
            resolveConfigDir: () => ({ configDir: `${HOME}/.claude-other`, planId: null, planUnresolved: false }),
            loadBillingMap: () => map,
        }));
        expect(id.provider).toBe('anthropic');
        expect(id.authProfile).toBe('configdir:.claude-other');
        expect(id.billingMode).toBe('unknown');
    });
    it("is 'unknown' for a mapped auth_profile under a DIFFERENT provider", () => {
        const id = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: 'deepseek-v4-pro', source: 'explicit_model' }),
            resolveConfigDir: () => ({ configDir: null, planId: 'company-team', planUnresolved: false }),
            loadBillingMap: () => map,
        }));
        expect(id.provider).toBe('deepseek');
        expect(id.billingMode).toBe('unknown');
    });
    it('the committed example documents the auth_profile key space P2-C really produces', () => {
        // Before P2-C the example's auth_profile values were free-form ('api-key',
        // 'max-subscription'), so an operator who copied it verbatim would have had
        // every lookup MISS and every dispatch resolve to 'unknown' forever. The
        // example is part of the validated surface: it must match the three
        // namespaces resolveAuthProfile emits.
        const example = JSON.parse(readFileSync(join(__dirname, '..', '..', 'config-examples', 'billing-map.example.json'), 'utf-8'));
        const shape = /^(plan:[A-Za-z0-9_.-]+|configdir:[^/][^\s]*|host_default)$/;
        expect(example.entries.length).toBeGreaterThan(0);
        for (const e of example.entries) {
            expect(e.auth_profile, `example auth_profile ${e.auth_profile}`).toMatch(shape);
            expect(e.auth_profile.startsWith('/')).toBe(false);
        }
        // All three namespaces are actually demonstrated.
        const kinds = new Set(example.entries.map(e => e.auth_profile.split(':')[0]));
        expect(kinds).toEqual(new Set(['plan', 'configdir', 'host_default']));
    });
    it('reuses resolveBillingMode + loadBillingMap and hardcodes no billing-mode literal', () => {
        expect(defaultDispatchIdentityDeps().loadBillingMap).toBe(loadBillingMap);
        expect(IDENTITY).toMatch(/resolveBillingMode\(deps\.loadBillingMap\(\), provider, authProfile\)/);
        // 'unknown' is the fault/absent sentinel and may appear; a POSITIVE billing
        // mode literal in this module would mean the value is being invented here.
        expect(IDENTITY).not.toMatch(/subscription_included|subscription_credit|api_payg|local_compute/);
    });
});
// ---------------------------------------------------------------------------
// 7. fault isolation: a resolver fault must never block a send
// ---------------------------------------------------------------------------
describe('P2-C: a resolver fault stamps un-attributed instead of blocking the dispatch', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    it('resolveDispatchIdentitySafe swallows a throwing resolver', () => {
        const boom = () => { throw new Error('p2c: resolver exploded'); };
        expect(() => resolveDispatchIdentitySafe('a', {}, boom)).not.toThrow();
        expect(resolveDispatchIdentitySafe('a', {}, boom)).toEqual(UNRESOLVED_DISPATCH_IDENTITY);
    });
    it('the dispatch row is STILL created, with the four descriptive columns NULL', () => {
        const boom = () => { throw new Error('p2c: resolver exploded'); };
        const id = createDispatch(getDb(), {
            source: 'kanban', agent: 'faulty', cardId: 'c1',
            ...resolveDispatchIdentitySafe('faulty', {}, boom),
        });
        const row = getDb().prepare('SELECT * FROM dispatches WHERE dispatch_id = ?').get(id);
        expect(row).toBeTruthy();
        expect(row.agent).toBe('faulty');
        expect(row.model_profile).toBeNull();
        expect(row.configured_model).toBeNull();
        expect(row.runtime_model).toBeNull();
        expect(row.provider).toBeNull();
        expect(row.auth_profile).toBeNull();
        // Deliberately NOT null: 'unknown' is the single spelling of "could not be
        // determined", shared with the missing-config path.
        expect(row.billing_mode).toBe('unknown');
    });
    it('the safe wrapper really is a try/catch returning the unresolved sentinel', () => {
        const idx = IDENTITY.indexOf('export function resolveDispatchIdentitySafe(');
        expect(idx).toBeGreaterThan(0);
        const body = IDENTITY.slice(idx);
        expect(body).toMatch(/try \{/);
        expect(body).toMatch(/\} catch \(err\) \{/);
        expect(body).toMatch(/return \{ \.\.\.UNRESOLVED_DISPATCH_IDENTITY \}/);
    });
});
// ---------------------------------------------------------------------------
// 8. runtime: real resolver, real DB row, real grouping
// ---------------------------------------------------------------------------
describe('P2-C runtime: a real row through the REAL resolver has the columns populated', () => {
    beforeEach(() => { initDatabase(':memory:'); });
    // A name that has no agents/<name>/ dir in any checkout, so the real resolver
    // deterministically takes its install-default path everywhere.
    const AGENT = `p2c-fixture-${randomUUID().slice(0, 8)}`;
    it('stamps non-NULL configured/runtime/provider/auth_profile/billing_mode', () => {
        const identity = resolveDispatchIdentitySafe(AGENT);
        const id = createDispatch(getDb(), { source: 'message', agent: AGENT, ...identity });
        const row = getDb().prepare('SELECT configured_model, runtime_model, provider, auth_profile, billing_mode, model_profile FROM dispatches WHERE dispatch_id = ?').get(id);
        expect(row.configured_model).not.toBeNull();
        expect(row.runtime_model).not.toBeNull();
        expect(row.provider).not.toBeNull();
        expect(row.auth_profile).not.toBeNull();
        expect(row.billing_mode).not.toBeNull();
        // ...and CORRECT, derived from the same shared resolvers the reader uses.
        expect(row.configured_model).toBe(DEFAULT_AGENT_MODEL);
        expect(row.runtime_model).toBe(row.configured_model);
        expect(row.provider).toBe(deriveProvider(DEFAULT_AGENT_MODEL));
        expect(row.auth_profile).toBe(HOST_DEFAULT_AUTH_PROFILE);
        expect(row.billing_mode).toBe(resolveBillingMode(loadBillingMap(), row.provider, row.auth_profile));
        // No profile is configured for a nonexistent agent -- honestly NULL.
        expect(row.model_profile).toBeNull();
    });
    it('the auth_profile it produced carries no absolute path', () => {
        const identity = resolveDispatchIdentitySafe(AGENT);
        expect(identity.authProfile).not.toContain('/home/');
        expect(identity.authProfile?.startsWith('/')).toBe(false);
    });
    it('cost_per_accepted_task can finally group by modelProfile / model / provider / billingMode', () => {
        // This is the end-to-end proof of the gap: before the stamping, every one of
        // these group keys except `agent` was NULL on every live row.
        const pricing = {
            version: 1, currency: 'USD',
            models: { 'claude-sonnet-5': { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0.3, cache_write_per_mtok: 3.75 } },
        };
        const identity = resolveDispatchIdentity('a', {}, deps({
            resolveModel: () => ({ model: 'claude-sonnet-5', source: 'model_profile' }),
            readModelProfile: () => 'build_strong',
            resolveConfigDir: () => ({ configDir: null, planId: 'company-team', planUnresolved: false }),
            loadBillingMap: () => ({
                version: 1,
                entries: [{ provider: 'anthropic', auth_profile: 'plan:company-team', billing_mode: 'subscription_credit' }],
            }),
        }));
        const id = createDispatch(getDb(), { source: 'kanban', agent: 'mason', cardId: 'c9', ...identity });
        recordOutcome(getDb(), { dispatchId: id, outcome: 'accepted', evidence: 'kanban:done' });
        const groups = costPerAcceptedTask(getDb(), { pricing });
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            agent: 'mason',
            modelProfile: 'build_strong',
            model: 'claude-sonnet-5',
            provider: 'anthropic',
            billingMode: 'subscription_credit',
            acceptedTasks: 1,
        });
    });
});
