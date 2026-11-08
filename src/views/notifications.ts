import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
    Course,
    NotificationStatus,
    StepikApi,
    StepikNotification
} from '../api/stepikApi';
import { getLanguage, localeFor, pluralize, t, webviewStrings } from '../i18n';
import { stepikBrandHtml, stepikThemeCss } from './theme';

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 60_000;

type NotificationFlag = 'unread' | 'read' | 'all' | 'favorites';

interface NotificationsMessage {
    command?: string;
    requestId?: number;
    page?: number;
    flag?: string;
    type?: string;
    course?: string | number;
    order?: string;
    id?: number;
    isUnread?: boolean;
    isFavorite?: boolean;
    url?: string;
}

interface NotificationCoursePayload {
    id: number;
    title: string;
    cover?: string;
    url: string;
}

interface NotificationPayload {
    id: number;
    isUnread: boolean;
    isFavorite: boolean;
    time: string;
    type: string;
    action: string;
    actorName?: string;
    actorUrl?: string;
    actionText: string;
    contextText?: string;
    commentPreview?: string;
    discussionPreview?: string;
    submissionText?: string;
    htmlText?: string;
    actionUrl?: string;
    asideLesson?: string;
    asideStep?: string;
    icon: 'comment' | 'reply' | 'solution' | 'like' | 'like-lesson' | 'bell';
    courses: NotificationCoursePayload[];
}

