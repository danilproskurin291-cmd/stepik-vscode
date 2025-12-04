"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StepikSubmit = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class StepikSubmit {
    api;
    treeProvider;
    constructor(api, treeProvider) {
        this.api = api;
        this.treeProvider = treeProvider;
    }
    async submitCurrentFile() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active file to submit');
            return;
        }
        const filePath = editor.document.uri.fsPath;
        const mapping = this.getStepMapping(filePath);
        if (!mapping) {
            vscode.window.showErrorMessage('This file is not associated with a Stepik step. Open a step from the tree first.');
            return;
        }
        const { stepId, language } = mapping;
        const code = editor.document.getText();
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Submitting solution...',
            cancellable: false
        }, async (progress) => {
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
            }
            catch (error) {
                vscode.window.showErrorMessage(`Submission failed: ${error}`);
            }
        });
    }
    getStepMapping(filePath) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }
        const mappingPath = path.join(workspaceFolder.uri.fsPath, '.stepik', 'mapping.json');
        if (!fs.existsSync(mappingPath)) {
            return undefined;
        }
        const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        return mapping[filePath];
    }
    async pollSubmissionResult(submissionId, maxAttempts = 30, intervalMs = 1000) {
        for (let i = 0; i < maxAttempts; i++) {
            const submission = await this.api.getSubmission(submissionId);
            if (submission.status !== 'evaluation') {
                return submission;
            }
            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
        throw new Error('Submission evaluation timeout');
    }
    showResult(result) {
        const isCorrect = result.status === 'correct';
        if (isCorrect) {
            vscode.window.showInformationMessage(`✅ Correct! Score: ${result.score}`, 'OK');
        }
        else {
            const message = result.hint || result.feedback || 'Wrong answer';
            vscode.window.showErrorMessage(`❌ ${result.status}: ${message}`, 'OK');
        }
    }
}
exports.StepikSubmit = StepikSubmit;
//# sourceMappingURL=submit.js.map