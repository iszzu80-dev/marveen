import { listAgentNames, readAgentCapabilities, writeAgentCapabilities, isKnownAgent } from '../agent-config.js';
import { readBody, json } from '../http-helpers.js';
// GET /.well-known/fleetq
// Machine-readable fleet capability manifest. Requires Bearer auth (enforced
// by the auth gate in web.ts before this handler is reached) so the agent
// roster is not visible to unauthenticated callers on LAN-exposed instances.
//
// PUT /api/agents/:name/capabilities
// Update a specific agent's capability tags at runtime. Requires Bearer auth
// (handled by the outer auth gate in web.ts). Body: { "capabilities": string[] }
export async function tryHandleFleetQ(ctx) {
    const { req, res, path, method } = ctx;
    if (path === '/.well-known/fleetq' && method === 'GET') {
        const manifest = {};
        for (const name of listAgentNames()) {
            manifest[name] = readAgentCapabilities(name);
        }
        json(res, manifest);
        return true;
    }
    const capMatch = path.match(/^\/api\/agents\/([^/]+)\/capabilities$/);
    if (capMatch && method === 'PUT') {
        const name = decodeURIComponent(capMatch[1]);
        if (!isKnownAgent(name)) {
            json(res, { error: 'Agent nem található' }, 404);
            return true;
        }
        const body = await readBody(req);
        const parsed = JSON.parse(body.toString());
        if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every((c) => typeof c === 'string')) {
            json(res, { error: 'capabilities: string[] required' }, 400);
            return true;
        }
        writeAgentCapabilities(name, parsed.capabilities);
        json(res, { ok: true, capabilities: parsed.capabilities });
        return true;
    }
    return false;
}
