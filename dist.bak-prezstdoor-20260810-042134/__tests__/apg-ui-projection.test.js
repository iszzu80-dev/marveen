import { describe, it, expect } from 'vitest';
import { deriveDisplayState } from '../apg/ui-projection.js';
// Direct unit coverage of the pure display-state precedence rule (spec 5/6.4),
// isolated from any DB/store concern -- deriveDisplayState takes no I/O.
describe('deriveDisplayState precedence (spec 5)', () => {
    const base = {
        latestTransitionState: null,
        latestCheckpointResult: null,
        latestCheckpoint: null,
        hasAssistedRecommendation: false,
        recommendationEvidenceCompleteness: null,
    };
    it('an explicit, recognized transition state wins over everything else', () => {
        expect(deriveDisplayState({
            ...base,
            latestTransitionState: 'blocked',
            latestCheckpointResult: 'PASS',
            latestCheckpoint: 'release_ready',
        })).toBe('blocked');
    });
    it('an unrecognized transition state is ignored, falls through to checkpoint logic', () => {
        expect(deriveDisplayState({
            ...base,
            latestTransitionState: 'some_unknown_state',
            latestCheckpointResult: 'PASS',
            latestCheckpoint: 'release_ready',
        })).toBe('accepted');
    });
    it('a FAILed checkpoint means blocked, even with no transition row', () => {
        expect(deriveDisplayState({ ...base, latestCheckpointResult: 'FAIL' })).toBe('blocked');
    });
    // Owner decision 2026-08-09 ("legyen B"): MISSING and PARTIAL are no longer
    // the same thing. Only MISSING -- no evidence chain at all -- is an attention
    // item. PARTIAL (evidence exists, chain unfinished, e.g. gated but deliberately
    // not deployed) reports as 'verifying' so it stays visible in the counts
    // without crowding the attention list.
    it('a MISSING assisted recommendation means evidence_needed, ranked above a PASS checkpoint that is not the acceptance gate', () => {
        expect(deriveDisplayState({
            ...base,
            latestCheckpointResult: 'PASS',
            latestCheckpoint: 'spec_ready',
            hasAssistedRecommendation: true,
            recommendationEvidenceCompleteness: 'MISSING',
        })).toBe('evidence_needed');
    });
    it('a PARTIAL assisted recommendation is verifying, NOT evidence_needed', () => {
        expect(deriveDisplayState({
            ...base,
            latestCheckpointResult: 'PASS',
            latestCheckpoint: 'spec_ready',
            hasAssistedRecommendation: true,
            recommendationEvidenceCompleteness: 'PARTIAL',
        })).toBe('verifying');
    });
    it('PARTIAL does not become evidence_needed even with no checkpoint at all', () => {
        expect(deriveDisplayState({
            ...base,
            hasAssistedRecommendation: true,
            recommendationEvidenceCompleteness: 'PARTIAL',
        })).toBe('verifying');
    });
    it('a COMPLETE assisted recommendation does not force evidence_needed', () => {
        expect(deriveDisplayState({
            ...base,
            latestCheckpointResult: 'PASS',
            latestCheckpoint: 'release_ready',
            hasAssistedRecommendation: true,
            recommendationEvidenceCompleteness: 'COMPLETE',
        })).toBe('accepted');
    });
    it('PASS on release_ready or runtime_acceptance is accepted; PASS elsewhere is not', () => {
        expect(deriveDisplayState({ ...base, latestCheckpointResult: 'PASS', latestCheckpoint: 'runtime_acceptance' })).toBe('accepted');
        expect(deriveDisplayState({ ...base, latestCheckpointResult: 'PASS', latestCheckpoint: 'release_ready' })).toBe('accepted');
        expect(deriveDisplayState({ ...base, latestCheckpointResult: 'PASS', latestCheckpoint: 'implementation_ready' })).toBe('executing');
    });
    it('UNKNOWN/NOT_APPLICABLE checkpoint result means clarification', () => {
        expect(deriveDisplayState({ ...base, latestCheckpointResult: 'UNKNOWN' })).toBe('clarification');
        expect(deriveDisplayState({ ...base, latestCheckpointResult: 'NOT_APPLICABLE' })).toBe('clarification');
    });
    it('no signal at all defaults to executing, never a fabricated accepted/off', () => {
        expect(deriveDisplayState({ ...base })).toBe('executing');
    });
    it('never returns a 9th bucket for any input combination', () => {
        const VALID = new Set([
            'clarification', 'evidence_needed', 'executing', 'verifying',
            'decision_needed', 'blocked', 'accepted', 'off',
        ]);
        const transitionOptions = [null, 'blocked', 'accepted', 'garbage'];
        const resultOptions = [null, 'PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'];
        const checkpointOptions = [null, 'release_ready', 'spec_ready'];
        for (const t of transitionOptions) {
            for (const r of resultOptions) {
                for (const c of checkpointOptions) {
                    for (const hasRec of [true, false]) {
                        for (const completeness of [null, 'COMPLETE', 'PARTIAL']) {
                            const state = deriveDisplayState({
                                latestTransitionState: t,
                                latestCheckpointResult: r,
                                latestCheckpoint: c,
                                hasAssistedRecommendation: hasRec,
                                recommendationEvidenceCompleteness: completeness,
                            });
                            expect(VALID.has(state)).toBe(true);
                        }
                    }
                }
            }
        }
    });
});