interface NotificationWatchState {
    ids: number[];
    total: number;
    initialized: boolean;
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

/** Notification bodies arrive as HTML; the webview only renders plain text. */
function stripHtml(value: unknown): string {
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
        .replace(/&#x2f;/gi, '/')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function submissionStatusLabel(status: string | undefined): string {
    switch ((status || '').toLowerCase()) {
        case 'correct':
            return t('notifications.submissionStatus.correct');
        case 'wrong':
            return t('notifications.submissionStatus.wrong');
        case 'evaluation':
        case 'pending':
            return t('notifications.submissionStatus.pending');
        default:
            return status || '';
    }
}

function formatDateTime(value: string | undefined): string {
    if (!value) {
        return '';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    try {
        return date.toLocaleString(localeFor(), {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch {
        return '';
    }
}

function truncate(text: string, limit: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= limit) {
        return normalized;
    }
    return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Notification list and the background watcher behind the status bar bell.
 *
 * Stepik's own page has four filters (status, category, course, order), two
 * per-card actions (read/unread and favorite), "mark all as read" and an
 * action that opens the commented step. The panel reproduces those parts of
 * the website while staying inside the editor.
 */
export class StepikNotificationsView implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private readonly statusBar: vscode.StatusBarItem;
    private pollTimer: NodeJS.Timeout | undefined;
    private polling = false;
    private started = false;
    private seenUnread = new Set<number>();
    private watchUserId: number | undefined;
    private watchInitialized = false;
    private watchTotal: number | null = null;
    private awayQueue: StepikNotification[] = [];
    private windowFocused = vscode.window.state.focused;
    private readonly focusListener: vscode.Disposable;
    private lastStatus: NotificationStatus | null = null;
    private courseOptionsPromise: Promise<Course[]> | undefined;
    private readonly courseMap = new Map<number, Course>();
    private readonly log: (message: string) => void;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly api: StepikApi,
        outputChannel: vscode.OutputChannel
    ) {
        this.log = message => outputChannel.appendLine(`[Notifications] ${message}`);
        this.statusBar = vscode.window.createStatusBarItem(
            'stepikNotifications',
            vscode.StatusBarAlignment.Right,
            90
        );
        this.statusBar.name = t('notifications.statusBarName');
        this.statusBar.command = 'stepik.showNotifications';
        this.statusBar.text = '$(bell)';
        this.statusBar.tooltip = t('notifications.statusBarTooltip');
        this.statusBar.hide();
        this.focusListener = vscode.window.onDidChangeWindowState(state => {
            const wasFocused = this.windowFocused;
            this.windowFocused = state.focused;
            if (state.focused && !wasFocused) {
                void this.flushAwayQueue();
            }
        });
    }

    /** Start polling after login or when the extension activates. */
    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        this.statusBar.show();
        void this.refreshStatus('startup');
        this.pollTimer = setInterval(() => {
            void this.refreshStatus('poll');
        }, POLL_INTERVAL_MS);
    }

    /** Stop polling without touching the panel or cached courses. */
    stop(): void {
        this.started = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        this.statusBar.hide();
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'stepikNotifications',
            t('notifications.panelTitle'),
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        panel.iconPath = vscode.Uri.joinPath(
            this.context.extensionUri,
            'resources',
            'stepik-badge.svg'
        );

        const listener = panel.webview.onDidReceiveMessage(message =>
            this.handleMessage(message as NotificationsMessage)
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

    /** Open the panel on the unread tab, used by notification toasts. */
    showUnread(): void {
        const wasOpen = Boolean(this.panel);
        this.show();
        if (wasOpen) {
            this.post({ command: 'showUnread' });
        }
    }

    /** Re-render the panel after the interface language changed. */
    refreshLocalization(): void {
        this.statusBar.name = t('notifications.statusBarName');
        this.statusBar.tooltip = t('notifications.statusBarTooltip');
        if (!this.panel) {
            return;
        }
        this.panel.title = t('notifications.panelTitle');
        this.panel.webview.html = this.getHtml(this.panel.webview);
    }

    /** Dispose the panel and forget everything tied to the previous account. */
    resetForLogout(): void {
        this.stop();
        this.panel?.dispose();
        this.panel = undefined;
        this.seenUnread.clear();
        this.watchUserId = undefined;
        this.watchInitialized = false;
        this.watchTotal = null;
        this.awayQueue = [];
        this.lastStatus = null;
        this.courseOptionsPromise = undefined;
        this.courseMap.clear();
    }

    dispose(): void {
        this.resetForLogout();
        this.focusListener.dispose();
        this.statusBar.dispose();
    }

    private watchStateKey(userId: number): string {
        return `stepik.notifications.watch.${userId}`;
    }

    private loadWatchState(userId: number): void {
        if (this.watchUserId !== userId) {
            this.watchUserId = userId;
            this.seenUnread.clear();
            this.watchInitialized = false;
            this.watchTotal = null;
        }

        // Merge instead of replace: another VS Code window may have advanced
        // the shared state while this window was open.
        const saved = this.context.globalState.get<NotificationWatchState>(
            this.watchStateKey(userId)
        );
        if (!saved || !Array.isArray(saved.ids)) {
            return;
        }
        for (const id of saved.ids) {
            if (Number.isInteger(id) && id > 0) {
                this.seenUnread.add(id);
            }
        }
        this.watchInitialized = this.watchInitialized || saved.initialized !== false;
        if (Number.isFinite(saved.total)) {
            this.watchTotal = saved.total;
        }
    }

    private saveWatchState(): void {
        if (this.watchUserId === undefined) {
            return;
        }
        this.watchInitialized = true;
        this.watchTotal = Math.max(0, Number(this.lastStatus?.total) || 0);
        const state: NotificationWatchState = {
            ids: Array.from(this.seenUnread).slice(-500),
            total: this.watchTotal,
            initialized: true
        };
        void this.context.globalState.update(this.watchStateKey(this.watchUserId), state);
    }

    private async refreshStatus(source: 'startup' | 'poll' | 'manual'): Promise<void> {
        if (this.polling) {
            return;
        }
        this.polling = true;
        try {
            const user = await this.api.getCurrentUser();
            if (!user) {
                return;
            }
            this.loadWatchState(user.id);
            const status = await this.api.getNotificationStatus(user.id);
            this.lastStatus = status;
            this.updateStatusBar(status);
            this.post({ command: 'status', status });

            const previousTotal = this.watchTotal;
            const fresh: StepikNotification[] = [];
            let pageNumber = 1;
            let pagesRead = 0;
            let hasNext = true;
            while (hasNext && pagesRead < 10) {
                const page = await this.api.getNotifications({
                    page: pageNumber,
                    pageSize: PAGE_SIZE,
                    isUnread: true,
                    order: '-time,-id'
                });
                let containsSeen = false;
                for (const notification of page.notifications) {
                    if (this.seenUnread.has(notification.id)) {
                        containsSeen = true;
                        continue;
                    }
                    fresh.push(notification);
                    this.seenUnread.add(notification.id);
                }
                hasNext = page.hasNext;
                pageNumber += 1;
                pagesRead += 1;
                // The list is newest-first, so once a page reaches an item we
                // have already seen, everything after it is old as well.
                if (containsSeen && this.watchInitialized) {
                    break;
                }
            }

            if (!this.watchInitialized) {
                // First launch for this account: remember what is already
                // unread instead of replaying the whole list as new.
                this.saveWatchState();
                return;
            }

            this.saveWatchState();
            if (fresh.length === 0) {
                return;
            }

            this.post({ command: 'notificationsChanged', count: fresh.length });
            if (source === 'manual') {
                // The user is looking at the list and just refreshed it.
                return;
            }

            const total = Math.max(0, Number(status?.total) || 0);
            const added = previousTotal === null
                ? fresh.length
                : Math.max(fresh.length, Math.max(0, total - previousTotal));

            if (this.windowFocused) {
                void this.announceNotifications(fresh, added);
            } else {
                this.queueAwayNotifications(fresh);
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('notifications.watchLogError', { detail }));
        } finally {
            this.polling = false;
        }
    }

    private notificationMessage(notification: StepikNotification): string {
        const payload = this.mapNotification(notification);
        const title = payload.actorName
            ? `${payload.actorName} ${payload.actionText}`
            : payload.actionText;
        const lines = [`Stepik: ${title}`];
        if (payload.contextText) {
            lines.push(payload.contextText);
        }
        const preview =
            payload.commentPreview || payload.discussionPreview || payload.htmlText;
        if (preview) {
            lines.push(truncate(preview, 180));
        } else if (payload.submissionText) {
            lines.push(payload.submissionText);
        }
        return lines.join('\n');
    }

    private async announceNotifications(
        items: StepikNotification[],
        count: number
    ): Promise<void> {
        if (items.length === 0 || count <= 0) {
            return;
        }
        let message: string;
        if (count === 1) {
            message = this.notificationMessage(items[0]);
        } else {
            message = t('notifications.summary', {
                count,
                word: pluralize(count, 'notifications.notificationWord')
            });
        }
        const viewButton = t('notifications.viewButton');
        const action = await vscode.window.showInformationMessage(message, viewButton);
        if (action === viewButton) {
            this.showUnread();
        }
    }

    private queueAwayNotifications(items: StepikNotification[]): void {
        for (const item of items) {
            if (!this.awayQueue.some(queued => queued.id === item.id)) {
                this.awayQueue.push(item);
            }
        }
    }

    private async flushAwayQueue(): Promise<void> {
        if (!this.started || this.awayQueue.length === 0) {
            return;
        }
        const pending = this.awayQueue;
        this.awayQueue = [];
        await this.announceNotifications(pending, pending.length);
    }

    private updateStatusBar(status: NotificationStatus | null): void {
        if (!this.started) {
            return;
        }
        const total = Math.max(0, Number(status?.total) || 0);
        this.statusBar.text = total > 0 ? `$(bell) ${total}` : '$(bell)';
        this.statusBar.tooltip =
            total > 0
                ? t('notifications.statusBarUnread', {
                      count: total,
                      word: pluralize(total, 'notifications.notificationWord')
                  })
                : t('notifications.statusBarTooltip');
        this.statusBar.color = total > 0
            ? new vscode.ThemeColor('notificationsErrorIcon.foreground')
            : undefined;
    }

    private getCourseOptions(): Promise<Course[]> {
        if (!this.courseOptionsPromise) {
            const promise = this.api.getUserCourses();
            this.courseOptionsPromise = promise;
            void promise.then(
                courses => {
                    for (const course of courses) {
                        this.courseMap.set(course.id, course);
                    }
                },
                () => {
                    if (this.courseOptionsPromise === promise) {
                        this.courseOptionsPromise = undefined;
                    }
                }
            );
        }
        return this.courseOptionsPromise;
    }

    private coursePayload(course: Course): NotificationCoursePayload {
        return {
            id: course.id,
            title: course.title,
            cover: normalizeImageUrl(course.cover),
            url: `https://stepik.org/course/${course.id}`
        };
    }

    private courseOptionsPayload(): NotificationCoursePayload[] {
        return Array.from(this.courseMap.values())
            .map(course => this.coursePayload(course))
            .sort((left, right) => left.title.localeCompare(right.title, 'ru'));
    }

    private async initPanel(): Promise<void> {
        try {
            const user = await this.api.getCurrentUser();
            const [status, courses] = await Promise.all([
                this.api.getNotificationStatus(user.id).catch(() => null),
                this.getCourseOptions().catch(() => [] as Course[])
            ]);
            this.lastStatus = status;
            this.updateStatusBar(status);
            this.post({
                command: 'init',
                status,
                courses: this.courseOptionsPayload(),
                userId: user.id,
                profileUrl: `https://stepik.org/users/${user.id}/profile`,
                settingsUrl: 'https://stepik.org/edit-profile/notifications'
            });
            if (courses.length === 0) {
                this.log(t('notifications.coursesEmpty'));
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('notifications.initLogError', { detail }));
            this.post({
                command: 'error',
                message: /not authenticated|login first|session has expired|Сессия Stepik истекла/i.test(detail)
                    ? t('notifications.loginRequired')
                    : detail
            });
        }
    }

    private normalizeFlag(value: string | undefined): NotificationFlag {
        return value === 'read' || value === 'all' || value === 'favorites'
            ? value
            : 'unread';
    }

    private normalizeType(value: string | undefined): string {
        return value === 'learn' ||
            value === 'review' ||
            value === 'comments' ||
            value === 'teach' ||
            value === 'default'
            ? value
            : 'all';
    }

    private normalizeOrder(value: string | undefined): string {
        return value === 'time,id' ? 'time,id' : '-time,-id';
    }

    private parseCourse(value: string | number | undefined): number | undefined {
        const id = Number(value);
        return Number.isInteger(id) && id > 0 ? id : undefined;
    }

    private async resolveCourses(notifications: StepikNotification[]): Promise<void> {
        const ids = new Set<number>();
        for (const notification of notifications) {
            for (const course of notification.courses || []) {
                if (typeof course === 'number') {
                    ids.add(course);
                } else if (course && typeof course === 'object' && course.id) {
                    ids.add(course.id);
                }
            }
            for (const course of notification.context?.target?.courses || []) {
                if (course.course_id) {
                    ids.add(course.course_id);
                }
            }
        }
        const missing = Array.from(ids).filter(id => !this.courseMap.has(id));
        if (missing.length === 0) {
            return;
        }
        try {
            const courses = await this.api.getCoursesByIds(missing);
            for (const course of courses) {
                this.courseMap.set(course.id, course);
            }
        } catch (error) {
            this.log(
                t('notifications.loadCoursesLogError', {
                    detail: error instanceof Error ? error.message : String(error)
                })
            );
        }
    }

    private notificationCourses(notification: StepikNotification): NotificationCoursePayload[] {
        const result = new Map<number, NotificationCoursePayload>();
        const add = (id: number | undefined) => {
            if (!id || result.has(id)) {
                return;
            }
            const course = this.courseMap.get(id);
            if (course) {
                result.set(id, this.coursePayload(course));
            }
        };

        for (const course of notification.courses || []) {
            if (typeof course === 'number') {
                add(course);
            } else if (course && typeof course === 'object' && course.id) {
                if (!result.has(course.id)) {
                    const known = this.courseMap.get(course.id);
                    result.set(course.id, {
                        id: course.id,
                        title: known?.title || course.title || t('notifications.coursePrefix', { id: course.id }),
                        cover: normalizeImageUrl(known?.cover || course.cover),
                        url: `https://stepik.org/course/${course.id}`
                    });
                }
            }
        }
        for (const course of notification.context?.target?.courses || []) {
            if (!course.course_id || result.has(course.course_id)) {
                continue;
            }
            const known = this.courseMap.get(course.course_id);
            result.set(course.course_id, {
                id: course.course_id,
                title: known?.title || course.course_title || t('notifications.coursePrefix', { id: course.course_id }),
                cover: normalizeImageUrl(known?.cover || course.course_cover),
                url: normalizeStepikUrl(course.course_url) || `https://stepik.org/course/${course.course_id}`
            });
        }
        return Array.from(result.values());
    }

    private mapNotification(notification: StepikNotification): NotificationPayload {
        const context = notification.context || {};
        const data = context.data || {};
        const target = context.target || {};
        const solutions = Boolean(data.submission_id || data.comment_is_solutions_thread);
        const targetCourse = (target.courses || [])[0];
        const courses = this.notificationCourses(notification);
        const course = courses[0];

        const actorName = (data.actor_name || '').trim() || undefined;
        const actorUrl = normalizeStepikUrl(data.actor_url);
        const actionUrl =
            normalizeStepikUrl(context.action_url) ||
            normalizeStepikUrl(target.step_url) ||
            normalizeStepikUrl(target.lesson_url) ||
            normalizeStepikUrl(targetCourse?.course_url) ||
            course?.url;

        let actionText = '';
        let icon: NotificationPayload['icon'] = 'bell';
        if (notification.type === 'comments' && notification.action === 'commented') {
            actionText = solutions
                ? t('notifications.action.postedSolution')
                : t('notifications.action.leftComment');
            icon = solutions ? 'solution' : 'comment';
        } else if (notification.type === 'comments' && notification.action === 'replied') {
            actionText = solutions
                ? t('notifications.action.commentedSolution')
                : t('notifications.action.replied');
            icon = 'reply';
        } else if (notification.action === 'voted') {
            const voteTarget = data.vote_target_type;
            if (voteTarget === 'lesson') {
                actionText = t('notifications.action.likedLesson');
                icon = 'like-lesson';
            } else if (solutions && data.submission_id) {
                actionText = t('notifications.action.likedSolution');
                icon = 'like';
            } else if (solutions) {
                actionText = t('notifications.action.likedSolutionComment');
                icon = 'like';
            } else {
                actionText = t('notifications.action.likedComment');
                icon = 'like';
            }
        } else {
            const labels: Record<string, string> = {
                issued_certificate: t('notifications.action.certificate'),
                opened: t('notifications.action.newModule'),
                soft_deadline_approach: t('notifications.action.softDeadline'),
                hard_deadline_approach: t('notifications.action.hardDeadline'),
                review_taken: t('notifications.action.reviewReceived'),
                course_review_taken: t('notifications.action.courseReviewed'),
                course_review_replied: t('notifications.action.reviewReplied'),
                instructor_review_pending: t('notifications.action.reviewPending'),
                enrollment_opened: t('notifications.action.enrollmentOpened'),
                price_dropped: t('notifications.action.priceDropped')
            };
            actionText = labels[notification.action] || t('notifications.action.newNotification');
        }

        const courseTitle = course?.title || targetCourse?.course_title;
        const lessonTitle = target.lesson_title;
        const stepPosition = target.step_position;
        const sectionPosition = targetCourse?.section_position;
        const unitPosition = targetCourse?.unit_position;
        let contextText = '';
        if (lessonTitle && stepPosition) {
            contextText = t('notifications.contextLessonStep', {
                lesson: lessonTitle,
                position: stepPosition
            });
        } else if (lessonTitle) {
            contextText = t('notifications.contextLesson', { lesson: lessonTitle });
        } else if (courseTitle) {
            contextText = t('notifications.contextCourse', { course: courseTitle });
        }

        const asideLesson = lessonTitle
            ? sectionPosition && unitPosition
                ? `${sectionPosition}.${unitPosition} ${lessonTitle}`
                : lessonTitle
            : undefined;
        const asideStep = stepPosition
            ? t('notifications.step', { position: stepPosition })
            : undefined;

        const commentPreview = stripHtml(data.comment_preview_text) || undefined;
        const discussionPreview = stripHtml(data.discussion_preview_text) || undefined;
        let submissionText: string | undefined;
        if (data.submission_id) {
            const status = submissionStatusLabel(data.submission_status);
            const when = formatDateTime(data.submission_time);
            submissionText =
                t('notifications.solutionPrefix', { id: data.submission_id }) +
                (status ? `, ${status}` : '') +
                (when ? ` · ${when}` : '');
        }

        let htmlText: string | undefined;
        if (!commentPreview && !discussionPreview && !submissionText && notification.html_text) {
            htmlText = stripHtml(notification.html_text) || undefined;
        }

        return {
            id: notification.id,
            isUnread: notification.is_unread,
            isFavorite: notification.is_favorite,
            time: notification.time,
            type: notification.type,
            action: notification.action,
            actorName,
            actorUrl,
            actionText,
            contextText: contextText || undefined,
            commentPreview,
            discussionPreview,
            submissionText,
            htmlText,
            actionUrl,
            asideLesson,
            asideStep,
            icon,
            courses
        };
    }

    private async loadNotifications(message: NotificationsMessage): Promise<void> {
        const page = Math.max(1, Math.floor(Number(message.page) || 1));
        const flag = this.normalizeFlag(message.flag);
        const type = this.normalizeType(message.type);
        const order = this.normalizeOrder(message.order);
        const course = this.parseCourse(message.course);
        const requestId = Number(message.requestId) || 0;

        try {
            const result = await this.api.getNotifications({
                page,
                pageSize: PAGE_SIZE,
                isUnread: flag === 'unread' ? true : flag === 'read' ? false : undefined,
                isFavorite: flag === 'favorites' ? true : undefined,
                type,
                course,
                order
            });
            await this.resolveCourses(result.notifications);
            const status = await this.api
                .getNotificationStatus()
                .catch(() => this.lastStatus);
            if (status) {
                this.lastStatus = status;
                this.updateStatusBar(status);
            }

            this.post({
                command: 'notifications',
                requestId,
                page: result.page,
                flag,
                type,
                course: course || 'all',
                order,
                hasNext: result.hasNext,
                status,
                courses: this.courseOptionsPayload(),
                items: result.notifications.map(notification =>
                    this.mapNotification(notification)
                )
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('notifications.loadLogError', { detail }));
            this.post({
                command: 'error',
                requestId,
                page,
                flag,
                type,
                course: course || 'all',
                order,
                message: /not authenticated|login first|session has expired|Сессия Stepik истекла/i.test(detail)
                    ? t('notifications.loginRequired')
                    : detail
            });
        }
    }

    private async toggleRead(message: NotificationsMessage): Promise<void> {
        const id = Number(message.id);
        if (!Number.isInteger(id) || id <= 0 || typeof message.isUnread !== 'boolean') {
            return;
        }
        try {
            const updated = await this.api.updateNotification(id, {
                is_unread: message.isUnread
            });
            const status = await this.api.getNotificationStatus().catch(() => null);
            if (status) {
                this.lastStatus = status;
                this.updateStatusBar(status);
            }
            this.post({
                command: 'notificationUpdated',
                id,
                isUnread: updated?.is_unread ?? message.isUnread,
                isFavorite: updated?.is_favorite,
                status
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('notifications.toggleLogError', { id, detail }));
            vscode.window.showErrorMessage(t('notifications.toggleError', { detail }));
        }
    }

    private async toggleFavorite(message: NotificationsMessage): Promise<void> {
        const id = Number(message.id);
        if (!Number.isInteger(id) || id <= 0 || typeof message.isFavorite !== 'boolean') {
            return;
        }
        try {
            const updated = await this.api.updateNotification(id, {
                is_favorite: message.isFavorite
            });
            this.post({
                command: 'notificationUpdated',
                id,
                isFavorite: updated?.is_favorite ?? message.isFavorite,
                isUnread: updated?.is_unread
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('notifications.favoriteLogError', { id, detail }));
            vscode.window.showErrorMessage(t('notifications.favoriteError', { detail }));
        }
    }

    private async markAllRead(message: NotificationsMessage): Promise<void> {
        const type = this.normalizeType(message.type);
        const course = this.parseCourse(message.course);
        try {
            const statusText = await this.api.markAllNotificationsRead({
                type,
                course
            });
            const status = await this.api.getNotificationStatus().catch(() => null);
            if (status) {
                this.lastStatus = status;
                this.updateStatusBar(status);
            }
            this.post({ command: 'markAllDone', statusText, status });
            vscode.window.showInformationMessage(
                statusText || t('notifications.markAllDone')
            );
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.log(t('notifications.markAllLogError', { detail }));
            vscode.window.showErrorMessage(t('notifications.markAllError', { detail }));
        }
    }

    private async openExternal(url: string | undefined): Promise<void> {
        const safe = normalizeStepikUrl(url);
        if (!safe) {
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(safe));
    }

    private async handleMessage(message: NotificationsMessage): Promise<void> {
        switch (message.command) {
            case 'init':
                await this.initPanel();
                break;
            case 'load':
                await this.loadNotifications(message);
                break;
            case 'toggleRead':
                await this.toggleRead(message);
                break;
            case 'toggleFavorite':
                await this.toggleFavorite(message);
                break;
            case 'markAllRead':
                await this.markAllRead(message);
                break;
            case 'openExternal':
                await this.openExternal(message.url);
                break;
            case 'refresh':
                await this.refreshStatus('manual');
                this.post({ command: 'status', status: this.lastStatus });
                break;
            case 'resetCaches':
                this.courseOptionsPromise = undefined;
                this.courseMap.clear();
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
    <title>${t('notifications.panelTitle')}</title>
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
        button, select {
            font-family: inherit;
            font-size: inherit;
        }
        .notifications-shell {
            max-width: 1000px;
            margin: 0 auto;
            padding: 22px 24px 48px;
        }
        .page-head {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            margin-bottom: 14px;
        }
        .page-head h1 {
            display: flex;
            align-items: center;
            gap: 9px;
            margin: 0;
            font-size: 24px;
            font-weight: 600;
            letter-spacing: -0.2px;
        }
        .unread-badge {
            min-width: 22px;
            height: 20px;
            padding: 0 7px;
            border-radius: 999px;
            color: var(--vscode-badge-foreground);
            background: var(--vscode-badge-background);
            font-size: 11px;
            font-weight: 600;
            line-height: 20px;
            text-align: center;
        }
        .page-subtitle {
            margin: 5px 0 0;
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
        .primary-button,
        .link-button {
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
        .secondary-button:disabled,
        .primary-button:disabled {
            opacity: 0.55;
            cursor: default;
        }
        .primary-button {
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            border: 1px solid var(--vscode-button-border, transparent);
        }
        .primary-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .link-button {
            padding: 0 6px;
            color: var(--vscode-textLink-foreground);
            background: transparent;
            border: 0;
        }
        .link-button:hover {
            color: var(--vscode-textLink-activeForeground);
            text-decoration: underline;
        }
        .flag-tabs {
            display: flex;
            flex-wrap: wrap;
            gap: 3px;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
            margin-bottom: 12px;
        }
        .flag-tab {
            position: relative;
            padding: 8px 13px 10px;
            border: 0;
            border-radius: 6px 6px 0 0;
            color: var(--vscode-descriptionForeground);
            background: transparent;
            cursor: pointer;
        }
        .flag-tab:hover {
            color: var(--vscode-foreground);
            background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.12));
        }
        .flag-tab.active {
            color: var(--vscode-foreground);
            font-weight: 600;
        }
        .flag-tab.active::after {
            content: '';
            position: absolute;
            left: 11px;
            right: 11px;
            bottom: -1px;
            height: 2px;
            border-radius: 2px;
            background: var(--vscode-focusBorder);
        }
        .filters {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            margin-bottom: 14px;
        }
        .filters select {
            height: 32px;
            padding: 0 28px 0 9px;
            color: var(--vscode-dropdown-foreground);
            background: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-dropdown-border, transparent);
            border-radius: 6px;
            outline: none;
        }
        .filters select:focus {
            border-color: var(--vscode-focusBorder);
        }
        .filters .spacer { flex: 1; }
        .status-line {
            min-height: 20px;
            margin: 0 0 10px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .status-line.error { color: var(--vscode-errorForeground, #f14c4c); }
        .status-line.loading { color: var(--vscode-textLink-foreground); }
        .status-line.info { color: var(--vscode-descriptionForeground); }
        .notifications-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .notification-card {
            display: grid;
            grid-template-columns: 36px minmax(0, 1fr) minmax(130px, 190px);
            gap: 12px;
            padding: 14px 15px 12px;
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.25)));
            border-radius: 8px;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            transition: border-color 120ms ease;
        }
        .notification-card:hover { border-color: var(--vscode-focusBorder); }
        .notification-card.unread {
            border-left: 3px solid var(--vscode-focusBorder);
            padding-left: 13px;
        }
        .notification-card.removing {
            opacity: 0.4;
            transform: translateX(6px);
            transition: opacity 160ms ease, transform 160ms ease;
        }
        .icon-column {
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding-top: 1px;
        }
        .icon-wrap {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 30px;
            height: 30px;
            color: var(--vscode-textLink-foreground);
        }
        .icon-wrap svg {
            width: 24px;
            height: 24px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.7;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .unread-dot {
            position: absolute;
            top: -2px;
            left: -2px;
            width: 8px;
            height: 8px;
            border: 2px solid var(--vscode-editorWidget-background, var(--vscode-editor-background));
            border-radius: 50%;
            background: var(--vscode-focusBorder);
        }
        .card-main { min-width: 0; }
        .card-title {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 4px;
            margin-bottom: 5px;
            line-height: 1.45;
        }
        .card-title .actor {
            color: var(--vscode-textLink-foreground);
            font-weight: 600;
            text-decoration: none;
        }
        .card-title .actor:hover { text-decoration: underline; }
        .card-title .action { color: var(--vscode-foreground); }
        .card-title .context { color: var(--vscode-descriptionForeground); }
        .card-time {
            margin-left: auto;
            padding-left: 14px;
            color: var(--vscode-descriptionForeground);
            font-size: 11.5px;
            white-space: nowrap;
        }
        .card-body {
            margin: 0;
            color: var(--vscode-foreground);
            line-height: 1.5;
        }
        .card-body p { margin: 0 0 6px; white-space: pre-wrap; }
        .card-body p:last-child { margin-bottom: 0; }
        .quote {
            margin: 0 0 7px;
            padding: 6px 10px;
            border-left: 3px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
            color: var(--vscode-descriptionForeground);
            white-space: pre-wrap;
        }
        .submission-line {
            display: inline-block;
            margin: 3px 0 6px;
            padding: 2px 7px;
            border-radius: 4px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.1));
            font-size: 11.5px;
        }
        .card-footer {
            display: flex;
            align-items: center;
            gap: 5px;
            margin-top: 8px;
        }
        .card-footer .spacer { flex: 1; }
        .main-action {
            padding: 0;
            border: 0;
            color: var(--vscode-textLink-foreground);
            background: transparent;
            cursor: pointer;
            font-size: 12px;
        }
        .main-action:hover { text-decoration: underline; }
        .icon-action {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 27px;
            height: 27px;
            padding: 0;
            border: 0;
            border-radius: 5px;
            color: var(--vscode-descriptionForeground);
            background: transparent;
            cursor: pointer;
        }
        .icon-action:hover {
            color: var(--vscode-foreground);
            background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.16));
        }
        .icon-action.active { color: var(--vscode-charts-yellow, #d7ba4a); }
        .icon-action svg {
            width: 16px;
            height: 16px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.7;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .card-aside {
            min-width: 0;
            padding-left: 12px;
            border-left: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
            color: var(--vscode-descriptionForeground);
            font-size: 11.5px;
            line-height: 1.35;
        }
        .aside-course {
            display: flex;
            align-items: flex-start;
            gap: 7px;
            text-decoration: none;
            color: inherit;
        }
        .aside-course:hover .aside-title { color: var(--vscode-textLink-foreground); }
        .aside-cover {
            flex: 0 0 auto;
            width: 38px;
            height: 38px;
            border-radius: 5px;
            object-fit: cover;
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.12));
        }
        .aside-title {
            display: -webkit-box;
            overflow: hidden;
            color: var(--vscode-foreground);
            font-size: 12px;
            font-weight: 500;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 3;
        }
        .aside-more {
            display: block;
            margin-top: 5px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .aside-lesson {
            margin-top: 8px;
            color: var(--vscode-foreground);
            font-size: 11.5px;
            line-height: 1.4;
        }
        .aside-step {
            margin-top: 2px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .empty-state {
            padding: 54px 24px;
            text-align: center;
            border: 1px dashed var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
            border-radius: 9px;
            color: var(--vscode-descriptionForeground);
        }
        .empty-state svg {
            width: 48px;
            height: 48px;
            margin-bottom: 10px;
            fill: none;
            stroke: currentColor;
            stroke-width: 1.3;
            opacity: 0.65;
        }
        .empty-state strong {
            display: block;
            margin-bottom: 5px;
            color: var(--vscode-foreground);
            font-size: 15px;
            font-weight: 500;
        }
        .loading {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 9px;
            padding: 24px 0;
            color: var(--vscode-descriptionForeground);
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
            .notification-card { transition: none; }
        }
        .footer {
            display: flex;
            align-items: center;
            justify-content: center;
            margin-top: 16px;
        }
        .scroll-sentinel { width: 100%; height: 1px; }
        @media (max-width: 700px) {
            .notifications-shell { padding: 16px 14px 32px; }
            .page-head { flex-direction: column; gap: 10px; }
            .head-actions { justify-content: flex-start; }
            .notification-card {
                grid-template-columns: 30px minmax(0, 1fr);
            }
            .card-aside {
                grid-column: 2;
                padding: 8px 0 0;
                border-left: 0;
                border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
            }
            .card-time { margin-left: 0; }
        }
${stepikThemeCss}
    </style>
</head>
<body data-view="notifications">
    ${stepikBrandHtml()}
    <div class="notifications-shell">
        <header class="page-head">
            <div>
                <h1>${t('notifications.title')} <span id="unread-badge" class="unread-badge" hidden></span></h1>
                <p class="page-subtitle">${t('notifications.subtitle')}</p>
            </div>
            <div class="head-actions">
                <button type="button" id="favorites" class="secondary-button">${t('notifications.favorites')}</button>
                <button type="button" id="settings" class="secondary-button">${t('notifications.settings')}</button>
                <button type="button" id="refresh" class="secondary-button" title="${t('notifications.refreshTitle')}">${t('notifications.refresh')}</button>
            </div>
        </header>

        <nav class="flag-tabs" role="tablist" aria-label="${t('notifications.ariaStatus')}">
            <button type="button" class="flag-tab active" role="tab" aria-selected="true" data-flag="unread">${t('notifications.tabUnread')}</button>
            <button type="button" class="flag-tab" role="tab" aria-selected="false" data-flag="read">${t('notifications.tabRead')}</button>
            <button type="button" class="flag-tab" role="tab" aria-selected="false" data-flag="all">${t('notifications.tabAll')}</button>
            <button type="button" class="flag-tab" role="tab" aria-selected="false" data-flag="favorites">${t('notifications.tabFavorites')}</button>
        </nav>

        <div class="filters">
            <select id="type-filter" aria-label="${t('notifications.ariaCategory')}">
                <option value="all">${t('notifications.allCategories')}</option>
                <option value="learn">${t('notifications.learning')}</option>
                <option value="review">${t('notifications.reviews')}</option>
                <option value="comments">${t('notifications.comments')}</option>
                <option value="teach">${t('notifications.teaching')}</option>
                <option value="default">${t('notifications.other')}</option>
            </select>
            <select id="course-filter" aria-label="${t('notifications.ariaCourse')}">
                <option value="all">${t('notifications.allCourses')}</option>
            </select>
            <select id="order-filter" aria-label="${t('notifications.ariaOrder')}">
                <option value="new">${t('notifications.newest')}</option>
                <option value="old">${t('notifications.oldest')}</option>
            </select>
            <span class="spacer"></span>
            <button type="button" id="mark-all" class="primary-button">${t('notifications.markAllRead')}</button>
        </div>

        <div id="status" class="status-line loading">${t('notifications.loading')}</div>
        <div id="list" class="notifications-list"></div>
        <div id="loading-more" class="loading" hidden>${t('notifications.loadingMore')}</div>
        <div id="scroll-sentinel" class="scroll-sentinel" aria-hidden="true"></div>
        <div class="footer">
            <button type="button" id="load-more" class="secondary-button" hidden>${t('notifications.loadMore')}</button>
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
                flag: 'unread',
                type: 'all',
                course: 'all',
                order: 'new',
                requestId: 0,
                page: 0,
                hasNext: false,
                items: [],
                loading: false,
                initialized: false,
                error: '',
                status: null,
                courses: [],
                settingsUrl: 'https://stepik.org/edit-profile/notifications',
                profileUrl: '',
                loadingMore: false,
                notice: ''
            };

            var badge = document.getElementById('unread-badge');
            var statusLine = document.getElementById('status');
            var list = document.getElementById('list');
            var loadMore = document.getElementById('load-more');
            var loadingMore = document.getElementById('loading-more');
            var sentinel = document.getElementById('scroll-sentinel');
            var typeFilter = document.getElementById('type-filter');
            var courseFilter = document.getElementById('course-filter');
            var orderFilter = document.getElementById('order-filter');
            var markAll = document.getElementById('mark-all');
            var tabs = Array.prototype.slice.call(document.querySelectorAll('.flag-tab'));

            function requestPage(page) {
                state.loading = true;
                state.loadingMore = false;
                state.error = '';
                state.requestId += 1;
                state.notice = '';
                render();
                vscode.postMessage({
                    command: 'load',
                    requestId: state.requestId,
                    page: page,
                    flag: state.flag,
                    type: state.type,
                    course: state.course,
                    order: state.order === 'old' ? 'time,id' : '-time,-id'
                });
            }

            function resetFilters() {
                state.flag = 'unread';
                state.type = 'all';
                state.course = 'all';
                state.order = 'new';
                typeFilter.value = 'all';
                courseFilter.value = 'all';
                orderFilter.value = 'new';
                state.page = 0;
                state.items = [];
                requestPage(1);
            }

            function unreadForFilter() {
                if (!state.status) {
                    return 0;
                }
                if (state.type !== 'all') {
                    return Number(state.status[state.type]) || 0;
                }
                return Number(state.status.total) || 0;
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
                if (isNaN(date.getTime())) {
                    return '';
                }
                try {
                    return date.toLocaleDateString(L.__locale || undefined, {
                        day: 'numeric',
                        month: 'long',
                        year: 'numeric'
                    });
                } catch (error) {
                    return '';
                }
            }

            function formatRelative(value) {
                if (!value) {
                    return '';
                }
                var date = new Date(value);
                if (isNaN(date.getTime())) {
                    return '';
                }
                var seconds = Math.round((date.getTime() - Date.now()) / 1000);
                var abs = Math.abs(seconds);
                if (abs < 60) {
                    return t('notifications.justNow');
                }
                if (abs < 3600) {
                    return t('notifications.minutesAgo', { count: Math.round(abs / 60) });
                }
                if (abs < 86400) {
                    return t('notifications.hoursAgo', { count: Math.round(abs / 3600) });
                }
                if (abs < 7 * 86400) {
                    return t('notifications.daysAgo', { count: Math.round(abs / 86400) });
                }
                return formatDate(value);
            }

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

            function icon(name) {
                var paths = {
                    comment: '<path d="M4 5.5h16v10.5H9l-5 4V5.5z"></path><path d="M8 9h8M8 12h5"></path>',
                    reply: '<path d="M4 5.5h16v10.5H9l-5 4V5.5z"></path><path d="M9 11.5l3-3 3 3M12 8.5v5"></path>',
                    solution: '<path d="M5 4.5h14v15H5z"></path><path d="M8 8l-2 2.5L8 13M16 8l2 2.5L16 13M13 7.5l-2 6"></path>',
                    like: '<path d="M7 10v9H4v-9h3z"></path><path d="M7 10l4-6c1.5 0 2 1.2 1.6 2.4L12 9h5.2c1.4 0 2 1 1.7 2.2l-1.2 4.6c-.2.8-.9 1.2-1.8 1.2H7"></path>',
                    'like-lesson': '<path d="M7 10v9H4v-9h3z"></path><path d="M7 10l4-6c1.5 0 2 1.2 1.6 2.4L12 9h5.2c1.4 0 2 1 1.7 2.2l-1.2 4.6c-.2.8-.9 1.2-1.8 1.2H7"></path><path d="M17 4.5l.5 2M20 5l-1.5 1.5"></path>',
                    bell: '<path d="M6 16V10a6 6 0 0 1 12 0v6l2 2H4l2-2z"></path><path d="M10 20h4"></path>',
                    bookmarkOutline: '<path d="M6.5 3.5h11v17L12 16.5 6.5 20.5z"></path>',
                    bookmarkFilled: '<path d="M6.5 3.5h11v17L12 16.5 6.5 20.5z" fill="currentColor"></path>',
                    check: '<path d="M5 12.5l4 4L19 6.5"></path>',
                    mark: '<path d="M4 5.5h16v13H4z"></path><path d="M8 10l2.5 2.5L16 8"></path>'
                };
                return '<svg viewBox="0 0 24 24" aria-hidden="true">' + paths[name] + '</svg>';
            }

            function openExternal(url) {
                if (url) {
                    vscode.postMessage({ command: 'openExternal', url: url });
                }
            }

            function addCourseAside(aside, item) {
                if (item.courses && item.courses.length > 0) {
                    var first = item.courses[0];
                    var link = element('a', 'aside-course');
                    link.href = '#';
                    link.title = first.title;
                    link.addEventListener('click', function (event) {
                        event.preventDefault();
                        openExternal(first.url);
                    });
                    if (first.cover) {
                        var image = element('img', 'aside-cover');
                        image.src = first.cover;
                        image.alt = '';
                        image.loading = 'lazy';
                        image.referrerPolicy = 'no-referrer';
                        image.addEventListener('error', function () { image.remove(); });
                        link.appendChild(image);
                    }
                    link.appendChild(element('span', 'aside-title', first.title));
                    aside.appendChild(link);
                    if (item.courses.length > 1) {
                        aside.appendChild(element(
                            'span',
                            'aside-more',
                            t('notifications.courseMore', {
                                count: item.courses.length - 1,
                                word: plural('notifications.courseWord', item.courses.length - 1)
                            })
                        ));
                    }
                }
                if (item.asideLesson) {
                    aside.appendChild(element('div', 'aside-lesson', item.asideLesson));
                }
                if (item.asideStep) {
                    aside.appendChild(element('div', 'aside-step', item.asideStep));
                }
            }

            function createCard(item) {
                var card = element('article', 'notification-card' + (item.isUnread ? ' unread' : ''));
                card.setAttribute('data-id', String(item.id));

                var iconColumn = element('div', 'icon-column');
                var iconWrap = element('div', 'icon-wrap');
                if (item.isUnread) {
                    iconWrap.appendChild(element('span', 'unread-dot'));
                }
                iconWrap.innerHTML = icon(item.icon || 'bell');
                iconColumn.appendChild(iconWrap);
                card.appendChild(iconColumn);

                var main = element('div', 'card-main');
                var title = element('div', 'card-title');
                if (item.actorName) {
                    if (item.actorUrl) {
                        var actor = element('a', 'actor', item.actorName);
                        actor.href = '#';
                        actor.addEventListener('click', function (event) {
                            event.preventDefault();
                            openExternal(item.actorUrl);
                        });
                        title.appendChild(actor);
                    } else {
                        title.appendChild(element('span', 'actor', item.actorName));
                    }
                }
                title.appendChild(element('span', 'action', item.actionText));
                if (item.contextText) {
                    title.appendChild(element('span', 'context', item.contextText));
                }
                var time = element('time', 'card-time', formatRelative(item.time));
                time.dateTime = item.time;
                time.title = formatDate(item.time) + ', ' +
                    new Date(item.time).toLocaleTimeString(L.__locale || undefined, { hour: '2-digit', minute: '2-digit' });
                title.appendChild(time);
                main.appendChild(title);

                var body = element('div', 'card-body');
                if (item.discussionPreview) {
                    body.appendChild(element('blockquote', 'quote', item.discussionPreview));
                }
                if (item.submissionText) {
                    body.appendChild(element('div', 'submission-line', item.submissionText));
                }
                if (item.commentPreview) {
                    body.appendChild(element('p', '', item.commentPreview));
                }
                if (item.htmlText) {
                    body.appendChild(element('p', '', item.htmlText));
                }
                if (body.childNodes.length > 0) {
                    main.appendChild(body);
                }

                var footer = element('div', 'card-footer');
                if (item.actionUrl) {
                    var actionLabel = item.icon === 'like' || item.icon === 'like-lesson'
                        ? t(item.icon === 'like-lesson'
                            ? 'notifications.viewLesson'
                            : 'notifications.viewComment')
                        : item.type === 'comments'
                            ? t('notifications.viewComment')
                            : t('notifications.openStepik');
                    var action = element('button', 'main-action', actionLabel);
                    action.type = 'button';
                    action.addEventListener('click', function () {
                        if (item.isUnread) {
                            vscode.postMessage({
                                command: 'toggleRead',
                                id: item.id,
                                isUnread: false
                            });
                        }
                        openExternal(item.actionUrl);
                    });
                    footer.appendChild(action);
                }
                footer.appendChild(element('span', 'spacer'));

                var favorite = element('button', 'icon-action' + (item.isFavorite ? ' active' : ''));
                favorite.type = 'button';
                favorite.innerHTML = icon(item.isFavorite ? 'bookmarkFilled' : 'bookmarkOutline');
                favorite.title = item.isFavorite
                    ? t('notifications.removeFavorite')
                    : t('notifications.addFavorite');
                favorite.setAttribute('aria-label', favorite.title);
                favorite.addEventListener('click', function () {
                    favorite.disabled = true;
                    vscode.postMessage({
                        command: 'toggleFavorite',
                        id: item.id,
                        isFavorite: !item.isFavorite
                    });
                });
                footer.appendChild(favorite);

                var read = element('button', 'icon-action');
                read.type = 'button';
                read.innerHTML = icon(item.isUnread ? 'check' : 'mark');
                read.title = item.isUnread
                    ? t('notifications.markRead')
                    : t('notifications.markUnread');
                read.setAttribute('aria-label', read.title);
                read.addEventListener('click', function () {
                    read.disabled = true;
                    vscode.postMessage({
                        command: 'toggleRead',
                        id: item.id,
                        isUnread: !item.isUnread
                    });
                });
                footer.appendChild(read);
                main.appendChild(footer);
                card.appendChild(main);

                var aside = element('aside', 'card-aside');
                addCourseAside(aside, item);
                if (aside.childNodes.length > 0) {
                    card.appendChild(aside);
                } else {
                    card.style.gridTemplateColumns = '36px minmax(0, 1fr)';
                }
                return card;
            }

            function updateTabs() {
                tabs.forEach(function (tab) {
                    var active = tab.getAttribute('data-flag') === state.flag;
                    tab.classList.toggle('active', active);
                    tab.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                document.getElementById('favorites').classList.toggle(
                    'primary-button',
                    state.flag === 'favorites'
                );
                document.getElementById('favorites').classList.toggle(
                    'secondary-button',
                    state.flag !== 'favorites'
                );
            }

            function updateCourseOptions() {
                var selected = String(state.course);
                while (courseFilter.firstChild) {
                    courseFilter.removeChild(courseFilter.firstChild);
                }
                courseFilter.appendChild(new Option(t('notifications.allCourses'), 'all'));
                var seen = {};
                state.courses.forEach(function (course) {
                    if (!course || seen[course.id]) {
                        return;
                    }
                    seen[course.id] = true;
                    courseFilter.appendChild(new Option(course.title, String(course.id)));
                });
                if (selected !== 'all' && !seen[selected]) {
                    courseFilter.appendChild(new Option(
                        t('notifications.coursePrefix', { id: selected }),
                        selected
                    ));
                }
                courseFilter.value = selected;
            }

            function updateStatus() {
                var total = Number(state.status && state.status.total) || 0;
                badge.hidden = total <= 0;
                badge.textContent = total > 0 ? formatNumber(total) : '';
                badge.title = total > 0
                    ? t('notifications.statusBarUnread', {
                          count: total,
                          word: plural('notifications.notificationWord', total)
                      })
                    : '';
                markAll.disabled = state.loading || unreadForFilter() === 0;

                if (state.error) {
                    statusLine.className = 'status-line error';
                    statusLine.textContent = state.error;
                } else if (state.loading && state.items.length === 0) {
                    statusLine.className = 'status-line loading';
                    statusLine.textContent = t('notifications.loading');
                } else if (state.notice) {
                    statusLine.className = 'status-line info';
                    statusLine.textContent = state.notice;
                } else if (state.items.length === 0) {
                    statusLine.className = 'status-line';
                    statusLine.textContent = '';
                } else {
                    statusLine.className = 'status-line';
                    statusLine.textContent = t('notifications.statusShown', {
                        count: state.items.length
                    }) + (state.hasNext ? t('notifications.statusMore') : '');
                }
            }

            function emptyState() {
                var empty = element('div', 'empty-state');
                var svg = element('div');
                svg.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V10a6 6 0 0 1 12 0v6l2 2H4l2-2z"></path><path d="M10 20h4"></path></svg>';
                empty.appendChild(svg.firstChild);

                var heading = element('strong');
                var hint = element('span');
                if (state.error) {
                    heading.textContent = t('notifications.emptyErrorTitle');
                    hint.textContent = t('notifications.emptyErrorHint');
                } else if (state.flag === 'favorites') {
                    heading.textContent = t('notifications.emptyFavoritesTitle');
                    hint.textContent = t('notifications.emptyFavoritesHint');
                } else if (state.flag === 'unread' && state.type === 'all' && state.course === 'all') {
                    heading.textContent = t('notifications.emptyUnreadTitle');
                    hint.textContent = t('notifications.emptyUnreadHint');
                } else {
                    heading.textContent = t('notifications.emptyFilteredTitle');
                    hint.textContent = t('notifications.emptyFilteredHint');
                }
                empty.appendChild(heading);
                empty.appendChild(hint);

                if (state.error || state.flag !== 'unread' || state.type !== 'all' || state.course !== 'all') {
                    var reset = element('button', 'link-button', t('notifications.resetFilters'));
                    reset.type = 'button';
                    reset.style.marginTop = '10px';
                    reset.addEventListener('click', resetFilters);
                    empty.appendChild(reset);
                }
                return empty;
            }

            function render() {
                updateTabs();
                updateStatus();

                while (list.firstChild) {
                    list.removeChild(list.firstChild);
                }
                if (state.items.length === 0 && !state.loading) {
                    list.appendChild(emptyState());
                } else {
                    state.items.forEach(function (item) {
                        list.appendChild(createCard(item));
                    });
                }
                if (state.loading && state.items.length === 0) {
                    var loading = element('div', 'loading', t('notifications.loading'));
                    list.appendChild(loading);
                }

                loadingMore.hidden = !state.loadingMore;
                loadMore.hidden = !(state.items.length > 0 && state.hasNext);
                loadMore.disabled = state.loading || state.loadingMore;
                loadMore.textContent = state.loadingMore
                    ? t('notifications.loadingButton')
                    : t('notifications.loadMore');
            }

            function applyItems(message) {
                var incoming = Array.isArray(message.items) ? message.items : [];
                if (Number(message.page) === 1) {
                    state.items = incoming;
                } else {
                    var known = {};
                    state.items.forEach(function (item) { known[item.id] = true; });
                    incoming.forEach(function (item) {
                        if (!known[item.id]) {
                            known[item.id] = true;
                            state.items.push(item);
                        }
                    });
                }
                state.page = Number(message.page) || 1;
                state.hasNext = Boolean(message.hasNext);
                if (Array.isArray(message.courses)) {
                    state.courses = message.courses;
                    updateCourseOptions();
                }
                if (message.status) {
                    state.status = message.status;
                }
                state.notice = '';
            }

            function maybeLoadMore() {
                if (!state.loading && !state.loadingMore && state.hasNext) {
                    state.loadingMore = true;
                    state.requestId += 1;
                    render();
                    vscode.postMessage({
                        command: 'load',
                        requestId: state.requestId,
                        page: state.page + 1,
                        flag: state.flag,
                        type: state.type,
                        course: state.course,
                        order: state.order === 'old' ? 'time,id' : '-time,-id'
                    });
                }
            }

            tabs.forEach(function (tab) {
                tab.addEventListener('click', function () {
                    var flag = tab.getAttribute('data-flag');
                    if (!flag || flag === state.flag) {
                        return;
                    }
                    state.flag = flag;
                    state.page = 0;
                    state.items = [];
                    state.notice = '';
                    requestPage(1);
                });
            });

            document.getElementById('favorites').addEventListener('click', function () {
                state.flag = state.flag === 'favorites' ? 'unread' : 'favorites';
                state.page = 0;
                state.items = [];
                requestPage(1);
            });

            document.getElementById('settings').addEventListener('click', function () {
                openExternal(state.settingsUrl);
            });

            document.getElementById('refresh').addEventListener('click', function () {
                vscode.postMessage({ command: 'resetCaches' });
                state.page = 0;
                state.items = [];
                state.error = '';
                requestPage(1);
            });

            typeFilter.addEventListener('change', function () {
                state.type = typeFilter.value;
                state.page = 0;
                state.items = [];
                requestPage(1);
            });

            courseFilter.addEventListener('change', function () {
                state.course = courseFilter.value;
                state.page = 0;
                state.items = [];
                requestPage(1);
            });

            orderFilter.addEventListener('change', function () {
                state.order = orderFilter.value;
                state.page = 0;
                state.items = [];
                requestPage(1);
            });

            markAll.addEventListener('click', function () {
                markAll.disabled = true;
                vscode.postMessage({
                    command: 'markAllRead',
                    type: state.type,
                    course: state.course
                });
            });

            loadMore.addEventListener('click', function () {
                maybeLoadMore();
            });

            if ('IntersectionObserver' in window) {
                var observer = new IntersectionObserver(function (entries) {
                    for (var i = 0; i < entries.length; i++) {
                        if (entries[i].isIntersecting) {
                            maybeLoadMore();
                            break;
                        }
                    }
                }, { rootMargin: '500px 0px' });
                observer.observe(sentinel);
            } else {
                window.addEventListener('scroll', function () {
                    if (sentinel.getBoundingClientRect().top < window.innerHeight + 500) {
                        maybeLoadMore();
                    }
                }, { passive: true });
            }

            window.addEventListener('message', function (event) {
                var message = event.data || {};
                if (message.command === 'init') {
                    state.status = message.status || null;
                    state.courses = Array.isArray(message.courses) ? message.courses : [];
                    state.settingsUrl = message.settingsUrl || state.settingsUrl;
                    state.profileUrl = message.profileUrl || '';
                    state.initialized = true;
                    updateCourseOptions();
                    requestPage(1);
                    return;
                }
                if (message.command === 'notificationsChanged') {
                    state.notice = t('notifications.newNotice');
                    render();
                    return;
                }
                if (message.command === 'showUnread') {
                    resetFilters();
                    return;
                }
                if (message.command === 'status') {
                    state.status = message.status || state.status;
                    updateStatus();
                    return;
                }
                if (message.command === 'markAllDone') {
                    state.status = message.status || state.status;
                    state.page = 0;
                    state.items = [];
                    state.notice = message.statusText || t('notifications.markAllDone');
                    requestPage(1);
                    return;
                }
                if (message.command === 'notificationUpdated') {
                    var index = -1;
                    for (var i = 0; i < state.items.length; i++) {
                        if (state.items[i].id === message.id) {
                            index = i;
                            break;
                        }
                    }
                    if (index >= 0) {
                        var item = state.items[index];
                        if (typeof message.isUnread === 'boolean') {
                            item.isUnread = message.isUnread;
                        }
                        if (typeof message.isFavorite === 'boolean') {
                            item.isFavorite = message.isFavorite;
                        }
                        var dropsUnread = state.flag === 'unread' && item.isUnread === false;
                        var dropsFavorite = state.flag === 'favorites' && item.isFavorite === false;
                        if (dropsUnread || dropsFavorite) {
                            state.items.splice(index, 1);
                        }
                    }
                    state.status = message.status || state.status;
                    state.loading = false;
                    render();
                    return;
                }
                if (message.command === 'error') {
                    if (message.requestId && Number(message.requestId) !== state.requestId) {
                        return;
                    }
                    state.loading = false;
                    state.loadingMore = false;
                    state.error = message.message || t('notifications.loadErrorFallback');
                    render();
                    return;
                }
                if (message.command === 'notifications') {
                    if (Number(message.requestId) !== state.requestId) {
                        return;
                    }
                    state.loading = false;
                    state.loadingMore = false;
                    state.error = '';
                    applyItems(message);
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
