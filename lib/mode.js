import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const parser = require('../vendor/caveman/src/hooks/caveman-parse.js');
const modeConfig = require('../vendor/caveman/src/hooks/caveman-config.js');
/** A profile override wins; otherwise follow environment and file resolution. */
export function defaultModeFor(configured, cwd) {
    if (configured !== undefined)
        return configured;
    const mode = modeConfig.getDefaultMode(cwd);
    return mode === 'manual' || mode === 'off' || mode === 'caveman' || mode === 'ultracave' || mode === 'megacave' ? mode : 'caveman';
}
function transition(mode, message, configured) {
    if (message.source.kind !== 'user')
        return { mode, action: 'none' };
    const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    const change = parser.parseModeChange(text, { getDefaultMode: () => configured });
    if (!change)
        return { mode, action: 'none' };
    if (change.action === 'status')
        return { mode, action: 'status' };
    if (change.action === 'unresolved')
        return { mode, action: 'unresolved' };
    if (change.action === 'clear')
        return { mode: 'off', action: 'change' };
    if (change.mode && parser.INDEPENDENT_MODES.has(change.mode))
        return { mode, action: 'one-shot' };
    if (change.mode === 'caveman' || change.mode === 'ultracave' || change.mode === 'megacave') {
        return { mode: change.mode, action: 'change' };
    }
    return { mode, action: 'none' };
}
/** Replay only user-authored messages, then evaluate the incoming batch. */
export function resolveMode(configured, events, pending) {
    let mode = configured === 'manual' ? 'off' : configured;
    for (const event of events) {
        if (event.type !== 'user/message' || !event.data || typeof event.data !== 'object')
            continue;
        const message = event.data;
        if (!message.source || !Array.isArray(message.content))
            continue;
        mode = transition(mode, message, configured).mode;
    }
    let action = 'none';
    for (const message of pending) {
        const result = transition(mode, message, configured);
        mode = result.mode;
        if (result.action !== 'none')
            action = result.action;
    }
    return { mode, action };
}
