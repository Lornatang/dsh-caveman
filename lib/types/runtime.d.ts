type Binary = 'blocks' | 'browse';
type Module = 'scripts' | 'browse' | 'input';
/** Find a configured binary, PATH command, or the CLI's installation. */
export declare function findCavemanBinary(kind: Binary, configured?: string, env?: NodeJS.ProcessEnv): string | undefined;
/** Modules default to on; a saved explicit off is respected. */
export declare function moduleEnabled(kind: Module, env?: NodeJS.ProcessEnv): boolean;
/** Verify that the loopback listener matches the runtime's private run-state record. */
export declare function verifiedRuntime(endpoint: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean>;
/** Guard every automatic middleware call against a different or replaced listener. */
export declare function guardedRuntimeFetch(endpoint: string, env?: NodeJS.ProcessEnv): typeof fetch;
export {};
