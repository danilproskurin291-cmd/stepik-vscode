import * as vscode from 'vscode';
import * as fs from 'fs';
import { StepikAuth } from './auth';
import { StepikTreeProvider } from './providers/treeProvider';
import { StepikApi } from './api/stepikApi';
import { StepikWebview } from './views/webview';
import { CourseCatalogView } from './views/courseCatalog';
import { StepikSubmit } from './submit';
import { StepContext } from './stepContext';
import { getActiveSolutionRoot } from './stepikPaths';
import { AccountWorkspace } from './accountWorkspace';

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
        outputChannel.appendLine(`[Solutions] Папка решений: ${folder}`);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
            `Не удалось создать папку решений ${folder}: ${detail}`
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
            treeView.title = 'Выберите курс';
        }
    };
    updateTreeTitle();

    // The provider restores the selected course asynchronously, so keep the
    // view title in sync with every tree refresh.
    context.subscriptions.push(
        treeProvider.onDidChangeTreeData(() => updateTreeTitle())
    );

    // Register commands
    context.subscriptions.push(
        webview,
        catalog,

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
                        `Данные Stepik 0.4.1 перенесены в ${state.folder}`
                    );
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                outputChannel.appendLine(
                    `[Account] Не удалось подготовить папку аккаунта: ${detail}`
                );
                vscode.window.showErrorMessage(
                    `Не удалось подготовить папку аккаунта: ${detail}`
                );
            }
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.logout', async () => {
            const archive = await accountWorkspace.archiveCurrentAccount();
            if (!archive.ok) {
                vscode.window.showErrorMessage(
                    `Не удалось архивировать решения перед выходом: ${
                        archive.error || 'неизвестная ошибка'
                    }. Выход отменён, данные не удалены.`
                );
                return;
            }
            await auth.logout();
            api.clearCache();
            webview.resetForLogout();
            catalog.resetForLogout();
            accountWorkspace.clearActiveAccount();
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.archiveAccount', async () => {
            const result = await accountWorkspace.archiveCurrentAccount();
            if (!result.ok) {
                vscode.window.showErrorMessage(
                    `Не удалось архивировать решения: ${
                        result.error || 'неизвестная ошибка'
                    }`
                );
                return;
            }
            if (result.path) {
                vscode.window.showInformationMessage(
                    `Архив решений сохранён: ${result.path}`
                );
            } else {
                vscode.window.showInformationMessage(
                    'Нет активного аккаунта для архивирования.'
                );
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

        vscode.commands.registerCommand('stepik.openStep', async (stepContext: StepContext) => {
            if (!stepContext?.step) {
                vscode.window.showErrorMessage('Не удалось определить шаг Stepik.');
                return;
            }
            await webview.showStep(stepContext);
        }),

        vscode.commands.registerCommand(
            'stepik.startExam',
            async (args?: { sectionId?: number; sectionTitle?: string }) => {
                const sectionId = args?.sectionId;
                if (!sectionId) {
                    vscode.window.showErrorMessage('Не удалось определить экзаменационную секцию.');
                    return;
                }

                try {
                    const state = await treeProvider.getSectionAccessById(sectionId, true);
                    if (!state) {
                        vscode.window.showErrorMessage('Не удалось загрузить экзаменационную секцию.');
                        return;
                    }

                    const { access } = state;
                    let examSession = access.examSession;
                    if (access.isExam && !examSession) {
                        if (!access.canStartExam) {
                            vscode.window.showWarningMessage(
                                access.reason || 'Экзамен сейчас недоступен.'
                            );
                            return;
                        }

                        const minutes = state.section.exam_duration_minutes || 120;
                        const confirmation = await vscode.window.showWarningMessage(
                            `Начать экзамен «${state.section.title}»? После старта запустится таймер на ${minutes} мин, и материалы экзамена станут доступны.`,
                            { modal: true },
                            'Начать экзамен'
                        );
                        if (confirmation !== 'Начать экзамен') {
                            return;
                        }

                        examSession = await api.createExamSession(sectionId);
                        treeProvider.forceRefresh();
                    }

                    const firstStep = await treeProvider.getFirstStep(sectionId);
                    if (!firstStep) {
                        vscode.window.showInformationMessage(
                            'В экзаменационной секции нет доступных шагов.'
                        );
                        return;
                    }
                    await webview.showStep(firstStep, examSession);
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Не удалось начать экзамен: ${detail}`);
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
                    `Данные Stepik 0.4.1 перенесены в ${state.folder}`
                );
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(
                `[Account] Не удалось подготовить папку аккаунта: ${detail}`
            );
            vscode.window.showWarningMessage(
                `Не удалось подготовить папку аккаунта Stepik: ${detail}. Решения сохраняются в общей папке ~/stepik.`
            );
        }
        treeProvider.refresh();
    }

    // Prepare the solutions folder. It is independent of the open workspace
    // and does not need to be opened in VS Code.
    ensureSolutionDirectory(outputChannel);
}

export function deactivate() {}
