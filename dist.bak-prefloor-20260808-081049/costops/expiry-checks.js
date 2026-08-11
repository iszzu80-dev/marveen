// CostOps v0.7/v2 -- SSL cert + domain registration expiry (card bea78483).
//
// Both are pure READ-ONLY network checks: a TLS handshake to read the peer
// certificate's notAfter date, and a public RDAP lookup for a domain's
// registration expiration. No DNS/cert/domain change, no admin key needed.
import tls from 'node:tls';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
export const DOMAINS_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'costops-domains.json');
export const DOMAINS_EXAMPLE_PATH = join(PROJECT_ROOT, 'store', 'costops-domains.json.example');
const EMPTY = { version: 1, ssl_hosts: [], domains: [] };
const EXAMPLE = {
    version: 1,
    ssl_hosts: ['example.com'],
    domains: ['example.com'],
};
export function loadDomainsConfig() {
    if (!existsSync(DOMAINS_CONFIG_PATH)) {
        try {
            if (!existsSync(DOMAINS_EXAMPLE_PATH))
                writeFileSync(DOMAINS_EXAMPLE_PATH, JSON.stringify(EXAMPLE, null, 2) + '\n', 'utf-8');
        }
        catch { /* best effort */ }
        return { config: { ...EMPTY }, exists: false };
    }
    try {
        const raw = JSON.parse(readFileSync(DOMAINS_CONFIG_PATH, 'utf-8'));
        return {
            config: {
                version: typeof raw.version === 'number' ? raw.version : 1,
                ssl_hosts: Array.isArray(raw.ssl_hosts) ? raw.ssl_hosts.filter(h => typeof h === 'string') : [],
                domains: Array.isArray(raw.domains) ? raw.domains.filter(h => typeof h === 'string') : [],
            },
            exists: true,
        };
    }
    catch (err) {
        logger.warn({ err }, 'costops-domains.json is not valid JSON');
        return { config: { ...EMPTY }, exists: true };
    }
}
// Shared 30/14/7-day severity ladder -- exported for reuse by any other date-deadline warning
// (workspace-alerts.ts's suspension-date lifecycle uses the same "rises as it approaches" rule).
export const EXPIRY_THRESHOLDS = { warn: 30, urgent: 14, critical: 7 };
const SSL_THRESHOLDS = EXPIRY_THRESHOLDS;
function defaultTlsConnect(host, port) {
    return new Promise((resolve) => {
        const socket = tls.connect({ host, port, servername: host, timeout: 5000, rejectUnauthorized: false }, () => {
            const cert = socket.getPeerCertificate();
            socket.destroy();
            resolve(cert && cert.valid_to ? { validTo: cert.valid_to } : null);
        });
        socket.on('error', () => resolve(null));
        socket.on('timeout', () => { socket.destroy(); resolve(null); });
    });
}
export function severityForDays(days) {
    if (days <= EXPIRY_THRESHOLDS.critical)
        return 'high';
    if (days <= EXPIRY_THRESHOLDS.urgent)
        return 'medium';
    if (days <= EXPIRY_THRESHOLDS.warn)
        return 'low';
    return null;
}
/** TLS cert expiry for each configured host. Silent (no warning) when healthy. */
export async function checkSslExpiry(hosts, now, deps = {}) {
    const connect = deps.connect || defaultTlsConnect;
    const warnings = [];
    for (const host of hosts) {
        let cert;
        try {
            cert = await connect(host, 443);
        }
        catch {
            cert = null;
        }
        if (!cert) {
            warnings.push({
                code: 'ssl_check_failed', severity: 'low', provider: 'ssl', message: `${host}: SSL certificate not verifiable (connection error).`,
                warning_type: 'access', category: 'domains', source: 'tls', confidence: 'no_api_or_no_access', detail: { host },
            });
            continue;
        }
        const daysRemaining = Math.floor((Date.parse(cert.validTo) - now * 1000) / 86400000);
        const severity = severityForDays(daysRemaining);
        if (!severity)
            continue; // healthy -- no noise
        warnings.push({
            code: 'ssl_expiry_soon', severity, provider: 'ssl',
            message: `${host}: SSL certificate expires in ${daysRemaining} days.`,
            detail: { host, expiry_date: cert.validTo },
            warning_type: 'expiry', category: 'domains', source: 'tls', confidence: 'measured',
            expiry_date: cert.validTo, current_value: daysRemaining, threshold: SSL_THRESHOLDS.warn, unit: 'day',
            action: 'Verify that the certificate auto-renewal is configured.',
        });
    }
    return warnings;
}
const DOMAIN_THRESHOLDS = { warn: 30, urgent: 14, critical: 7 };
// Read-only public RDAP registries per TLD -- extend as new TLDs are used.
const RDAP_BASE = {
    com: 'https://rdap.verisign.com/com/v1/domain/',
    net: 'https://rdap.verisign.com/net/v1/domain/',
};
/** Domain registration expiry via public RDAP. Silent (no warning) when healthy or TLD unsupported. */
export async function checkDomainExpiry(domains, now, deps = {}) {
    const fetchJson = deps.fetchJson || (async (url) => {
        const r = await fetch(url);
        if (!r.ok)
            throw new Error(`rdap ${r.status}`);
        return r.json();
    });
    const warnings = [];
    for (const domain of domains) {
        const tld = domain.split('.').pop() || '';
        const base = RDAP_BASE[tld];
        if (!base) {
            warnings.push({
                code: 'domain_expiry_check_unsupported', severity: 'low', provider: 'domain', message: `${domain}: domain expiry not checkable (.${tld} TLD not supported).`,
                warning_type: 'access', category: 'domains', source: 'rdap', confidence: 'no_api_or_no_access', detail: { domain },
            });
            continue;
        }
        let resp;
        try {
            resp = await fetchJson(`${base}${domain}`);
        }
        catch {
            warnings.push({
                code: 'domain_expiry_check_failed', severity: 'low', provider: 'domain', message: `${domain}: domain expiry query failed.`,
                warning_type: 'access', category: 'domains', source: 'rdap', confidence: 'no_api_or_no_access', detail: { domain },
            });
            continue;
        }
        const expEvent = (resp.events || []).find(e => e.eventAction === 'expiration');
        if (!expEvent?.eventDate)
            continue; // no data -- never fabricate an expiry
        const daysRemaining = Math.floor((Date.parse(expEvent.eventDate) - now * 1000) / 86400000);
        const severity = severityForDays(daysRemaining);
        if (!severity)
            continue;
        warnings.push({
            code: 'domain_expiry_soon', severity, provider: 'domain',
            message: `${domain}: domain registration expires in ${daysRemaining} days.`,
            detail: { domain, expiry_date: expEvent.eventDate },
            warning_type: 'expiry', category: 'domains', source: 'rdap', confidence: 'measured',
            expiry_date: expEvent.eventDate, current_value: daysRemaining, threshold: DOMAIN_THRESHOLDS.warn, unit: 'day',
            action: 'Renew the domain registration.',
        });
    }
    return warnings;
}
