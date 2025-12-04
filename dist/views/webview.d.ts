import * as vscode from 'vscode';
import { StepikApi, Step } from '../api/stepikApi';
interface StepContext {
    step: Step;
    courseName: string;
    lessonTitle: string;
}
export declare class StepikWebview {
    private context;
    private api;
    private panel;
    private currentStep;
    constructor(context: vscode.ExtensionContext, api: StepikApi);
    showStep(stepContext: StepContext): Promise<void>;
    private handleMessage;
    private createSolutionFile;
    private storeStepMapping;
    private getFileExtension;
    private getHtmlContent;
    private escapeHtml;
}
export {};
//# sourceMappingURL=webview.d.ts.map