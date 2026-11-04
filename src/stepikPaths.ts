import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Root folder for all Stepik data (solutions and per-account metadata).
 *
 * Since 0.4.2 every Stepik account gets its own working folder:
 *
 *   ~/stepik/<account name>/
 *   ~/stepik/archive/<account id>.zip
 *
 * The old 0.4.1 layout used `~/.stepik` directly. It is migrated into the
 * first account folder when that account logs in.
 */
export function getStepikRoot(): string {
    return path.join(os.homedir(), 'stepik');
}

export function getStepikServiceDir(): string {
    return path.join(getStepikRoot(), '.stepik');
}

export function getArchiveDir(): string {
    return path.join(getStepikRoot(), 'archive');
}

export function getAccountsRegistryPath(): string {
    return path.join(getStepikServiceDir(), 'accounts.json');
}

export function getActiveAccountPath(): string {
    return path.join(getStepikServiceDir(), 'active-account.json');
}

/** Root of the pre-0.4.2 layout. */
export function getLegacyStepikRoot(): string {
    return path.join(os.homedir(), '.stepik');
}

export interface ActiveAccountLocation {
    id: number;
    name: string;
    folder: string;
}

export interface AccountsRegistry {
    version: number;
    accounts: Array<
        ActiveAccountLocation & { lastLoginAt?: string; createdAt?: string }
    >;
}

function readJson<T>(filePath: string): T | undefined {
    try {
        if (!fs.existsSync(filePath)) {
            return undefined;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

/**
 * Resolve a stored folder name inside `~/stepik` and reject paths that could
 * escape the root (for example `../other`).
 */
export function resolveAccountDir(folder: string): string | undefined {
    const root = path.resolve(getStepikRoot());
    const candidate = path.resolve(root, folder);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return undefined;
    }
    return candidate;
}

/** Active account written by AccountWorkspace after a successful login. */
export function getActiveAccountLocation(): ActiveAccountLocation | undefined {
    const value = readJson<ActiveAccountLocation>(getActiveAccountPath());
    if (!value || !Number.isInteger(value.id) || value.id <= 0 || typeof value.folder !== 'string') {
        return undefined;
    }
    if (!resolveAccountDir(value.folder)) {
        return undefined;
    }
    return value;
}

/**
 * The folder where solution files for the currently logged-in account live.
 * Before the first login (or if metadata is missing) it falls back to the
 * common root so the extension remains usable.
 */
export function getActiveSolutionRoot(): string {
    const account = getActiveAccountLocation();
    return account ? resolveAccountDir(account.folder) ?? getStepikRoot() : getStepikRoot();
}

export function getAccountServiceDir(accountDir: string = getActiveSolutionRoot()): string {
    return path.join(accountDir, '.stepik');
}

/**
 * Mapping for the active account. Legacy/global mapping is used only before
 * an account folder has been prepared.
 */
export function getMappingPath(): string {
    return path.join(getAccountServiceDir(), 'mapping.json');
}

/**
 * Creates `~/stepik` if it does not exist yet and returns its absolute path.
 * Callers decide how to report a failure to the user.
 */
export function ensureStepikRoot(): string {
    const root = getStepikRoot();
    fs.mkdirSync(root, { recursive: true });
    return root;
}

export function getLegacyMappingPaths(): string[] {
    const paths: string[] = [];

    // 0.4.1 and earlier stored the global mapping here.
    paths.push(path.join(getLegacyStepikRoot(), '.stepik', 'mapping.json'));

    for (const folder of vscodeWorkspaceFolders()) {
        const mappingPath = path.join(folder, '.stepik', 'mapping.json');
        if (!paths.includes(mappingPath)) {
            paths.push(mappingPath);
        }
    }
    return paths;
}

// Kept in a separate function so this module stays importable in plain Node
// tests and the `vscode` module is only touched at runtime.
function vscodeWorkspaceFolders(): string[] {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require('vscode') as typeof import('vscode');
        return (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    } catch {
        return [];
    }
}
