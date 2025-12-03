import * as vscode from 'vscode';

const CLIENT_ID_KEY = 'stepik.clientId';
const CLIENT_SECRET_KEY = 'stepik.clientSecret';
const ACCESS_TOKEN_KEY = 'stepik.accessToken';

export class StepikAuth {
    private secretStorage: vscode.SecretStorage;

    constructor(context: vscode.ExtensionContext) {
        this.secretStorage = context.secrets;
    }

    async login(): Promise<boolean> {
        const clientId = await vscode.window.showInputBox({
            prompt: 'Enter your Stepik Client ID',
            placeHolder: 'Client ID from https://stepik.org/oauth2/applications/',
            ignoreFocusOut: true
        });

        if (!clientId) {
            return false;
        }

        const clientSecret = await vscode.window.showInputBox({
            prompt: 'Enter your Stepik Client Secret',
            placeHolder: 'Client Secret',
            password: true,
            ignoreFocusOut: true
        });

        if (!clientSecret) {
            return false;
        }

        try {
            // Get access token using client credentials
            const token = await this.getAccessToken(clientId, clientSecret);
            
            await this.secretStorage.store(CLIENT_ID_KEY, clientId);
            await this.secretStorage.store(CLIENT_SECRET_KEY, clientSecret);
            await this.secretStorage.store(ACCESS_TOKEN_KEY, token);

            vscode.window.showInformationMessage('Successfully logged in to Stepik!');
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to login: ${error}`);
            return false;
        }
    }

    private async getAccessToken(clientId: string, clientSecret: string): Promise<string> {
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        
        const response = await fetch('https://stepik.org/oauth2/token/', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: 'grant_type=client_credentials'
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as { access_token: string };
        return data.access_token;
    }

    async logout(): Promise<void> {
        await this.secretStorage.delete(CLIENT_ID_KEY);
        await this.secretStorage.delete(CLIENT_SECRET_KEY);
        await this.secretStorage.delete(ACCESS_TOKEN_KEY);
        vscode.window.showInformationMessage('Logged out from Stepik');
    }

    async isLoggedIn(): Promise<boolean> {
        const token = await this.secretStorage.get(ACCESS_TOKEN_KEY);
        return !!token;
    }

    async getToken(): Promise<string | undefined> {
        return await this.secretStorage.get(ACCESS_TOKEN_KEY);
    }
}
