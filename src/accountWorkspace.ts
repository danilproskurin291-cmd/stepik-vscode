import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { StepikApi } from './api/stepikApi';
import {
    AccountsRegistry,
    ActiveAccountLocation,
    getAccountsRegistryPath,
    getActiveAccountLocation,
    getActiveAccountPath,
    getArchiveDir,
    getLegacyStepikRoot,
    getStepikRoot,
    getStepikServiceDir,
    resolveAccountDir
} from './stepikPaths';

export interface StepikIdentity {
    id: number;
    name: string;
    alias?: string;
    avatar?: string;
}

interface AccountRecord extends ActiveAccountLocation {
    lastLoginAt?: string;
    createdAt?: string;
}

interface AccountMetadata {
    id: number;
    name: string;
    folder: string;
    updatedAt: string;
}

interface LegacyMigrationMarker {
    migrated: boolean;
    from?: string;
    to?: string;
    backup?: string | null;
    renamed?: boolean;
    pendingRename?: boolean;
    reason?: string;
    at: string;
}

export interface ArchiveResult {
    ok: boolean;
    path?: string;
    error?: string;
}

const REGISTRY_VERSION = 1;

function sanitizeFolderName(value: string, fallback: string): string {
    const cleaned = (value || '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^\.+$/, '')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 80);
    return cleaned || fallback;
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

function writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch {
            // Ignore cleanup errors.
        }
        throw error;
    }
}

