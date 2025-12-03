import * as vscode from 'vscode';
import { StepikAuth } from './auth';
import { StepikTreeProvider } from './providers/treeProvider';
import { StepikApi } from './api/stepikApi';
import { StepikWebview } from './views/webview';
import { StepikSubmit } from './submit';
import { Step } from './api/stepikApi';

let api: StepikApi;
let treeProvider: StepikTreeProvider;

export async function activate(context: vscode.ExtensionContext): Promise<void> {

    const auth = new StepikAuth(context);
    api = new StepikApi(auth);
    treeProvider = new StepikTreeProvider(api);
    const webview = new StepikWebview(context, api);
    const submit = new StepikSubmit(api, treeProvider);

    // Register tree view
    const treeView = vscode.window.createTreeView('stepikCourses', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('stepik.login', async () => {
            await auth.login();
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.logout', async () => {
            await auth.logout();
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.refresh', () => {
            treeProvider.refresh();
        }),

        vscode.commands.registerCommand('stepik.openStep', async (stepContext: { step: Step; courseName: string; lessonTitle: string }) => {
            await webview.showStep(stepContext);
        }),

        vscode.commands.registerCommand('stepik.submit', async () => {
            await submit.submitCurrentFile();
        }),

        treeView
    );

    // Check if already logged in
    if (await auth.isLoggedIn()) {
        treeProvider.refresh();
    }
}

export function deactivate() {}
