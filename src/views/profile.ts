import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
    Certificate,
    StepikApi,
    StepikProfile,
    StepikUser,
    UserActivity,
    UserActivitySummary
} from '../api/stepikApi';
import { getLanguage, pluralize, t, webviewStrings } from '../i18n';
import { stepikBrandHtml, stepikThemeCss } from './theme';

interface ProfileMessage {
    command?: string;
    url?: string;
    certificateUrl?: string;
}

interface ProfileActivityDay {
    date: string;
    count: number;
}

interface ProfileCertificatePayload {
    id: number;
    title: string;
    subtitle: string;
    issueDate?: string;
    grade?: number;
    type?: string;
    previewUrl?: string;
    url?: string;
    courseId?: number;
    rank?: string;
}

interface ProfilePayload {
    id: number;
    fullName: string;
    alias?: string;
    avatar?: string;
    shortBio?: string;
    details?: string;
    city?: string;
    reputation: number;
    reputationRank?: number | null;
    knowledge: number;
    knowledgeRank?: number | null;
    followers: number;
    solvedSteps: number;
    createdCourses: number;
    createdLessons: number;
    issuedCertificates: number;
    joinDate?: string;
    socialProfiles: Array<{ title: string; url: string }>;
    activity: {
        days: ProfileActivityDay[];
        recentStrike: number;
        maxStrike: number;
        solved: number;
        solvedToday: number;
    };
    certificates: ProfileCertificatePayload[];
    profileUrl: string;
    editProfileUrl: string;
}

function normalizeStepikUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }
    let url = value.trim();
    if (url.startsWith('//')) {
        url = `https:${url}`;
    } else if (url.startsWith('/')) {
        url = `https://stepik.org${url}`;
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'stepik.org') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
}

function normalizeImageUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }
    let url = value.trim();
    if (url.startsWith('//')) {
        url = `https:${url}`;
    } else if (url.startsWith('/')) {
        url = `https://stepik.org${url}`;
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
}

/** Social profiles live on third-party sites, so any HTTPS host is allowed. */
function normalizeExternalUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || !value.trim()) {
        return undefined;
    }
    let url = value.trim();
    if (url.startsWith('//')) {
        url = `https:${url}`;
    }
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
            return undefined;
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
}

/** Strip rich-text markup from profile fields before showing them as text. */
function plainText(value: unknown): string {
    if (typeof value !== 'string') {
        return '';
    }
    return value
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|blockquote|h[1-6])>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function certificateTitle(certificate: Certificate): string {
    return (
        certificate.course_title ||
        certificate.course_title_en ||
        (certificate.course
            ? t('profile.courseFallback', { id: certificate.course })
            : t('profile.certificateStepik'))
    );
}

function certificateSubtitle(certificate: Certificate): string {
    const type = certificate.type === 'distinction'
        ? t('profile.certificateDistinction')
        : certificate.type === 'regular'
            ? t('profile.certificateRegular')
            : certificate.type
                ? certificate.type
                : t('profile.certificateRegular');
    const grade = typeof certificate.grade === 'number'
        ? t('profile.certificateProgress', { grade: Math.round(certificate.grade) })
        : '';
    return grade ? `${type}. ${grade}` : type;
}

