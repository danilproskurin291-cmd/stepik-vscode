import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Course, StepikApi } from '../api/stepikApi';
import { StepikTreeProvider } from '../providers/treeProvider';
import { getLanguage, pluralize, t, webviewStrings } from '../i18n';
import { stepikBrandHtml, stepikThemeCss } from './theme';

type CatalogMode = 'recommended' | 'all' | 'my';

/** Stepik's curated "Популярные курсы" list. */
const POPULAR_COURSE_LIST_ID = 109;
const COURSE_LIST_PAGE_SIZE = 20;

interface CatalogMessage {
    command?: string;
    mode?: string;
    page?: number;
    freeOnly?: boolean;
    requestId?: number;
    search?: string;
    courseId?: number;
    url?: string;
    /** Background request for the page after the one currently shown. */
    prefetch?: boolean;
}

interface CatalogCoursePayload {
    id: number;
    title: string;
    summary: string;
    cover?: string;
    learnersCount: number;
    ratingAverage?: number;
    ratingCount: number;
    isPaid: boolean;
    price: string;
    workload?: string;
    language?: string;
    createDate?: string;
    withCertificate: boolean;
    enrolled: boolean;
    url: string;
}

/**
 * Course browser opened from "Select Course → Choose another course".
 *
 * The view is intentionally independent from the step webview: it reads the
 * public catalog and the user's course list, can enrol the user in a free
 * course, and hands the selected course back to the tree provider. Paid
 * courses without an existing enrollment are never enrolled locally; they are
 * opened on stepik.org so the purchase happens on the website.
 */
