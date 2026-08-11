// P2-B: Context Packet builder + validator + committed example.
//
// The load-bearing test in this file is "a full document inlined instead of
// referenced FAILS validation" -- there are three of them, one per way of
// inlining (a pasted section, an over-long excerpt, an excerpt that is really the
// whole artifact). Each is written so that deleting the corresponding rule from
// validateContextPacket() turns it RED.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildContextPacket, renderContextPacket, validateContextPacket, estimateFreshTokens, estimatePacketFreshTokens, derivePacketMetadata, artifactRefFromContent, hashContent, truncateExcerpt, CONTEXT_PACKET_VERSION, MAX_EXCERPT_CHARS, MAX_SECTION_CHARS, TARGET_FRESH_TOKENS, } from '../context-packet.js';
import { EXAMPLE_PACKET, EXAMPLE_PACKET_DOC_PATH, renderExamplePacketDoc } from '../context-packet-example.js';
const REPO_ROOT = join(import.meta.dirname, '..', '..');
/** Drop line and block comments so a source assertion is about CODE, not prose. */
export function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/[ \t]\/\/.*$/gm, '');
}
function minimal(over = {}) {
    return buildContextPacket({
        goal: 'Ship the thing',
        dataSensitivity: 'internal',
        doneWhen: ['tests green'],
        ...over,
    });
}
// A realistic "full document": a long audit nobody should ever paste again.
const FULL_DOCUMENT = Array.from({ length: 400 }, (_, i) => `Line ${i}: findings, evidence and a recommendation that the receiving agent could read from disk.`).join('\n');
describe('P2-B context packet: builder', () => {
    it('fills the five sections and defaults the version', () => {
        const p = minimal();
        expect(p.packetVersion).toBe(CONTEXT_PACKET_VERSION);
        expect(p.references).toEqual([]);
        expect(p.constraints).toEqual([]);
        expect(p.dataSensitivityNotes).toEqual([]);
        const text = renderContextPacket(p);
        for (const h of ['## Goal', '## Canonical references', '## Relevant constraints', '## Data sensitivity', '## Done when']) {
            expect(text).toContain(h);
        }
    });
    it('trims and drops empty bullets so a packet carries no filler', () => {
        const p = minimal({ constraints: ['  real  ', '', '   '], doneWhen: ['  done  '] });
        expect(p.constraints).toEqual(['real']);
        expect(p.doneWhen).toEqual(['done']);
    });
    it('renders deterministically (same input -> byte-identical text)', () => {
        expect(renderContextPacket(minimal())).toBe(renderContextPacket(minimal()));
    });
    it('artifactRefFromContent derives the hash and size from the REAL content', () => {
        const ref = artifactRefFromContent('docs/a.md', 'abc1234', FULL_DOCUMENT, { excerpt: 'Line 0' });
        expect(ref.contentHash).toBe(hashContent(FULL_DOCUMENT));
        expect(ref.bytes).toBe(Buffer.byteLength(FULL_DOCUMENT, 'utf-8'));
        expect(ref.excerpt).toBe('Line 0');
    });
    it('artifactRefFromContent CANNOT accidentally inline a document: the excerpt is truncated', () => {
        const ref = artifactRefFromContent('docs/a.md', 'abc1234', FULL_DOCUMENT, { excerpt: FULL_DOCUMENT });
        expect((ref.excerpt ?? '').length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
        expect(validateContextPacket(minimal({ references: [ref] })).ok).toBe(true);
    });
    it('truncateExcerpt marks the cut so a reader knows to open the path', () => {
        expect(truncateExcerpt('x'.repeat(MAX_EXCERPT_CHARS + 50)).endsWith(' ...')).toBe(true);
        expect(truncateExcerpt('short')).toBe('short');
    });
});
describe('P2-B context packet: validator accepts a well-formed packet', () => {
    it('a reference-based packet validates with no errors and no warnings', () => {
        const v = validateContextPacket(EXAMPLE_PACKET);
        expect(v.errors).toEqual([]);
        expect(v.warnings).toEqual([]);
        expect(v.ok).toBe(true);
    });
    it('requires goal, doneWhen and an EXPLICIT data-sensitivity class', () => {
        expect(validateContextPacket(minimal({ goal: '   ' })).errors.map(e => e.code)).toContain('goal_missing');
        expect(validateContextPacket(minimal({ doneWhen: [] })).errors.map(e => e.code)).toContain('done_when_missing');
        const noClass = validateContextPacket(minimal({ dataSensitivity: 'secret' }));
        expect(noClass.errors.map(e => e.code)).toContain('data_sensitivity_missing');
    });
    it('requires every reference to be a real reference (path + pinned ref + sha256)', () => {
        const bad = minimal({ references: [{ path: '', ref: '', contentHash: 'nope' }] });
        const codes = validateContextPacket(bad).errors.map(e => e.code);
        expect(codes).toContain('reference_path_missing');
        expect(codes).toContain('reference_ref_missing');
        expect(codes).toContain('reference_hash_invalid');
    });
});
// ---------------------------------------------------------------------------
// THE reference-not-inline rule. Three tests, one per inlining route. Removing
// the matching branch from validateContextPacket() makes the test RED (proven by
// mutation, see the P2-B report).
// ---------------------------------------------------------------------------
describe('P2-B context packet: a full document inlined instead of referenced FAILS', () => {
    it('FAILS when the document is pasted into a packet section', () => {
        const inlined = minimal({ constraints: [FULL_DOCUMENT] });
        const v = validateContextPacket(inlined);
        expect(v.ok).toBe(false);
        expect(v.errors.map(e => e.code)).toContain('section_inlined');
        // ...and the reference-based alternative for the SAME material passes, so
        // the test is about inlining, not about size in general.
        const referenced = minimal({
            references: [artifactRefFromContent('docs/audit.md', 'abc1234', FULL_DOCUMENT, { excerpt: 'Line 0: findings' })],
        });
        expect(validateContextPacket(referenced).ok).toBe(true);
    });
    it('FAILS when the document is pasted into an excerpt (over the excerpt limit)', () => {
        const v = validateContextPacket(minimal({
            references: [{ path: 'docs/audit.md', ref: 'abc1234', contentHash: hashContent(FULL_DOCUMENT), excerpt: FULL_DOCUMENT }],
        }));
        expect(v.ok).toBe(false);
        expect(v.errors.map(e => e.code)).toContain('excerpt_too_long');
    });
    it('FAILS when an "excerpt" is really most of the artifact (under the char limit)', () => {
        // 1000-byte artifact, 900-byte "excerpt": inside MAX_EXCERPT_CHARS, but it is
        // the document, not an excerpt. This is the case the char limit alone misses.
        const artifact = 'y'.repeat(1000);
        expect(artifact.length).toBeLessThan(MAX_EXCERPT_CHARS);
        const v = validateContextPacket(minimal({
            references: [{ path: 'docs/small.md', ref: 'abc1234', contentHash: hashContent(artifact), bytes: 1000, excerpt: 'y'.repeat(900) }],
        }));
        expect(v.ok).toBe(false);
        expect(v.errors.map(e => e.code)).toContain('artifact_inlined');
    });
    it('does NOT punish quoting a genuinely tiny artifact in full', () => {
        const tiny = 'export const X = 1\n';
        const v = validateContextPacket(minimal({
            references: [artifactRefFromContent('src/x.ts', 'abc1234', tiny, { excerpt: tiny })],
        }));
        expect(v.ok).toBe(true);
    });
    it('the section limit is a FORMAT rule, not a context cap: a big REFERENCED packet is valid', () => {
        const refs = Array.from({ length: 30 }, (_, i) => artifactRefFromContent(`docs/doc-${i}.md`, 'abc1234', FULL_DOCUMENT, { excerpt: `Line ${i}: findings` }));
        const p = minimal({ references: refs });
        expect(validateContextPacket(p).ok).toBe(true);
    });
});
describe('P2-B context packet: data sensitivity', () => {
    it('REJECTS a packet carrying something shaped like a credential', () => {
        for (const secret of [
            'sk-abcdefghijklmnopqrstuvwxyz012345',
            'AKIAIOSFODNN7EXAMPLE',
            'postgresql://user:hunter2@db.example.com:5432/app',
            '-----BEGIN RSA PRIVATE KEY-----',
            'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc',
        ]) {
            const v = validateContextPacket(minimal({ constraints: [`Use ${secret} to connect`] }));
            expect(v.ok, secret).toBe(false);
            expect(v.errors.map(e => e.code)).toContain('possible_secret');
        }
    });
    it('does not flag an ordinary constraint bullet', () => {
        expect(validateContextPacket(minimal({ constraints: ['Read the token from store/.dashboard-token at call time'] })).ok).toBe(true);
    });
});
describe('P2-B context packet: fresh-token estimate is an ESTIMATE, never measured', () => {
    it('always marks confidence as estimated and names its method', () => {
        const e = estimateFreshTokens('hello world');
        expect(e.confidence).toBe('estimated');
        expect(e.method).toMatch(/heuristic/);
        expect(e.method).toMatch(/no tokenizer/);
    });
    it('never returns the string "measured" for any input', () => {
        for (const text of ['', 'x', 'x'.repeat(100000), FULL_DOCUMENT]) {
            expect(estimateFreshTokens(text).confidence).toBe('estimated');
        }
    });
    it('is deterministic and monotonic in length', () => {
        expect(estimateFreshTokens('abcd').tokens).toBe(1);
        expect(estimateFreshTokens('a'.repeat(4000)).tokens).toBe(1000);
        expect(estimateFreshTokens('a'.repeat(4001)).tokens).toBeGreaterThan(estimateFreshTokens('a'.repeat(4000)).tokens);
    });
    it('derivePacketMetadata carries the confidence marker with the number, by construction', () => {
        const m = derivePacketMetadata(EXAMPLE_PACKET);
        expect(m.estimateConfidence).toBe('estimated');
        expect(m.estimatedFreshTokens).toBeGreaterThan(0);
        expect(m.estimateMethod.length).toBeGreaterThan(0);
    });
    it('metadata carries paths and hashes ONLY -- no excerpt or prompt text', () => {
        const m = derivePacketMetadata(EXAMPLE_PACKET);
        expect(m.referencedArtifacts).toEqual([
            'docs/optimization/marveen-lean-optimization-audit-2026-07-17.md@9dd1c27',
            'src/context-guard.ts@9dd1c27',
        ]);
        expect(m.contentHashes).toHaveLength(2);
        for (const h of m.contentHashes)
            expect(h).toMatch(/^[0-9a-f]{64}$/);
        const blob = JSON.stringify(m);
        for (const r of EXAMPLE_PACKET.references) {
            if (r.excerpt)
                expect(blob).not.toContain(r.excerpt);
            if (r.note)
                expect(blob).not.toContain(r.note);
        }
    });
});
describe('P2-B context packet: the ~3000-token figure is a TARGET, not a cap', () => {
    it('over-target with no justification is a WARNING, and the packet stays valid', () => {
        const refs = Array.from({ length: 40 }, (_, i) => artifactRefFromContent(`docs/doc-${i}.md`, 'abc1234', FULL_DOCUMENT, { excerpt: 'x'.repeat(400) }));
        const p = minimal({ references: refs });
        const v = validateContextPacket(p);
        expect(v.estimate.tokens).toBeGreaterThan(TARGET_FRESH_TOKENS);
        expect(v.ok).toBe(true);
        expect(v.warnings.map(w => w.code)).toContain('over_target_tokens');
    });
    it('a documented complex task gets no warning at all', () => {
        const refs = Array.from({ length: 40 }, (_, i) => artifactRefFromContent(`docs/doc-${i}.md`, 'abc1234', FULL_DOCUMENT, { excerpt: 'x'.repeat(400) }));
        const p = minimal({ references: refs, complexityJustification: 'Cross-cutting migration: 40 call sites must be listed to be actionable.' });
        const v = validateContextPacket(p);
        expect(v.estimate.tokens).toBeGreaterThan(TARGET_FRESH_TOKENS);
        expect(v.warnings).toEqual([]);
    });
    it('there is NO cumulative token cap in the packet layer -- in particular no 12000', () => {
        for (const file of ['context-packet.ts', 'context-packet-example.ts', 'session-saturation.ts', 'session-checkpoint.ts']) {
            const src = stripComments(readFileSync(join(REPO_ROOT, 'src', file), 'utf-8'));
            // A cumulative cap would have to name a number near 12000 in CODE (the
            // comments deliberately discuss the absence of one, so they are stripped).
            expect(src, file).not.toMatch(/12[_,]?000/);
            expect(src, file).not.toMatch(/cumulative(Cap|Budget|Limit)/i);
        }
    });
});
describe('P2-B context packet: committed example stays in sync', () => {
    it('the committed markdown equals renderExamplePacketDoc() byte for byte', () => {
        const onDisk = readFileSync(join(REPO_ROOT, EXAMPLE_PACKET_DOC_PATH), 'utf-8');
        expect(onDisk).toBe(renderExamplePacketDoc());
    });
    it('the example is a NORMAL packet: under the ~3000-token target', () => {
        const est = estimatePacketFreshTokens(EXAMPLE_PACKET);
        expect(est.confidence).toBe('estimated');
        expect(est.tokens).toBeLessThan(TARGET_FRESH_TOKENS);
    });
    it('the example inlines none of the documents it references', () => {
        for (const r of EXAMPLE_PACKET.references) {
            expect((r.excerpt ?? '').length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
        }
        expect(renderContextPacket(EXAMPLE_PACKET).length).toBeLessThan(MAX_SECTION_CHARS * 3);
    });
});
