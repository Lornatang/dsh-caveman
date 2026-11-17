import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
function executable(path) {
    try {
        accessSync(path, constants.X_OK);
        return statSync(path).isFile();
    }
    catch {
        return false;
    }
}
function pathCommand(name, env) {
    const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
    const names = process.platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? [name, `${name}.exe`] : [name];
    for (const dir of dirs)
        for (const candidate of names) {
            const path = resolve(dir, candidate);
            if (executable(path))
                return path;
        }
    return undefined;
}
/** Find a configured binary, PATH command, or the CLI's installation. */
export function findCavemanBinary(kind, configured, env = process.env) {
    if (configured !== undefined) {
        if (!isAbsolute(configured))
            throw new Error(`dsh-caveman: ${kind}Binary must be an absolute path`);
        return configured;
    }
    const override = env[kind === 'blocks' ? 'CAVEMAN_BLOCKS_BIN' : 'CAVEMAN_BROWSE_BIN'];
    if (override) {
        if (isAbsolute(override) || /[\\/]/u.test(override)) {
            const absolute = resolve(override);
            return executable(absolute) ? absolute : undefined;
        }
        return pathCommand(override, env);
    }
    const name = `caveman-${kind}`;
    const onPath = pathCommand(name, env);
    if (onPath)
        return onPath;
    const filename = process.platform === 'win32' ? `${name}.exe` : name;
    const local = resolve(env.CAVEMAN_HOME ?? join(homedir(), '.caveman'), 'bin', filename);
    return executable(local) ? local : undefined;
}
/** Modules default to on; a saved explicit off is respected. */
export function moduleEnabled(kind, env = process.env) {
    try {
        const home = env.CAVEMAN_HOME ?? join(homedir(), '.caveman');
        let raw;
        try {
            raw = readFileSync(join(home, 'cloud.json'), 'utf8');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
            raw = readFileSync(join(homedir(), '.caveman-cloud', 'config.json'), 'utf8');
        }
        const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ''));
        const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const document = object(parsed);
        const selected = object(document.modules)[kind];
        if (typeof selected === 'boolean')
            return selected;
        if (kind !== 'browse')
            return true;
        const setting = object(document.execute).browse_tool ?? object(document.wrap).browse;
        return setting !== false && !(typeof setting === 'string' && ['0', 'false', 'no', 'off'].includes(setting.trim().toLowerCase()));
    }
    catch {
        return true;
    }
}
