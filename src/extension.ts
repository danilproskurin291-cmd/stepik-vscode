import * as vscode from 'vscode';
import * as fs from 'fs';
import { StepikAuth } from './auth';
import { StepikTreeProvider } from './providers/treeProvider';
import { StepikApi } from './api/stepikApi';
import { StepikWebview } from './views/webview';
import { CourseCatalogView } from './views/courseCatalog';
import { StepikNotificationsView } from './views/notifications';
import { StepikProfileView } from './views/profile';
import { StepikSubmit } from './submit';
import { StepContext } from './stepContext';
import { getActiveSolutionRoot } from './stepikPaths';
import { AccountWorkspace } from './accountWorkspace';
import { t } from './i18n';

let api: StepikApi;
let treeProvider: StepikTreeProvider;

/**
 * Solutions are stored in the active account folder under `~/stepik`,
 * regardless of the open workspace. The folder is created automatically; it
 * never has to be opened as a workspace.
 */
function ensureSolutionDirectory(outputChannel: vscode.OutputChannel): void {
    const folder = getActiveSolutionRoot();
    try {
        fs.mkdirSync(folder, { recursive: true });
        outputChannel.appendLine(`[Solutions] ${t('ext.solutionsFolder', { path: folder })}`);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            t('ext.solutionsFolderError', { path: folder, detail })
        );
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {

    // Create output channel for errors
    const outputChannel = vscode.window.createOutputChannel('Stepik');

    const auth = new StepikAuth(context);
    api = new StepikApi(auth);
    treeProvider = new StepikTreeProvider(api, context);
    const accountWorkspace = new AccountWorkspace(api, outputChannel);
    const webview = new StepikWebview(context, api, treeProvider, outputChannel);
    const catalog = new CourseCatalogView(context, api, treeProvider, outputChannel);
    const notifications = new StepikNotificationsView(context, api, outputChannel);
    const profile = new StepikProfileView(context, api, outputChannel);
    const submit = new StepikSubmit(api, treeProvider, outputChannel);

    // Register tree view
    const treeView = vscode.window.createTreeView('stepikCourses', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Update tree view title based on selected course. The activity bar
    // container is already named "Stepik", so do not repeat that prefix in the
    // view title (course titles on Stepik may start with "Stepik:" too).
    const updateTreeTitle = () => {
        const course = treeProvider.getSelectedCourse();
        if (course) {
            const title = course.title.replace(/^(?:\s*Stepik\s*:\s*)+/i, '').trim();
            treeView.title = title || course.title;
        } else {
            treeView.title = t('ext.treeNoCourse');
        }
    };
    updateTreeTitle();

    // The provider restores the selected course asynchronously, so keep the
    // view title in sync with every tree refresh.
    context.subscriptions.push(
        treeProvider.onDidChangeTreeData(() => updateTreeTitle())
    );

    /** Rebuild every localized surface after the language setting changes. */
    const applyLanguage = () => {
        updateTreeTitle();
        treeProvider.refresh();
        profile.refreshLocalization();
        notifications.refreshLocalization();
        catalog.refreshLocalization();
        webview.refreshLocalization();
    };

    // Register commands
    context.subscriptions.push(
        webview,
        catalog,
        notifications,
        profile,

        vscode.commands.registerCommand('stepik.login', async () => {
            const loggedIn = await auth.login();
            if (!loggedIn) {
                return;
            }
            api.clearCache();
            try {
                const state = await accountWorkspace.ensureCurrentAccount();
                ensureSolutionDirectory(outputChannel);
                if (state.migratedLegacy) {
                    vscode.window.showInformationMessage(
                        t('ext.legacyMigrated', { path: state.folder })
                    );
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(
                    `[Account] ${t('ext.accountFolderError', { detail })}`
                );
                vscode.window.showErrorMessage(
                    t('ext.accountFolderError', { detail })
                );
            }
            if (loggedIn) {
                notifications.start();
            }
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.logout', async () => {
            const archive = await accountWorkspace.archiveCurrentAccount();
            if (!archive.ok) {
                vscode.window.showErrorMessage(
                    t('ext.archiveBeforeLogoutError', {
                        detail: archive.error || t('ext.unknownError')
                    })
                );
                return;
            }
            await auth.logout();
            api.clearCache();
            webview.resetForLogout();
            catalog.resetForLogout();
            notifications.resetForLogout();
            profile.resetForLogout();
            accountWorkspace.clearActiveAccount();
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.archiveAccount', async () => {
            const result = await accountWorkspace.archiveCurrentAccount();
            if (!result.ok) {
                vscode.window.showErrorMessage(
                    t('ext.archiveError', {
                        detail: result.error || t('ext.unknownError')
                    })
                );
                return;
            }
            if (result.path) {
                vscode.window.showInformationMessage(
                    t('ext.archiveSaved', { path: result.path })
                );
            } else {
                vscode.window.showInformationMessage(t('ext.noAccount'));
            }
        }),

        vscode.commands.registerCommand('stepik.refresh', () => {
            treeProvider.forceRefresh();
        }),

        vscode.commands.registerCommand('stepik.selectCourse', async () => {
            const action = await treeProvider.selectCourse();
            if (action === 'browse') {
                catalog.show();
            }
            updateTreeTitle();
        }),

        vscode.commands.registerCommand('stepik.browseCourses', () => {
            catalog.show();
        }),

        vscode.commands.registerCommand('stepik.showNotifications', () => {
            notifications.show();
        }),

        vscode.commands.registerCommand('stepik.showProfile', () => {
            profile.show();
        }),

        vscode.commands.registerCommand('stepik.changeLanguage', async () => {
            const config = vscode.workspace.getConfiguration('stepik');
            const current = config.get<string>('language', 'auto');
            const options = [
                {
                    label: t('ext.languageAuto'),
                    description: current === 'auto' ? '✓' : '',
                    value: 'auto'
                },
                {
                    label: t('ext.languageRussian'),
                    description: current === 'ru' ? '✓' : '',
                    value: 'ru'
                },
                {
                    label: t('ext.languageEnglish'),
                    description: current === 'en' ? '✓' : '',
                    value: 'en'
                }
            ];
            const picked = await vscode.window.showQuickPick(options, {
                placeHolder: t('ext.languagePick')
            });
            if (!picked) {
                return;
            }
            await config.update(
                'language',
                picked.value,
                vscode.ConfigurationTarget.Global
            );
            // Read the label after the update so the confirmation uses the
            // language that is now active, not the previous one.
            const languageLabel =
                picked.value === 'ru'
                    ? t('ext.languageRussian')
                    : picked.value === 'en'
                        ? t('ext.languageEnglish')
                        : t('ext.languageAuto');
            vscode.window.showInformationMessage(
                t('ext.languageChanged', { language: languageLabel })
            );
        }),

        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('stepik.language')) {
                applyLanguage();
            }
        }),

        vscode.commands.registerCommand('stepik.openStep', async (stepContext: StepContext) => {
            if (!stepContext?.step) {
                vscode.window.showErrorMessage(t('ext.stepNotFound'));
                return;
            }
            await webview.showStep(stepContext);
        }),

        vscode.commands.registerCommand(
            'stepik.startExam',
            async (args?: { sectionId?: number; sectionTitle?: string }) => {
                const sectionId = args?.sectionId;
                if (!sectionId) {
                    vscode.window.showErrorMessage(t('ext.examSectionNotFound'));
                    return;
                }

                try {
                    const state = await treeProvider.getSectionAccessById(sectionId, true);
                    if (!state) {
                        vscode.window.showErrorMessage(t('ext.examSectionLoadError'));
                        return;
                    }

                    const { access } = state;
                    let examSession = access.examSession;
                    if (access.isExam && !examSession) {
                        if (!access.canStartExam) {
                            vscode.window.showWarningMessage(
                                access.reason || t('ext.examUnavailable')
                            );
                            return;
                        }

                        const minutes = state.section.exam_duration_minutes || 120;
                        const startExam = t('ext.examStartButton');
                        const confirmation = await vscode.window.showWarningMessage(
                            t('ext.examStartConfirm', {
                                title: state.section.title,
                                minutes
                            }),
                            { modal: true },
                            startExam
                        );
                        if (confirmation !== startExam) {
                            return;
                        }

                        examSession = await api.createExamSession(sectionId);
                        treeProvider.forceRefresh();
                    }

                    const firstStep = await treeProvider.getFirstStep(sectionId);
                    if (!firstStep) {
                        vscode.window.showInformationMessage(t('ext.examNoSteps'));
                        return;
                    }
                    await webview.showStep(firstStep, examSession);
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(
                        t('ext.examStartError', { detail })
                    );
                }
            }
        ),

        vscode.commands.registerCommand('stepik.submit', async () => {
            await submit.submitCurrentFile();
        }),

        treeView,
        treeProvider,
        outputChannel
    );

    // Check if already logged in. Preparing the account folder also migrates
    // the pre-0.4.2 `~/.stepik` layout on the first launch after upgrade.
    if (await auth.isLoggedIn()) {
        try {
            const state = await accountWorkspace.ensureCurrentAccount();
            outputChannel.appendLine(
                `[Account] Активный аккаунт: ${state.account.name} (ID ${state.account.id}), папка ${state.folder}`
            );
            if (state.migratedLegacy) {
                vscode.window.showInformationMessage(
                    t('ext.legacyMigrated', { path: state.folder })
                );
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(
                `[Account] ${t('ext.accountFolderError', { detail })}`
            );
            vscode.window.showWarningMessage(
                t('ext.accountFolderWarning', { detail })
            );
        }
        treeProvider.refresh();
        notifications.start();
    }

    // Prepare the solutions folder. It is independent of the open workspace
    // and does not need to be opened in VS Code.
    ensureSolutionDirectory(outputChannel);
}

export function deactivate() {}
