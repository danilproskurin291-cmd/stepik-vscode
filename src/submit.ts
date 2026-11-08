import * as vscode from 'vscode';
import * as fs from 'fs';
import { StepikApi } from './api/stepikApi';
import { StepikTreeProvider } from './providers/treeProvider';
import { combineSubmissionFeedback } from './submissionFeedback';
import { getComparableFilePath, getStepMappingPaths } from './stepikPaths';
import { t } from './i18n';

interface StepMapping {
    [filePath: string]: {
        stepId: number;
        language: string;
        sectionId?: number;
    };
}

export class StepikSubmit {
    constructor(
        private api: StepikApi,
        private treeProvider: StepikTreeProvider,
        private outputChannel: vscode.OutputChannel
    ) {}

    async submitCurrentFile(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage(t('submit.noActiveFile'));
            return;
        }

        const filePath = editor.document.uri.fsPath;
        const mapping = this.getStepMapping(filePath);

        if (!mapping) {
            vscode.window.showErrorMessage(t('submit.notMapped'));
            return;
        }

        const { stepId, language, sectionId } = mapping;
        const code = editor.document.getText();

        // Exam sessions can expire (or the exam might not be started at all);
        // never send a solution in that case.
        let access: { ok: boolean; reason?: string };
        try {
            access = await this.treeProvider.canSubmit(sectionId);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(t('task.sectionAccessError', { detail }));
            return;
        }
        if (!access.ok) {
            vscode.window.showWarningMessage(
                access.reason || t('tree.submitUnavailable')
            );
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: t('submit.progressTitle'),
                cancellable: false
            },
            async (progress: vscode.Progress<{ message?: string }>) => {
                try {
                    // Reuse the latest attempt, exactly like the web client.
                    progress.report({ message: t('submit.preparing') });
                    const attempt = await this.api.getOrCreateAttempt(stepId);

                    // Submit solution
                    progress.report({ message: t('submit.sending') });
                    const submission = await this.api.submitSolution(attempt.id, language, code);

                    // Poll for result
                    progress.report({ message: t('submit.waiting') });
                    const result = await this.pollSubmissionResult(submission.id);

                    // Show result
                    this.showResult(result, stepId);

                    // Refresh tree to update status (with delay for API to update progress)
                    if (result.status === 'correct') {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        this.treeProvider.forceRefresh();
                    }
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(t('submit.failed', { detail }));
                }
            }
        );
    }

    private getStepMapping(
        filePath: string
    ): { stepId: number; language: string; sectionId?: number } | undefined {
        // The active account mapping is authoritative, but solutions created
        // under another account or by 0.4.1 must stay submittable.
        const targetKey = getComparableFilePath(filePath);

        for (const mappingPath of getStepMappingPaths()) {
            const mapping = this.readMappingFile(mappingPath);
            if (!mapping) {
                continue;
            }

            const direct = this.parseMappingEntry(mapping[filePath]);
            if (direct) {
                return direct;
            }

            for (const [mappedPath, value] of Object.entries(mapping)) {
                if (getComparableFilePath(mappedPath) !== targetKey) {
                    continue;
                }
                const entry = this.parseMappingEntry(value);
                if (entry) {
                    return entry;
                }
            }
        }

        this.outputChannel.appendLine(
            `[Mapping] Привязка для файла не найдена: ${filePath}`
        );
        return undefined;
    }

    private parseMappingEntry(
        entry: StepMapping[string] | undefined
    ): { stepId: number; language: string; sectionId?: number } | undefined {
        if (
            !entry ||
            typeof entry !== 'object' ||
            !Number.isInteger(entry.stepId) ||
            entry.stepId <= 0 ||
            typeof entry.language !== 'string' ||
            !entry.language.trim()
        ) {
            return undefined;
        }

        const sectionId =
            Number.isInteger(entry.sectionId) && entry.sectionId! > 0
                ? entry.sectionId
                : undefined;
        return { stepId: entry.stepId, language: entry.language, sectionId };
    }

    private readMappingFile(mappingPath: string): StepMapping | undefined {
        if (!fs.existsSync(mappingPath)) {
            return undefined;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as StepMapping;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return undefined;
            }
            return parsed;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Mapping] Не удалось прочитать ${mappingPath}: ${detail}`
            );
            return undefined;
        }
    }

    private async pollSubmissionResult(
        submissionId: number, 
        maxAttempts: number = 30,
        intervalMs: number = 1000
    ): Promise<{ status: string; score: number; hint: unknown; feedback: unknown }> {
        for (let i = 0; i < maxAttempts; i++) {
            const submission = await this.api.getSubmission(submissionId);
            
            if (submission.status !== 'evaluation') {
                return submission;
            }

            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        throw new Error('Submission evaluation timeout');
    }

    private showResult(result: { status: string; score: number; hint: unknown; feedback: unknown }, stepId: number): void {
        const isCorrect = result.status === 'correct';
        
        if (isCorrect) {
            // Mark step as passed locally for instant UI update
            this.treeProvider.markStepAsPassed(stepId);
            this.treeProvider.refresh();
            
            vscode.window.showInformationMessage(
                t('task.correctScore', { score: result.score }),
                'OK'
            );
        } else {
            // Show brief message in notification
            const showDetails = t('submit.showDetails');
            vscode.window.showErrorMessage(
                t('task.wrongAnswer'),
                showDetails
            ).then(selection => {
                if (selection === showDetails) {
                    this.outputChannel.show();
                }
            });
            
            // Output detailed error to output channel
            const detail = combineSubmissionFeedback(result.hint, result.feedback);
            this.outputChannel.appendLine('═'.repeat(50));
            this.outputChannel.appendLine(`❌ Submission Result: ${result.status}`);
            this.outputChannel.appendLine(`Step ID: ${stepId}`);
            this.outputChannel.appendLine(`Score: ${result.score}`);
            if (detail) {
                this.outputChannel.appendLine(`\nFeedback: ${detail}`);
            }
            this.outputChannel.appendLine('═'.repeat(50));
            this.outputChannel.appendLine('');
        }
    }
}