function socialProfileTitle(profile: Record<string, unknown>): string {
    const candidates = ['name', 'title', 'type', 'provider', 'service'];
    for (const key of candidates) {
        const value = profile[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return t('profile.linkFallback');
}

function socialProfileUrl(profile: Record<string, unknown>): string | undefined {
    const candidates = ['url', 'link', 'href'];
    for (const key of candidates) {
        const safe = normalizeExternalUrl(profile[key]);
        if (safe) {
            return safe;
        }
    }
    return undefined;
}

function buildActivity(
    activity: UserActivity | null,
    summary: UserActivitySummary | null,
    fallbackSolved: number
): ProfilePayload['activity'] {
    const pins = activity?.pins?.length ? activity.pins : summary?.pins || [];
    const today = new Date();
    const end = Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate()
    );
    const days: ProfileActivityDay[] = pins.map((count, index) => {
        const date = new Date(end - (pins.length - 1 - index) * 86_400_000);
        return {
            date: date.toISOString().slice(0, 10),
            count: Math.max(0, Number(count) || 0)
        };
    });
    return {
        days,
        recentStrike: Math.max(0, Number(summary?.recent_strike) || 0),
        maxStrike: Math.max(0, Number(summary?.max_strike) || 0),
        solved: Math.max(0, Number(summary?.solved) || fallbackSolved || 0),
        solvedToday: Math.max(0, Number(summary?.solved_today) || 0)
    };
}

/**
 * The current user's Stepik profile. It mirrors the website layout: sidebar
 * with avatar/counters/join date/User ID, a one-year activity calendar and the
 * list of issued certificates.
 */
export class StepikProfileView implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private readonly log: (message: string) => void;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly api: StepikApi,
        outputChannel: vscode.OutputChannel
    ) {
        this.log = message => outputChannel.appendLine(`[Profile] ${message}`);
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'stepikProfile',
            t('profile.panelTitle'),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        panel.iconPath = vscode.Uri.joinPath(
            this.context.extensionUri,
            'resources',
            'stepik.svg'
        );

        const listener = panel.webview.onDidReceiveMessage(message =>
            this.handleMessage(message as ProfileMessage)
        );
        panel.onDidDispose(() => {
            listener.dispose();
            if (this.panel === panel) {
                this.panel = undefined;
            }
        });

        this.panel = panel;
        panel.webview.html = this.getHtml(panel.webview);
    }

    resetForLogout(): void {
        this.panel?.dispose();
        this.panel = undefined;
    }

    /** Re-render the panel after the interface language changed. */
    refreshLocalization(): void {
        if (!this.panel) {
            return;
        }
        this.panel.title = t('profile.panelTitle');
        this.panel.webview.html = this.getHtml(this.panel.webview);
    }

    dispose(): void {
        this.resetForLogout();
    }

    private async loadProfile(): Promise<void> {
        try {
            const current = await this.api.getCurrentUser();
            const [user, profile, activity, summary, certificates] = await Promise.all([
                this.api.getUser(current.id),
                this.api.getProfile(current.id),
                this.api.getUserActivity(current.id),
                this.api.getUserActivitySummary(current.id),
                this.api.getCertificates(current.id)
            ]);

            if (!user && !profile) {
                throw new Error(t('profile.dataMissing'));
            }

            const knownUser: StepikUser = user || {
                id: current.id,
                full_name: current.fullName,
                avatar: current.avatar,
                alias: current.alias
            };
            const knownProfile: StepikProfile | null = profile;

            const socialProfiles = (knownUser.social_profiles || [])
                .map(profileItem => {
                    const url = socialProfileUrl(profileItem as Record<string, unknown>);
                    if (!url) {
                        return undefined;
                    }
                    return {
                        title: socialProfileTitle(profileItem as Record<string, unknown>),
                        url
                    };
                })
                .filter((item): item is { title: string; url: string } => Boolean(item));

            const avatar = normalizeImageUrl(
                knownUser.avatar || knownProfile?.avatar || current.avatar
            );

            const payload: ProfilePayload = {
                id: current.id,
                fullName:
                    knownUser.full_name ||
                    knownProfile?.full_name ||
                    current.fullName ||
                    current.alias ||
                    t('profile.userFallback', { id: current.id }),
                alias: knownUser.alias || current.alias || undefined,
                avatar,
                shortBio: plainText(knownUser.short_bio || knownProfile?.short_bio) || undefined,
                details: plainText(knownUser.details || knownProfile?.details) || undefined,
                city: knownUser.city || knownProfile?.city || undefined,
                reputation: Math.max(0, Number(knownUser.reputation) || 0),
                reputationRank: knownUser.reputation_rank ?? null,
                knowledge: Math.max(0, Number(knownUser.knowledge) || 0),
                knowledgeRank: knownUser.knowledge_rank ?? null,
                followers: Math.max(0, Number(knownUser.followers_count) || 0),
                solvedSteps: Math.max(
                    0,
                    Number(knownUser.solved_steps_count) || summary?.solved || 0
                ),
                createdCourses: Math.max(0, Number(knownUser.created_courses_count) || 0),
                createdLessons: Math.max(0, Number(knownUser.created_lessons_count) || 0),
                issuedCertificates: certificates.length,
                joinDate: knownUser.join_date || undefined,
                socialProfiles,
                activity: buildActivity(activity, summary, knownUser.solved_steps_count || 0),
                certificates: certificates.map(certificate => ({
                    id: certificate.id,
                    title: certificateTitle(certificate),
                    subtitle: certificateSubtitle(certificate),
                    issueDate: certificate.issue_date,
                    grade: certificate.grade,
                    type: certificate.type,
                    previewUrl: normalizeImageUrl(certificate.preview_url),
                    url: normalizeStepikUrl(certificate.url),
                    courseId: certificate.course,
                    rank:
                        certificate.user_rank && certificate.leaderboard_size
                            ? t('profile.rankOf', {
                                  rank: certificate.user_rank,
                                  total: certificate.leaderboard_size
                              })
                            : undefined
                })),
                profileUrl: `https://stepik.org/users/${current.id}/profile`,
                editProfileUrl: 'https://stepik.org/edit-profile'
            };

            this.post({ command: 'profile', profile: payload });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('profile.loadLog', { detail }));
            this.post({
                command: 'error',
                message: /not authenticated|login first|session has expired|Сессия Stepik истекла/i.test(detail)
                    ? t('profile.loginRequired')
                    : detail
            });
        }
    }

    private async openExternal(url: string | undefined): Promise<void> {
        const safe = normalizeExternalUrl(url);
        if (!safe) {
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(safe));
    }

    private async handleMessage(message: ProfileMessage): Promise<void> {
        switch (message.command) {
            case 'init':
                await this.loadProfile();
                break;
            case 'refresh':
                // The profile endpoints are cached for a minute; a manual
                // refresh should always show the latest counters.
                this.api.clearCache();
                await this.loadProfile();
                break;
            case 'openExternal':
                await this.openExternal(message.url);
                break;
            case 'openCertificate':
                await this.openExternal(message.certificateUrl);
                break;
            default:
                break;
        }
    }

    private post(message: unknown): void {
        void this.panel?.webview.postMessage(message);
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = crypto.randomBytes(16).toString('hex');
        const language = getLanguage();
        const strings = JSON.stringify(webviewStrings(language)).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="${language}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src https: data:;">
    <title>${t('profile.panelTitle')}</title>
    <style>
        * { box-sizing: border-box; }
        [hidden] { display: none !important; }
        body {
            margin: 0;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size, 13px);
        }
        button, a { font-family: inherit; }
        .profile-shell {
            max-width: 1000px;
            margin: 0 auto;
            padding: 24px 24px 52px;
        }
        .profile-head {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 18px;
        }
        .profile-head h1 {
            margin: 0 0 4px;
            font-size: 24px;
            font-weight: 600;
            letter-spacing: -0.2px;
        }
        .profile-head p {
            margin: 0;
            color: var(--vscode-descriptionForeground);
            line-height: 1.45;
        }
        .head-actions {
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 7px;
        }
        .secondary-button,
        .primary-button {
            height: 32px;
            padding: 0 11px;
            border-radius: 6px;
            cursor: pointer;
            white-space: nowrap;
        }
        .secondary-button {
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
            border: 1px solid var(--vscode-button-border, transparent);
        }
        .secondary-button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .primary-button {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            border: 1px solid var(--vscode-button-border, transparent);
        }
        .primary-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .profile-layout {
            display: grid;
            grid-template-columns: 220px minmax(0, 1fr);
            gap: 38px;
            align-items: start;
        }
        .profile-sidebar {
            min-width: 0;
        }
        .avatar {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 150px;
            height: 150px;
            overflow: hidden;
            border-radius: 24px;
            color: rgba(255, 255, 255, 0.9);
            background: #526e52;
            font-size: 58px;
            font-weight: 500;
            line-height: 1;
        }
        .avatar img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .counters {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin: 18px 0 18px;
            padding: 0;
            list-style: none;
        }
        .counter {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 22px;
            color: var(--vscode-descriptionForeground);
        }
        .counter svg {
            flex: 0 0 auto;
            width: 17px;
            height: 17px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.6;
            stroke-linecap: round;
            stroke-linejoin: round;
            opacity: 0.9;
        }
        .counter b {
            color: var(--vscode-foreground);
            font-weight: 600;
        }
        .sidebar-nav {
            display: flex;
            flex-direction: column;
            gap: 5px;
            margin: 0 0 16px;
            padding: 0;
            list-style: none;
        }
        .sidebar-nav a,
        .sidebar-nav button {
            padding: 3px 0;
            border: 0;
            color: var(--vscode-textLink-foreground);
            background: transparent;
            text-align: left;
            text-decoration: none;
            cursor: pointer;
        }
        .sidebar-nav a:hover,
        .sidebar-nav button:hover {
            text-decoration: underline;
        }
        .sidebar-nav .active {
            color: var(--vscode-foreground);
            font-weight: 600;
            text-decoration: none;
        }
        .sidebar-divider {
            height: 1px;
            margin: 15px 0;
            background: var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
        }
        .join-date {
            margin: 0 0 12px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.45;
        }
        .sidebar-link {
            display: block;
            margin: 0 0 12px;
            padding: 0;
            border: 0;
            color: var(--vscode-textLink-foreground);
            background: transparent;
            text-align: left;
            cursor: pointer;
            line-height: 1.4;
        }
        .sidebar-link:hover { text-decoration: underline; }
        .preview-banner {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 16px;
            padding: 9px 12px;
            border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-panel-border, rgba(128, 128, 128, 0.35)));
            border-radius: 6px;
            color: var(--vscode-foreground);
            background: var(--vscode-inputValidation-infoBackground, rgba(128, 128, 128, 0.1));
            line-height: 1.4;
        }
        .preview-banner-text {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }
        .preview-banner-text svg {
            flex: 0 0 auto;
            width: 16px;
            height: 16px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.6;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .preview-exit {
            flex: 0 0 auto;
            height: 28px;
            padding: 0 10px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 5px;
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
            cursor: pointer;
            white-space: nowrap;
        }
        .preview-exit:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .user-id {
            margin: 0;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .profile-main {
            min-width: 0;
        }
        .profile-name {
            margin: 0;
            padding-bottom: 24px;
            font-size: 27px;
            font-weight: 600;
            line-height: 1.45;
            letter-spacing: -0.2px;
            overflow-wrap: anywhere;
        }
        .profile-alias {
            margin: 0 0 10px;
            color: var(--vscode-descriptionForeground);
        }
        .profile-bio {
            margin: 7px 0 20px;
            color: var(--vscode-foreground);
            line-height: 1.5;
            white-space: pre-wrap;
        }
        .section-title {
            margin: 0 0 9px;
            color: var(--vscode-foreground);
            font-size: 15px;
            font-weight: 600;
        }
        .activity-card {
            padding: 16px 18px 14px;
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25)));
            border-radius: 7px;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            overflow: hidden;
        }
        .activity-scroll {
            overflow-x: auto;
            padding-bottom: 2px;
        }
        .heatmap-wrap {
            display: flex;
            gap: 6px;
            min-width: 680px;
        }
        .weekday-labels {
            display: grid;
            grid-template-rows: repeat(7, 10px);
            gap: 3px;
            padding-top: 19px;
            color: var(--vscode-descriptionForeground);
            font-size: 9.5px;
            line-height: 10px;
        }
        .heatmap-column {
            display: flex;
            flex-direction: column;
            min-width: 0;
        }
        .months {
            position: relative;
            height: 19px;
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            white-space: nowrap;
        }
        .month-label {
            position: absolute;
            top: 0;
            transform: translateX(-1px);
        }
        .heatmap {
            display: grid;
            grid-auto-flow: column;
            grid-template-rows: repeat(7, 10px);
            grid-auto-columns: 10px;
            gap: 3px;
        }
        .heat-cell {
            width: 10px;
            height: 10px;
            border-radius: 2px;
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.14));
        }
        .heat-cell:not(.pad) { cursor: default; }
        .heat-cell:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 1px;
        }
        .heat-cell.level-1 { background: #468c46; }
        .heat-cell.level-2 { background: #264c26; }
        .heat-cell.pad { background: transparent; }
        .heat-tooltip {
            position: fixed;
            z-index: 10;
            max-width: 280px;
            padding: 7px 10px;
            border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border, transparent));
            border-radius: 4px;
            color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
            background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
            font-size: 12px;
            line-height: 1.45;
            white-space: nowrap;
            pointer-events: none;
            opacity: 0;
            transform: translateY(2px);
            transition: opacity 70ms ease, transform 70ms ease;
        }
        .heat-tooltip.visible {
            opacity: 1;
            transform: translateY(0);
        }
        .heat-legend {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 3px;
            margin-top: 10px;
            color: var(--vscode-descriptionForeground);
            font-size: 10.5px;
        }
        .heat-legend .heat-cell { width: 9px; height: 9px; }
        .activity-counters {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
            margin-top: 16px;
            padding-top: 14px;
            border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
        }
        .activity-value {
            margin: 0;
            color: var(--vscode-foreground);
            font-size: 24px;
            font-weight: 600;
            line-height: 1.1;
        }
        .activity-label {
            margin: 2px 0 0;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            line-height: 1.35;
        }
        .activity-note {
            margin: 8px 0 0;
            color: var(--vscode-descriptionForeground);
            font-size: 10.5px;
            text-align: right;
        }
        .profile-section {
            margin-top: 26px;
        }
        .details-box {
            padding: 13px 16px;
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25)));
            border-radius: 7px;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            line-height: 1.55;
            white-space: pre-wrap;
        }
        .certificates {
            border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
        }
        .certificate {
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
        }
        .certificate-button {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            width: 100%;
            padding: 14px 4px;
            border: 0;
            color: inherit;
            background: transparent;
            text-align: left;
            cursor: pointer;
        }
        .certificate-icon {
            flex: 0 0 auto;
            width: 27px;
            height: 27px;
            color: var(--vscode-charts-yellow, #d7ba4a);
        }
        .certificate-icon svg {
            width: 27px;
            height: 27px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.5;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .certificate-text {
            display: block;
            min-width: 0;
        }
        .certificate-title {
            display: block;
            margin: 0;
            color: var(--vscode-foreground);
            font-size: 14px;
            font-weight: 600;
            line-height: 1.35;
        }
        .certificate-subtitle {
            display: block;
            margin: 2px 0 0;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            line-height: 1.4;
        }
        .certificate-chevron {
            margin-left: auto;
            padding: 2px 4px;
            color: var(--vscode-descriptionForeground);
            transition: transform 150ms ease;
        }
        .certificate.open .certificate-chevron { transform: rotate(180deg); }
        .certificate-details {
            padding: 0 4px 14px 39px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.5;
        }
        .certificate-meta {
            display: flex;
            flex-wrap: wrap;
            gap: 5px 14px;
            margin-bottom: 8px;
        }
        .certificate-open {
            padding: 0;
            border: 0;
            color: var(--vscode-textLink-foreground);
            background: transparent;
            cursor: pointer;
            font-size: 12px;
        }
        .certificate-open:hover { text-decoration: underline; }
        .certificate-empty {
            padding: 16px 4px;
            color: var(--vscode-descriptionForeground);
        }
        .social-list {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
        }
        .social-link {
            padding: 5px 9px;
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
            border-radius: 999px;
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            font-size: 12px;
        }
        .social-link:hover { border-color: var(--vscode-focusBorder); }
        .loading,
        .error-state,
        .empty-state {
            padding: 56px 24px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 9px;
            padding: 24px 0;
        }
        .loading::before {
            content: '';
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-progressBar-background, var(--vscode-focusBorder));
            border-right-color: transparent;
            border-radius: 50%;
            animation: spin 750ms linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
            .loading::before { animation: none; }
            .certificate-chevron { transition: none; }
        }
        .error-state strong,
        .empty-state strong {
            display: block;
            margin-bottom: 5px;
            color: var(--vscode-foreground);
            font-size: 15px;
        }
        @media (max-width: 760px) {
            .profile-shell { padding: 16px 14px 36px; }
            .profile-head { flex-direction: column; }
            .head-actions { justify-content: flex-start; }
            .preview-banner {
                flex-direction: column;
                align-items: flex-start;
            }
            .profile-layout {
                grid-template-columns: 1fr;
                gap: 24px;
            }
            .avatar {
                width: 96px;
                height: 96px;
                border-radius: 18px;
                font-size: 38px;
            }
            .profile-name { font-size: 24px; }
            .activity-counters { gap: 10px; }
            .activity-value { font-size: 20px; }
        }
${stepikThemeCss}
    </style>
</head>
<body data-view="profile">
    ${stepikBrandHtml()}
    <div class="profile-shell">
        <header class="profile-head">
            <div>
                <h1>${t('profile.title')}</h1>
                <p>${t('profile.subtitle')}</p>
            </div>
            <div class="head-actions">
                <button type="button" id="refresh" class="secondary-button">${t('profile.refresh')}</button>
                <button type="button" id="edit-profile" class="secondary-button">${t('profile.edit')}</button>
                <button type="button" id="open-stepik" class="primary-button">${t('profile.openStepik')}</button>
            </div>
        </header>
        <div id="content">
            <div class="loading">${t('profile.loading')}</div>
        </div>
    </div>

    <script nonce="${nonce}">
        (function () {
            var vscode = acquireVsCodeApi();
            var L = ${strings};

            function t(key, params) {
                var template = L[key] || key;
                if (!params) {
                    return template;
                }
                return template.replace(/\\{(\\w+)\\}/g, function (match, name) {
                    return params[name] === undefined ? match : String(params[name]);
                });
            }

            function plural(key, count) {
                var forms = String(L[key] || '').split('|');
                if (L.__lang === 'en') {
                    return count === 1 ? (forms[0] || '') : (forms[2] || forms[1] || forms[0] || '');
                }
                var abs = Math.abs(count) % 100;
                var last = abs % 10;
                if (abs > 10 && abs < 20) { return forms[2] || forms[0] || ''; }
                if (last > 1 && last < 5) { return forms[1] || forms[0] || ''; }
                if (last === 1) { return forms[0] || ''; }
                return forms[2] || forms[0] || '';
            }

            var state = {
                profile: null,
                loading: true,
                error: '',
                preview: false
            };
            var content = document.getElementById('content');

            function element(tag, className, text) {
                var node = document.createElement(tag);
                if (className) {
                    node.className = className;
                }
                if (text !== undefined) {
                    node.textContent = text;
                }
                return node;
            }

            function formatNumber(value) {
                try {
                    return Number(value || 0).toLocaleString(L.__locale || undefined);
                } catch (error) {
                    return String(value || 0);
                }
            }

            function formatDate(value, withYear) {
                if (!value) {
                    return '';
                }
                var date = new Date(value);
                if (isNaN(date.getTime())) {
                    return '';
                }
                try {
                    return date.toLocaleDateString(L.__locale || undefined, {
                        day: 'numeric',
                        month: 'long',
                        year: withYear === false ? undefined : 'numeric'
                    });
                } catch (error) {
                    return '';
                }
            }

            /** Activity pins are UTC dates; format them without a local shift. */
            function formatDay(value) {
                if (!value) {
                    return '';
                }
                var date = new Date(value + 'T00:00:00Z');
                if (isNaN(date.getTime())) {
                    return '';
                }
                try {
                    return date.toLocaleDateString(L.__locale || undefined, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric',
                        timeZone: 'UTC'
                    });
                } catch (error) {
                    return '';
                }
            }

            function formatJoin(value) {
                if (!value) {
                    return '';
                }
                var date = new Date(value);
                if (isNaN(date.getTime())) {
                    return '';
                }
                var now = new Date();
                var months = (now.getFullYear() - date.getFullYear()) * 12 +
                    (now.getMonth() - date.getMonth());
                if (date.getDate() > now.getDate()) {
                    months -= 1;
                }
                if (months <= 0) {
                    return t('profile.joinedThisMonth');
                }
                if (months === 1) {
                    return t('profile.joinedLastMonth');
                }
                if (months < 12) {
                    return t('profile.joinedMonths', {
                        count: months,
                        word: plural('profile.months', months)
                    });
                }
                try {
                    var label = date.toLocaleDateString(L.__locale || undefined, {
                        month: 'long',
                        year: 'numeric'
                    }).replace(/ г\.$/, '');
                    return t('profile.joinedIn', { date: label });
                } catch (error) {
                    return t('profile.joinedIn', { date: formatDate(value) });
                }
            }

            function icon(name) {
                var paths = {
                    followers: '<circle cx="12" cy="8" r="3.2"></circle><path d="M5.5 19c.6-3 3.2-4.7 6.5-4.7s5.9 1.7 6.5 4.7"></path>',
                    reputation: '<circle cx="12" cy="12" r="8"></circle><path d="M12 7l1.5 3 3.3.5-2.4 2.3.6 3.2-3-1.6-3 1.6.6-3.2-2.4-2.3 3.3-.5z"></path>',
                    knowledge: '<circle cx="12" cy="12" r="8"></circle><path d="M8.5 10.5h7M8.5 13.5h5M9.5 7.5l2.5 9 2.5-9"></path>',
                    certificate: '<path d="M6 3.5h9l3 3v9.5H6z"></path><path d="M15 3.5v3h3"></path><circle cx="10.5" cy="10" r="2"></circle><path d="M8 14.5l1.4-1.4 1.1 1.1 2.5-2.5 1.5 1.5"></path><path d="M9 16.5l-1 4 3-1.5 3 1.5-1-4"></path>'
                };
                return '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
            }

            function openExternal(url) {
                if (url) {
                    vscode.postMessage({ command: 'openExternal', url: url });
                }
            }

            var heatTooltip = null;

            function ensureHeatTooltip() {
                if (!heatTooltip) {
                    heatTooltip = element('div', 'heat-tooltip');
                    document.body.appendChild(heatTooltip);
                }
                return heatTooltip;
            }

            function positionHeatTooltip(cell) {
                if (!heatTooltip) {
                    return;
                }
                var rect = cell.getBoundingClientRect();
                heatTooltip.style.left = '0px';
                heatTooltip.style.top = '0px';
                var tooltipRect = heatTooltip.getBoundingClientRect();
                var left = rect.left + rect.width / 2 - tooltipRect.width / 2;
                var top = rect.top - tooltipRect.height - 6;
                if (top < 4) {
                    top = rect.bottom + 6;
                }
                left = Math.max(4, Math.min(left, window.innerWidth - tooltipRect.width - 4));
                heatTooltip.style.left = Math.round(left) + 'px';
                heatTooltip.style.top = Math.round(top) + 'px';
            }

            function showHeatTooltip(cell, day) {
                var tooltip = ensureHeatTooltip();
                while (tooltip.firstChild) {
                    tooltip.removeChild(tooltip.firstChild);
                }
                tooltip.appendChild(element('div', 'heat-tooltip-date', formatDay(day.date)));
                tooltip.appendChild(element(
                    'div',
                    'heat-tooltip-value',
                    t('profile.tooltipSolved', { count: formatNumber(day.count) })
                ));
                tooltip.classList.add('visible');
                positionHeatTooltip(cell);
            }

            function hideHeatTooltip() {
                if (heatTooltip) {
                    heatTooltip.classList.remove('visible');
                }
            }

            window.addEventListener('scroll', hideHeatTooltip, true);
            window.addEventListener('resize', hideHeatTooltip);

            function createCounter(iconName, value, label) {
                var item = element('li', 'counter');
                var iconBox = element('span');
                iconBox.innerHTML = icon(iconName);
                item.appendChild(iconBox.firstChild);
                var text = element('span');
                text.appendChild(element('b', '', formatNumber(value)));
                text.appendChild(document.createTextNode(' ' + label));
                item.appendChild(text);
                return item;
            }

            function buildHeatmap(activity) {
                var days = Array.isArray(activity.days) ? activity.days.slice(-365) : [];
                var card = element('div', 'activity-card');
                var scroll = element('div', 'activity-scroll');
                var wrap = element('div', 'heatmap-wrap');

                var weekdays = element('div', 'weekday-labels');
                var weekdayLabels = String(L['profile.weekdays'] || '').split(',');
                weekdayLabels.forEach(function (label) {
                    weekdays.appendChild(element('span', '', label));
                });
                wrap.appendChild(weekdays);

                var column = element('div', 'heatmap-column');
                var months = element('div', 'months');
                var grid = element('div', 'heatmap');

                if (days.length === 0) {
                    column.appendChild(months);
                    grid.appendChild(element('div', 'heat-cell'));
                    column.appendChild(grid);
                    wrap.appendChild(column);
                    scroll.appendChild(wrap);
                    card.appendChild(scroll);
                    card.appendChild(element('p', 'activity-note', t('profile.noActivity')));
                    return card;
                }

                var parse = function (iso) {
                    var parts = iso.split('-').map(Number);
                    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
                };
                var first = parse(days[0].date);
                var pad = (first.getUTCDay() + 6) % 7;
                var total = pad + days.length;
                var weeks = Math.ceil(total / 7);
                var max = 0;
                days.forEach(function (day) { max = Math.max(max, day.count); });

                var level = function (count) {
                    if (count <= 0) { return 0; }
                    if (max <= 1) { return 1; }
                    return count / max > 0.5 ? 2 : 1;
                };

                var labelForDate = function (date) {
                    try {
                        return date.toLocaleDateString(L.__locale || undefined, { month: 'short' }).replace('.', '');
                    } catch (error) {
                        return '';
                    }
                };

                var monthLabels = [];
                for (var index = 0; index < days.length; index++) {
                    var date = parse(days[index].date);
                    if (date.getUTCDate() === 1) {
                        var weekIndex = Math.floor((pad + index) / 7);
                        var label = labelForDate(date);
                        if (!monthLabels.length || monthLabels[monthLabels.length - 1].label !== label) {
                            monthLabels.push({ week: weekIndex, label: label });
                        }
                    }
                }
                var monthWidth = 13;
                months.style.width = (weeks * monthWidth) + 'px';
                monthLabels.forEach(function (entry) {
                    var label = element('span', 'month-label', entry.label);
                    label.style.left = (entry.week * monthWidth) + 'px';
                    months.appendChild(label);
                });
                column.appendChild(months);

                for (var empty = 0; empty < pad; empty++) {
                    grid.appendChild(element('div', 'heat-cell pad'));
                }
                days.forEach(function (day) {
                    var cell = element('div', 'heat-cell level-' + level(day.count));
                    var label = t('profile.heatmapAria', {
                        date: formatDay(day.date),
                        count: day.count,
                        word: plural('profile.solved', day.count)
                    });
                    cell.setAttribute('aria-label', label);
                    cell.addEventListener('mouseenter', function () {
                        showHeatTooltip(cell, day);
                    });
                    cell.addEventListener('mouseleave', hideHeatTooltip);
                    grid.appendChild(cell);
                });
                column.appendChild(grid);
                wrap.appendChild(column);
                scroll.appendChild(wrap);
                card.appendChild(scroll);

                var legend = element('div', 'heat-legend');
                legend.appendChild(element('span', '', t('profile.less')));
                for (var levelIndex = 0; levelIndex <= 2; levelIndex++) {
                    legend.appendChild(element('span', 'heat-cell level-' + levelIndex));
                }
                legend.appendChild(element('span', '', t('profile.more')));
                card.appendChild(legend);

                var counters = element('div', 'activity-counters');
                var streak = function (count) {
                    return plural('profile.dayStreak', count);
                };
                var values = [
                    [activity.recentStrike, streak(activity.recentStrike)],
                    [activity.maxStrike, streak(activity.maxStrike) + ' ' + t('profile.maxSuffix')],
                    [
                        activity.solved,
                        plural('profile.solved', activity.solved)
                    ]
                ];
                values.forEach(function (value) {
                    var cell = element('div');
                    cell.appendChild(element('p', 'activity-value', formatNumber(value[0])));
                    cell.appendChild(element('p', 'activity-label', value[1]));
                    counters.appendChild(cell);
                });
                card.appendChild(counters);
                card.appendChild(element('p', 'activity-note', t('profile.nextDay')));
                return card;
            }

            function certificateRow(certificate) {
                var row = element('div', 'certificate');
                var button = element('button', 'certificate-button');
                button.type = 'button';

                var iconBox = element('span', 'certificate-icon');
                iconBox.innerHTML = icon('certificate');
                button.appendChild(iconBox);

                var text = element('span', 'certificate-text');
                text.appendChild(element('span', 'certificate-title', certificate.title));
                text.appendChild(element('span', 'certificate-subtitle', certificate.subtitle));
                button.appendChild(text);
                var chevron = element('span', 'certificate-chevron', '⌄');
                button.appendChild(chevron);
                row.appendChild(button);

                var details = element('div', 'certificate-details');
                details.hidden = true;
                var meta = element('div', 'certificate-meta');
                if (certificate.issueDate) {
                    meta.appendChild(element('span', '', t('profile.issued', {
                        date: formatDate(certificate.issueDate)
                    })));
                }
                if (typeof certificate.grade === 'number') {
                    meta.appendChild(element('span', '', t('profile.grade', {
                        grade: Math.round(certificate.grade)
                    })));
                }
                if (certificate.rank) {
                    meta.appendChild(element('span', '', t('profile.rank', {
                        rank: certificate.rank
                    })));
                }
                if (meta.childNodes.length > 0) {
                    details.appendChild(meta);
                }
                if (certificate.url) {
                    var link = element('button', 'certificate-open', t('profile.openCertificate'));
                    link.type = 'button';
                    link.addEventListener('click', function (event) {
                        event.stopPropagation();
                        vscode.postMessage({
                            command: 'openCertificate',
                            certificateUrl: certificate.url
                        });
                    });
                    details.appendChild(link);
                }
                row.appendChild(details);

                button.addEventListener('click', function () {
                    row.classList.toggle('open');
                    details.hidden = !row.classList.contains('open');
                });
                return row;
            }

            function buildPreviewBanner() {
                var banner = element('div', 'preview-banner');
                var text = element('div', 'preview-banner-text');
                var iconBox = element('span');
                iconBox.innerHTML =
                    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
                    '<path d="M2.5 12s3.5-6.2 9.5-6.2S21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"></path>' +
                    '<circle cx="12" cy="12" r="2.8"></circle></svg>';
                text.appendChild(iconBox.firstChild);
                text.appendChild(element('span', '', t('profile.previewBanner')));
                banner.appendChild(text);
                var exit = element('button', 'preview-exit', t('profile.exitPreview'));
                exit.type = 'button';
                exit.addEventListener('click', function () {
                    state.preview = false;
                    render();
                    window.scrollTo(0, 0);
                });
                banner.appendChild(exit);
                return banner;
            }

            function renderProfile(profile) {
                while (content.firstChild) {
                    content.removeChild(content.firstChild);
                }
                hideHeatTooltip();

                var editButton = document.getElementById('edit-profile');
                if (editButton) {
                    editButton.hidden = state.preview;
                }

                if (state.preview) {
                    content.appendChild(buildPreviewBanner());
                }

                var layout = element('div', 'profile-layout');

                var sidebar = element('aside', 'profile-sidebar');
                var avatar = element('div', 'avatar');
                if (profile.avatar) {
                    var image = element('img');
                    image.src = profile.avatar;
                    image.alt = profile.fullName;
                    image.referrerPolicy = 'no-referrer';
                    image.addEventListener('error', function () {
                        image.remove();
                        avatar.textContent = (profile.fullName || 'S').slice(0, 1).toUpperCase();
                    });
                    avatar.appendChild(image);
                } else {
                    avatar.textContent = (profile.fullName || 'S').slice(0, 1).toUpperCase();
                }
                sidebar.appendChild(avatar);

                var counters = element('ul', 'counters');
                counters.appendChild(createCounter(
                    'followers',
                    profile.followers,
                    plural('profile.followers', profile.followers)
                ));
                counters.appendChild(createCounter(
                    'reputation',
                    profile.reputation,
                    t('profile.reputation')
                ));
                counters.appendChild(createCounter(
                    'knowledge',
                    profile.knowledge,
                    t('profile.knowledge')
                ));
                sidebar.appendChild(counters);

                var nav = element('ul', 'sidebar-nav');
                var profileItem = element('li');
                profileItem.appendChild(element('span', 'active', t('profile.profileTab')));
                nav.appendChild(profileItem);
                var certificatesItem = element('li');
                var certificatesLink = element('button', '', t('profile.certificatesTab'));
                certificatesLink.type = 'button';
                certificatesLink.addEventListener('click', function () {
                    var section = document.getElementById('certificates-section');
                    if (section) {
                        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                });
                certificatesItem.appendChild(certificatesLink);
                nav.appendChild(certificatesItem);
                sidebar.appendChild(nav);

                var divider = element('div', 'sidebar-divider');
                sidebar.appendChild(divider);

                if (profile.joinDate) {
                    var joined = element('p', 'join-date', formatJoin(profile.joinDate));
                    joined.title = formatDate(profile.joinDate);
                    sidebar.appendChild(joined);
                }

                if (!state.preview) {
                    var preview = element('button', 'sidebar-link', t('profile.previewLink'));
                    preview.type = 'button';
                    preview.addEventListener('click', function () {
                        state.preview = true;
                        render();
                        window.scrollTo(0, 0);
                    });
                    sidebar.appendChild(preview);
                    var userId = element('p', 'user-id', t('profile.userId', { id: profile.id }));
                    sidebar.appendChild(userId);
                }

                var main = element('section', 'profile-main');
                main.appendChild(element('h2', 'profile-name', profile.fullName));
                if (profile.alias && profile.alias !== profile.fullName) {
                    main.appendChild(element('p', 'profile-alias', '@' + profile.alias));
                }
                if (profile.shortBio) {
                    main.appendChild(element('p', 'profile-bio', profile.shortBio));
                }

                var activityTitle = element('h3', 'section-title', t('profile.activityTitle'));
                main.appendChild(activityTitle);
                main.appendChild(buildHeatmap(profile.activity));

                if (profile.details) {
                    var detailsSection = element('section', 'profile-section');
                    detailsSection.appendChild(element('h3', 'section-title', t('profile.about')));
                    detailsSection.appendChild(element('div', 'details-box', profile.details));
                    main.appendChild(detailsSection);
                }

                var certificatesSection = element('section', 'profile-section');
                certificatesSection.id = 'certificates-section';
                certificatesSection.appendChild(element('h3', 'section-title', t('profile.certificates')));
                if (profile.certificates.length === 0) {
                    certificatesSection.appendChild(element(
                        'div',
                        'certificate-empty',
                        t('profile.noCertificates')
                    ));
                } else {
                    var certificateList = element('div', 'certificates');
                    profile.certificates.forEach(function (certificate) {
                        certificateList.appendChild(certificateRow(certificate));
                    });
                    certificatesSection.appendChild(certificateList);
                }
                main.appendChild(certificatesSection);

                if (profile.socialProfiles.length > 0) {
                    var socialSection = element('section', 'profile-section');
                    socialSection.appendChild(element('h3', 'section-title', t('profile.links')));
                    var socialList = element('div', 'social-list');
                    profile.socialProfiles.forEach(function (social) {
                        var link = element('a', 'social-link', social.title);
                        link.href = '#';
                        link.addEventListener('click', function (event) {
                            event.preventDefault();
                            openExternal(social.url);
                        });
                        socialList.appendChild(link);
                    });
                    socialSection.appendChild(socialList);
                    main.appendChild(socialSection);
                }

                layout.appendChild(sidebar);
                layout.appendChild(main);
                content.appendChild(layout);
            }

            function render() {
                while (content.firstChild) {
                    content.removeChild(content.firstChild);
                }
                if (state.loading) {
                    content.appendChild(element('div', 'loading', t('profile.loading')));
                    return;
                }
                if (state.error) {
                    var error = element('div', 'error-state');
                    error.appendChild(element('strong', '', t('profile.loadErrorTitle')));
                    error.appendChild(element('span', '', state.error));
                    content.appendChild(error);
                    return;
                }
                if (!state.profile) {
                    var empty = element('div', 'empty-state');
                    empty.appendChild(element('strong', '', t('profile.unavailableTitle')));
                    empty.appendChild(element('span', '', t('profile.unavailableHint')));
                    content.appendChild(empty);
                    return;
                }
                renderProfile(state.profile);
            }

            document.getElementById('refresh').addEventListener('click', function () {
                state.loading = true;
                state.error = '';
                render();
                vscode.postMessage({ command: 'refresh' });
            });

            document.getElementById('edit-profile').addEventListener('click', function () {
                var url = state.profile && state.profile.editProfileUrl;
                openExternal(url || 'https://stepik.org/edit-profile');
            });

            document.getElementById('open-stepik').addEventListener('click', function () {
                var url = state.profile ? state.profile.profileUrl : 'https://stepik.org';
                openExternal(url);
            });

            window.addEventListener('message', function (event) {
                var message = event.data || {};
                if (message.command === 'profile') {
                    state.profile = message.profile;
                    state.loading = false;
                    state.error = '';
                    render();
                    return;
                }
                if (message.command === 'error') {
                    state.loading = false;
                    state.error = message.message || t('profile.loadErrorFallback');
                    render();
                }
            });

            vscode.postMessage({ command: 'init' });
        })();
    </script>
</body>
</html>`;
    }
}