function copyMissing(source: string, destination: string): void {
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            copyMissing(path.join(source, entry), path.join(destination, entry));
        }
        return;
    }

    // Do not follow symlinks during migration: a link can point outside the
    // account folder and would otherwise be copied into the archive.
    if (!stat.isFile()) {
        return;
    }
    if (fs.existsSync(destination)) {
        return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

/**
 * Owns the per-account solution folders and archives.
 *
 * Identity comes from Stepik itself (`/stepics/1`), so the folder name is the
 * user's real Stepik name and the archive name is the immutable account id.
 */
export class AccountWorkspace {
    constructor(
        private api: StepikApi,
        private outputChannel: vscode.OutputChannel
    ) {}

    getActiveAccount(): ActiveAccountLocation | undefined {
        return getActiveAccountLocation();
    }

    /**
     * Fetch the current Stepik identity and prepare its workspace. Called
     * after login, on activation, and before logout/account switching.
     */
    async ensureCurrentAccount(): Promise< {
        account: ActiveAccountLocation;
        folder: string;
        migratedLegacy: boolean;
    }> {
        const user = await this.api.getCurrentUser();
        const identity: StepikIdentity = {
            id: user.id,
            name: user.fullName || user.alias || `Аккаунт ${user.id}`,
            alias: user.alias ?? undefined,
            avatar: user.avatar ?? undefined
        };
        return this.ensureAccount(identity);
    }

    ensureAccount(identity: StepikIdentity): {
        account: ActiveAccountLocation;
        folder: string;
        migratedLegacy: boolean;
    } {
        if (!Number.isInteger(identity.id) || identity.id <= 0) {
            throw new Error('Stepik не вернул корректный ID аккаунта.');
        }

        const root = getStepikRoot();
        fs.mkdirSync(root, { recursive: true });
        fs.mkdirSync(getStepikServiceDir(), { recursive: true });

        const registry = this.readRegistry();
        const now = new Date().toISOString();
        let record: AccountRecord | undefined = registry.accounts.find(
            item => item.id === identity.id
        );

        if (!record) {
            const folder = this.pickFolderName(identity, registry);
            record = {
                id: identity.id,
                name: identity.name,
                folder,
                createdAt: now,
                lastLoginAt: now
            };
            registry.accounts.push(record);
        } else {
            // The account ID is stable, the display name is not. Keep the
            // existing folder so solutions do not move when the user renames
            // their Stepik profile.
            record.name = identity.name;
            record.lastLoginAt = now;
        }

        const accountDir = resolveAccountDir(record.folder);
        if (!accountDir) {
            throw new Error(`Некорректная папка аккаунта: ${record.folder}`);
        }
        fs.mkdirSync(path.join(accountDir, '.stepik'), { recursive: true });

        const metadata: AccountMetadata = {
            id: identity.id,
            name: identity.name,
            folder: record.folder,
            updatedAt: now
        };
        writeJsonAtomic(path.join(accountDir, '.stepik', 'account.json'), metadata);

        // The first account created by 0.4.2 inherits the old `~/.stepik`
        // solutions. The legacy folder is moved to a backup name after a
        // successful copy, so nothing is silently duplicated or deleted.
        const migratedLegacy = this.migrateLegacyRoot(accountDir);

        this.writeRegistry(registry);
        writeJsonAtomic(getActiveAccountPath(), {
            id: record.id,
            name: record.name,
            folder: record.folder,
            updatedAt: now
        });

        this.outputChannel.appendLine(
            `[Account] ${identity.name} (ID ${identity.id}) → ${accountDir}`
        );
        if (migratedLegacy) {
            this.outputChannel.appendLine(
                `[Account] Данные 0.4.1 перенесены в ${accountDir}`
            );
        }

        return {
            account: { id: record.id, name: record.name, folder: record.folder },
            folder: accountDir,
            migratedLegacy
        };
    }

    async archiveCurrentAccount(): Promise<ArchiveResult> {
        const active = getActiveAccountLocation();
        if (active) {
            return this.archiveAccount(active);
        }
        return { ok: true };
    }

    archiveAccount(account: ActiveAccountLocation): ArchiveResult {
        try {
            const accountDir = resolveAccountDir(account.folder);
            if (!accountDir || !fs.existsSync(accountDir)) {
                return { ok: true };
            }

            const archiveDir = getArchiveDir();
            fs.mkdirSync(archiveDir, { recursive: true });
            const archivePath = path.join(archiveDir, `${account.id}.zip`);
            const tempPath = `${archivePath}.${process.pid}.tmp`;

            const zip = new AdmZip();
            for (const entry of fs.readdirSync(accountDir)) {
                const fullPath = path.join(accountDir, entry);
                if (fs.statSync(fullPath).isDirectory()) {
                    zip.addLocalFolder(fullPath, entry);
                } else {
                    zip.addLocalFile(fullPath, '', entry);
                }
            }
            zip.writeZip(tempPath);

            if (fs.existsSync(archivePath)) {
                fs.unlinkSync(archivePath);
            }
            fs.renameSync(tempPath, archivePath);
            this.outputChannel.appendLine(
                `[Account] Архив ${account.name} (ID ${account.id}): ${archivePath}`
            );
            return { ok: true, path: archivePath };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Account] Не удалось создать архив для ${account.name} (ID ${account.id}): ${message}`
            );
            return { ok: false, error: message };
        }
    }

    clearActiveAccount(): void {
        try {
            if (fs.existsSync(getActiveAccountPath())) {
                fs.unlinkSync(getActiveAccountPath());
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Account] Не удалось очистить активный аккаунт: ${message}`
            );
        }
    }

    private pickFolderName(identity: StepikIdentity, registry: AccountsRegistry): string {
        const base = sanitizeFolderName(identity.name, `account-${identity.id}`);
        const candidates = [base, `${base} (${identity.id})`];
        for (const candidate of candidates) {
            if (!this.isFolderTaken(candidate, identity.id, registry)) {
                return candidate;
            }
        }
        return `${base} (${identity.id})-${Date.now().toString(36)}`;
    }

    private isFolderTaken(
        folder: string,
        accountId: number,
        registry: AccountsRegistry
    ): boolean {
        const normalized = folder.toLocaleLowerCase();
        const conflict = registry.accounts.some(
            item =>
                item.id !== accountId &&
                item.folder.toLocaleLowerCase() === normalized
        );
        if (conflict) {
            return true;
        }

        const accountDir = resolveAccountDir(folder);
        if (!accountDir) {
            return true;
        }
        const metadataPath = path.join(accountDir, '.stepik', 'account.json');
        const metadata = readJson<AccountMetadata>(metadataPath);
        return Boolean(metadata && metadata.id !== accountId);
    }

    private readRegistry(): AccountsRegistry {
        const registryPath = getAccountsRegistryPath();
        const parsed = readJson<AccountsRegistry>(registryPath);
        if (!parsed || !Array.isArray(parsed.accounts)) {
            return { version: REGISTRY_VERSION, accounts: [] };
        }
        return {
            version: REGISTRY_VERSION,
            accounts: parsed.accounts.filter(
                item =>
                    Number.isInteger(item.id) &&
                    item.id > 0 &&
                    typeof item.folder === 'string' &&
                    Boolean(resolveAccountDir(item.folder))
            )
        };
    }

    private writeRegistry(registry: AccountsRegistry): void {
        writeJsonAtomic(getAccountsRegistryPath(), {
            version: REGISTRY_VERSION,
            accounts: registry.accounts
        });
    }

    /**
     * Copy everything from `~/.stepik` into the first 0.4.2 account folder,
     * rewrite the old absolute mapping keys, and move the old root to a dated
     * backup. A marker prevents running the migration for every account.
     */
    private migrateLegacyRoot(accountDir: string): boolean {
        const markerPath = path.join(getStepikServiceDir(), 'legacy-migration.json');
        const legacyRoot = getLegacyStepikRoot();

        if (fs.existsSync(markerPath)) {
            const marker = readJson<LegacyMigrationMarker>(markerPath);
            // A previous copy succeeded but Windows held a handle on the old
            // folder. Retry only the rename; never copy the same tree twice.
            // Older 0.4.2 builds recorded an intended backup path without the
            // `renamed` flag, so treat a missing backup as a pending rename too.
            const missingBackup = Boolean(
                marker?.backup && !fs.existsSync(marker.backup)
            );
            const retryRename =
                Boolean(marker?.pendingRename) ||
                Boolean(
                    marker?.migrated &&
                        marker.renamed !== true &&
                        missingBackup
                );
            if (retryRename && fs.existsSync(legacyRoot)) {
                const renamed = this.renameLegacyRoot(legacyRoot);
                if (renamed.ok) {
                    writeJsonAtomic(markerPath, {
                        ...marker,
                        backup: renamed.backup,
                        renamed: true,
                        pendingRename: false,
                        at: new Date().toISOString()
                    });
                    this.outputChannel.appendLine(
                        `[Account] Старая папка 0.4.1 перемещена в ${renamed.backup}`
                    );
                } else {
                    this.outputChannel.appendLine(
                        `[Account] Старую папку 0.4.1 пока не удалось переименовать: ${renamed.error}`
                    );
                }
            }
            return false;
        }

        if (!fs.existsSync(legacyRoot)) {
            writeJsonAtomic(markerPath, {
                migrated: false,
                reason: 'legacy-root-missing',
                at: new Date().toISOString()
            });
            return false;
        }

        fs.mkdirSync(accountDir, { recursive: true });

        for (const entry of fs.readdirSync(legacyRoot)) {
            if (entry === '.stepik') {
                continue;
            }
            copyMissing(
                path.join(legacyRoot, entry),
                path.join(accountDir, entry)
            );
        }

        this.mergeLegacyMapping(legacyRoot, accountDir);

        const renamed = this.renameLegacyRoot(legacyRoot);
        if (!renamed.ok) {
            this.outputChannel.appendLine(
                `[Account] Копия 0.4.1 перенесена, но старую папку не удалось переименовать: ${renamed.error}`
            );
        }

        writeJsonAtomic(markerPath, {
            migrated: true,
            from: legacyRoot,
            to: accountDir,
            // Record a backup only after a successful rename; recording the
            // intended path made the marker lie about a locked folder.
            backup: renamed.backup ?? null,
            renamed: renamed.ok,
            pendingRename: !renamed.ok,
            at: new Date().toISOString()
        });
        return true;
    }

    private renameLegacyRoot(legacyRoot: string): {
        ok: boolean;
        backup?: string;
        error?: string;
    } {
        try {
            const stamp = new Date()
                .toISOString()
                .replace(/[-:]/g, '')
                .replace(/\..+$/, '');
            let backupPath = `${legacyRoot}.backup-${stamp}`;
            let suffix = 1;
            while (fs.existsSync(backupPath)) {
                backupPath = `${legacyRoot}.backup-${stamp}-${suffix++}`;
            }
            fs.renameSync(legacyRoot, backupPath);
            return { ok: true, backup: backupPath };
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    private mergeLegacyMapping(legacyRoot: string, accountDir: string): void {
        const legacyMappingPath = path.join(legacyRoot, '.stepik', 'mapping.json');
        const legacyMapping = readJson<Record<string, unknown>>(legacyMappingPath);
        if (!legacyMapping) {
            return;
        }

        const newMappingPath = path.join(accountDir, '.stepik', 'mapping.json');
        const newMapping =
            readJson<Record<string, unknown>>(newMappingPath) || {};

        const legacyPrefix = path.resolve(legacyRoot) + path.sep;
        for (const [filePath, value] of Object.entries(legacyMapping)) {
            const resolved = path.resolve(filePath);
            if (!resolved.toLowerCase().startsWith(legacyPrefix.toLowerCase())) {
                continue;
            }
            const relative = path.relative(legacyRoot, resolved);
            const newPath = path.join(accountDir, relative);
            if (!(newPath in newMapping)) {
                newMapping[newPath] = value;
            }
        }

        writeJsonAtomic(newMappingPath, newMapping);
    }
}
