// Filesystem side of remote access key enrollment.
//
// Kept separate from the pure logic in remote-enroll-core.ts so the read-
// modify-write, permission handling, atomic replace, and lockfile behaviour
// can be tested against a temporary directory instead of the real ~/.ssh.
import { openSync, closeSync, writeSync, fsyncSync, readFileSync, renameSync, unlinkSync, mkdirSync, statSync, existsSync, chmodSync, } from 'node:fs';
import { join } from 'node:path';
import { mergeAuthorizedKeys, removeAuthorizedKey } from './remote-enroll-core.js';
const SSH_DIR_MODE = 0o700;
const AUTH_KEYS_MODE = 0o600;
const AUTH_KEYS_NAME = 'authorized_keys';
const LOCK_NAME = 'authorized_keys.lock';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** True when a mode grants any permission beyond the given owner-only mask. */
function looserThan(mode, ownerMask) {
    return (mode & 0o777 & ~ownerMask) !== 0;
}
function fmtMode(mode) {
    return '0' + (mode & 0o777).toString(8).padStart(3, '0');
}
/**
 * Ensure the .ssh directory exists with 0700. If it already exists with looser
 * permissions, warn but do not change it.
 */
function ensureSshDir(sshDir, warnings) {
    if (!existsSync(sshDir)) {
        mkdirSync(sshDir, { recursive: true, mode: SSH_DIR_MODE });
        // mkdir mode is subject to umask; enforce explicitly.
        chmodSync(sshDir, SSH_DIR_MODE);
        return;
    }
    const st = statSync(sshDir);
    if (!st.isDirectory()) {
        throw new Error(`${sshDir} exists but is not a directory`);
    }
    if (looserThan(st.mode, SSH_DIR_MODE)) {
        warnings.push(`${sshDir} permissions are ${fmtMode(st.mode)} (looser than 0700); leaving as-is`);
    }
}
/**
 * Acquire an exclusive lock via O_EXCL. Retries on contention and removes a
 * stale lockfile whose mtime is older than staleLockMs. Returns the lock file
 * descriptor; the caller must releaseLock() it.
 */
async function acquireLock(lockPath, retries, delayMs, staleMs, sleep) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            // 'wx' => O_CREAT | O_EXCL: fails if the file already exists.
            const fd = openSync(lockPath, 'wx', AUTH_KEYS_MODE);
            try {
                writeSync(fd, `${process.pid}\n`);
            }
            catch {
                // Non-fatal: the lock is the file's existence, not its contents.
            }
            return fd;
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            // Contended. If the existing lock is stale, remove it and retry now.
            try {
                const st = statSync(lockPath);
                if (Date.now() - st.mtimeMs > staleMs) {
                    unlinkSync(lockPath);
                    continue;
                }
            }
            catch {
                // Lock vanished between open and stat; retry immediately.
                continue;
            }
            await sleep(delayMs);
        }
    }
    throw new Error(`could not acquire ${lockPath} after ${retries} attempts; another enrollment may be running`);
}
function releaseLock(fd, lockPath) {
    try {
        closeSync(fd);
    }
    catch {
        /* ignore */
    }
    try {
        unlinkSync(lockPath);
    }
    catch {
        /* ignore */
    }
}
/**
 * Enroll (append or replace-by-id) the restricted line into
 * <sshDir>/authorized_keys with an atomic read-modify-write guarded by an
 * O_EXCL lockfile. Never reads back or logs other users' keys; only reports
 * the action taken and any permission warnings.
 */
export async function enrollAuthorizedKey(opts) {
    const { sshDir, restrictedLine, installId, lockRetries = 20, lockRetryDelayMs = 100, staleLockMs = 15000, sleep = defaultSleep, } = opts;
    const warnings = [];
    const authPath = join(sshDir, AUTH_KEYS_NAME);
    const lockPath = join(sshDir, LOCK_NAME);
    ensureSshDir(sshDir, warnings);
    const fd = await acquireLock(lockPath, lockRetries, lockRetryDelayMs, staleLockMs, sleep);
    try {
        let existing = '';
        if (existsSync(authPath)) {
            const st = statSync(authPath);
            if (looserThan(st.mode, AUTH_KEYS_MODE)) {
                warnings.push(`${authPath} permissions were ${fmtMode(st.mode)} (looser than 0600); the rewritten file is 0600`);
            }
            existing = readFileSync(authPath, 'utf8');
        }
        const { content, action } = mergeAuthorizedKeys(existing, restrictedLine, installId);
        writeAtomic(sshDir, authPath, content);
        return { action, authorizedKeysPath: authPath, warnings };
    }
    finally {
        releaseLock(fd, lockPath);
    }
}
/** Atomic write: temp file in the same directory (same filesystem), 0600,
 * fsync, then rename over the target. */
function writeAtomic(sshDir, authPath, content) {
    const tmpPath = join(sshDir, `.${AUTH_KEYS_NAME}.${process.pid}.${Date.now()}.tmp`);
    const tfd = openSync(tmpPath, 'wx', AUTH_KEYS_MODE);
    try {
        writeSync(tfd, content);
        fsyncSync(tfd);
    }
    finally {
        closeSync(tfd);
    }
    // Enforce mode explicitly in case umask trimmed the create mode.
    chmodSync(tmpPath, AUTH_KEYS_MODE);
    try {
        renameSync(tmpPath, authPath);
    }
    catch (err) {
        try {
            unlinkSync(tmpPath);
        }
        catch {
            /* ignore */
        }
        throw err;
    }
}
/**
 * Remove the marveen-remote:<installId> line from <sshDir>/authorized_keys --
 * the revoke counterpart of enrollAuthorizedKey, under the same lock and
 * atomic-replace discipline. A missing file or missing line reports
 * removed:false (idempotent: revoking twice must not fail).
 */
export async function removeEnrolledKey(opts) {
    const { sshDir, installId, lockRetries = 20, lockRetryDelayMs = 100, staleLockMs = 15000, sleep = defaultSleep, } = opts;
    const authPath = join(sshDir, AUTH_KEYS_NAME);
    const lockPath = join(sshDir, LOCK_NAME);
    if (!existsSync(authPath))
        return { removed: false, authorizedKeysPath: authPath };
    const fd = await acquireLock(lockPath, lockRetries, lockRetryDelayMs, staleLockMs, sleep);
    try {
        if (!existsSync(authPath))
            return { removed: false, authorizedKeysPath: authPath };
        const existing = readFileSync(authPath, 'utf8');
        const { content, removed } = removeAuthorizedKey(existing, installId);
        if (removed)
            writeAtomic(sshDir, authPath, content);
        return { removed, authorizedKeysPath: authPath };
    }
    finally {
        releaseLock(fd, lockPath);
    }
}
