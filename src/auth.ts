import * as vscode from 'vscode';

const CLIENT_ID_KEY = 'stepik.clientId';
const CLIENT_SECRET_KEY = 'stepik.clientSecret';
const ACCESS_TOKEN_KEY = 'stepik.accessToken';
const ACCESS_TOKEN_EXPIRES_AT_KEY = 'stepik.accessTokenExpiresAt';
const TOKEN_REFRESH_MARGIN_MS = 60_000;

interface TokenResponse {
    access_token: string;
    expires_in?: number;
}

export class StepikAuth {
    private secretStorage: vscode.SecretStorage;

    constructor(context: vscode.ExtensionContext) {
        this.secretStorage = context.secrets;
    }

    async login(): Promise<boolean> {
        const clientId = await vscode.window.showInputBox({
            prompt: 'Введите Client ID приложения Stepik',
            placeHolder: 'Client ID из https://stepik.org/oauth2/applications/',
            ignoreFocusOut: true
        });

        if (!clientId) {
            return false;
        }

        const clientSecret = await vscode.window.showInputBox({
            prompt: 'Введите Client Secret приложения Stepik',
            placeHolder: 'Client Secret',
            password: true,
            ignoreFocusOut: true
        });

        if (!clientSecret) {
            return false;
        }

        try {
            const token = await this.getAccessToken(clientId, clientSecret);

            await this.secretStorage.store(CLIENT_ID_KEY, clientId);
            await this.secretStorage.store(CLIENT_SECRET_KEY, clientSecret);
            await this.storeToken(token);

            vscode.window.showInformationMessage('Вход в Stepik выполнен.');
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Не удалось войти в Stepik: ${error}`);
            return false;
        }
    }

    private async getAccessToken(clientId: string, clientSecret: string): Promise<TokenResponse> {
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

        const data = await response.json() as TokenResponse;
        if (!data.access_token) {
            throw new Error('Stepik не вернул access_token.');
        }
        return data;
    }

    private async storeToken(token: TokenResponse): Promise<void> {
        await this.secretStorage.store(ACCESS_TOKEN_KEY, token.access_token);
        const expiresAt = token.expires_in
            ? Date.now() + token.expires_in * 1000
            : undefined;
        if (expiresAt) {
            await this.secretStorage.store(ACCESS_TOKEN_EXPIRES_AT_KEY, String(expiresAt));
        } else {
            await this.secretStorage.delete(ACCESS_TOKEN_EXPIRES_AT_KEY);
        }
    }

    async logout(): Promise<void> {
        await this.secretStorage.delete(CLIENT_ID_KEY);
        await this.secretStorage.delete(CLIENT_SECRET_KEY);
        await this.secretStorage.delete(ACCESS_TOKEN_KEY);
        await this.secretStorage.delete(ACCESS_TOKEN_EXPIRES_AT_KEY);
        vscode.window.showInformationMessage('Вы вышли из Stepik.');
    }

    async isLoggedIn(): Promise<boolean> {
        return Boolean(await this.getToken());
    }

    /**
     * Return a valid access token, refreshing it automatically when the
     * client credentials are still stored. Stepik tokens can expire; without
     * this the extension keeps sending a dead token until the user logs in
     * again manually.
     */
    async getToken(): Promise<string | undefined> {
        const token = await this.secretStorage.get(ACCESS_TOKEN_KEY);
        if (!token) {
            return undefined;
        }

        const expiresAtRaw = await this.secretStorage.get(ACCESS_TOKEN_EXPIRES_AT_KEY);
        const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : undefined;
        if (!expiresAt || Number.isNaN(expiresAt)) {
            return token;
        }
        if (Date.now() < expiresAt - TOKEN_REFRESH_MARGIN_MS) {
            return token;
        }

        const clientId = await this.secretStorage.get(CLIENT_ID_KEY);
        const clientSecret = await this.secretStorage.get(CLIENT_SECRET_KEY);
        if (!clientId || !clientSecret) {
            return undefined;
        }

        try {
            const refreshed = await this.getAccessToken(clientId, clientSecret);
            await this.storeToken(refreshed);
            return refreshed.access_token;
        } catch (error) {
            console.warn('[Stepik] Failed to refresh access token:', error);
            return undefined;
        }
    }
}
