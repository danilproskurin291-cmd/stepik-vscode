import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { StepikApi } from './api/stepikApi';
import { StepikTreeProvider } from './providers/treeProvider';

interface StepMapping {
    [filePath: string]: {
        stepId: number;
        language: string;
    };
}

export class StepikSubmit {
    constructor(
        private api: StepikApi,
        private treeProvider: StepikTreeProvider
    ) {}

    async submitCurrentFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active file to submit');
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const mapping = this.getStepMapping(filePath);

        if (!mapping) {
            vscode.window.showErrorMessage(
                'This file is not associated with a Stepik step. Open a step from the tree first.'
            );
            return;
        }

        const { stepId, language } = mapping;
        const code = editor.document.getText();

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Submitting solution...',
                cancellable: false
            },
            async (progress: vscode.Progress<{ message?: string }>) => {
                try {
                    // Create attempt
                    progress.report({ message: 'Creating attempt...' });
                    const attempt = await this.api.createAttempt(stepId);

                    // Submit solution
                    progress.report({ message: 'Sending code...' });
                    const submission = await this.api.submitSolution(attempt.id, language, code);

                    // Poll for result
                    progress.report({ message: 'Waiting for result...' });
                    const result = await this.pollSubmissionResult(submission.id);

                    // Show result
                    this.showResult(result);

                    // Refresh tree to update status
                    this.treeProvider.refresh();
                } catch (error) {
                    vscode.window.showErrorMessage(`Submission failed: ${error}`);
                }
            }
        );
    }

    private getStepMapping(filePath: string): { stepId: number; language: string } | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }

        const mappingPath = path.join(workspaceFolder.uri.fsPath, '.stepik', 'mapping.json');
        
        if (!fs.existsSync(mappingPath)) {
            return undefined;
        }

        const mapping: StepMapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        return mapping[filePath];
    }

    private async pollSubmissionResult(
        submissionId: number, 
        maxAttempts: number = 30,
        intervalMs: number = 1000
    ): Promise<{ status: string; score: number; hint: string; feedback: string }> {
        for (let i = 0; i < maxAttempts; i++) {
            const submission = await this.api.getSubmission(submissionId);
            
            if (submission.status !== 'evaluation') {
                return submission;
            }

            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        throw new Error('Submission evaluation timeout');
    }

    private showResult(result: { status: string; score: number; hint: string; feedback: string }): void {
        const isCorrect = result.status === 'correct';
        
        if (isCorrect) {
            vscode.window.showInformationMessage(
                `✅ Correct! Score: ${result.score}`,
                'OK'
            );
        } else {
            const message = result.hint || result.feedback || 'Wrong answer';
            vscode.window.showErrorMessage(
                `❌ ${result.status}: ${message}`,
                'OK'
            );
        }
    }
}
