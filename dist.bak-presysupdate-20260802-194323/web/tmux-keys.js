// Pure mapping of dashboard keyboard input -> `tmux send-keys` arguments, and
// the scripted /login keystroke sequence. Kept dependency-free + exported so
// the mapping (the part most likely to drift) is unit-testable without spawning
// tmux. The actual execFile lives in routes/agent-terminal.ts.
// Named special keys the web terminal may send (xterm captures these and posts
// {special}). tmux understands these key names directly in send-keys.
const SPECIAL_KEYS = {
    Enter: ['Enter'],
    Escape: ['Escape'],
    Tab: ['Tab'],
    BSpace: ['BSpace'],
    Backspace: ['BSpace'],
    Up: ['Up'],
    Down: ['Down'],
    Left: ['Left'],
    Right: ['Right'],
    Home: ['Home'],
    End: ['End'],
    PageUp: ['PageUp'],
    PageDown: ['PageDown'],
    Space: ['Space'],
    'S-Tab': ['BTab'],
    'C-c': ['C-c'],
    'C-d': ['C-d'],
    'C-u': ['C-u'],
    'C-l': ['C-l'],
    'C-r': ['C-r'],
    'C-a': ['C-a'],
    'C-e': ['C-e'],
};
/**
 * Resolve a {special} key name to the tmux send-keys argument list, or null if
 * the name is not allow-listed. The allow-list is the security boundary: the
 * web terminal can only inject keys we recognise, not arbitrary control args.
 */
export function resolveSpecialKey(name) {
    return SPECIAL_KEYS[name] ?? null;
}
/**
 * Build send-keys args for a literal text chunk. tmux send-keys treats a string
 * that begins with `-` as a flag; the leading `--` terminator forces it to be
 * taken literally. We always pass the text after `--`. Returns null for empty.
 */
export function literalKeyArgs(session, text) {
    if (!text)
        return null;
    // `-l` sends the keys literally (no key-name interpretation), so text like
    // "Enter" or "C-c" typed by the user is inserted as characters, not actions.
    return ['send-keys', '-t', session, '-l', '--', text];
}
/**
 * Build send-keys args for a named special key. Returns null if not allow-listed.
 */
export function specialKeyArgs(session, name) {
    const keys = resolveSpecialKey(name);
    if (!keys)
        return null;
    return ['send-keys', '-t', session, ...keys];
}
export function loginSequence(phase) {
    if (phase === 'start') {
        return [
            // Type the slash command and submit it.
            { kind: 'literal', text: '/login', delayMs: 400 },
            { kind: 'special', key: 'Enter', delayMs: 1500 },
            // The login picker appears with the subscription option highlighted
            // first; Enter accepts it and launches the browser OAuth.
            { kind: 'special', key: 'Enter', delayMs: 300 },
        ];
    }
    // confirm: the two trailing Enters after the user authorised in the browser.
    return [
        { kind: 'special', key: 'Enter', delayMs: 500 },
        { kind: 'special', key: 'Enter', delayMs: 100 },
    ];
}
