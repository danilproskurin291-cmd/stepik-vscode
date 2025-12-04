import * as vscode from 'vscode';
export declare class StepikAuth {
    private secretStorage;
    constructor(context: vscode.ExtensionContext);
    login(): Promise<boolean>;
    private getAccessToken;
    logout(): Promise<void>;
    isLoggedIn(): Promise<boolean>;
    getToken(): Promise<string | undefined>;
}
//# sourceMappingURL=auth.d.ts.map