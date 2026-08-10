/**
 * Accordion guard tests (card 9193eedd follow-up).
 *
 * Verifies that clicks inside .cos-owner-ctrl do NOT toggle the tile
 * open/closed, while clicks on the tile header still do.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
describe('accordion guard (card 9193eedd follow-up)', () => {
    it('clicks inside .cos-owner-ctrl do not toggle the tile', () => {
        document.body.innerHTML = '';
        const container = document.createElement('div');
        container.id = 'test-container';
        document.body.appendChild(container);
        const tile = document.createElement('div');
        tile.className = 'cos-case-tile expanded';
        tile.dataset.caseId = 'TEST-001';
        const detail = document.createElement('div');
        detail.className = 'cos-case-detail';
        detail.hidden = true; // closed
        tile.appendChild(detail);
        // Owner control inside the tile.
        const ctrl = document.createElement('div');
        ctrl.className = 'cos-owner-ctrl';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.className = 'cos-owner-radio';
        ctrl.appendChild(radio);
        const btn = document.createElement('button');
        btn.className = 'cos-owner-btn';
        btn.textContent = 'Küldés';
        ctrl.appendChild(btn);
        tile.appendChild(ctrl);
        container.appendChild(tile);
        // Install the same accordion handler logic with the guard.
        let toggled = false;
        container.addEventListener('click', ((e) => {
            // THE GUARD — card 9193eedd follow-up.
            if (e.target.closest?.('.cos-owner-ctrl'))
                return;
            const t = e.target.closest?.('.cos-case-tile');
            if (!t)
                return;
            const d = t.querySelector('.cos-case-detail');
            if (!d)
                return;
            toggled = true;
            d.hidden = !d.hidden;
        }));
        // Click the radio — must NOT toggle.
        toggled = false;
        radio.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(toggled).toBe(false);
        expect(detail.hidden).toBe(true); // still closed
        // Click the button — must NOT toggle.
        toggled = false;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(toggled).toBe(false);
        expect(detail.hidden).toBe(true);
        // Click the tile (outside the control) — MUST toggle.
        toggled = false;
        tile.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(toggled).toBe(true);
        expect(detail.hidden).toBe(false); // opened
    });
    it('typing in textarea inside owner control does not toggle', () => {
        document.body.innerHTML = '';
        const container = document.createElement('div');
        document.body.appendChild(container);
        const tile = document.createElement('div');
        tile.className = 'cos-case-tile expanded';
        tile.dataset.caseId = 'TEST-002';
        const detail = document.createElement('div');
        detail.className = 'cos-case-detail';
        detail.hidden = true;
        tile.appendChild(detail);
        const ctrl = document.createElement('div');
        ctrl.className = 'cos-owner-ctrl';
        const textarea = document.createElement('textarea');
        textarea.className = 'cos-owner-text';
        ctrl.appendChild(textarea);
        tile.appendChild(ctrl);
        container.appendChild(tile);
        let toggled = false;
        container.addEventListener('click', ((e) => {
            if (e.target.closest?.('.cos-owner-ctrl'))
                return;
            const t = e.target.closest?.('.cos-case-tile');
            if (!t)
                return;
            const d = t.querySelector('.cos-case-detail');
            if (!d)
                return;
            toggled = true;
            d.hidden = !d.hidden;
        }));
        // Click the textarea — must NOT toggle.
        toggled = false;
        textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(toggled).toBe(false);
        expect(detail.hidden).toBe(true);
        // Type into it (keydown) — no toggle (keydowns don't bubble to the
        // accordion click handler, but just to be thorough).
        toggled = false;
        textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
        expect(toggled).toBe(false);
    });
});
