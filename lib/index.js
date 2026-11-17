import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createSkillProvider } from './skills.js';
import { defaultModeFor, resolveMode } from './mode.js';
import { registerCompression } from './compression.js';
import { registerBlocks } from './blocks.js';
import { sessionStats } from './stats.js';
export const name = 'caveman';
export const inject = ['skills', 'tools', 'systemPrompt', 'llm'];
export const Config = z.object({
    defaultMode: z.union([
        z.const('caveman'), z.const('ultracave'), z.const('megacave'), z.const('off'), z.const('manual'),
    ]),
    inputCompression: z.boolean().default(false),
    middlewareEndpoint: z.string().default('http://127.0.0.1:8787'),
    blocksBinary: z.string().min(1),
    browseBinary: z.string().min(1),
});
/** Register the upstream skills and reinforce the selected mode per session. */
export function apply(ctx, config = {}) {
    const root = fileURLToPath(new URL('../upstream/skills/', import.meta.url));
    ctx.skills.registerProvider(control => createSkillProvider(root, control));
    if (config.inputCompression)
        registerCompression(ctx, config.middlewareEndpoint ?? 'http://127.0.0.1:8787');
    if (config.blocksBinary)
        registerBlocks(ctx, config.blocksBinary);
    if (config.browseBinary) {
        if (!isAbsolute(config.browseBinary))
            throw new Error('dsh-caveman: browseBinary must be an absolute path');
        const binary = config.browseBinary;
        ctx.inject(['mcpManager'], scoped => {
            scoped.mcpManager.register('caveman_browse', { transport: 'stdio', command: binary, args: [] });
        });
    }
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        const decision = await next();
        if (decision.kind === 'reject')
            return decision;
        const directMessages = decision.messages.filter(message => message.source.kind === 'user');
        if (directMessages.length === 0)
            return decision;
        signal.throwIfAborted();
        const statsRequest = directMessages.map(message => message.content
            .filter(block => block.type === 'text').map(block => block.text).join('\n'))
            .map(text => /^\/caveman(?::caveman)?-stats(?:\s+(.*))?$/u.exec(text.trim()))
            .reverse().find(match => match !== null);
        if (statsRequest) {
            const report = sessionStats(agent.session.snapshotEvents(), statsRequest[1]?.trim() ?? '');
            const reminder = createUserMessage({
                source: { kind: 'dsh-caveman-stats', form: 'notice' },
                content: [{ type: 'text', text: `Print this report verbatim in a fenced code block. Do not infer savings.\n\n${report}` }],
            });
            return { ...decision, messages: [...decision.messages, reminder] };
        }
        const directory = ctx.get('workingDirectory');
        const cwd = directory ? await directory.ensure(agent, signal) : agent.session.header.cwd;
        const selected = resolveMode(defaultModeFor(config.defaultMode, cwd), agent.session.snapshotEvents(), directMessages);
        if (selected.action === 'one-shot' || (selected.mode === 'off' && selected.action === 'none'))
            return decision;
        let text;
        if (selected.action === 'status') {
            text = `Report this status without changing it: Caveman mode: ${selected.mode}`;
        }
        else if (selected.action === 'unresolved') {
            text = 'The requested Caveman mode is not recognized. Keep the current mode unchanged and explain the valid commands.';
        }
        else if (selected.mode === 'off') {
            text = 'Caveman mode is off. Stop following previous Caveman mode instructions and resume the normal response style.';
        }
        else {
            const skill = await ctx.skills.get(selected.mode, { scope: agent, signal });
            signal.throwIfAborted();
            if (!skill)
                throw new Error(`dsh-caveman: ${selected.mode} skill is unavailable`);
            text = `Caveman mode: ${selected.mode}\n\n${skill.content}`;
        }
        const reminder = createUserMessage({
            source: { kind: 'dsh-caveman-mode', form: 'instructions', mode: selected.mode },
            content: [{ type: 'text', text }],
        });
        return { ...decision, messages: [...decision.messages, reminder] };
    });
}
