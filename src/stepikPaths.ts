import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Root folder for all solution files. It is intentionally independent of the
 * currently opened VS Code workspace: the extension can be used from any
 * project, and solutions are always stored in the user's home directory.
 */
export function getStepikRoot(): string {
    return path.join(os.homedir(), '.stepik');
}

/**
 * Service folder inside the root. Keeping it inside `~/.stepik` preserves the
 * layout used by earlier versions, where `~/.stepik` was opened as a workspace.
 */
export function getStepikServiceDir(): string {
    return path.join(getStepikRoot(), '.stepik');
}

export function getMappingPath(): string {
    return path.join(getStepikServiceDir(), 'mapping.json');
}

/**
 * Creates `~/.stepik` if it does not exist yet and returns its absolute path.
 * Callers decide how to report a failure to the user.
 */
export function ensureStepikRoot(): string {
    const root = getStepikRoot();
    fs.mkdirSync(root, { recursive: true });
    return root;
}

/**
 * Mapping files written by versions before 0.4.0 could live in any folder that
 * was open as a workspace. They are still read as a fallback so existing
 * solutions keep working after the upgrade.
 */
export function getLegacyMappingPaths(): string[] {
    const paths: string[] = [];
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
