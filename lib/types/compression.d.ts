import type { Context } from '@deepseek-ai/cordis';
/** Install recoverable compression using the middleware protocol. */
export declare function registerCompression(ctx: Context, endpoint: string, automatic?: {
    fetch: typeof fetch;
    available: (signal: AbortSignal) => Promise<boolean>;
}): void;
