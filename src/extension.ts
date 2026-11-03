import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StepikAuth } from './auth';
import { StepikTreeProvider } from './providers/treeProvider';
import { StepikApi } from './api/stepikApi';
import { StepikWebview } from './views/webview';
import { StepikSubmit } from './submit';
import { StepContext } from './stepContext';

let api: StepikApi;
let treeProvider: StepikTreeProvider;

const STEPIK_WORKSPACE_DIR = path.join(os.homedir(), '.stepik');

async function checkAndCreateWorkspace(): Promise<void> {
    // Check if workspace is already open
    const workspaceFolders = vscode.workspace.workspaceFolders;
    
    // Check if .stepik directory exists
    const stepikDirExists = fs.existsSync(STEPIK_WORKSPACE_DIR);
    
    if (!stepikDirExists) {
        const createChoice = await vscode.window.showInformationMessage(
            'Stepik workspace folder not found. Create ~/.stepik for storing your solutions?',
            'Create',
            'Cancel'
        );
        
        if (createChoice === 'Create') {
            try {
                fs.mkdirSync(STEPIK_WORKSPACE_DIR, { recursive: true });
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(
                    `Не удалось создать папку ${STEPIK_WORKSPACE_DIR}: ${detail}`
                );
                return;
            }
            
            const openChoice = await vscode.window.showInformationMessage(
                'Workspace folder created. Open it now?',
                'Open',
                'Later'
            );
            
            if (openChoice === 'Open') {
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(STEPIK_WORKSPACE_DIR));
            }
        }
    } else if (!workspaceFolders || workspaceFolders.length === 0) {
        // .stepik exists but no workspace is open
        const openChoice = await vscode.window.showInformationMessage(
            'Open Stepik workspace folder (~/.stepik)?',
            'Open',
            'Later'
        );
        
        if (openChoice === 'Open') {
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(STEPIK_WORKSPACE_DIR));
        }
    }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {

    // Create output channel for errors
    const outputChannel = vscode.window.createOutputChannel('Stepik');

    const auth = new StepikAuth(context);
    api = new StepikApi(auth);
    treeProvider = new StepikTreeProvider(api, context);
    const webview = new StepikWebview(context, api, treeProvider, outputChannel);
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

        vscode.commands.registerCommand('stepik.login', async () => {
            await auth.login();
            api.clearCache();
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.logout', async () => {
            await auth.logout();
            api.clearCache();
            webview.resetForLogout();
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.refresh', () => {
            treeProvider.forceRefresh();
        }),

        vscode.commands.registerCommand('stepik.selectCourse', async () => {
            await treeProvider.selectCourse();
            updateTreeTitle();
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

    // Check if already logged in
    if (await auth.isLoggedIn()) {
        treeProvider.refresh();
    }

    // Check workspace setup
    await checkAndCreateWorkspace();
}

export function deactivate() {}
