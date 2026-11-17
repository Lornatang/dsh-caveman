type Binary = 'blocks' | 'browse';
type Module = 'scripts' | 'browse';
/** Find a configured binary, PATH command, or the CLI's installation. */
export declare function findCavemanBinary(kind: Binary, configured?: string, env?: NodeJS.ProcessEnv): string | undefined;
/** Modules default to on; a saved explicit off is respected. */
export declare function moduleEnabled(kind: Module, env?: NodeJS.ProcessEnv): boolean;
export {};
