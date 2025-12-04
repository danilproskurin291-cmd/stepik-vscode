import { StepikApi } from './api/stepikApi';
import { StepikTreeProvider } from './providers/treeProvider';
export declare class StepikSubmit {
    private api;
    private treeProvider;
    constructor(api: StepikApi, treeProvider: StepikTreeProvider);
    submitCurrentFile(): Promise<void>;
    private getStepMapping;
    private pollSubmissionResult;
    private showResult;
}
//# sourceMappingURL=submit.d.ts.map