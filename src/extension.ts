import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StepikAuth } from './auth';
import { StepikTreeProvider } from './providers/treeProvider';
import { StepikApi } from './api/stepikApi';
import { StepikWebview } from './views/webview';
import { StepikSubmit } from './submit';
import { Step } from './api/stepikApi';

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
            fs.mkdirSync(STEPIK_WORKSPACE_DIR, { recursive: true });
            
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

    // Update tree view title based on selected course
    const updateTreeTitle = () => {
        const course = treeProvider.getSelectedCourse();
        treeView.title = course ? `Stepik: ${course.title}` : 'Stepik: Select Course';
    };
    updateTreeTitle();

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
            treeProvider.forceRefresh();
        }),

        vscode.commands.registerCommand('stepik.selectCourse', async () => {
            await treeProvider.selectCourse();
            updateTreeTitle();
        }),

        vscode.commands.registerCommand('stepik.openStep', async (stepContext: { step: Step; courseName: string; lessonTitle: string }) => {
            await webview.showStep(stepContext);
        }),

        vscode.commands.registerCommand('stepik.submit', async () => {
            await submit.submitCurrentFile();
        }),

        treeView,
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
