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
exports.StepikAuth = void 0;
const vscode = __importStar(require("vscode"));
const CLIENT_ID_KEY = 'stepik.clientId';
const CLIENT_SECRET_KEY = 'stepik.clientSecret';
const ACCESS_TOKEN_KEY = 'stepik.accessToken';
class StepikAuth {
    secretStorage;
    constructor(context) {
        this.secretStorage = context.secrets;
    }
    async login() {
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
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to login: ${error}`);
            return false;
        }
    }
    async getAccessToken(clientId, clientSecret) {
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
        const data = await response.json();
        return data.access_token;
    }
    async logout() {
        await this.secretStorage.delete(CLIENT_ID_KEY);
        await this.secretStorage.delete(CLIENT_SECRET_KEY);
        await this.secretStorage.delete(ACCESS_TOKEN_KEY);
        vscode.window.showInformationMessage('Logged out from Stepik');
    }
    async isLoggedIn() {
        const token = await this.secretStorage.get(ACCESS_TOKEN_KEY);
        return !!token;
    }
    async getToken() {
        return await this.secretStorage.get(ACCESS_TOKEN_KEY);
    }
}
exports.StepikAuth = StepikAuth;
//# sourceMappingURL=auth.js.map