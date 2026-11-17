import type { Context } from '@deepseek-ai/cordis';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-caveman-native': {
            kind: 'dsh-caveman-native';
            form: 'notice';
        };
    }
}
type PolicyMode = 'record' | 'safe' | 'max';
/** Hash and classify the prompt locally; the runtime does not receive the prompt text. */
export declare function nativePrompt(prompt: string): {
    prompt: {
        bytes: number;
        sha256: string;
    };
    task_profile: {
        type: string;
        terms: string[];
        continuation: boolean;
    };
};
/** Name the same per-install socket as the local runtime. */
export declare function nativeSocketPath(home: string, platform?: NodeJS.Platform): string;
/** Add dynamic native task context when the verified local runtime is running. */
export declare function registerNative(ctx: Context, endpoint: string, policy: {
    mode: PolicyMode;
    profile: string;
    core: boolean;
}): void;
export {};
