import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBytes, decryptBytes, createEncryptedBackup, restoreEncryptedBackup, pruneBackups, } from '../cos/backup.js';
// §C DoD: backups are ENCRYPTED, a restore round-trips byte-for-byte (the
// restore-test), and old backups are pruned to the retention window.
const PASS = 'correct horse battery staple';
describe('encrypted backup', () => {
    it('encrypts + decrypts a byte buffer (round-trip)', () => {
        const plain = Buffer.from('the quick brown fox \x00\x01\x02', 'binary');
        const blob = encryptBytes(plain, PASS);
        expect(blob.subarray(0, 8).toString('ascii')).toBe('COSBAK01');
        expect(blob.equals(plain)).toBe(false); // actually encrypted, not stored plain
        expect(decryptBytes(blob, PASS).equals(plain)).toBe(true);
    });
    it('the RESTORE-TEST: a backed-up DB file restores byte-for-byte', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cos-bak-'));
        const dbPath = join(dir, 'claudeclaw.db');
        const original = Buffer.from('SQLite format 3\x00' + 'x'.repeat(500));
        writeFileSync(dbPath, original);
        const { path } = createEncryptedBackup({ dbPath, destDir: dir, passphrase: PASS, now: 1000 });
        const restored = restoreEncryptedBackup({ encPath: path, passphrase: PASS });
        expect(restored.equals(original)).toBe(true);
    });
    it('a wrong passphrase fails to decrypt (integrity/auth check)', () => {
        const blob = encryptBytes(Buffer.from('secret'), PASS);
        expect(() => decryptBytes(blob, 'wrong pass')).toThrow();
    });
    it('a corrupted blob is rejected (GCM tag mismatch)', () => {
        const blob = encryptBytes(Buffer.from('secret'), PASS);
        blob[blob.length - 1] ^= 0xff; // flip a ciphertext bit
        expect(() => decryptBytes(blob, PASS)).toThrow();
    });
    it('a non-backup blob is rejected by magic', () => {
        expect(() => decryptBytes(Buffer.from('not a backup at all........'), PASS)).toThrow(/magic|short/);
    });
    it('pruneBackups deletes files older than the retention window, keeps recent', () => {
        const dir = mkdtempSync(join(tmpdir(), 'cos-bak-'));
        const oldF = join(dir, 'backup-1.db.enc');
        writeFileSync(oldF, 'old');
        const newF = join(dir, 'backup-2.db.enc');
        writeFileSync(newF, 'new');
        const other = join(dir, 'notes.txt');
        writeFileSync(other, 'keep me'); // not a backup file
        const now = 100 * 86400;
        // old file mtime = 40 days ago (> 30d retention); new = 1 day ago
        utimesSync(oldF, now - 40 * 86400, now - 40 * 86400);
        utimesSync(newF, now - 1 * 86400, now - 1 * 86400);
        const r = pruneBackups({ destDir: dir, retentionDays: 30, now });
        expect(r.deleted).toEqual(['backup-1.db.enc']);
        expect(r.kept).toEqual(['backup-2.db.enc']);
        // the non-backup file is untouched
        expect(readdirSync(dir)).toContain('notes.txt');
        expect(readFileSync(other, 'utf8')).toBe('keep me');
    });
});
