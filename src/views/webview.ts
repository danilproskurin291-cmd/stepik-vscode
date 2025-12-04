import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { StepikApi, Step, Attempt, QuizReply } from '../api/stepikApi';
import { StepikTreeProvider } from '../providers/treeProvider';

interface StepContext {
    step: Step;
    courseName: string;
    lessonTitle: string;
}

interface WebviewMessage {
    command: string;
    language?: string;
    choices?: boolean[];
    text?: string;
    number?: string;
}

export class StepikWebview {
    private panel: vscode.WebviewPanel | undefined;
    private currentStep: StepContext | undefined;
    private currentAttempt: Attempt | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private api: StepikApi,
        private treeProvider: StepikTreeProvider
    ) {}

    async showStep(stepContext: StepContext): Promise<void> {
        this.currentStep = stepContext;
        const { step } = stepContext;

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'stepikStep',
                'Stepik Task',
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });

            this.panel.webview.onDidReceiveMessage(
                (message: WebviewMessage) => this.handleMessage(message),
                undefined,
                this.context.subscriptions
            );
        }

        // Create attempt for quiz types to get dataset (options)
        const quizTypes = ['choice', 'string', 'number'];
        if (quizTypes.includes(step.block.name)) {
            this.currentAttempt = await this.api.createAttempt(step.id);
        }

        this.panel.title = `Step ${step.position}`;
        this.panel.webview.html = this.getHtmlContent(step);
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        switch (message.command) {
            case 'selectLanguage':
                if (message.language && this.currentStep) {
                    await this.createSolutionFile(this.currentStep, message.language);
                }
                break;
            case 'submitQuiz':
                await this.submitQuiz(message);
                break;
            case 'restart':
                if (this.currentStep) {
                    // Create new attempt and refresh
                    this.currentAttempt = await this.api.createAttempt(this.currentStep.step.id);
                    if (this.panel) {
                        this.panel.webview.html = this.getHtmlContent(this.currentStep.step);
                    }
                }
                break;
        }
    }

    private async submitQuiz(message: WebviewMessage): Promise<void> {
        if (!this.currentStep || !this.currentAttempt) {
            vscode.window.showErrorMessage('No active quiz');
            return;
        }

        const stepType = this.currentStep.step.block.name;
        let reply: QuizReply = {};

        if (stepType === 'choice') {
            reply.choices = message.choices;
        } else if (stepType === 'string') {
            reply.text = message.text;
        } else if (stepType === 'number') {
            reply.number = message.number;
        }

        try {
            const submission = await this.api.submitQuiz(this.currentAttempt.id, reply);
            const result = await this.pollSubmissionResult(submission.id);
            
            if (result.status === 'correct') {
                vscode.window.showInformationMessage(`✅ Correct! Score: ${result.score}`);
                this.treeProvider.refresh();
            } else {
                const hint = result.hint || result.feedback || 'Wrong answer';
                vscode.window.showErrorMessage(`❌ ${result.status}: ${hint}`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Submission failed: ${error}`);
        }
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

    private async createSolutionFile(stepContext: StepContext, language: string): Promise<void> {
        const { step, courseName, lessonTitle } = stepContext;
        
        // Sanitize names for filesystem
        const safeName = (name: string) => name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
        const courseDir = safeName(courseName);
        const lessonDir = safeName(lessonTitle);
        
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('Please open a workspace folder first');
            return;
        }

        const dirPath = path.join(workspaceFolder.uri.fsPath, courseDir, lessonDir);
        
        // Create directories
        fs.mkdirSync(dirPath, { recursive: true });

        // Get file extension
        const ext = this.getFileExtension(language);
        const fileName = `step-${step.position}${ext}`;
        const filePath = path.join(dirPath, fileName);

        // Get template from step
        const template = step.block.options?.code_templates?.[language] || '';

        // Write file if not exists
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, template);
        }

        // Open in editor
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

        // Store step info for submission
        this.storeStepMapping(filePath, step.id, language);
    }

    private storeStepMapping(filePath: string, stepId: number, language: string): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {return;}

        const mappingPath = path.join(workspaceFolder.uri.fsPath, '.stepik', 'mapping.json');
        
        let mapping: { [key: string]: { stepId: number; language: string } } = {};
        
        if (fs.existsSync(mappingPath)) {
            mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        } else {
            fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
        }

        mapping[filePath] = { stepId, language };
        fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
    }

    private getFileExtension(language: string): string {
        const extensions: { [key: string]: string } = {
            // Python
            'python3': '.py',
            'python': '.py',
            'python2': '.py',
            'python31': '.py',
            // C/C++
            'cpp': '.cpp',
            'c++': '.cpp',
            'cpp11': '.cpp',
            'c++11': '.cpp',
            'cpp14': '.cpp',
            'c++14': '.cpp',
            'cpp17': '.cpp',
            'c++17': '.cpp',
            'cpp20': '.cpp',
            'c++20': '.cpp',
            'c': '.c',
            'c11': '.c',
            // Java
            'java': '.java',
            'java8': '.java',
            'java11': '.java',
            'java17': '.java',
            // JavaScript/TypeScript
            'javascript': '.js',
            'js': '.js',
            'nodejs': '.js',
            'typescript': '.ts',
            'ts': '.ts',
            // Other languages
            'kotlin': '.kt',
            'go': '.go',
            'golang': '.go',
            'rust': '.rs',
            'csharp': '.cs',
            'c#': '.cs',
            'ruby': '.rb',
            'php': '.php',
            'scala': '.scala',
            'haskell': '.hs',
            'hs': '.hs',
            'sql': '.sql',
            'swift': '.swift',
            'r': '.r',
            'perl': '.pl',
            'octave': '.m',
            'matlab': '.m',
            'bash': '.sh',
            'shell': '.sh',
            'clojure': '.clj',
            'mono c#': '.cs',
            'asm32': '.asm',
            'asm64': '.asm',
        };
        // Try exact match first, then lowercase
        return extensions[language] || extensions[language.toLowerCase()] || '.txt';
    }

    private getHtmlContent(step: Step): string {
        const stepType = step.block.name;
        const isCodeTask = stepType === 'code';
        const isQuizTask = ['choice', 'string', 'number'].includes(stepType);
        
        const languages = step.block.options?.code_templates 
            ? Object.keys(step.block.options.code_templates) 
            : [];

        const languageSelector = isCodeTask && languages.length > 0 
            ? this.getLanguageSelectorHtml(languages)
            : '';

        const quizSection = isQuizTask
            ? this.getQuizHtml(step)
            : '';

        const samples = step.block.options?.samples || [];
        const samplesHtml = samples.length > 0
            ? this.getSamplesHtml(samples)
            : '';

        const stepUrl = `https://stepik.org/lesson/${step.lesson}/step/${step.position}`;
        
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${this.getStyles()}
    </style>
</head>
<body>
    <div class="step-header">
        <a href="${stepUrl}" class="stepik-link">Open on Stepik ↗</a>
    </div>
    
    <div class="task-type">${step.block.name.toUpperCase()}</div>
    
    <div class="task-content">
        ${step.block.text}
    </div>
    
    ${languageSelector}
    ${quizSection}
    ${samplesHtml}
    
    <script>
        ${this.getScript(stepType)}
    </script>
</body>
</html>`;
    }

    private getLanguageSelectorHtml(languages: string[]): string {
        return `
            <div class="language-selector">
                <label>Select Language:</label>
                <select id="language-select">
                    <option value="">-- Choose --</option>
                    ${languages.map(lang => `<option value="${lang}">${lang}</option>`).join('')}
                </select>
                <button id="open-btn" disabled>Open in Editor</button>
            </div>
        `;
    }

    private getQuizHtml(step: Step): string {
        const stepType = step.block.name;
        const options = this.currentAttempt?.dataset?.options || [];
        const isMultiple = this.currentAttempt?.dataset?.is_multiple_choice ?? false;

        if (stepType === 'choice') {
            const inputType = isMultiple ? 'checkbox' : 'radio';
            return `
                <div class="quiz-section">
                    <div class="quiz-options">
                        ${options.map((opt, i) => `
                            <label class="quiz-option">
                                <input type="${inputType}" name="choice" value="${i}" data-index="${i}">
                                <span>${opt}</span>
                            </label>
                        `).join('')}
                    </div>
                    <div class="quiz-actions">
                        <button id="submit-quiz-btn">Submit</button>
                        <button id="restart-btn" class="secondary">Restart</button>
                    </div>
                </div>
            `;
        } else if (stepType === 'string') {
            return `
                <div class="quiz-section">
                    <div class="quiz-input">
                        <input type="text" id="string-input" placeholder="Enter your answer...">
                    </div>
                    <div class="quiz-actions">
                        <button id="submit-quiz-btn">Submit</button>
                        <button id="restart-btn" class="secondary">Restart</button>
                    </div>
                </div>
            `;
        } else if (stepType === 'number') {
            return `
                <div class="quiz-section">
                    <div class="quiz-input">
                        <input type="number" id="number-input" placeholder="Enter a number..." step="any">
                    </div>
                    <div class="quiz-actions">
                        <button id="submit-quiz-btn">Submit</button>
                        <button id="restart-btn" class="secondary">Restart</button>
                    </div>
                </div>
            `;
        }
        return '';
    }

    private getSamplesHtml(samples: Array<[string, string]>): string {
        return `
            <div class="samples">
                <h3>Samples</h3>
                ${samples.map(([input, output], i) => `
                    <div class="sample">
                        <div class="sample-header">Sample ${i + 1}</div>
                        <div class="sample-io">
                            <div class="sample-input">
                                <strong>Input:</strong>
                                <pre>${this.escapeHtml(input)}</pre>
                            </div>
                            <div class="sample-output">
                                <strong>Output:</strong>
                                <pre>${this.escapeHtml(output)}</pre>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    private getStyles(): string {
        return `
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            line-height: 1.6;
        }
        .step-header {
            margin-bottom: 16px;
            text-align: right;
        }
        .stepik-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            font-size: 14px;
        }
        .stepik-link:hover {
            text-decoration: underline;
        }
        .task-type {
            display: inline-block;
            padding: 4px 8px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 4px;
            font-size: 12px;
            margin-bottom: 16px;
        }
        .task-content {
            margin-bottom: 24px;
        }
        .task-content img {
            max-width: 100%;
        }
        .task-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
        }
        .task-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 2px;
        }
        .language-selector {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 16px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            margin-bottom: 16px;
        }
        select, button, input[type="text"], input[type="number"] {
            padding: 8px 12px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            cursor: pointer;
        }
        input[type="text"], input[type="number"] {
            width: 100%;
            box-sizing: border-box;
            cursor: text;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        button:not(:disabled):hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .quiz-section {
            padding: 16px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            margin-bottom: 16px;
        }
        .quiz-options {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 16px;
        }
        .quiz-option {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 12px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
        }
        .quiz-option:hover {
            border-color: var(--vscode-focusBorder);
        }
        .quiz-option input {
            margin-top: 4px;
        }
        .quiz-input {
            margin-bottom: 16px;
        }
        .quiz-actions {
            display: flex;
            gap: 12px;
        }
        .samples {
            margin-top: 24px;
        }
        .sample {
            margin-bottom: 16px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .sample-header {
            padding: 8px 12px;
            background: var(--vscode-sideBarSectionHeader-background);
            font-weight: bold;
        }
        .sample-io {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            padding: 12px;
        }
        .sample-input pre, .sample-output pre {
            margin: 8px 0 0;
            padding: 8px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 4px;
            white-space: pre-wrap;
        }
        `;
    }

    private getScript(stepType: string): string {
        if (stepType === 'code') {
            return `
                const vscode = acquireVsCodeApi();
                const select = document.getElementById('language-select');
                const btn = document.getElementById('open-btn');
                
                if (select && btn) {
                    select.addEventListener('change', () => {
                        btn.disabled = !select.value;
                    });
                    
                    btn.addEventListener('click', () => {
                        if (select.value) {
                            vscode.postMessage({ 
                                command: 'selectLanguage', 
                                language: select.value 
                            });
                        }
                    });
                }
            `;
        } else if (stepType === 'choice') {
            return `
                const vscode = acquireVsCodeApi();
                const submitBtn = document.getElementById('submit-quiz-btn');
                const restartBtn = document.getElementById('restart-btn');
                const inputs = document.querySelectorAll('input[name="choice"]');
                
                submitBtn.addEventListener('click', () => {
                    const choices = [];
                    inputs.forEach((input, index) => {
                        choices[index] = input.checked;
                    });
                    vscode.postMessage({ 
                        command: 'submitQuiz', 
                        choices: choices 
                    });
                });
                
                restartBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'restart' });
                });
            `;
        } else if (stepType === 'string') {
            return `
                const vscode = acquireVsCodeApi();
                const submitBtn = document.getElementById('submit-quiz-btn');
                const restartBtn = document.getElementById('restart-btn');
                const input = document.getElementById('string-input');
                
                submitBtn.addEventListener('click', () => {
                    vscode.postMessage({ 
                        command: 'submitQuiz', 
                        text: input.value 
                    });
                });
                
                restartBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'restart' });
                });
                
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') submitBtn.click();
                });
            `;
        } else if (stepType === 'number') {
            return `
                const vscode = acquireVsCodeApi();
                const submitBtn = document.getElementById('submit-quiz-btn');
                const restartBtn = document.getElementById('restart-btn');
                const input = document.getElementById('number-input');
                
                submitBtn.addEventListener('click', () => {
                    vscode.postMessage({ 
                        command: 'submitQuiz', 
                        number: input.value 
                    });
                });
                
                restartBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'restart' });
                });
                
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') submitBtn.click();
                });
            `;
        }
        return '';
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
