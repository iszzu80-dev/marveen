import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
const SECURITY = '/usr/bin/security';
const SERVICE = 'com.marveen.vault';
const ACCOUNT = 'master-key';
export function isKeychainAvailable() {
    return platform() === 'darwin';
}
export function keychainStore(value) {
    execFileSync(SECURITY, [
        'add-generic-password',
        '-U',
        '-s', SERVICE,
        '-a', ACCOUNT,
        '-w', value,
        '-A',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
}
export function keychainRetrieve() {
    try {
        const out = execFileSync(SECURITY, [
            'find-generic-password',
            '-s', SERVICE,
            '-a', ACCOUNT,
            '-w',
        ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
        return out.trim() || null;
    }
    catch {
        return null;
    }
}
export function keychainDelete() {
    try {
        execFileSync(SECURITY, [
            'delete-generic-password',
            '-s', SERVICE,
            '-a', ACCOUNT,
        ], { stdio: ['ignore', 'ignore', 'ignore'] });
        return true;
    }
    catch {
        return false;
    }
}
