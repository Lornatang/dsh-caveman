export type VoiceMode = 'off' | 'caveman' | 'ultracave' | 'megacave';
export type DefaultMode = VoiceMode | 'manual';
export type ModeAction = 'none' | 'change' | 'status' | 'one-shot' | 'unresolved';
interface InputMessage {
    readonly source: {
        readonly kind: string;
    };
    readonly content: readonly {
        readonly type: string;
        readonly text?: string;
    }[];
}
interface InputEvent {
    readonly type: string;
    readonly data: unknown;
}
/** A profile override wins; otherwise follow upstream environment and file resolution. */
export declare function defaultModeFor(configured: DefaultMode | undefined, cwd?: string): DefaultMode;
/** Replay only user-authored messages, then evaluate the incoming batch. */
export declare function resolveMode(configured: DefaultMode, events: readonly InputEvent[], pending: readonly InputMessage[]): {
    mode: VoiceMode;
    action: ModeAction;
};
export {};
