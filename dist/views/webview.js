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
exports.StepikWebview = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
class StepikWebview {
    context;
    api;
    panel;
    currentStep;
    constructor(context, api) {
        this.context = context;
        this.api = api;
    }
    async showStep(stepContext) {
        this.currentStep = stepContext;
        const { step, courseName, lessonTitle } = stepContext;
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('stepikStep', 'Stepik Task', vscode.ViewColumn.Beside, {
                enableScripts: true,
                retainContextWhenHidden: true
            });
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
            this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message), undefined, this.context.subscriptions);
        }
        this.panel.title = `Step ${step.position}`;
        this.panel.webview.html = this.getHtmlContent(step);
    }
    async handleMessage(message) {
        switch (message.command) {
            case 'selectLanguage':
                if (message.language && this.currentStep) {
                    await this.createSolutionFile(this.currentStep, message.language);
                }
                break;
        }
    }
    async createSolutionFile(stepContext, language) {
        const { step, courseName, lessonTitle } = stepContext;
        // Sanitize names for filesystem
        const safeName = (name) => name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
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
    storeStepMapping(filePath, stepId, language) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }
        const mappingPath = path.join(workspaceFolder.uri.fsPath, '.stepik', 'mapping.json');
        let mapping = {};
        if (fs.existsSync(mappingPath)) {
            mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
        }
        else {
            fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
        }
        mapping[filePath] = { stepId, language };
        fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
    }
    getFileExtension(language) {
        const extensions = {
            'python3': '.py',
            'python': '.py',
            'cpp': '.cpp',
            'cpp11': '.cpp',
            'cpp14': '.cpp',
            'cpp17': '.cpp',
            'cpp20': '.cpp',
            'c': '.c',
            'c11': '.c',
            'java': '.java',
            'java8': '.java',
            'java11': '.java',
            'java17': '.java',
            'javascript': '.js',
            'typescript': '.ts',
            'kotlin': '.kt',
            'go': '.go',
            'rust': '.rs',
            'csharp': '.cs',
            'ruby': '.rb',
            'php': '.php',
            'scala': '.scala',
            'haskell': '.hs',
            'sql': '.sql'
        };
        return extensions[language] || '.txt';
    }
    getHtmlContent(step) {
        const isCodeTask = step.block.name === 'code';
        const languages = step.block.options?.code_templates
            ? Object.keys(step.block.options.code_templates)
            : [];
        const languageSelector = isCodeTask && languages.length > 0
            ? `
                <div class="language-selector">
                    <label>Select Language:</label>
                    <select id="language-select">
                        <option value="">-- Choose --</option>
                        ${languages.map(lang => `<option value="${lang}">${lang}</option>`).join('')}
                    </select>
                    <button id="open-btn" disabled>Open in Editor</button>
                </div>
            `
            : '';
        const samples = step.block.options?.samples || [];
        const samplesHtml = samples.length > 0
            ? `
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
            `
            : '';
        return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            line-height: 1.6;
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
        select, button {
            padding: 8px 12px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            cursor: pointer;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        button:not(:disabled):hover {
            background: var(--vscode-button-hoverBackground);
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
    </style>
</head>
<body>
    <div class="task-type">${step.block.name.toUpperCase()}</div>
    
    <div class="task-content">
        ${step.block.text}
    </div>
    
    ${languageSelector}
    ${samplesHtml}
    
    <script>
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
    </script>
</body>
</html>`;
    }
    escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
exports.StepikWebview = StepikWebview;
//# sourceMappingURL=webview.js.map