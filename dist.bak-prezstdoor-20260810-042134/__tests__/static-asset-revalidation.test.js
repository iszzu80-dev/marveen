import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// App logic served from an unversioned URL must REVALIDATE.
//
// 2026-08-10: coscontrol.js was served with max-age=86400. A UI fix shipped and
// merged and restarted was still invisible in the browser for a day — Istvan
// looked for an approval button on a page running yesterday's JavaScript. Same
// class as the other "shipped but never landed" failures tonight; the code was
// right and did not reach the person.
//
// Avatars and icons keep their max-age: they are content that tolerates
// staleness, which is exactly what the option is for.
const SRC = readFileSync(join(import.meta.dirname, '..', 'web', 'routes', 'static.ts'), 'utf8');
const APP_ASSETS = ['style.css', 'app.js', 'coscontrol.js', 'apg.js', 'apg.css'];
describe('static asset caching', () => {
    for (const f of APP_ASSETS) {
        it(`${f} is served without a long max-age`, () => {
            const line = SRC.split('\n').find((l) => l.includes(`'${f}'`) && l.includes('serveFile'));
            expect(line, `no serveFile line for ${f}`).toBeTruthy();
            expect(line, `${f} must revalidate`).not.toMatch(/cacheSeconds:\s*\d/);
        });
    }
    it('avatars and icons may still cache — the option is not banned, just misapplied', () => {
        expect(SRC).toMatch(/avatarPath, \{ cacheSeconds: \d+ \}/);
    });
    it('no unversioned asset in the web root gets a day-long cache', () => {
        const offenders = SRC.split('\n').filter((l) => l.includes('join(webDir') && /cacheSeconds:\s*(8640|86400)/.test(l));
        expect(offenders, offenders.join('\n')).toHaveLength(0);
    });
});
