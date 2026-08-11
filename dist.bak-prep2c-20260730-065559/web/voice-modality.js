// Transient in-memory store for last-inbound-modality per (agentId, chatId).
// Used by auto-mode: if the last message to an agent was a voice message,
// the reply should also be voice. Entries expire after TTL to avoid replying
// with voice hours after the original request.
//
// This is process-local state (intentionally). A restart clears all flags,
// which is fine: the worst case is a text reply to a stale auto-mode session.
const TTL_MS = 10 * 60 * 1000; // 10 minutes
const store = new Map();
function key(agentId, chatId) {
    return `${agentId}:${chatId}`;
}
export function setLastInboundModality(agentId, chatId, modality) {
    store.set(key(agentId, chatId), { modality, ts: Date.now() });
}
export function getLastInboundModality(agentId, chatId) {
    const entry = store.get(key(agentId, chatId));
    if (!entry)
        return null;
    if (Date.now() - entry.ts > TTL_MS) {
        store.delete(key(agentId, chatId));
        return null;
    }
    return entry.modality;
}
export function clearLastInboundModality(agentId, chatId) {
    store.delete(key(agentId, chatId));
}
