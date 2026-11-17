import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Report recorded message usage without claiming savings or unreported counts. */
export declare function sessionStats(events: readonly SessionEvent[], flags: string): string;