export class CourseCatalogView implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private userCoursesPromise: Promise<Course[]> | undefined;
    private courseListPromise: Promise<number[]> | undefined;
    private readonly log: (message: string) => void;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly api: StepikApi,
        private readonly treeProvider: StepikTreeProvider,
        outputChannel: vscode.OutputChannel
    ) {
        this.log = message => outputChannel.appendLine(`[Catalog] ${message}`);
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'stepikCourseCatalog',
            t('catalog.panelTitle'),
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
            this.handleMessage(message as CatalogMessage)
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
        this.userCoursesPromise = undefined;
        this.courseListPromise = undefined;
    }

    /** Re-render the panel after the interface language changed. */
    refreshLocalization(): void {
        if (!this.panel) {
            return;
        }
        this.panel.title = t('catalog.panelTitle');
        this.panel.webview.html = this.getHtml(this.panel.webview);
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
        this.userCoursesPromise = undefined;
        this.courseListPromise = undefined;
    }

    private async handleMessage(message: CatalogMessage): Promise<void> {
        switch (message.command) {
            case 'load':
                await this.loadCourses(message);
                break;
            case 'selectCourse':
                await this.selectCourse(message.courseId);
                break;
            case 'enrollCourse':
                await this.enrollCourse(message.courseId);
                break;
            case 'openExternal':
                await this.openExternal(message.url);
                break;
            case 'resetCaches':
                this.userCoursesPromise = undefined;
                this.courseListPromise = undefined;
                break;
            default:
                break;
        }
    }

    private normalizeMode(value: string | undefined): CatalogMode {
        return value === 'all' || value === 'my' ? value : 'recommended';
    }

    private getUserCoursesCached(): Promise<Course[]> {
        if (!this.userCoursesPromise) {
            const promise = this.api.getUserCourses();
            this.userCoursesPromise = promise;
            void promise.catch(() => {
                // Allow a retry after a transient network or auth error.
                if (this.userCoursesPromise === promise) {
                    this.userCoursesPromise = undefined;
                }
            });
        }
        return this.userCoursesPromise;
    }

    private async getEnrolledIds(): Promise<Set<number>> {
        try {
            const courses = await this.getUserCoursesCached();
            return new Set(courses.map(course => course.id));
        } catch (error) {
            // Enrollment badges are decorative; a failure here must not hide
            // the public catalog.
            this.log(
                t('catalog.userCoursesLogError', {
                    detail: error instanceof Error ? error.message : String(error)
                })
            );
            return new Set<number>();
        }
    }

    private async isCourseEnrolled(courseId: number): Promise<boolean> {
        try {
            const courses = await this.getUserCoursesCached();
            return courses.some(course => course.id === courseId);
        } catch (error) {
            // If the personal list is unavailable, do not let a paid course
            // skip the purchase flow.
            this.log(
                t('catalog.enrolledCheckLogError', {
                    id: courseId,
                    detail: error instanceof Error ? error.message : String(error)
                })
            );
            return false;
        }
    }

    private getPopularCourseIds(): Promise<number[]> {
        if (!this.courseListPromise) {
            const promise = this.api.getCourseListCourseIds(POPULAR_COURSE_LIST_ID);
            this.courseListPromise = promise;
            void promise.catch(() => {
                // Allow a retry after a transient network or auth error.
                if (this.courseListPromise === promise) {
                    this.courseListPromise = undefined;
                }
            });
        }
        return this.courseListPromise;
    }

    private async loadCourses(message: CatalogMessage): Promise<void> {
        const mode = this.normalizeMode(message.mode);
        const page = Math.max(1, Math.floor(Number(message.page) || 1));
        const freeOnly = Boolean(message.freeOnly);
        const requestId = Number(message.requestId) || 0;
        const search = typeof message.search === 'string' ? message.search.trim() : '';
        const prefetch = Boolean(message.prefetch);

        try {
            let courses: Course[];
            let hasNext = false;

            if (mode === 'my') {
                courses = page === 1 ? await this.getUserCoursesCached() : [];
            } else if (mode === 'recommended' || search) {
                // Same ranking as Stepik's search page: an empty query returns
                // the top catalog courses, a query returns relevant matches.
                const result = await this.api.searchCatalogCourseIds(
                    search,
                    page,
                    freeOnly
                );
                courses = await this.api.getCoursesByIds(result.courseIds);
                hasNext = result.hasNext;
            } else {
                // "Популярные" uses Stepik's own curated list instead of the
                // public feed, which is sorted by creation date and therefore
                // shows empty, just-published courses.
                const ids = await this.getPopularCourseIds();
                const start = (page - 1) * COURSE_LIST_PAGE_SIZE;
                const pageIds = ids.slice(start, start + COURSE_LIST_PAGE_SIZE);
                courses = await this.api.getCoursesByIds(pageIds);
                hasNext = start + COURSE_LIST_PAGE_SIZE < ids.length;
            }

            // The API honours `is_paid=false`, but older deployments and the
            // personal course list do not, so enforce the filter locally too.
            if (freeOnly) {
                courses = courses.filter(course => course.is_paid !== true);
            }

            const summaryIds = courses
                .map(course =>
                    typeof course.review_summary === 'number' ? course.review_summary : 0
                )
                .filter(id => id > 0);
            const summaries = await this.api.getCourseReviewSummaries(summaryIds);
            const enrolledIds = await this.getEnrolledIds();

            const payload: CatalogCoursePayload[] = courses.map(course => {
                const summary =
                    typeof course.review_summary === 'number'
                        ? summaries.get(course.review_summary)
                        : undefined;
                const rating =
                    summary && summary.count > 0
                        ? Math.round(summary.average * 10) / 10
                        : undefined;
                const price =
                    course.display_price ||
                    (course.price ? String(course.price) : '') ||
                    t('catalog.paidFallback');

                return {
                    id: course.id,
                    title: course.title,
                    summary: (course.summary || '').trim(),
                    cover: this.normalizeCoverUrl(course.cover),
                    learnersCount: Number(course.learners_count) || 0,
                    ratingAverage: rating,
                    ratingCount: summary?.count || 0,
                    isPaid: course.is_paid === true,
                    price,
                    workload: course.workload || undefined,
                    language: course.language || undefined,
                    createDate: course.create_date || undefined,
                    withCertificate: course.with_certificate === true,
                    enrolled: mode === 'my' || enrolledIds.has(course.id),
                    url: `https://stepik.org/course/${course.id}`
                };
            });

            this.post({
                command: 'courses',
                requestId,
                mode,
                page,
                freeOnly,
                search,
                prefetch,
                hasNext: mode === 'my' ? false : hasNext,
                courses: payload
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('catalog.loadLogError', { detail }));
            const friendly = /not authenticated|login first|session has expired|Сессия Stepik истекла/i.test(detail)
                ? t('catalog.loginRequired')
                : detail;
            this.post({
                command: 'error',
                requestId,
                mode,
                page,
                freeOnly,
                search,
                prefetch,
                message: friendly
            });
        }
    }

    private async selectCourse(courseId: number | undefined): Promise<void> {
        if (!Number.isInteger(courseId) || Number(courseId) <= 0) {
            return;
        }

        try {
            const course = await this.api.getCourse(Number(courseId));
            if (!course) {
                throw new Error(t('catalog.courseNotFound'));
            }

            // Paid courses must be bought on Stepik. Selecting one directly
            // would leave the user with a course they cannot access.
            if (course.is_paid === true && !(await this.isCourseEnrolled(course.id))) {
                await this.redirectToPaidCourse(course);
                return;
            }

            await this.finishSelection(
                course,
                t('catalog.courseSelected', { title: course.title })
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('catalog.selectLogError', { id: Number(courseId), detail }));
            const friendly = t('catalog.selectError', { detail });
            void this.panel?.webview.postMessage({
                command: 'selectFailed',
                courseId,
                message: friendly
            });
            vscode.window.showErrorMessage(friendly);
        }
    }

    private async enrollCourse(courseId: number | undefined): Promise<void> {
        if (!Number.isInteger(courseId) || Number(courseId) <= 0) {
            return;
        }

        let enrolledNow = false;
        try {
            const course = await this.api.getCourse(Number(courseId));
            if (!course) {
                throw new Error(t('catalog.courseNotFound'));
            }

            // Never enrol in a paid course locally, even if a crafted webview
            // message asks for it. Payment and enrolment happen on stepik.org.
            if (course.is_paid === true) {
                await this.redirectToPaidCourse(course);
                return;
            }

            if (!(await this.isCourseEnrolled(course.id))) {
                await this.api.enrollCourse(course.id);
                enrolledNow = true;
                // The card came from the old personal list and the next
                // catalog opening must not reuse it.
                this.userCoursesPromise = undefined;
            }

            await this.finishSelection(
                course,
                enrolledNow
                    ? t('catalog.enrolledSelected', { title: course.title })
                    : t('catalog.selected', { title: course.title })
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.userCoursesPromise = undefined;
            this.log(t('catalog.enrollLogError', { id: Number(courseId), detail }));
            const friendly = t('catalog.enrollError', { detail });
            void this.panel?.webview.postMessage({
                command: 'enrollFailed',
                courseId,
                message: friendly
            });
            vscode.window.showErrorMessage(friendly);
        }
    }

    private async redirectToPaidCourse(course: Course): Promise<void> {
        await this.openExternal(`https://stepik.org/course/${course.id}`);
        vscode.window.showInformationMessage(
            t('catalog.paidInfo', { title: course.title })
        );
    }

    private async finishSelection(course: Course, message: string): Promise<void> {
        await this.treeProvider.setSelectedCourse(course);
        await vscode.commands.executeCommand('stepikCourses.focus');
        this.panel?.dispose();
        vscode.window.showInformationMessage(message);
    }

    private async openExternal(url: string | undefined): Promise<void> {
        if (!url) {
            return;
        }
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' || parsed.hostname !== 'stepik.org') {
                return;
            }
            await vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
        } catch {
            // Ignore malformed URLs coming from the webview.
        }
    }

    private normalizeCoverUrl(cover: string | null | undefined): string | undefined {
        if (!cover) {
            return undefined;
        }
        if (cover.startsWith('//')) {
            return `https:${cover}`;
        }
        if (cover.startsWith('/')) {
            return `https://stepik.org${cover}`;
        }
        if (/^https:\/\//i.test(cover)) {
            return cover;
        }
        if (/^http:\/\//i.test(cover)) {
            return cover.replace(/^http:/i, 'https:');
        }
        return undefined;
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
    <title>${t('catalog.panelTitle')}</title>
    <style>
        * {
            box-sizing: border-box;
        }
        [hidden] {
            display: none !important;
        }
        body {
            margin: 0;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size, 13px);
        }
        button,
        input,
        select {
            font-family: inherit;
            font-size: inherit;
        }
        .catalog-shell {
            max-width: 1240px;
            margin: 0 auto;
            padding: 22px 24px 48px;
        }
        .catalog-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 18px;
        }
        .catalog-header h1 {
            margin: 0 0 5px;
            font-size: 24px;
            font-weight: 600;
            letter-spacing: -0.2px;
        }
        .catalog-subtitle {
            margin: 0;
            color: var(--vscode-descriptionForeground);
            line-height: 1.45;
        }
        .icon-button {
            flex: 0 0 auto;
            min-width: 34px;
            height: 34px;
            padding: 0 10px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 6px;
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
            cursor: pointer;
        }
        .icon-button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .tabs {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
            margin-bottom: 16px;
        }
        .tab {
            position: relative;
            padding: 9px 14px 11px;
            border: 0;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            border-radius: 6px 6px 0 0;
        }
        .tab:hover {
            color: var(--vscode-foreground);
            background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.12));
        }
        .tab.active {
            color: var(--vscode-foreground);
            font-weight: 600;
        }
        .tab.active::after {
            content: '';
            position: absolute;
            left: 12px;
            right: 12px;
            bottom: -1px;
            height: 2px;
            background: var(--vscode-focusBorder);
            border-radius: 2px;
        }
        .toolbar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 10px;
            margin-bottom: 14px;
        }
        .search-field {
            position: relative;
            flex: 1 1 260px;
            min-width: 220px;
        }
        .search-field::before {
            content: '⌕';
            position: absolute;
            left: 10px;
            top: 50%;
            transform: translateY(-52%);
            color: var(--vscode-input-placeholderForeground);
            font-size: 17px;
            pointer-events: none;
        }
        .search-field input {
            width: 100%;
            height: 34px;
            padding: 0 12px 0 30px;
            color: var(--vscode-input-foreground);
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 6px;
            outline: none;
        }
        .search-field input:focus {
            border-color: var(--vscode-focusBorder);
        }
        .checkbox {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            height: 34px;
            padding: 0 10px;
            border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.3));
            border-radius: 6px;
            color: var(--vscode-foreground);
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
        }
        .checkbox input {
            margin: 0;
            accent-color: var(--vscode-focusBorder);
        }
        .status {
            min-height: 20px;
            margin: 4px 0 14px;
            color: var(--vscode-descriptionForeground);
        }
        .status.error {
            color: var(--vscode-errorForeground, #f14c4c);
        }
        .status.loading {
            color: var(--vscode-textLink-foreground);
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 16px;
        }
        .course-card {
            display: flex;
            flex-direction: column;
            min-width: 0;
            overflow: hidden;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25)));
            border-radius: 10px;
            transition: border-color 120ms ease, transform 120ms ease;
        }
        .course-card:hover {
            border-color: var(--vscode-focusBorder);
            transform: translateY(-1px);
        }
        .course-media {
            position: relative;
            aspect-ratio: 16 / 8.5;
            overflow: hidden;
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.12));
        }
        .course-media img {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .course-cover-placeholder {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            font-size: 38px;
            opacity: 0.55;
            background:
                radial-gradient(circle at 20% 20%, var(--vscode-focusBorder), transparent 55%),
                radial-gradient(circle at 80% 80%, var(--vscode-textLink-foreground), transparent 50%);
        }
        .course-badges {
            position: absolute;
            top: 8px;
            right: 8px;
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 5px;
        }
        .badge {
            padding: 3px 7px;
            border-radius: 999px;
            font-size: 10.5px;
            font-weight: 600;
            letter-spacing: 0.1px;
            color: var(--vscode-badge-foreground);
            background: var(--vscode-badge-background);
            box-shadow: 0 1px 4px rgba(0, 0, 0, 0.28);
        }
        .badge.enrolled {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
        }
        .badge.paid {
            color: var(--vscode-editor-background);
            background: var(--vscode-charts-orange, #d18616);
        }
        .course-body {
            display: flex;
            flex: 1;
            flex-direction: column;
            gap: 8px;
            padding: 13px 14px 14px;
        }
        .course-title {
            display: -webkit-box;
            margin: 0;
            overflow: hidden;
            color: var(--vscode-foreground);
            font-size: 15.5px;
            font-weight: 600;
            line-height: 1.35;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
        }
        .course-summary {
            display: -webkit-box;
            margin: 0;
            overflow: hidden;
            color: var(--vscode-descriptionForeground);
            font-size: 12.5px;
            line-height: 1.45;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 3;
        }
        .course-meta {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px 10px;
            margin-top: auto;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .meta-item {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            white-space: nowrap;
        }
        .rating-star {
            color: var(--vscode-charts-yellow, #d7ba4a);
            font-size: 13px;
        }
        .rating-count {
            opacity: 0.8;
        }
        .price {
            font-weight: 600;
            color: var(--vscode-charts-green, #89d185);
        }
        .price.paid {
            color: var(--vscode-charts-orange, #d18616);
        }
        .course-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 2px;
        }
        .purchase-hint {
            margin: 0;
            color: var(--vscode-descriptionForeground);
            font-size: 11.5px;
            line-height: 1.4;
        }
        .primary-button,
        .secondary-button {
            height: 32px;
            border-radius: 6px;
            cursor: pointer;
            white-space: nowrap;
        }
        .primary-button {
            flex: 1;
            padding: 0 12px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            border: 1px solid var(--vscode-button-border, transparent);
        }
        .primary-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .primary-button:disabled {
            opacity: 0.6;
            cursor: default;
        }
        .secondary-button {
            padding: 0 11px;
            color: var(--vscode-button-secondaryForeground);
            background: var(--vscode-button-secondaryBackground);
            border: 1px solid var(--vscode-button-border, transparent);
        }
        .secondary-button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .footer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 14px;
            margin-top: 22px;
            padding-top: 16px;
            border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
        }
        .footer-note {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .load-more {
            min-width: 140px;
            height: 34px;
            padding: 0 16px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 6px;
            cursor: pointer;
        }
        .load-more:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .load-more:disabled {
            opacity: 0.6;
            cursor: default;
        }
        .loading-more {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 9px;
            padding: 20px 0 2px;
            color: var(--vscode-descriptionForeground);
            font-size: 12.5px;
        }
        .loading-more::before {
            content: '';
            width: 14px;
            height: 14px;
            border: 2px solid var(--vscode-progressBar-background, var(--vscode-focusBorder));
            border-right-color: transparent;
            border-radius: 50%;
            animation: catalog-spin 750ms linear infinite;
        }
        @keyframes catalog-spin {
            to {
                transform: rotate(360deg);
            }
        }
        @media (prefers-reduced-motion: reduce) {
            .loading-more::before {
                animation: none;
            }
        }
        .scroll-sentinel {
            width: 100%;
            height: 1px;
        }
        .empty-state {
            padding: 56px 24px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            border: 1px dashed var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
            border-radius: 10px;
        }
        .empty-state strong {
            display: block;
            margin-bottom: 6px;
            color: var(--vscode-foreground);
            font-size: 15px;
        }
        @media (max-width: 520px) {
            .catalog-shell {
                padding: 16px 14px 32px;
            }
            .catalog-header h1 {
                font-size: 20px;
            }
            .grid {
                grid-template-columns: 1fr;
            }
            .footer {
                align-items: stretch;
                flex-direction: column;
            }
        }
${stepikThemeCss}
    </style>
</head>
<body data-view="catalog">
    ${stepikBrandHtml()}
    <div class="catalog-shell">
        <header class="catalog-header">
            <div>
                <h1>${t('catalog.title')}</h1>
                <p class="catalog-subtitle">${t('catalog.subtitle')}</p>
            </div>
            <button type="button" id="refresh" class="icon-button" title="${t('catalog.refreshTitle')}">${t('catalog.refresh')}</button>
        </header>

        <nav class="tabs" role="tablist" aria-label="${t('catalog.ariaSource')}">
            <button type="button" class="tab active" role="tab" aria-selected="true" data-mode="recommended">${t('catalog.tabRecommended')}</button>
            <button type="button" class="tab" role="tab" aria-selected="false" data-mode="all">${t('catalog.tabPopular')}</button>
            <button type="button" class="tab" role="tab" aria-selected="false" data-mode="my">${t('catalog.tabMy')}</button>
        </nav>

        <div class="toolbar">
            <label class="search-field">
                <input id="search" type="search" placeholder="${t('catalog.searchPlaceholder')}" aria-label="${t('catalog.searchAria')}">
            </label>
            <label class="checkbox">
                <input id="free-only" type="checkbox">
                <span>${t('catalog.freeOnly')}</span>
            </label>
        </div>

        <div id="status" class="status">${t('catalog.loading')}</div>
        <div id="grid" class="grid"></div>
        <div id="loading-more" class="loading-more" hidden>
            <span>${t('catalog.loadingMore')}</span>
        </div>
        <div id="scroll-sentinel" class="scroll-sentinel" aria-hidden="true"></div>
        <div class="footer">
            <span id="footer-note" class="footer-note"></span>
            <button type="button" id="load-more" class="load-more" hidden>${t('catalog.loadMore')}</button>
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
                mode: 'recommended',
                search: '',
                freeOnly: false,
                requestId: 0,
                searchTimer: 0,
                renderKey: '',
                renderFilter: '',
                renderVersion: -1,
                renderCount: 0
            };
            var cache = Object.create(null);
            var preloadedCovers = Object.create(null);
            var SCROLL_THRESHOLD = 700;

            var grid = document.getElementById('grid');
            var status = document.getElementById('status');
            var loadMore = document.getElementById('load-more');
            var loadingMore = document.getElementById('loading-more');
            var sentinel = document.getElementById('scroll-sentinel');
            var footerNote = document.getElementById('footer-note');
            var search = document.getElementById('search');
            var freeOnly = document.getElementById('free-only');
            var refresh = document.getElementById('refresh');
            var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));

            function normalizeQuery(query) {
                return String(query || '').trim().toLocaleLowerCase('ru-RU');
            }

            function cacheKey(mode, onlyFree, query) {
                return mode + ':' + (onlyFree ? '1' : '0') + ':' +
                    (mode === 'my' ? '' : normalizeQuery(query));
            }

            function currentKey() {
                return cacheKey(state.mode, state.freeOnly, state.search);
            }

            function getEntry(key) {
                if (!cache[key]) {
                    cache[key] = {
                        courses: [],
                        page: 0,
                        hasNext: true,
                        loaded: false,
                        loading: false,
                        error: '',
                        requestId: 0,
                        version: 0,
                        prefetch: null,
                        prefetching: false,
                        prefetchPage: 0,
                        prefetchRequestId: 0,
                        loadRequested: false
                    };
                }
                return cache[key];
            }

            function formatNumber(value) {
                try {
                    return Number(value || 0).toLocaleString(L.__locale || undefined);
                } catch (error) {
                    return String(value || 0);
                }
            }

            function formatDate(value) {
                if (!value) {
                    return '';
                }
                var date = new Date(value);
                if (Number.isNaN(date.getTime())) {
                    return '';
                }
                try {
                    return date.toLocaleDateString(L.__locale || undefined, { day: 'numeric', month: 'short', year: 'numeric' });
                } catch (error) {
                    return '';
                }
            }

            function languageName(code) {
                var names = {
                    ru: 'Русский',
                    en: 'English',
                    de: 'Deutsch',
                    fr: 'Français',
                    es: 'Español',
                    zh: '中文'
                };
                return names[code] || code || '';
            }

            function metaItem(text, className) {
                var span = document.createElement('span');
                span.className = 'meta-item' + (className ? ' ' + className : '');
                span.textContent = text;
                return span;
            }

            function createBadge(text, className) {
                var badge = document.createElement('span');
                badge.className = 'badge' + (className ? ' ' + className : '');
                badge.textContent = text;
                return badge;
            }

            function createCard(course) {
                var card = document.createElement('article');
                card.className = 'course-card';

                var media = document.createElement('div');
                media.className = 'course-media';
                var placeholder = document.createElement('div');
                placeholder.className = 'course-cover-placeholder';
                placeholder.textContent = '📚';
                placeholder.hidden = Boolean(course.cover);
                media.appendChild(placeholder);

                if (course.cover) {
                    var image = document.createElement('img');
                    image.src = course.cover;
                    image.alt = '';
                    image.loading = 'lazy';
                    image.referrerPolicy = 'no-referrer';
                    image.addEventListener('error', function () {
                        image.remove();
                        placeholder.hidden = false;
                    });
                    media.appendChild(image);
                }

                var badges = document.createElement('div');
                badges.className = 'course-badges';
                if (course.enrolled) {
                    badges.appendChild(createBadge(t('catalog.badgeEnrolled'), 'enrolled'));
                }
                if (course.isPaid) {
                    badges.appendChild(createBadge(t('catalog.badgePaid'), 'paid'));
                } else if (course.withCertificate) {
                    badges.appendChild(createBadge(t('catalog.badgeCertificate')));
                }
                if (badges.childNodes.length) {
                    media.appendChild(badges);
                }
                card.appendChild(media);

                var body = document.createElement('div');
                body.className = 'course-body';

                var title = document.createElement('h2');
                title.className = 'course-title';
                title.textContent = course.title;
                title.title = course.title;
                body.appendChild(title);

                if (course.summary) {
                    var summary = document.createElement('p');
                    summary.className = 'course-summary';
                    summary.textContent = course.summary;
                    body.appendChild(summary);
                }

                var meta = document.createElement('div');
                meta.className = 'course-meta';

                if (course.ratingAverage) {
                    var rating = document.createElement('span');
                    rating.className = 'meta-item';
                    var star = document.createElement('span');
                    star.className = 'rating-star';
                    star.textContent = '★';
                    rating.appendChild(star);
                    rating.appendChild(document.createTextNode(
                        Number(course.ratingAverage).toLocaleString(
                            L.__locale || undefined,
                            { maximumFractionDigits: 1 }
                        )
                    ));
                    if (course.ratingCount) {
                        var count = document.createElement('span');
                        count.className = 'rating-count';
                        count.textContent = '(' + formatNumber(course.ratingCount) + ')';
                        rating.appendChild(count);
                    }
                    rating.title = course.ratingCount
                        ? t('catalog.reviewsTitle', {
                              count: formatNumber(course.ratingCount),
                              word: plural('catalog.reviews', course.ratingCount)
                          })
                        : t('catalog.noRatings');
                    meta.appendChild(rating);
                }

                if (course.learnersCount) {
                    meta.appendChild(metaItem(
                        formatNumber(course.learnersCount) + ' ' +
                        plural('catalog.learners', course.learnersCount)
                    ));
                }

                if (course.workload) {
                    meta.appendChild(metaItem(course.workload));
                }

                if (course.language) {
                    meta.appendChild(metaItem(languageName(course.language)));
                }

                if (course.ratingAverage || course.learnersCount || course.workload || course.language) {
                    body.appendChild(meta);
                }

                var details = document.createElement('div');
                details.className = 'course-meta';
                var price = document.createElement('span');
                price.className = 'price' + (course.isPaid ? ' paid' : '');
                price.textContent = course.isPaid ? course.price : t('catalog.free');
                details.appendChild(price);
                var created = formatDate(course.createDate);
                if (created) {
                    details.appendChild(metaItem(t('catalog.since', { date: created })));
                }
                body.appendChild(details);

                var actions = document.createElement('div');
                actions.className = 'course-actions';
                var requiresPurchase = course.isPaid && !course.enrolled;
                var needsEnrollment = !course.isPaid && !course.enrolled;
                var select = document.createElement('button');
                select.type = 'button';
                select.className = 'primary-button';
                select.setAttribute('data-course-id', String(course.id));

                if (requiresPurchase) {
                    select.textContent = t('catalog.buy');
                    select.title = t('catalog.buyTitle');
                    select.addEventListener('click', function () {
                        vscode.postMessage({ command: 'openExternal', url: course.url });
                    });
                    actions.appendChild(select);
                } else {
                    var idleLabel = needsEnrollment ? t('catalog.enroll') : t('catalog.select');
                    select.textContent = idleLabel;
                    if (needsEnrollment) {
                        select.title = t('catalog.enrollHint');
                    }
                    select.addEventListener('click', function () {
                        select.disabled = true;
                        select.textContent = needsEnrollment
                            ? t('catalog.enrolling')
                            : t('catalog.selecting');
                        vscode.postMessage({
                            command: needsEnrollment ? 'enrollCourse' : 'selectCourse',
                            courseId: course.id
                        });
                        // Enrollment waits for a real POST, so keep the button
                        // disabled for the whole API timeout even if the host
                        // has not replied yet. Otherwise a second click could
                        // send a duplicate enrollment.
                        window.setTimeout(function () {
                            if (!select.isConnected) {
                                return;
                            }
                            select.disabled = false;
                            select.textContent = idleLabel;
                        }, needsEnrollment ? 35000 : 10000);
                    });
                    actions.appendChild(select);

                    var external = document.createElement('button');
                    external.type = 'button';
                    external.className = 'secondary-button';
                    external.textContent = t('catalog.openStepik');
                    external.title = t('catalog.openStepikTitle');
                    external.addEventListener('click', function () {
                        vscode.postMessage({ command: 'openExternal', url: course.url });
                    });
                    actions.appendChild(external);
                }
                body.appendChild(actions);

                if (requiresPurchase) {
                    var purchaseHint = document.createElement('p');
                    purchaseHint.className = 'purchase-hint';
                    purchaseHint.textContent = t('catalog.purchaseHint');
                    body.appendChild(purchaseHint);
                } else if (needsEnrollment) {
                    var enrollHint = document.createElement('p');
                    enrollHint.className = 'purchase-hint';
                    enrollHint.textContent = t('catalog.enrollHint');
                    body.appendChild(enrollHint);
                }

                card.appendChild(body);
                return card;
            }

            function visibleCourses(entry) {
                var query = normalizeQuery(state.search);
                var list = entry.courses.slice();
                if (state.freeOnly) {
                    list = list.filter(function (course) {
                        return !course.isPaid;
                    });
                }
                // Public modes search on the server, because a course may
                // match by author or content rather than title/summary. Only
                // the personal list is filtered locally.
                if (state.mode === 'my' && query) {
                    list = list.filter(function (course) {
                        var haystack = (course.title + ' ' + (course.summary || ''))
                            .toLocaleLowerCase('ru-RU');
                        return haystack.indexOf(query) !== -1;
                    });
                }
                return list;
            }

            function render() {
                var key = currentKey();
                var entry = getEntry(key);
                var filter = key + '|' + normalizeQuery(state.search);
                var list = visibleCourses(entry);

                // A page append only adds cards. Tabs, filters, a refreshed
                // first page, or a shorter locally filtered list rebuild the
                // grid so stale cards never stay behind.
                var rebuild = key !== state.renderKey ||
                    filter !== state.renderFilter ||
                    entry.version !== state.renderVersion ||
                    list.length < state.renderCount;

                if (rebuild) {
                    while (grid.firstChild) {
                        grid.removeChild(grid.firstChild);
                    }
                    state.renderKey = key;
                    state.renderFilter = filter;
                    state.renderVersion = entry.version;
                    state.renderCount = 0;
                }

                if (entry.loading && entry.courses.length === 0) {
                    status.className = 'status loading';
                    status.textContent = t('catalog.loading');
                } else if (entry.error) {
                    status.className = 'status error';
                    status.textContent = entry.error;
                } else if (!entry.loaded) {
                    status.className = 'status loading';
                    status.textContent = t('catalog.loading');
                } else if (list.length === 0) {
                    status.className = 'status';
                    status.textContent = t('catalog.nothingFound');
                } else {
                    status.className = 'status';
                    var suffix = state.search.trim()
                        ? t('catalog.foundQuery', { query: state.search.trim() })
                        : '';
                    status.textContent = t('catalog.found', {
                        count: list.length,
                        word: plural('catalog.courseWord', list.length)
                    }) + suffix;
                }

                if (list.length === 0) {
                    while (grid.firstChild) {
                        grid.removeChild(grid.firstChild);
                    }
                    state.renderCount = 0;

                    var empty = document.createElement('div');
                    empty.className = 'empty-state';
                    var heading = document.createElement('strong');
                    var hint = document.createElement('span');
                    if (entry.error) {
                        heading.textContent = t('catalog.emptyErrorTitle');
                        hint.textContent = t('catalog.emptyErrorHint');
                    } else if (entry.loaded) {
                        heading.textContent = state.search.trim()
                            ? t('catalog.emptySearchTitle')
                            : t('catalog.emptyTitle');
                        hint.textContent = state.freeOnly
                            ? t('catalog.emptyFilterHint')
                            : t('catalog.emptyHint');
                    } else {
                        heading.textContent = t('catalog.loadingTitle');
                        hint.textContent = t('catalog.loadingHint');
                    }
                    empty.appendChild(heading);
                    empty.appendChild(hint);
                    grid.appendChild(empty);
                } else {
                    for (var index = state.renderCount; index < list.length; index++) {
                        grid.appendChild(createCard(list[index]));
                    }
                    state.renderCount = list.length;
                }

                var awaitingPrefetch = entry.prefetching && entry.loadRequested;
                var busy = entry.loading || awaitingPrefetch;
                var showLoadingMore = busy && entry.courses.length > 0 && !entry.error;
                loadingMore.hidden = !showLoadingMore;
                if (showLoadingMore) {
                    loadingMore.firstElementChild.textContent = t('catalog.loadingMore');
                }

                footerNote.textContent = entry.courses.length && !entry.error
                    ? t('catalog.footerLoaded', { count: entry.courses.length }) +
                        (busy ? t('catalog.footerLoading') : '')
                    : '';

                if (entry.error) {
                    loadMore.hidden = false;
                    loadMore.textContent = t('catalog.retry');
                    loadMore.disabled = false;
                } else if (entry.loaded && entry.hasNext) {
                    loadMore.hidden = false;
                    loadMore.textContent = busy
                        ? t('catalog.footerLoadingButton')
                        : t('catalog.loadMore');
                    loadMore.disabled = busy;
                } else {
                    loadMore.hidden = true;
                    loadMore.disabled = false;
                }
            }

            function isNearBottom() {
                if (!sentinel) {
                    return false;
                }
                var viewport = window.innerHeight || document.documentElement.clientHeight || 0;
                return sentinel.getBoundingClientRect().top <= viewport + SCROLL_THRESHOLD;
            }

            function preloadCovers(courses) {
                for (var index = 0; index < courses.length; index++) {
                    var url = courses[index] && courses[index].cover;
                    if (!url || preloadedCovers[url]) {
                        continue;
                    }
                    preloadedCovers[url] = true;
                    var image = new Image();
                    image.src = url;
                }
            }

            function appendPage(entry, page, incoming, hasNext) {
                var pageNumber = Number(page) || 1;
                if (pageNumber === 1) {
                    entry.courses = incoming.slice();
                    entry.version += 1;
                } else {
                    var known = Object.create(null);
                    entry.courses.forEach(function (course) {
                        known[course.id] = true;
                    });
                    incoming.forEach(function (course) {
                        if (!known[course.id]) {
                            known[course.id] = true;
                            entry.courses.push(course);
                        }
                    });
                }
                entry.page = pageNumber;
                entry.hasNext = Boolean(hasNext);
                entry.loaded = true;
            }

            function requestPage(page) {
                var entry = getEntry(currentKey());
                if (entry.loading) {
                    return;
                }
                entry.loading = true;
                entry.loadRequested = false;
                entry.error = '';
                state.requestId += 1;
                entry.requestId = state.requestId;
                render();
                vscode.postMessage({
                    command: 'load',
                    mode: state.mode,
                    page: page,
                    freeOnly: state.freeOnly,
                    search: state.search.trim(),
                    requestId: state.requestId
                });
            }

            // Keep one page (20 courses) ready in the background. This is
            // what makes the next batch appear instantly when the user
            // reaches the bottom while scrolling at a normal pace.
            function requestPrefetch() {
                var entry = getEntry(currentKey());
                if (!entry.loaded || entry.loading || entry.error ||
                    !entry.hasNext || entry.prefetching) {
                    return;
                }
                var nextPage = entry.page + 1;
                if (nextPage < 2) {
                    return;
                }
                if (entry.prefetch && entry.prefetch.page >= nextPage) {
                    return;
                }
                entry.prefetching = true;
                entry.prefetchPage = nextPage;
                state.requestId += 1;
                entry.prefetchRequestId = state.requestId;
                vscode.postMessage({
                    command: 'load',
                    mode: state.mode,
                    page: nextPage,
                    freeOnly: state.freeOnly,
                    search: state.search.trim(),
                    requestId: state.requestId,
                    prefetch: true
                });
            }

            function maybeLoadMore() {
                var entry = getEntry(currentKey());
                if (!entry.loaded || entry.loading || entry.error || !entry.hasNext) {
                    return;
                }

                var nextPage = entry.page + 1;
                if (entry.prefetch && entry.prefetch.page === nextPage) {
                    var cached = entry.prefetch;
                    entry.prefetch = null;
                    appendPage(entry, cached.page, cached.courses, cached.hasNext);
                    render();
                    if (isNearBottom()) {
                        maybeLoadMore();
                    } else {
                        requestPrefetch();
                    }
                    return;
                }

                if (entry.prefetching && entry.prefetchPage === nextPage) {
                    // The background request is already on its way. Consume
                    // it as soon as it arrives, even if the user scrolled
                    // away in the meantime.
                    entry.loadRequested = true;
                    render();
                    return;
                }

                requestPage(nextPage);
            }

            function continueLoading() {
                if (isNearBottom()) {
                    maybeLoadMore();
                } else {
                    requestPrefetch();
                }
            }

            function ensureLoaded() {
                var entry = getEntry(currentKey());
                if (!entry.loaded && !entry.loading) {
                    requestPage(1);
                } else {
                    render();
                    continueLoading();
                }
            }

            tabs.forEach(function (tab) {
                tab.addEventListener('click', function () {
                    var mode = tab.getAttribute('data-mode');
                    if (!mode || mode === state.mode) {
                        return;
                    }
                    state.mode = mode;
                    state.search = search.value;
                    tabs.forEach(function (other) {
                        var active = other === tab;
                        other.classList.toggle('active', active);
                        other.setAttribute('aria-selected', active ? 'true' : 'false');
                    });
                    ensureLoaded();
                });
            });

            search.addEventListener('input', function () {
                state.search = search.value;
                if (state.mode === 'my') {
                    render();
                    return;
                }
                if (state.searchTimer) {
                    window.clearTimeout(state.searchTimer);
                }
                var pendingQuery = state.search;
                state.searchTimer = window.setTimeout(function () {
                    state.searchTimer = 0;
                    if (state.search !== pendingQuery) {
                        return;
                    }
                    ensureLoaded();
                }, 320);
            });

            freeOnly.addEventListener('change', function () {
                state.freeOnly = freeOnly.checked;
                ensureLoaded();
            });

            refresh.addEventListener('click', function () {
                cache = Object.create(null);
                state.renderKey = '';
                state.renderFilter = '';
                state.renderVersion = -1;
                state.renderCount = 0;
                if (state.searchTimer) {
                    window.clearTimeout(state.searchTimer);
                    state.searchTimer = 0;
                }
                vscode.postMessage({ command: 'resetCaches' });
                requestPage(1);
            });

            loadMore.addEventListener('click', function () {
                var entry = getEntry(currentKey());
                if (entry.error) {
                    if (entry.courses.length === 0) {
                        requestPage(1);
                    } else {
                        requestPage(entry.page + 1);
                    }
                    return;
                }
                maybeLoadMore();
            });

            window.addEventListener('message', function (event) {
                var message = event.data || {};
                if (message.command === 'selectFailed' || message.command === 'enrollFailed') {
                    var failed = document.querySelectorAll(
                        '.primary-button[data-course-id="' + Number(message.courseId) + '"]'
                    );
                    var failedLabel = message.command === 'enrollFailed'
                        ? t('catalog.enroll')
                        : t('catalog.select');
                    Array.prototype.forEach.call(failed, function (button) {
                        button.disabled = false;
                        button.textContent = failedLabel;
                    });
                    return;
                }
                if (message.command !== 'courses' && message.command !== 'error') {
                    return;
                }

                var key = cacheKey(message.mode, Boolean(message.freeOnly), message.search);
                var entry = getEntry(key);

                if (message.prefetch) {
                    if (Number(message.requestId) !== entry.prefetchRequestId) {
                        return;
                    }
                    entry.prefetching = false;

                    if (message.command === 'courses') {
                        var prefetchedPage = Number(message.page) || 0;
                        if (prefetchedPage > entry.page) {
                            entry.prefetch = {
                                page: prefetchedPage,
                                courses: Array.isArray(message.courses) ? message.courses : [],
                                hasNext: Boolean(message.hasNext)
                            };
                            preloadCovers(entry.prefetch.courses);
                        }
                    }

                    if (key === currentKey() && (entry.loadRequested || isNearBottom())) {
                        entry.loadRequested = false;
                        maybeLoadMore();
                    }
                    return;
                }

                if (Number(message.requestId) !== entry.requestId) {
                    return;
                }
                entry.loading = false;

                if (message.command === 'error') {
                    entry.error = message.message || t('catalog.loadErrorFallback');
                    if (message.page === 1) {
                        entry.loaded = true;
                        entry.version += 1;
                    }
                } else {
                    entry.error = '';
                    var incoming = Array.isArray(message.courses) ? message.courses : [];
                    appendPage(
                        entry,
                        Number(message.page) || 1,
                        incoming,
                        Boolean(message.hasNext)
                    );
                }

                if (key === currentKey()) {
                    render();
                    if (message.command === 'courses') {
                        continueLoading();
                    }
                }
            });

            function setupInfiniteScroll() {
                if ('IntersectionObserver' in window) {
                    var observer = new IntersectionObserver(function (entries) {
                        for (var index = 0; index < entries.length; index++) {
                            if (entries[index].isIntersecting) {
                                maybeLoadMore();
                                break;
                            }
                        }
                    }, { rootMargin: SCROLL_THRESHOLD + 'px 0px' });
                    observer.observe(sentinel);
                    return;
                }

                // Very old webview engines: fall back to a cheap scroll check.
                window.addEventListener('scroll', function () {
                    if (isNearBottom()) {
                        maybeLoadMore();
                    }
                }, { passive: true });
                window.addEventListener('resize', function () {
                    if (isNearBottom()) {
                        maybeLoadMore();
                    }
                });
            }

            setupInfiniteScroll();
            ensureLoaded();
        })();
    </script>
</body>
</html>`;
    }
}
