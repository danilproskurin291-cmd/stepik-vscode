import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Worker } from 'worker_threads';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import {
    StepikApi,
    StepikApiError,
    Step,
    Attempt,
    AttemptDataset,
    QuizReply,
    StepikComment,
    CommentUser,
    CommentVote,
    VoteValue,
    CommentsPage,
    DiscussionProxy,
    DiscussionThread,
    Submission,
    TableRowChoice,
    ChemicalSlot,
    FillBlanksComponent,
    MatchingPair,
    HtmlChecklistItem
} from '../api/stepikApi';
import { StepikTreeProvider } from '../providers/treeProvider';
import { StepContext } from '../stepContext';
import { getActiveSolutionRoot, getComparableFilePath, getMappingPath } from '../stepikPaths';
import { getStepTypeTitle } from '../stepTypes';
import { combineSubmissionFeedback } from '../submissionFeedback';
import {
    SectionAccess,
    formatDuration,
    getSectionAccess,
    getSessionTimeLeft,
    isExamSessionActive
} from '../exam/examAccess';
import { ExamSession } from '../api/stepikApi';
import { highlightCode, highlightCodeBlocks } from './syntaxHighlighter';
import { getRichCommentEditorScript } from './richCommentEditor';
import { uploadCommentImage } from '../uploadcare';
import { getLanguage, pluralize, t, webviewStrings } from '../i18n';
import { stepikBrandHtml, stepikThemeCss } from './theme';
import TurndownService from 'turndown';

// turndown-plugin-gfm ships without TypeScript declarations. Only the GFM
// plugin is used here (tables, strikethrough and task lists).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const turndownPluginGfm = require('turndown-plugin-gfm') as {
    gfm: TurndownService.Plugin;
};

type CommentSort = 'new' | 'discussed' | 'popular' | 'recent' | 'teacher' | 'mine';

// Stepik returns at most 20 comments per page even if page_size is larger.
// A batch of 100 is assembled from five pages, so opening a thread does not
// download the whole discussion at once.
const COMMENT_PAGE_SIZE = 20;
const REPLIES_PER_BATCH = 100;
const REPLIES_PAGES_PER_BATCH = Math.ceil(REPLIES_PER_BATCH / COMMENT_PAGE_SIZE);

/**
 * Stepik tasks that are submitted through the quiz endpoint. "code" is
 * handled through the local-editor workflow, but it is still answerable and
 * its solutions forum has to load the user's submissions.
 */
const ANSWERABLE_STEP_TYPES = new Set([
    'choice',
    'string',
    'number',
    'math',
    'free-answer',
    'sorting',
    'matching',
    'table',
    'fill-blanks',
    'sql',
    'html',
    'dataset',
    'chemical',
    'puzzle',
    'code'
]);

/** Types whose dataset comes from POST /attempts. Code has no dataset. */
const ATTEMPT_STEP_TYPES = new Set(
    Array.from(ANSWERABLE_STEP_TYPES).filter(type => type !== 'code')
);

/**
 * Stepik separates material steps from graded quizzes. Materials have
 * comments but no solutions forum; every other plugin quiz can have both.
 * The website uses the same rule (`is_quiz` = not material).
 */
const MATERIAL_STEP_TYPES = new Set(['text', 'video']);

interface ReplyThreadState {
    page: number;
    hasMore: boolean;
    loading: boolean;
}

interface WebviewMessage {
    command: string;
    language?: string;
    reply?: QuizReply;
    choices?: boolean[];
    text?: string;
    number?: string;
    commentId?: number;
    parentId?: number;
    page?: number;
    more?: boolean;
    sort?: CommentSort;
    thread?: 'default' | 'solutions';
    submissionId?: number;
    vote?: 'epic' | 'abuse';
    url?: string;
    active?: boolean;
    format?: 'html' | 'markdown';
    requestId?: string;
    name?: string;
    mimeType?: string;
    data?: string;
    markdown?: string;
    html?: string;
    formula?: string;
    display?: boolean;
}

interface CourseProgressSummary {
    courseId: number;
    score: number;
    cost: number;
    stepsPassed: number;
    stepsTotal: number;
    percent: number;
    streak: number;
    maxStreak: number;
    solved: number;
    certificateThreshold?: number;
    certificateDistinctionThreshold?: number;
    certificateRemaining?: number;
    studyTimeHours?: number;
}

export class StepikWebview implements vscode.Disposable {
    private panel: vscode.WebviewPanel | undefined;
    private currentStep: StepContext | undefined;
    private currentAccess: SectionAccess | undefined;
    private previousStep: StepContext | undefined;
    private nextStep: StepContext | undefined;
    private preloadTimer: ReturnType<typeof setTimeout> | undefined;
    private preloadToken = 0;
    private readonly preloadedSteps = new Map<number, number>();
    private currentAttempt: Attempt | undefined;
    private currentDatasetFile: string | undefined;
    private currentDatasetFileError: string | undefined;
    private readonly markedVideoSteps = new Set<number>();
    private readonly videoViewRequests = new Set<number>();
    private readonly viewedSteps = new Set<number>();
    private readonly viewRequests = new Map<number, Promise<boolean>>();
    private readonly assignmentIdCache = new Map<number, Promise<number | undefined>>();
    private readonly videoAudioWorkers = new Set<Worker>();
    private readonly videoAudioJobs = new Map<string, Promise<string>>();
    private videoTheaterActive = false;
    private comments: StepikComment[] = [];
    private pinnedComments: StepikComment[] = [];
    private loadedCommentIds = new Set<number>();
    private commentUsers = new Map<number, CommentUser>();
    private commentSubmissions = new Map<number, Submission>();
    private commentVoteIds = new Map<number, string>();
    private commentVoteValues = new Map<number, VoteValue>();
    private voteRequests = new Set<number>();
    private commentsPage = 1;
    private hasMoreComments = false;
    private commentsError: string | undefined;
    private commentsLoading = false;
    private commentsLoadToken = 0;
    private commentSort: CommentSort = 'new';
    private discussionProxyData: DiscussionProxy | undefined;
    private remainingCommentIds: number[] = [];
    private repliesCache = new Map<number, StepikComment[]>();
    private repliesState = new Map<number, ReplyThreadState>();
    private teacherRepliedParents = new Set<number>();
    private currentUserId: number | undefined;
    private readonly commentMarkdown = new MarkdownIt({
        // Rich editor payloads are HTML. Markdown is still rendered for the
        // Markdown mode, and enabling raw HTML keeps both round-trips stable.
        html: true,
        linkify: true,
        breaks: true,
        typographer: false
    });
    private readonly commentTurndown = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        fence: '```',
        emDelimiter: '*',
        strongDelimiter: '**',
        bulletListMarker: '-'
    });
    private progressSummary: CourseProgressSummary | undefined;
    private progressError: string | undefined;
    private progressToken = 0;

    private solutionsThread: DiscussionThread | undefined;
    private solutionsProxy: DiscussionProxy | undefined;
    private solutionsComments: StepikComment[] = [];
    private solutionsLoadedIds = new Set<number>();
    private solutionsRemainingIds: number[] = [];
    private solutionsAvailable = false;
    private solutionsLoaded = false;
    private solutionsLoading = false;
    private solutionsError: string | undefined;
    private solutionsSort: CommentSort = 'new';
    private solutionsToken = 0;
    private solutionsLoadToken = 0;
    private solutionSubmissions: Submission[] = [];
    private solutionSubmissionsError: string | undefined;
    private solutionSubmissionsToken = 0;
    private readonly solutionsAvailabilityCache = new Map<
        number,
        { expires: number; thread: DiscussionThread | undefined }
    >();
    private stylesCache: string | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private api: StepikApi,
        private treeProvider: StepikTreeProvider,
        private outputChannel: vscode.OutputChannel
    ) {
        this.commentTurndown.use(turndownPluginGfm.gfm);
        // Turndown escapes backslashes, which would turn Stepik's \(...\)
        // delimiters into \\(...\\). Keep math spans verbatim so switching to
        // Markdown and back does not break formulas.
        this.commentTurndown.addRule('stepikMath', {
            filter: node =>
                node.nodeName === 'SPAN' &&
                (node as HTMLElement).classList.contains('math-tex'),
            replacement: (_content, node) => (node.textContent || '').trim()
        });
    }

    async showStep(
        stepContext: StepContext,
        knownExamSession?: ExamSession
    ): Promise<void> {
        const { step, section } = stepContext;

        // An exam session already active in this section is also valid for its
        // neighbouring steps. Reuse it as a hint when Stepik's section payload
        // lags behind the session we just created.
        const examSessionHint =
            knownExamSession ||
            (section?.is_exam &&
            this.currentAccess?.examSession &&
            isExamSessionActive(this.currentAccess.examSession)
                ? this.currentAccess.examSession
                : undefined);

        // Exam material must not open until the user explicitly starts the
        // exam. The same guard also blocks sections after their deadline.
        let access: SectionAccess | undefined;
        if (section) {
            try {
                // Ordinary sections can reuse the short-lived tree cache: the
                // deadline is recalculated locally. An exam is refreshed on
                // the first open (and right after it starts), then navigation
                // inside it stays instant.
                const refreshAccess =
                    Boolean(knownExamSession) ||
                    (section.is_exam && !this.currentAccess?.examSession);
                const state = await this.treeProvider.getSectionAccessById(
                    section.id,
                    refreshAccess
                );
                access = state?.access;
                // Right after POST /exam-sessions the section response may
                // still be cached by Stepik without the new session. The
                // session we just created is authoritative proof that the
                // exam is running, but section deadlines still apply.
                if (
                    access &&
                    !access.examSession &&
                    examSessionHint &&
                    isExamSessionActive(examSessionHint)
                ) {
                    access = getSectionAccess(
                        section,
                        this.treeProvider.getSelectedCourse(),
                        examSessionHint
                    );
                }
                if (access && !access.canOpenStep) {
                    vscode.window.showWarningMessage(
                        access.reason || t('task.stepUnavailable')
                    );
                    return;
                }
            } catch (error) {
                // A failed access check must not make ordinary sections
                // unusable; the tree already falls back to section fields.
                this.outputChannel.appendLine(
                    `[Access] Failed to check section ${section.id}: ${error}`
                );
                // Exam material, however, stays locked when its state cannot
                // be verified.
                if (
                    section.is_exam &&
                    (!examSessionHint || !isExamSessionActive(examSessionHint))
                ) {
                    vscode.window.showErrorMessage(
                        t('task.examAccessCheckFailed')
                    );
                    return;
                }
            }

            // If the section request failed but the known session is valid,
            // build the access state locally. This keeps the exam timer and
            // submission checks working.
            if (
                section.is_exam &&
                !access &&
                examSessionHint &&
                isExamSessionActive(examSessionHint)
            ) {
                access = getSectionAccess(
                    section,
                    this.treeProvider.getSelectedCourse(),
                    examSessionHint
                );
                if (!access.canOpenStep) {
                    vscode.window.showWarningMessage(
                        access.reason || t('task.stepUnavailable')
                    );
                    return;
                }
            }

            if (
                section.is_exam &&
                !access &&
                (!examSessionHint || !isExamSessionActive(examSessionHint))
            ) {
                vscode.window.showWarningMessage(
                    t('task.examStateCheckFailed')
                );
                return;
            }
        }

        this.currentStep = stepContext;
        this.currentAccess = access;
        this.currentAttempt = undefined;
        this.currentDatasetFile = undefined;
        this.currentDatasetFileError = undefined;
        void this.setVideoTheater(false);

        try {
            const neighbors = await this.treeProvider.getStepNeighbors(stepContext);
            this.previousStep = neighbors.previous;
            this.nextStep = neighbors.next;
        } catch (error) {
            this.previousStep = undefined;
            this.nextStep = undefined;
            this.outputChannel.appendLine(
                `[Navigation] Failed to load step neighbors: ${error}`
            );
        }

        // Load comments and detect the solutions forum before rendering. The
        // user's submissions are loaded lazily when the solutions tab is
        // opened, so an ordinary step does not pay for an extra request.
        await Promise.all([
            this.loadInitialComments(step.id, step.discussion_proxy),
            this.loadSolutionsAvailability(step),
            this.loadProgressSummary(stepContext),
            this.getCurrentUserId().catch(error => {
                // Comment actions stay available through the comment cache even
                // if this request fails; the next render will retry.
                this.outputChannel.appendLine(
                    `[Comments] Не удалось определить пользователя: ${
                        error instanceof Error ? error.message : error
                    }`
                );
            })
        ]);

        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'stepikStep',
                t('task.panelTitle'),
                vscode.ViewColumn.Beside,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [
                        this.context.extensionUri,
                        // globalStorageUri uses the vscode-userdata scheme, but
                        // asWebviewUri serves cached files as file resources.
                        // Pass a file URI so the webview resource loader accepts
                        // the cached audio under this root.
                        vscode.Uri.file(this.context.globalStorageUri.fsPath)
                    ]
                }
            );

            this.panel.onDidDispose(() => {
                this.panel = undefined;
                // Closing the panel removes its editor group; VS Code restores
                // the remaining layout on its own.
                this.videoTheaterActive = false;
            });

            this.panel.webview.onDidReceiveMessage(
                (message: WebviewMessage) => this.handleMessage(message),
                undefined,
                this.context.subscriptions
            );
        }

        // Quiz datasets (options, pairs, rows, file contents) are created per
        // attempt. Code tasks create their attempt when a file is submitted,
        // but every other quiz type needs it before the form can be rendered.
        if (ATTEMPT_STEP_TYPES.has(step.block.name)) {
            await this.createAttemptForStep(step);
        }

        this.panel.title = t('task.tabTitle', { position: step.position });
        this.panel.webview.html = this.getHtmlContent(step);

        // The website creates a view record on every step change. Text steps
        // are marked as passed exactly this way, so report it for every step
        // and attach the assignment id to update course progress.
        void this.markStepViewed(stepContext);

        // Warm the previous and next steps after the current one is rendered.
        // Navigation then reuses the cached comments, threads and attempts
        // instead of waiting for the same requests again.
        this.scheduleNeighborPreload();
    }

    private scheduleNeighborPreload(): void {
        if (this.preloadTimer) {
            clearTimeout(this.preloadTimer);
            this.preloadTimer = undefined;
        }
        const token = ++this.preloadToken;
        this.preloadTimer = setTimeout(() => {
            this.preloadTimer = undefined;
            void this.preloadNeighbors(token);
        }, 600);
    }

    private async preloadNeighbors(token: number): Promise<void> {
        if (token !== this.preloadToken || !this.panel) {
            return;
        }
        const targets = [this.previousStep, this.nextStep].filter(
            (target): target is StepContext => Boolean(target)
        );
        for (const target of targets) {
            if (token !== this.preloadToken || !this.panel) {
                return;
            }
            await this.preloadStep(target, token);
        }
    }

    /**
     * Preload only read-only data. Opening a step can create an attempt for a
     * quiz, but preloading must not: a neighbour is not necessarily the step
     * the user is going to solve.
     */
    private async preloadStep(stepContext: StepContext, token: number): Promise<void> {
        const { step, section } = stepContext;
        if (!step || step.id === this.currentStep?.step.id) {
            return;
        }
        // Exam material must not be fetched before the exam is started.
        if (section?.is_exam && !this.currentAccess?.examSession) {
            return;
        }

        const cachedUntil = this.preloadedSteps.get(step.id);
        if (cachedUntil && cachedUntil > Date.now()) {
            return;
        }
        this.preloadedSteps.set(step.id, Date.now() + 45_000);

        try {
            await this.preloadStepResources(step, token);
        } catch (error) {
            this.preloadedSteps.delete(step.id);
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Preload] Failed to preload step ${step.id}: ${message}`
            );
        }
    }

    private async preloadStepResources(step: Step, token: number): Promise<void> {
        const tasks: Array<Promise<unknown>> = [];
        const proxyId = step.discussion_proxy;
        const quizStep = this.isQuizStep(step);

        // Warm the solutions thread metadata. When it exists, also warm the
        // submission list used by the solutions composer.
        if (quizStep && proxyId) {
            const candidates = new Set<string>(step.discussion_threads || []);
            const derived = proxyId.replace(/-1$/, '-2');
            if (derived !== proxyId) {
                candidates.add(derived);
            }
            if (candidates.size > 0) {
                tasks.push(
                    this.api
                        .getDiscussionThreads(Array.from(candidates))
                        .then(threads => {
                            if (threads.some(thread => thread.thread === 'solutions')) {
                                return this.api.getUserSubmissions(step.id);
                            }
                            return undefined;
                        })
                );
            }
        }

        if (this.commentSort === 'mine') {
            tasks.push(
                this.getCurrentUserId().then(userId =>
                    this.api.getUserComments(step.id, userId, 1)
                )
            );
        } else if (proxyId) {
            const proxy = await this.api.getDiscussionProxy(proxyId);
            if (token !== this.preloadToken) {
                return;
            }
            if (proxy) {
                const pinnedIds = proxy.discussions.slice(0, 10);
                const pinnedData = pinnedIds.length
                    ? await this.api.getCommentsByIds(pinnedIds)
                    : { comments: [] as StepikComment[] };
                if (token !== this.preloadToken) {
                    return;
                }

                // Reproduce the exact id list loadFirstOrderedComments() will
                // request: pinned comments are already in loadedCommentIds.
                const pinnedCommentIds = new Set(
                    pinnedData.comments
                        .filter(comment => comment.parent === null && comment.is_pinned)
                        .map(comment => comment.id)
                );
                if (this.commentSort !== 'teacher') {
                    const orderIds = this.getOrderIds(proxy)
                        .filter(id => !pinnedCommentIds.has(id))
                        .slice(0, 20);
                    if (orderIds.length > 0) {
                        tasks.push(this.api.getCommentsByIds(orderIds));
                    }
                }
            }
        } else {
            tasks.push(this.api.getComments(step.id, 1, null));
        }

        if (ATTEMPT_STEP_TYPES.has(step.block.name)) {
            // Read the attempts list only: it lets the next open reuse an
            // existing attempt instead of creating a new one.
            tasks.push(this.api.getAttempts(step.id));
        }

        await Promise.allSettled(tasks);
    }

    private isQuizStep(step: Step): boolean {
        return !MATERIAL_STEP_TYPES.has(step.block.name);
    }

    private getAttemptDataset(): AttemptDataset | undefined {
        const dataset = this.currentAttempt?.dataset;
        return dataset && typeof dataset === 'object' ? dataset : undefined;
    }

    private async createAttemptForStep(step: Step, forceNew: boolean = false): Promise<void> {
        try {
            // Reuse the latest attempt: Stepik keeps one attempt per step and
            // accepts several submissions in it. A brand-new attempt is only
            // created when the user explicitly asks for one.
            this.currentAttempt = forceNew
                ? await this.api.createAttempt(step.id)
                : await this.api.getOrCreateAttempt(step.id);
            this.currentDatasetFile = undefined;
            this.currentDatasetFileError = undefined;

            if (step.block.name === 'dataset' && this.currentAttempt) {
                try {
                    this.currentDatasetFile = await this.api.getAttemptFile(
                        this.currentAttempt.id,
                        this.currentAttempt.dataset_url
                    );
                } catch (error) {
                    this.currentDatasetFileError =
                        error instanceof Error ? error.message : String(error);
                    this.outputChannel.appendLine(
                        `[Dataset] Failed to load the input file for step ${step.id}: ${this.currentDatasetFileError}`
                    );
                }
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Attempt] Failed to create an attempt for step ${step.id}: ${detail}`
            );
            vscode.window.showErrorMessage(t('task.createAttemptFailed'));
        }
    }

    private getAssignmentId(stepContext: StepContext): Promise<number | undefined> {
        const stepId = stepContext.step.id;
        const cached = this.assignmentIdCache.get(stepId);
        if (cached) {
            return cached;
        }
        if (!stepContext.unitId) {
            return Promise.resolve(undefined);
        }

        const request = this.api
            .getAssignmentIdForStep(stepContext.unitId, stepId)
            .catch(error => {
                this.outputChannel.appendLine(
                    `[View] Failed to resolve assignment for step ${stepId}: ${error}`
                );
                return undefined;
            })
            .then(assignmentId => {
                // Do not cache a failed lookup forever: the next open of this
                // step should be able to attach the assignment again.
                if (assignmentId === undefined) {
                    this.assignmentIdCache.delete(stepId);
                }
                return assignmentId;
            });
        this.assignmentIdCache.set(stepId, request);
        return request;
    }

    /**
     * Stepik creates a `view` record on every step change and attaches the
     * assignment id. That is what marks text steps as passed and moves course
     * progress, so this runs for every opened step, not only for videos.
     */
    private markStepViewed(stepContext: StepContext): Promise<boolean> {
        const stepId = stepContext.step.id;
        if (this.viewedSteps.has(stepId)) {
            return Promise.resolve(true);
        }
        const pending = this.viewRequests.get(stepId);
        if (pending) {
            return pending;
        }

        const request = (async () => {
            try {
                const assignmentId = await this.getAssignmentId(stepContext);
                await this.api.markStepViewed(stepId, assignmentId);
                this.viewedSteps.add(stepId);
                this.outputChannel.appendLine(
                    `[View] Marked step ${stepId} as viewed` +
                        (assignmentId ? ` (assignment ${assignmentId})` : '')
                );

                if (stepContext.step.block.name === 'text') {
                    // Stepik recalculates the progress asynchronously.
                    setTimeout(() => this.treeProvider.refresh(), 1200);
                }
                return true;
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(
                    `[View] Failed to mark step ${stepId} as viewed: ${detail}`
                );
                return false;
            } finally {
                this.viewRequests.delete(stepId);
            }
        })();

        this.viewRequests.set(stepId, request);
        return request;
    }

    /**
     * The website creates a `view` record when a step is opened. For video
     * steps that is also what moves the course progress, so report a view the
     * first time the video is played. The call is best-effort: a network error
     * must not prevent local playback.
     */
    private async markVideoStepViewed(stepId: number): Promise<void> {
        if (this.markedVideoSteps.has(stepId) || this.videoViewRequests.has(stepId)) {
            return;
        }
        this.videoViewRequests.add(stepId);

        try {
            let ok = true;
            if (this.currentStep?.step.id === stepId) {
                ok = await this.markStepViewed(this.currentStep);
            } else {
                await this.api.markStepViewed(stepId);
            }
            if (!ok) {
                throw new Error(t('task.viewMarkFailed'));
            }
            this.markedVideoSteps.add(stepId);

            if (this.panel && this.currentStep?.step.id === stepId) {
                await this.panel.webview.postMessage({
                    command: 'videoViewed',
                    ok: true
                });
            }

            // Stepik recalculates progress asynchronously.
            setTimeout(() => this.treeProvider.refresh(), 1200);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Video] Failed to mark step ${stepId} as viewed: ${detail}`
            );
            if (this.panel && this.currentStep?.step.id === stepId) {
                await this.panel.webview.postMessage({
                    command: 'videoViewed',
                    ok: false,
                    message: t('task.viewMarkFailed')
                });
            }
        } finally {
            this.videoViewRequests.delete(stepId);
        }
    }

    /**
     * Stepik videos use AAC audio inside the MP4 container, which the VS Code
     * webview cannot decode. Extract the audio track in a worker, encode it to
     * MP3 (supported by webviews) and cache it in global storage.
     */
    private async prepareVideoAudio(step: Step): Promise<void> {
        const video = step.block.video;
        if (!video) {
            return;
        }
        const videoId = video.id ?? step.id;
        const sources = (video.urls || [])
            .map(source => ({
                quality: this.videoQualityValue(String(source?.quality || '')),
                url: this.normalizeMediaUrl(source?.url)
            }))
            .filter(
                (source): source is { quality: number; url: string } =>
                    Boolean(source.url)
            )
            .sort((left, right) => left.quality - right.quality);

        // The audio track is identical in all quality variants, so download
        // the smallest one.
        const sourceUrl = sources[0]?.url;
        if (!sourceUrl) {
            this.postVideoAudio(videoId, {
                ok: false,
                message: t('task.audioNotFound')
            });
            return;
        }

        const directory = this.videoAudioDirectory();
        fs.mkdirSync(directory, { recursive: true });
        const cacheKey = crypto
            .createHash('sha1')
            .update(`${videoId}:${sourceUrl}`)
            .digest('hex')
            .slice(0, 20);
        const finalPath = path.join(directory, `${cacheKey}.mp3`);

        if (this.hasVideoAudio(finalPath)) {
            this.postVideoAudioReady(videoId, finalPath);
            return;
        }

        const pending = this.videoAudioJobs.get(cacheKey);
        if (pending) {
            try {
                const file = await pending;
                this.postVideoAudioReady(videoId, file);
            } catch (error) {
                this.postVideoAudioError(videoId, error);
            }
            return;
        }

        const job = this.runVideoAudioWorker(videoId, sourceUrl, directory, cacheKey);
        this.videoAudioJobs.set(cacheKey, job);
        try {
            const file = await job;
            this.postVideoAudioReady(videoId, file);
            this.pruneVideoAudioCache(directory);
        } catch (error) {
            this.postVideoAudioError(videoId, error);
        } finally {
            this.videoAudioJobs.delete(cacheKey);
        }
    }

    private videoAudioDirectory(): string {
        return path.join(this.context.globalStorageUri.fsPath, 'video-audio');
    }

    private hasVideoAudio(filePath: string): boolean {
        try {
            return fs.statSync(filePath).size > 0;
        } catch {
            return false;
        }
    }

    private postVideoAudioReady(videoId: number, filePath: string): void {
        const url = this.panel?.webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
        if (!url) {
            return;
        }
        this.postVideoAudio(videoId, { ok: true, url });
    }

    private postVideoAudioError(videoId: number, error: unknown): void {
        const detail = error instanceof Error ? error.message : String(error);
        this.outputChannel.appendLine(
            `[Video] Failed to prepare audio for video ${videoId}: ${detail}`
        );
        this.postVideoAudio(videoId, {
            ok: false,
            message: t('task.audioPrepareError', { detail })
        });
    }

    private postVideoAudio(videoId: number, message: Record<string, unknown>): void {
        if (!this.panel) {
            return;
        }
        void this.panel.webview.postMessage({
            command: 'videoAudio',
            videoId,
            ...message
        });
    }

    private postVideoAudioProgress(
        videoId: number,
        phase: 'download' | 'transcode',
        percent: number
    ): void {
        if (!this.panel) {
            return;
        }
        void this.panel.webview.postMessage({
            command: 'videoAudioProgress',
            videoId,
            phase,
            percent
        });
    }

    private runVideoAudioWorker(
        videoId: number,
        sourceUrl: string,
        directory: string,
        cacheKey: string
    ): Promise<string> {
        const finalPath = path.join(directory, `${cacheKey}.mp3`);
        const token = crypto.randomBytes(6).toString('hex');
        const inputPath = path.join(directory, `${cacheKey}.${token}.mp4`);
        const partialPath = path.join(directory, `${cacheKey}.${token}.mp3.part`);
        const workerPath = path.join(this.context.extensionPath, 'dist', 'audioWorker.js');

        return new Promise<string>((resolve, reject) => {
            let worker: Worker | undefined;
            let settled = false;
            const cleanup = (): void => {
                for (const file of [inputPath, partialPath]) {
                    try {
                        fs.unlinkSync(file);
                    } catch {
                        // The worker may have already removed its temporary file.
                    }
                }
            };
            const finish = (error?: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                if (worker) {
                    this.videoAudioWorkers.delete(worker);
                    void worker.terminate();
                }
                if (error) {
                    cleanup();
                    reject(error);
                } else {
                    resolve(finalPath);
                }
            };

            try {
                worker = new Worker(workerPath, {
                    workerData: {
                        url: sourceUrl,
                        inputPath,
                        outputPath: partialPath,
                        messages: {
                            downloadFailed: t('audio.downloadFailed'),
                            noStream: t('audio.noStream'),
                            noTrack: t('audio.noTrack')
                        }
                    }
                });
            } catch (error) {
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }

            this.videoAudioWorkers.add(worker);
            worker.on('message', (message: {
                type?: string;
                phase?: 'download' | 'transcode';
                percent?: number;
                message?: string;
            }) => {
                if (message.type === 'progress' && message.phase) {
                    this.postVideoAudioProgress(
                        videoId,
                        message.phase,
                        Number(message.percent) || 0
                    );
                    return;
                }
                if (message.type === 'done') {
                    try {
                        if (!this.hasVideoAudio(partialPath)) {
                            throw new Error(t('task.audioNotCreated'));
                        }
                        fs.copyFileSync(partialPath, finalPath);
                        cleanup();
                        finish();
                    } catch (error) {
                        finish(error instanceof Error ? error : new Error(String(error)));
                    }
                    return;
                }
                if (message.type === 'error') {
                    finish(new Error(message.message || t('task.audioPrepareFailed')));
                }
            });
            worker.on('error', error => finish(error));
            worker.on('exit', code => {
                if (!settled) {
                    finish(new Error(t('task.audioPrepareExit', { code })));
                }
            });
        });
    }

    private pruneVideoAudioCache(directory: string): void {
        const now = Date.now();
        const audioCutoff = now - 30 * 24 * 60 * 60 * 1000;
        const tempCutoff = now - 24 * 60 * 60 * 1000;
        try {
            for (const name of fs.readdirSync(directory)) {
                const filePath = path.join(directory, name);
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) {
                    continue;
                }
                if (name.endsWith('.mp3') && stat.mtimeMs < audioCutoff) {
                    fs.unlinkSync(filePath);
                } else if (
                    (name.endsWith('.part') || name.endsWith('.mp4')) &&
                    stat.mtimeMs < tempCutoff
                ) {
                    fs.unlinkSync(filePath);
                }
            }
        } catch {
            // Cache pruning is best-effort.
        }
    }

    /**
     * The webview fills the editor group in theater mode, but the group itself
     * may be split. Toggle the group maximization so the video uses the whole
     * editor area, and restore the previous layout when theater mode ends.
     */
    private async setVideoTheater(active: boolean): Promise<void> {
        if (this.videoTheaterActive === active) {
            return;
        }
        this.videoTheaterActive = active;
        try {
            await vscode.commands.executeCommand(
                'workbench.action.toggleMaximizeEditorGroup'
            );
        } catch {
            // Older VS Code versions may not expose this command.
        }
    }

    /** Re-render the task panel after the interface language changed. */
    refreshLocalization(): void {
        if (!this.panel || !this.currentStep) {
            return;
        }
        this.panel.title = t('task.tabTitle', { position: this.currentStep.step.position });
        this.panel.webview.html = this.getHtmlContent(this.currentStep.step);
    }

    dispose(): void {
        if (this.preloadTimer) {
            clearTimeout(this.preloadTimer);
            this.preloadTimer = undefined;
        }
        this.preloadToken++;
        this.preloadedSteps.clear();
        for (const worker of this.videoAudioWorkers) {
            void worker.terminate();
        }
        this.videoAudioWorkers.clear();
        this.videoAudioJobs.clear();
        this.videoTheaterActive = false;
        this.panel?.dispose();
        this.panel = undefined;
    }

    /** Drop all account-specific state after logout. */
    resetForLogout(): void {
        this.dispose();
        this.currentStep = undefined;
        this.currentAccess = undefined;
        this.previousStep = undefined;
        this.nextStep = undefined;
        this.currentAttempt = undefined;
        this.currentDatasetFile = undefined;
        this.currentDatasetFileError = undefined;
        this.currentUserId = undefined;
        this.progressSummary = undefined;
        this.progressError = undefined;
        this.progressToken++;
        this.solutionsAvailabilityCache.clear();
        this.assignmentIdCache.clear();
        this.viewedSteps.clear();
        this.viewRequests.clear();
        this.markedVideoSteps.clear();
    }

    /**
     * Load course-level indicators shown above the task: day streak, total
     * points, completed steps and the distance to the regular certificate.
     * The stepik API exposes them through three separate endpoints, so a
     * failure of one must not hide the others.
     */
    private async loadProgressSummary(stepContext: StepContext): Promise<void> {
        const courseId = stepContext.courseId;
        this.progressSummary = undefined;
        this.progressError = undefined;
        if (!courseId) {
            return;
        }

        const token = ++this.progressToken;
        try {
            const [course, progress, user] = await Promise.all([
                this.api.getCourse(courseId),
                this.api.getCourseProgress(courseId),
                this.api.getCurrentUser()
            ]);
            const activity = user
                ? await this.api.getUserActivitySummary(user.id)
                : null;
            if (token !== this.progressToken) {
                return;
            }

            const score = Math.max(0, Number.parseInt(progress?.score ?? '0', 10) || 0);
            const cost = Math.max(0, Number(progress?.cost ?? 0) || 0);
            const stepsTotal = Math.max(0, Number(progress?.n_steps ?? 0) || 0);
            const stepsPassed = Math.max(
                0,
                Number(progress?.n_steps_passed ?? 0) || 0
            );
            const regularThreshold =
                typeof course?.certificate_regular_threshold === 'number' &&
                course.certificate_regular_threshold > 0
                    ? course.certificate_regular_threshold
                    : undefined;
            const distinctionThreshold =
                typeof course?.certificate_distinction_threshold === 'number' &&
                course.certificate_distinction_threshold > 0
                    ? course.certificate_distinction_threshold
                    : undefined;
            const threshold = regularThreshold ?? distinctionThreshold;
            const percent =
                stepsTotal > 0
                    ? Math.round((stepsPassed / stepsTotal) * 1000) / 10
                    : 0;
            const certificateRemaining =
                typeof threshold === 'number' && threshold > 0
                    ? Math.max(0, threshold - score)
                    : undefined;
            const timeToComplete = Math.max(
                0,
                Number(course?.time_to_complete ?? 0) || 0
            );

            // Stepik estimates the remaining study time by scaling the course
            // duration to the share of points still needed for the certificate.
            const studyTimeHours =
                certificateRemaining !== undefined &&
                certificateRemaining > 0 &&
                cost > 0 &&
                timeToComplete > 0
                    ? Math.round(
                          (certificateRemaining / cost) *
                              (timeToComplete / 3600) *
                              2
                      ) / 2
                    : undefined;

            this.progressSummary = {
                courseId,
                score,
                cost,
                stepsPassed,
                stepsTotal,
                percent,
                streak: Math.max(0, Number(activity?.recent_strike ?? 0) || 0),
                maxStreak: Math.max(0, Number(activity?.max_strike ?? 0) || 0),
                solved: Math.max(0, Number(activity?.solved ?? 0) || 0),
                certificateThreshold:
                    typeof threshold === 'number' && threshold > 0
                        ? threshold
                        : undefined,
                certificateDistinctionThreshold:
                    distinctionThreshold !== undefined &&
                    distinctionThreshold !== threshold
                        ? distinctionThreshold
                        : undefined,
                certificateRemaining,
                studyTimeHours
            };
        } catch (error) {
            if (token !== this.progressToken) {
                return;
            }
            this.progressSummary = undefined;
            this.progressError = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Progress] Не удалось загрузить показатели курса: ${this.progressError}`
            );
        }
    }

    private getProgressHtml(): string {
        const summary = this.progressSummary;
        if (!summary) {
            return this.progressError
                ? `<div class="progress-panel progress-panel-error" title="${this.escapeHtml(
                      this.progressError
                  )}">${t('task.progressLoadError')}</div>`
                : '';
        }

        const points =
            summary.cost > 0
                ? `${summary.score}/${summary.cost}`
                : String(summary.score);
        const streakWord = pluralize(summary.streak, 'task.dayForms');
        const maxStreak = Math.max(summary.maxStreak, summary.streak);
        const maxStreakWord = pluralize(maxStreak, 'task.dayForms');
        const remaining = summary.certificateRemaining;
        const progressPercent =
            summary.cost > 0
                ? Math.min(100, Math.max(0, (summary.score / summary.cost) * 100))
                : 0;
        const markerThresholds = [
            summary.certificateThreshold,
            summary.certificateDistinctionThreshold
        ].filter((value): value is number => typeof value === 'number' && value > 0);
        const markerPositions =
            summary.cost > 0
                ? Array.from(
                      new Set(
                          markerThresholds.map(value =>
                              Number(
                                  Math.min(
                                      100,
                                      Math.max(0, (value / summary.cost) * 100)
                                  ).toFixed(2)
                              )
                          )
                      )
                  ).sort((a, b) => a - b)
                : [];
        const progressMarkers = markerPositions
            .map(
                percent =>
                    `<span class="progress-line-marker" style="left: ${percent}%"></span>`
            )
            .join('');
        let tooltip = '';
        if (summary.certificateThreshold && remaining !== undefined) {
            const pointsLine =
                remaining > 0
                    ? `${t('task.toCertificate')} <span>${this.formatCount(
                          remaining
                      )} ${pluralize(remaining, 'task.pointForms')}</span>`
                    : t('task.certificateReceived');
            const timeLine =
                remaining > 0 && summary.studyTimeHours !== undefined
                    ? `<div class="progress-tooltip-line">${t('task.studyTime')} <span>${this.formatStudyTime(
                          summary.studyTimeHours
                      )}</span></div>`
                    : '';
            tooltip = `
                <div class="progress-tooltip" id="progress-tooltip" role="tooltip">
                    <div class="progress-tooltip-line">${pointsLine}</div>
                    ${timeLine}
                </div>
            `;
        }

        return `
            <div class="progress-panel" id="progress-panel" role="group" aria-label="${t('task.progressAria')}">
                <div class="progress-streak" role="img" tabindex="0" aria-label="${t('task.streakAria', { streak: summary.streak, word: streakWord, max: maxStreak, maxWord: maxStreakWord })}" aria-describedby="progress-streak-tooltip">
                    <svg class="progress-streak-icon" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
                        <g clip-path="url(#stepik-streak-clip)" fill-rule="evenodd" clip-rule="evenodd" fill="currentColor">
                            <path d="M24.891 36.826c1.45-.739 2.868-2.122 6.34-5.595 3.473-3.472 4.856-4.89 5.595-6.34a10.774 10.774 0 000-9.782c-.739-1.45-2.122-2.868-5.595-6.34-3.472-3.473-4.89-4.856-6.34-5.595a10.774 10.774 0 00-9.782 0c-1.45.739-2.868 2.122-6.34 5.595-3.473 3.472-4.856 4.89-5.595 6.34a10.774 10.774 0 000 9.782c.739 1.45 2.122 2.868 5.595 6.34 3.472 3.473 4.89 4.856 6.34 5.595a10.774 10.774 0 009.782 0zM1.392 25.799c.919 1.803 2.6 3.484 5.962 6.847 3.363 3.362 5.044 5.043 6.847 5.962a12.774 12.774 0 0011.598 0c1.803-.919 3.484-2.6 6.847-5.962 3.362-3.363 5.043-5.044 5.962-6.847a12.774 12.774 0 000-11.598c-.919-1.803-2.6-3.484-5.962-6.847-3.363-3.362-5.044-5.043-6.847-5.962a12.774 12.774 0 00-11.598 0c-1.803.919-3.484 2.6-6.847 5.962-3.362 3.363-5.043 5.044-5.962 6.847a12.774 12.774 0 000 11.598z"></path>
                            <path d="M21.398 9.083a1 1 0 01.594 1.041L21.132 17H29a1 1 0 01.768 1.64l-10 12a1 1 0 01-1.76-.764l.86-6.876H11a1 1 0 01-.768-1.64l10-12a1 1 0 011.166-.277zM13.135 21H20a1 1 0 01.992 1.124l-.577 4.616 6.45-7.74H20a1 1 0 01-.992-1.124l.577-4.616-6.45 7.74z"></path>
                        </g>
                        <defs>
                            <clipPath id="stepik-streak-clip">
                                <path fill="currentColor" d="M0 0h40v40H0z"></path>
                            </clipPath>
                        </defs>
                    </svg>
                    <span class="progress-streak-count">${summary.streak}</span>
                    <div class="progress-tooltip progress-tooltip-streak" id="progress-streak-tooltip" role="tooltip">
                        <div class="progress-tooltip-title">${t('task.streakTitle')}</div>
                        <div class="progress-tooltip-line">${t('task.streakLine', { streak: summary.streak, word: streakWord })}</div>
                        <div class="progress-tooltip-line">${t('task.maxStreakLabel')} <span>${maxStreak} ${maxStreakWord}</span></div>
                    </div>
                </div>
                <div class="progress-course"${tooltip ? ' tabindex="0" aria-describedby="progress-tooltip"' : ''}>
                    <div class="progress-course-row">
                        <span class="progress-course-label">${t('task.progressLabel')}</span>
                        <span class="progress-course-score">${this.escapeHtml(points)}</span>
                    </div>
                    <div class="progress-line" role="progressbar" aria-label="${t('task.progressAria')}" aria-valuemin="0" aria-valuemax="${summary.cost}" aria-valuenow="${summary.score}">
                        <div class="progress-line-track">
                            <span class="progress-line-fill" style="width: ${progressPercent.toFixed(2)}%"></span>
                            ${progressMarkers}
                        </div>
                    </div>
                    ${tooltip}
                </div>
            </div>
        `;
    }

    private formatCount(value: number): string {
        return String(Math.max(0, Math.trunc(value))).replace(
            /\B(?=(\d{3})+(?!\d))/g,
            ' '
        );
    }

    private formatStudyTime(hours: number): string {
        const rounded = Math.round(hours * 2) / 2;
        if (!Number.isFinite(rounded) || rounded <= 0) {
            return t('task.lessThanHour');
        }
        const value = Number.isInteger(rounded)
            ? String(rounded)
            : getLanguage() === 'ru'
                ? rounded.toFixed(1).replace('.', ',')
                : rounded.toFixed(1);
        const word = Number.isInteger(rounded)
            ? pluralize(rounded, 'task.hourForms')
            : t('task.hourShort');
        return `${value} ${word}`;
    }

    private pluralizeRu(value: number, one: string, few: string, many: string): string {
        const abs = Math.abs(value) % 100;
        const last = abs % 10;
        if (abs > 10 && abs < 20) {
            return many;
        }
        if (last === 1) {
            return one;
        }
        if (last >= 2 && last <= 4) {
            return few;
        }
        return many;
    }

    private async loadInitialComments(
        stepId: number,
        discussionProxy?: string,
        reuseProxy: boolean = false
    ): Promise<void> {
        const token = ++this.commentsLoadToken;

        this.comments = [];
        this.pinnedComments = [];
        this.loadedCommentIds.clear();
        this.commentUsers.clear();
        this.commentVoteIds.clear();
        this.commentVoteValues.clear();
        this.voteRequests.clear();
        this.repliesCache.clear();
        this.repliesState.clear();
        this.teacherRepliedParents.clear();
        this.commentsPage = 1;
        this.hasMoreComments = false;
        this.commentsError = undefined;
        this.remainingCommentIds = [];
        if (!reuseProxy) {
            this.discussionProxyData = undefined;
        }

        try {
            if (this.commentSort === 'mine') {
                await this.loadMyComments(stepId, token);
            } else if (discussionProxy) {
                if (!this.discussionProxyData || !reuseProxy) {
                    this.discussionProxyData = await this.api.getDiscussionProxy(discussionProxy);
                }
                if (token !== this.commentsLoadToken) {
                    return;
                }
            }

            const proxy = this.discussionProxyData;
            if (this.commentSort === 'mine') {
                // Already handled above; keep the proxy untouched so switching
                // back to a normal sort does not reload it.
            } else if (proxy) {
                await this.loadPinnedComments(proxy, token);
                if (token !== this.commentsLoadToken) {
                    return;
                }
                await this.loadFirstOrderedComments(proxy, token);
            } else {
                await this.loadFirstCommentsPage(stepId, token);
            }
        } catch (error) {
            if (token !== this.commentsLoadToken) {
                return;
            }
            this.commentsError = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Comments] Failed to load comments for step ${stepId}: ${this.commentsError}`
            );
        }
    }

    private async getCurrentUserId(): Promise<number> {
        if (this.currentUserId === undefined) {
            this.currentUserId = (await this.api.getCurrentUser()).id;
        }
        return this.currentUserId;
    }

    /**
     * Stepik's /comments?user= endpoint returns both top-level comments and
     * replies. Load every page, de-duplicate by id and put newest comments
     * first. The response may contain comments from both the default and the
     * solutions threads; callers filter them when necessary.
     */
    private async fetchCommentsByUser(
        stepId: number,
        userId: number
    ): Promise<StepikComment[]> {
        const byId = new Map<number, StepikComment>();

        for (let page = 1; page <= 50; page++) {
            const data = await this.api.getUserComments(stepId, userId, page);

            for (const user of data.users) {
                this.commentUsers.set(user.id, user);
            }
            this.rememberSubmissions(data.submissions);
            this.rememberCommentVotes(data.comments, data.votes);

            for (const comment of data.comments) {
                if (!byId.has(comment.id)) {
                    byId.set(comment.id, comment);
                    this.rememberTeacherReplied(comment);
                }
            }

            if (!data.hasNext || data.comments.length === 0) {
                break;
            }
        }

        return Array.from(byId.values()).sort((a, b) => this.compareByTimeDesc(a, b));
    }

    private async loadMyComments(stepId: number, token: number): Promise<void> {
        const userId = await this.getCurrentUserId();
        if (token !== this.commentsLoadToken) {
            return;
        }

        const comments = await this.fetchCommentsByUser(stepId, userId);
        if (
            token !== this.commentsLoadToken ||
            !this.currentStep ||
            this.currentStep.step.id !== stepId
        ) {
            return;
        }

        this.comments = comments;
        this.pinnedComments = [];
        this.loadedCommentIds = new Set(comments.map(comment => comment.id));
        this.remainingCommentIds = [];
        this.hasMoreComments = false;
    }

    private async loadPinnedComments(proxy: DiscussionProxy, token: number): Promise<void> {
        try {
            // Pinned comments are always first in the proxy order.
            const data = await this.api.getCommentsByIds(proxy.discussions.slice(0, 10));
            if (token !== this.commentsLoadToken) {
                return;
            }

            for (const user of data.users) {
                this.commentUsers.set(user.id, user);
            }
            this.rememberSubmissions(data.submissions);
            this.rememberCommentVotes(data.comments, data.votes);

            const pinned = data.comments.filter(
                comment => comment.parent === null && comment.is_pinned
            );
            for (const comment of pinned) {
                if (!this.loadedCommentIds.has(comment.id)) {
                    this.loadedCommentIds.add(comment.id);
                    this.pinnedComments.push(comment);
                    this.rememberTeacherReplied(comment);
                }
            }
            this.pinnedComments.sort((a, b) => this.compareComments(a, b));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Comments] Failed to load pinned comments: ${message}`
            );
        }
    }

    private async loadFirstOrderedComments(proxy: DiscussionProxy, token: number): Promise<void> {
        const orderIds = this.getOrderIds(proxy).filter(id => !this.loadedCommentIds.has(id));
        if (orderIds.length === 0) {
            this.hasMoreComments = false;
            return;
        }

        if (this.commentSort === 'teacher') {
            // Teacher comments and discussions with teacher replies can be
            // anywhere in the proxy, so load the full top-level list once.
            const comments = await this.fetchTopLevelComments(orderIds);
            if (token !== this.commentsLoadToken) {
                return;
            }
            for (const comment of comments) {
                this.loadedCommentIds.add(comment.id);
            }
            this.comments = comments.sort((a, b) => this.compareTeacherComments(a, b));
            this.remainingCommentIds = [];
            this.hasMoreComments = false;
            return;
        }

        const firstIds = orderIds.slice(0, 20);
        const comments = await this.fetchTopLevelComments(firstIds);
        if (token !== this.commentsLoadToken) {
            return;
        }
        this.comments = comments;
        for (const comment of comments) {
            this.loadedCommentIds.add(comment.id);
        }

        this.remainingCommentIds = orderIds
            .slice(firstIds.length)
            .filter(id => !this.loadedCommentIds.has(id));
        this.hasMoreComments = this.remainingCommentIds.length > 0;
    }

    private async loadFirstCommentsPage(stepId: number, token: number): Promise<void> {
        const page = await this.api.getComments(stepId, 1, null);
        if (token !== this.commentsLoadToken) {
            return;
        }

        for (const user of page.users) {
            this.commentUsers.set(user.id, user);
        }
        this.rememberSubmissions(page.submissions);
        this.rememberCommentVotes(page.comments, page.votes);
        this.commentsPage = page.page;
        this.hasMoreComments = page.hasNext;
        this.addFallbackComments(page.comments, false);
    }

    private getOrderIds(
        proxy: DiscussionProxy,
        sort: CommentSort = this.commentSort
    ): number[] {
        switch (sort) {
            case 'discussed':
                return proxy.discussions_most_active?.length
                    ? proxy.discussions_most_active
                    : proxy.discussions;
            case 'popular':
                return proxy.discussions_most_liked?.length
                    ? proxy.discussions_most_liked
                    : proxy.discussions;
            case 'recent':
                return proxy.discussions_recent_activity?.length
                    ? proxy.discussions_recent_activity
                    : proxy.discussions;
            case 'new':
            case 'teacher':
            case 'mine':
            default:
                return proxy.discussions;
        }
    }

    private rememberSubmissions(submissions: Submission[] | undefined): void {
        for (const submission of submissions || []) {
            this.commentSubmissions.set(submission.id, submission);
        }
    }

    /**
     * Stepik side-loads one vote relation per comment. The comment itself may
     * contain only the relation id, so both sources must be combined before
     * rendering the like/dislike controls.
     */
    private rememberCommentVotes(
        comments: StepikComment[],
        votes: CommentVote[] | undefined
    ): void {
        const votesById = new Map<string, VoteValue>();
        for (const vote of votes || []) {
            if (vote?.id !== undefined && vote?.id !== null) {
                votesById.set(String(vote.id), vote.value ?? null);
            }
        }

        for (const comment of comments) {
            const relation = comment.vote;
            let voteId: string | undefined;

            if (typeof relation === 'string' || typeof relation === 'number') {
                voteId = String(relation);
            } else if (relation && typeof relation === 'object') {
                if (relation.id !== undefined && relation.id !== null) {
                    voteId = String(relation.id);
                }
                if (relation.value !== undefined) {
                    this.commentVoteValues.set(comment.id, relation.value ?? null);
                }
            }

            if (!voteId) {
                // Some API responses omit comment.vote but still side-load
                // the current user's relation with an id ending in -<commentId>.
                const suffix = `-${comment.id}`;
                voteId = Array.from(votesById.keys()).find(id => id.endsWith(suffix));
            }

            if (!voteId) {
                this.commentVoteIds.delete(comment.id);
                this.commentVoteValues.delete(comment.id);
                continue;
            }

            this.commentVoteIds.set(comment.id, voteId);
            if (votesById.has(voteId)) {
                this.commentVoteValues.set(comment.id, votesById.get(voteId) ?? null);
            } else if (!this.commentVoteValues.has(comment.id)) {
                this.commentVoteValues.set(comment.id, null);
            }
        }
    }

    /**
     * Load top-level comments in the exact order of the provided ids. The
     * /comments?ids= endpoint also returns replies; they are not cached here
     * because replies are loaded lazily in pages of 100 when the user expands
     * a thread.
     */
    private async fetchTopLevelComments(ids: number[]): Promise<StepikComment[]> {
        if (ids.length === 0) {
            return [];
        }

        const byId = new Map<number, StepikComment>();
        for (let i = 0; i < ids.length; i += 100) {
            const chunk = ids.slice(i, i + 100);
            const data = await this.api.getCommentsByIds(chunk);

            for (const user of data.users) {
                this.commentUsers.set(user.id, user);
            }
            this.rememberSubmissions(data.submissions);
            this.rememberCommentVotes(data.comments, data.votes);

            for (const comment of data.comments) {
                if (comment.parent === null) {
                    byId.set(comment.id, comment);
                    this.rememberTeacherReplied(comment);
                } else if (comment.parent && comment.user_role === 'teacher') {
                    // The payload contains replies too. Use them only to mark
                    // the parent; the actual thread is loaded on demand.
                    this.teacherRepliedParents.add(comment.parent);
                }
            }
        }

        return ids
            .map(id => byId.get(id))
            .filter((comment): comment is StepikComment => Boolean(comment));
    }

    private addFallbackComments(
        comments: StepikComment[],
        forcePinned: boolean
    ): void {
        const unique = comments.filter(
            comment => comment.parent === null && !this.loadedCommentIds.has(comment.id)
        );
        for (const comment of unique) {
            this.loadedCommentIds.add(comment.id);
            this.rememberTeacherReplied(comment);
        }

        const pinned = unique.filter(comment => forcePinned || comment.is_pinned);
        const normal = unique.filter(comment => !forcePinned && !comment.is_pinned);

        if (pinned.length > 0) {
            this.pinnedComments.push(...pinned);
            this.pinnedComments.sort((a, b) => this.compareComments(a, b));
        }
        if (normal.length > 0) {
            this.comments.push(...normal);
            if (this.commentSort !== 'new') {
                this.comments.sort((a, b) => this.compareComments(a, b));
            }
        }
    }

    private rememberTeacherReplied(comment: StepikComment): void {
        if (comment.is_staff_replied) {
            this.teacherRepliedParents.add(comment.id);
        }
    }

    private compareComments(
        a: StepikComment,
        b: StepikComment,
        sort: CommentSort = this.commentSort
    ): number {
        const pinnedDiff = Number(Boolean(b.is_pinned)) - Number(Boolean(a.is_pinned));
        if (pinnedDiff !== 0) {
            return pinnedDiff;
        }

        switch (sort) {
            case 'discussed':
                return (b.reply_count || 0) - (a.reply_count || 0) ||
                    this.compareByTimeDesc(a, b);
            case 'popular':
                return (b.vote_delta || 0) - (a.vote_delta || 0) ||
                    this.compareByTimeDesc(a, b);
            case 'recent':
                return this.compareByLastTimeDesc(a, b);
            case 'teacher':
                return this.compareTeacherComments(a, b);
            case 'mine':
            case 'new':
            default:
                return this.compareByTimeDesc(a, b);
        }
    }

    private compareByTimeDesc(a: StepikComment, b: StepikComment): number {
        return new Date(b.time).getTime() - new Date(a.time).getTime();
    }

    private compareByLastTimeDesc(a: StepikComment, b: StepikComment): number {
        const aTime = new Date(a.last_time || a.time).getTime();
        const bTime = new Date(b.last_time || b.time).getTime();
        return bTime - aTime;
    }

    private teacherScore(comment: StepikComment): number {
        let score = 0;
        if (comment.user_role === 'teacher') {
            score += 2;
        }
        if (comment.is_staff_replied || this.teacherRepliedParents.has(comment.id)) {
            score += 1;
        }
        return score;
    }

    private compareTeacherComments(a: StepikComment, b: StepikComment): number {
        return this.teacherScore(b) - this.teacherScore(a) ||
            this.compareByTimeDesc(a, b);
    }

    private async loadMoreComments(): Promise<void> {
        if (!this.panel || !this.currentStep || !this.hasMoreComments || this.commentsLoading) {
            return;
        }
        if (this.commentSort === 'mine') {
            this.hasMoreComments = false;
            return;
        }

        const stepId = this.currentStep.step.id;
        const token = this.commentsLoadToken;
        this.commentsLoading = true;
        try {
            if (this.remainingCommentIds.length > 0) {
                const nextIds = this.remainingCommentIds.slice(0, 20);
                const comments = await this.fetchTopLevelComments(nextIds);
                if (
                    token !== this.commentsLoadToken ||
                    !this.panel ||
                    !this.currentStep ||
                    this.currentStep.step.id !== stepId
                ) {
                    return;
                }

                this.remainingCommentIds = this.remainingCommentIds.slice(nextIds.length);
                this.comments.push(...comments);
                for (const comment of comments) {
                    this.loadedCommentIds.add(comment.id);
                }
                this.hasMoreComments = this.remainingCommentIds.length > 0;

                await this.panel.webview.postMessage({
                    command: 'appendComments',
                    html: this.renderCommentsHtml(comments),
                    hasMore: this.hasMoreComments
                });
                return;
            }

            const page = await this.api.getComments(stepId, this.commentsPage + 1, null);
            if (
                token !== this.commentsLoadToken ||
                !this.panel ||
                !this.currentStep ||
                this.currentStep.step.id !== stepId
            ) {
                return;
            }

            for (const user of page.users) {
                this.commentUsers.set(user.id, user);
            }
            this.rememberCommentVotes(page.comments, page.votes);
            this.commentsPage = page.page;
            this.hasMoreComments = page.hasNext;

            if (this.commentSort !== 'new') {
                // Fallback pages are ordered by date. Re-sort the whole loaded
                // list and replace it rather than appending out of order.
                this.addFallbackComments(page.comments, false);
                await this.panel.webview.postMessage({
                    command: 'replaceComments',
                    html: this.renderCommentsListHtml(),
                    hasMore: this.hasMoreComments,
                    count: this.getCommentCount()
                });
                return;
            }

            const before = this.comments.length;
            this.addFallbackComments(page.comments, false);
            const added = this.comments.slice(before);
            await this.panel.webview.postMessage({
                command: 'appendComments',
                html: this.renderCommentsHtml(added),
                hasMore: this.hasMoreComments
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[Comments] Failed to load more comments: ${message}`);
            if (this.panel && this.currentStep && this.currentStep.step.id === stepId) {
                await this.panel.webview.postMessage({
                    command: 'commentsError',
                    message: t('task.commentsLoadError', { detail: message })
                });
            }
        } finally {
            this.commentsLoading = false;
        }
    }

    private async loadReplies(commentId: number, more: boolean = false): Promise<void> {
        if (!this.panel || !this.currentStep) {
            return;
        }

        const stepId = this.currentStep.step.id;
        const state = this.repliesState.get(commentId);

        if (!more) {
            const cached = this.repliesCache.get(commentId);
            if (cached && cached.length > 0 && state) {
                // The thread has already been loaded. Re-send it after a
                // re-render without hitting the API again.
                await this.sendReplies(commentId, cached, true, state.hasMore);
                return;
            }
            // Start from a clean slate. A cache without pagination state is
            // stale (for example, after changing the sort order).
            this.repliesCache.delete(commentId);
            this.repliesState.delete(commentId);
        } else if (!state || !state.hasMore) {
            return;
        }

        if (state?.loading) {
            return;
        }

        const threadState: ReplyThreadState = state || {
            page: 0,
            hasMore: true,
            loading: false
        };
        threadState.loading = true;
        this.repliesState.set(commentId, threadState);

        const gathered: StepikComment[] = [];
        const known = new Set(
            (this.repliesCache.get(commentId) || []).map(comment => comment.id)
        );

        try {
            let pagesFetched = 0;
            while (pagesFetched < REPLIES_PAGES_PER_BATCH && threadState.hasMore) {
                const nextPage = threadState.page + 1;
                let page: CommentsPage | undefined;
                try {
                    page = await this.api.getCommentReplies(
                        commentId,
                        nextPage,
                        COMMENT_PAGE_SIZE
                    );
                } catch (error) {
                    // Stepik answers 404 when a just-deleted reply makes the
                    // next page disappear. Treat it as the end of the thread.
                    if (
                        nextPage > 1 &&
                        error instanceof StepikApiError &&
                        error.status === 404
                    ) {
                        threadState.hasMore = false;
                        break;
                    }
                    throw error;
                }

                if (!page || !this.panel || !this.currentStep || this.currentStep.step.id !== stepId) {
                    return;
                }

                for (const user of page.users) {
                    this.commentUsers.set(user.id, user);
                }
                this.rememberSubmissions(page.submissions);
                this.rememberCommentVotes(page.comments, page.votes);

                for (const reply of page.comments) {
                    if (reply.parent !== commentId || known.has(reply.id)) {
                        continue;
                    }
                    known.add(reply.id);
                    gathered.push(reply);
                }

                threadState.page = page.page || nextPage;
                threadState.hasMore = page.hasNext;
                pagesFetched++;

                if (page.comments.length === 0 && !page.hasNext) {
                    break;
                }
            }

            const cache = this.repliesCache.get(commentId) || [];
            const cacheIds = new Set(cache.map(comment => comment.id));
            for (const reply of gathered) {
                if (!cacheIds.has(reply.id)) {
                    cacheIds.add(reply.id);
                    cache.push(reply);
                }
            }
            this.repliesCache.set(commentId, cache);

            if (cache.some(comment => comment.user_role === 'teacher')) {
                this.teacherRepliedParents.add(commentId);
            }

            await this.sendReplies(
                commentId,
                more ? gathered : cache,
                !more,
                threadState.hasMore
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Comments] Failed to load replies for comment ${commentId}: ${message}`
            );
            if (this.panel && this.currentStep && this.currentStep.step.id === stepId) {
                await this.panel.webview.postMessage({
                    command: 'repliesError',
                    commentId,
                    more,
                    message: t('task.repliesLoadError', { detail: message })
                });
            }
        } finally {
            threadState.loading = false;
        }
    }

    private async sendReplies(
        commentId: number,
        replies: StepikComment[],
        replace: boolean,
        hasMore: boolean
    ): Promise<void> {
        if (!this.panel) {
            return;
        }

        const parent = this.findComment(commentId);
        const teacherReplied = Boolean(
            parent?.is_staff_replied ||
            this.teacherRepliedParents.has(commentId) ||
            replies.some(comment => comment.user_role === 'teacher')
        );
        if (teacherReplied) {
            this.teacherRepliedParents.add(commentId);
        }

        const sort = parent?.thread === 'solutions' ? this.solutionsSort : this.commentSort;
        const sorted = [...replies];
        if (sort === 'teacher') {
            sorted.sort((a, b) => this.compareTeacherComments(a, b));
        } else {
            sorted.sort(
                (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
            );
        }

        await this.panel.webview.postMessage({
            command: 'appendReplies',
            commentId,
            html: this.renderCommentsHtml(sorted),
            hasMore,
            replace,
            teacherReplied,
            total: parent?.reply_count ?? (this.repliesCache.get(commentId) || []).length
        });
    }

    private async loadSolutionsAvailability(
        step: Step,
        forceRefresh: boolean = false
    ): Promise<void> {
        const token = ++this.solutionsToken;
        this.solutionsThread = undefined;
        this.solutionsProxy = undefined;
        this.solutionsComments = [];
        this.solutionsLoadedIds.clear();
        this.solutionsRemainingIds = [];
        this.solutionsAvailable = false;
        this.solutionsLoaded = false;
        this.solutionsLoading = false;
        this.solutionsError = undefined;
        this.solutionsSort = 'new';
        this.solutionsLoadToken++;
        this.repliesState.clear();
        // Submission code is shared by comments and solutions of this step.
        // Clear it once per opened step instead of on every comment reload.
        this.commentSubmissions.clear();

        // Comments exist for material steps too, but the solutions forum is a
        // quiz feature. Stepik shows it for every quiz plugin, not only for
        // code steps.
        if (!this.isQuizStep(step) || !step.discussion_proxy) {
            return;
        }

        const cached = this.solutionsAvailabilityCache.get(step.id);
        if (!forceRefresh && cached && cached.expires > Date.now()) {
            this.solutionsThread = cached.thread;
            this.solutionsAvailable = Boolean(cached.thread);
            return;
        }

        // The tree caches steps briefly. Refresh the step only when the caller
        // explicitly asks for it (for example after a submission unlocked the
        // solutions forum).
        let currentStep = step;
        if (forceRefresh) {
            try {
                const loaded = await this.api.getStep(step.id);
                if (token !== this.solutionsToken) {
                    return;
                }
                if (loaded) {
                    currentStep = loaded;
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.outputChannel.appendLine(
                    `[Solutions] Failed to refresh step ${step.id}: ${message}`
                );
            }
        }

        const proxyId = currentStep.discussion_proxy || step.discussion_proxy;
        if (!proxyId) {
            return;
        }

        // Stepik names the default and solutions threads with suffixes -1/-2.
        // The second thread is returned only when the forum is unlocked, so it
        // is the same signal the website uses (`discussion_threads.length > 1`).
        const listedIds = new Set<string>(currentStep.discussion_threads || []);
        const candidates = new Set<string>(listedIds);
        const derived = proxyId.replace(/-1$/, '-2');
        if (derived !== proxyId) {
            candidates.add(derived);
        }

        let solutions: DiscussionThread | undefined;
        const returnedIds = new Set<string>();
        try {
            const threads = await this.api.getDiscussionThreads(
                Array.from(candidates),
                forceRefresh
            );
            if (token !== this.solutionsToken) {
                return;
            }
            for (const thread of threads) {
                returnedIds.add(thread.id);
            }
            solutions = threads.find(thread => thread.thread === 'solutions');
        } catch (error) {
            if (token !== this.solutionsToken) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Solutions] Failed to load threads for step ${step.id}: ${message}`
            );
        }

        // The batch endpoint hides locked threads as empty results instead of
        // returning 403, so query every candidate it did not return. This is
        // also the fallback when the batch request fails entirely.
        if (!solutions) {
            for (const id of candidates) {
                if (returnedIds.has(id)) {
                    continue;
                }
                try {
                    const thread = await this.api.getDiscussionThread(id, forceRefresh);
                    if (token !== this.solutionsToken) {
                        return;
                    }
                    if (thread && thread.thread === 'solutions') {
                        solutions = thread;
                        break;
                    }
                } catch (threadError) {
                    if (token !== this.solutionsToken) {
                        return;
                    }
                    // Locked and missing threads return 403/404. They simply
                    // mean that the solutions forum is not available yet.
                    const status =
                        threadError instanceof StepikApiError
                            ? threadError.status
                            : 0;
                    if (status !== 403 && status !== 404) {
                        const threadMessage =
                            threadError instanceof Error
                                ? threadError.message
                                : String(threadError);
                        this.outputChannel.appendLine(
                            `[Solutions] Thread ${id} is not available: ${threadMessage}`
                        );
                    }
                }
            }
        }

        // The freshly loaded step explicitly lists a second thread. Trust that
        // signal even if the metadata request failed, so a temporary API error
        // does not hide the whole forum.
        if (!solutions) {
            const listedSolutionsId = Array.from(listedIds).find(id => id !== proxyId);
            if (listedSolutionsId) {
                solutions = {
                    id: listedSolutionsId,
                    thread: 'solutions',
                    discussions_count: 0,
                    discussion_proxy: listedSolutionsId
                };
            }
        }

        if (token !== this.solutionsToken) {
            return;
        }

        this.solutionsThread = solutions;
        this.solutionsAvailable = Boolean(solutions);
        this.solutionsAvailabilityCache.set(step.id, {
            expires: Date.now() + (solutions ? 5 * 60_000 : 60_000),
            thread: solutions
        });

        if (solutions) {
            this.outputChannel.appendLine(
                `[Solutions] Forum is available for step ${step.id} (thread ${solutions.id})`
            );
        } else if (forceRefresh) {
            this.outputChannel.appendLine(
                `[Solutions] Forum is still locked for step ${step.id} ` +
                `(threads: ${Array.from(listedIds).join(', ') || 'none'})`
            );
        }
    }

    private async notifySolutionsAvailability(): Promise<void> {
        if (!this.panel) {
            return;
        }
        const step = this.currentStep?.step;
        const available = Boolean(
            step && this.isQuizStep(step) && this.solutionsThread
        );
        await this.panel.webview.postMessage({
            command: 'solutionsAvailability',
            available,
            count: this.solutionsThread?.discussions_count || 0,
            message: available ? '' : this.getSolutionsLockedMessage()
        });
    }

    /**
     * A submission can unlock the solutions forum. Stepik may create the
     * solutions thread with a short delay, so recheck a few times instead of
     * waiting for the user to reopen the step.
     */
    private async refreshSolutionsAvailabilityAfterSubmit(stepId: number): Promise<void> {
        const step = this.currentStep?.step;
        if (!step || step.id !== stepId) {
            return;
        }
        if (this.solutionsThread) {
            await this.notifySolutionsAvailability();
            return;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
            await this.loadSolutionsAvailability(step, true);
            if (this.solutionsThread) {
                break;
            }
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        await this.notifySolutionsAvailability();
    }

    private async loadSolutionSubmissions(stepId: number, notify: boolean = false): Promise<void> {
        const token = ++this.solutionSubmissionsToken;
        this.solutionSubmissions = [];
        this.solutionSubmissionsError = undefined;

        try {
            const submissions = await this.api.getUserSubmissions(stepId);
            if (
                token !== this.solutionSubmissionsToken ||
                !this.currentStep ||
                this.currentStep.step.id !== stepId
            ) {
                return;
            }
            this.solutionSubmissions = submissions;
            this.rememberSubmissions(submissions);
        } catch (error) {
            if (
                token !== this.solutionSubmissionsToken ||
                !this.currentStep ||
                this.currentStep.step.id !== stepId
            ) {
                return;
            }
            this.solutionSubmissionsError = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Solutions] Failed to load submissions for step ${stepId}: ${this.solutionSubmissionsError}`
            );
        }

        if (notify && this.panel) {
            await this.panel.webview.postMessage({
                command: 'solutionSubmissionsLoaded',
                optionsHtml: this.getSolutionSubmissionOptionsHtml(),
                hint: this.getSolutionSubmissionHint(),
                hasSubmissions: this.solutionSubmissions.length > 0
            });
        }
    }

    private async loadSolutions(forceReload: boolean = false): Promise<void> {
        if (!this.panel || !this.currentStep) {
            return;
        }
        if (this.solutionsLoading && !forceReload) {
            return;
        }

        let thread = this.solutionsThread;
        if (!thread) {
            // The tab is visible for every quiz step. Recheck the forum when
            // it is opened so a solution submitted in another window or on
            // stepik.org is picked up without reopening the step.
            await this.loadSolutionsAvailability(this.currentStep.step, true);
            await this.notifySolutionsAvailability();
            thread = this.solutionsThread;
        }
        if (!thread) {
            await this.panel.webview.postMessage({
                command: 'solutionsError',
                message: this.getSolutionsLockedMessage()
            });
            return;
        }

        const stepId = this.currentStep.step.id;
        if (!forceReload) {
            // The user may have submitted a new solution after the panel was
            // opened. Refresh the selector before the solutions tab is shown.
            await this.loadSolutionSubmissions(stepId, true);
        }
        const token = ++this.solutionsLoadToken;
        this.solutionsLoading = true;

        if (forceReload) {
            this.solutionsComments = [];
            this.solutionsLoadedIds.clear();
            this.solutionsRemainingIds = [];
            this.solutionsLoaded = false;
            this.solutionsError = undefined;
        }

        try {
            if (this.solutionsSort === 'mine') {
                const userId = await this.getCurrentUserId();
                const allComments = await this.fetchCommentsByUser(stepId, userId);
                if (token !== this.solutionsLoadToken) {
                    return;
                }

                const mine = allComments.filter(comment => comment.thread === 'solutions');
                this.solutionsComments = mine;
                this.solutionsLoadedIds = new Set(mine.map(comment => comment.id));
                this.solutionsRemainingIds = [];
                this.solutionsLoaded = true;
                this.solutionsError = undefined;

                await this.panel.webview.postMessage({
                    command: 'solutionsLoaded',
                    html: this.renderCommentsHtml(mine),
                    hasMore: false
                });
                return;
            }

            let proxy = this.solutionsProxy;
            if (!proxy || forceReload) {
                proxy = await this.api.getDiscussionProxy(thread.discussion_proxy);
                if (token !== this.solutionsLoadToken) {
                    return;
                }
                if (!proxy) {
                    throw new Error(t('task.forumEmpty'));
                }
                this.solutionsProxy = proxy;
            }

            const orderIds = this.getOrderIds(proxy, this.solutionsSort)
                .filter(id => !this.solutionsLoadedIds.has(id));

            let comments: StepikComment[];
            let hasMore: boolean;

            if (this.solutionsSort === 'teacher') {
                // Teacher solutions and threads with teacher replies can be
                // anywhere in the proxy, so load the full solutions list.
                comments = await this.fetchTopLevelComments(orderIds);
                if (token !== this.solutionsLoadToken) {
                    return;
                }
                comments.sort((a, b) => this.compareTeacherComments(a, b));
                this.solutionsRemainingIds = [];
                hasMore = false;
            } else {
                const firstIds = orderIds.slice(0, 20);
                comments = await this.fetchTopLevelComments(firstIds);
                if (token !== this.solutionsLoadToken) {
                    return;
                }
                this.solutionsRemainingIds = orderIds
                    .slice(firstIds.length)
                    .filter(id => !this.solutionsLoadedIds.has(id));
                hasMore = this.solutionsRemainingIds.length > 0;
            }

            this.solutionsComments = comments;
            for (const comment of comments) {
                this.solutionsLoadedIds.add(comment.id);
            }
            this.solutionsLoaded = true;
            this.solutionsError = undefined;

            await this.panel.webview.postMessage({
                command: 'solutionsLoaded',
                html: this.renderCommentsHtml(comments),
                hasMore
            });
        } catch (error) {
            if (token !== this.solutionsLoadToken) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.solutionsError = message;
            this.outputChannel.appendLine(`[Solutions] Failed to load: ${message}`);
            if (this.panel && this.currentStep && this.currentStep.step.id === stepId) {
                await this.panel.webview.postMessage({
                    command: 'solutionsError',
                    message: t('task.solutionsLoadError', { detail: message })
                });
            }
        } finally {
            if (token === this.solutionsLoadToken) {
                this.solutionsLoading = false;
            }
        }
    }

    private async loadMoreSolutions(): Promise<void> {
        if (!this.panel || !this.currentStep || this.solutionsLoading) {
            return;
        }
        if (this.solutionsSort === 'mine') {
            await this.panel.webview.postMessage({
                command: 'appendSolutions',
                html: '',
                hasMore: false
            });
            return;
        }

        const stepId = this.currentStep.step.id;
        const token = ++this.solutionsLoadToken;
        this.solutionsLoading = true;

        if (this.solutionsRemainingIds.length === 0) {
            this.solutionsLoading = false;
            await this.panel.webview.postMessage({
                command: 'appendSolutions',
                html: '',
                hasMore: false
            });
            return;
        }

        try {
            const nextIds = this.solutionsRemainingIds.slice(0, 20);
            const comments = await this.fetchTopLevelComments(nextIds);
            if (
                token !== this.solutionsLoadToken ||
                !this.panel ||
                !this.currentStep ||
                this.currentStep.step.id !== stepId
            ) {
                return;
            }

            this.solutionsRemainingIds = this.solutionsRemainingIds.slice(nextIds.length);
            this.solutionsComments.push(...comments);
            for (const comment of comments) {
                this.solutionsLoadedIds.add(comment.id);
            }

            await this.panel.webview.postMessage({
                command: 'appendSolutions',
                html: this.renderCommentsHtml(comments),
                hasMore: this.solutionsRemainingIds.length > 0
            });
        } catch (error) {
            if (token !== this.solutionsLoadToken) {
                return;
            }
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[Solutions] Failed to load more: ${message}`);
            if (this.panel && this.currentStep && this.currentStep.step.id === stepId) {
                await this.panel.webview.postMessage({
                    command: 'solutionsError',
                    message: t('task.solutionsLoadError', { detail: message })
                });
            }
        } finally {
            if (token === this.solutionsLoadToken) {
                this.solutionsLoading = false;
            }
        }
    }

    private async postComment(
        text: string,
        parentId?: number,
        thread?: 'default' | 'solutions',
        submissionId?: number,
        format: 'html' | 'markdown' = 'markdown'
    ): Promise<void> {
        if (!this.panel || !this.currentStep) {
            return;
        }

        const stepId = this.currentStep.step.id;
        const trimmed = (text || '').trim();
        const plainText =
            format === 'html' ? this.htmlToText(trimmed) : trimmed;
        const hasImage = format === 'html' && /<img\b/i.test(trimmed);
        if (!plainText && !hasImage) {
            await this.panel.webview.postMessage({
                command: 'commentPostError',
                parentId,
                thread,
                message: t('task.enterCommentText')
            });
            return;
        }
        if (trimmed.length > 150000) {
            await this.panel.webview.postMessage({
                command: 'commentPostError',
                parentId,
                thread,
                message: t('task.commentTooLong')
            });
            return;
        }

        try {
            const parent = parentId ? this.findComment(parentId) : undefined;
            const solutionParent = Boolean(
                parentId && this.solutionsComments.some(comment => comment.id === parentId)
            );
            const targetThread: 'default' | 'solutions' =
                parent?.thread === 'solutions' || solutionParent || thread === 'solutions'
                    ? 'solutions'
                    : 'default';
            const isTopLevelSolution = !parentId && targetThread === 'solutions';
            let attachedSubmission: Submission | undefined;
            if (isTopLevelSolution) {
                attachedSubmission = submissionId
                    ? this.solutionSubmissions.find(submission => submission.id === submissionId)
                    : undefined;
                if (!attachedSubmission) {
                    const reason = this.solutionSubmissionsError
                        ? t('task.solutionSubmissionsLoadError', { detail: this.solutionSubmissionsError })
                        : this.solutionSubmissions.length === 0
                            ? t('task.noSubmittedSolutionsHint')
                            : t('task.selectSolutionHint');
                    await this.panel.webview.postMessage({
                        command: 'commentPostError',
                        thread: 'solutions',
                        message: reason
                    });
                    return;
                }
            }

            const createdResult = await this.api.createComment(
                stepId,
                this.formatCommentForApi(trimmed, format),
                parentId,
                targetThread,
                attachedSubmission?.id
            );
            const created = createdResult.comment;
            for (const user of createdResult.users) {
                this.commentUsers.set(user.id, user);
            }
            this.rememberSubmissions(createdResult.submissions);
            this.rememberCommentVotes([created], createdResult.votes);
            if (attachedSubmission && !created.submission) {
                created.submission = attachedSubmission.id;
            }

            if (parentId) {
                this.repliesCache.delete(parentId);
                this.repliesState.delete(parentId);
                if (parent) {
                    parent.reply_count = (parent.reply_count || 0) + 1;
                }
                await this.loadReplies(parentId, false);
                if (!this.panel || !this.currentStep || this.currentStep.step.id !== stepId) {
                    return;
                }

                // The fresh reply usually belongs to the last page of a large
                // thread. Append it explicitly so the author sees it without
                // loading every page.
                const cached = this.repliesCache.get(parentId) || [];
                if (!cached.some(comment => comment.id === created.id)) {
                    cached.push(created);
                    this.repliesCache.set(parentId, cached);
                    const state = this.repliesState.get(parentId);
                    await this.sendReplies(
                        parentId,
                        [created],
                        false,
                        state?.hasMore ?? false
                    );
                }

                await this.panel.webview.postMessage({
                    command: 'replyPosted',
                    commentId: parentId
                });
            } else if (targetThread === 'solutions') {
                await this.loadSolutions(true);
                if (!this.panel || !this.currentStep || this.currentStep.step.id !== stepId) {
                    return;
                }

                if (this.solutionsError) {
                    await this.panel.webview.postMessage({
                        command: 'commentPostError',
                        thread: 'solutions',
                        message: t('task.solutionsRefreshError', { detail: this.solutionsError })
                    });
                    return;
                }

                // A freshly created solution may not be present in the proxy
                // yet. Add it to the visible list so the author sees it right
                // away, keeping the selected sort order.
                if (!this.solutionsLoadedIds.has(created.id)) {
                    this.solutionsComments.push(created);
                    this.solutionsComments.sort((a, b) =>
                        this.solutionsSort === 'teacher'
                            ? this.compareTeacherComments(a, b)
                            : this.compareComments(a, b, this.solutionsSort)
                    );
                    this.solutionsLoadedIds.add(created.id);
                    this.solutionsRemainingIds = this.solutionsRemainingIds.filter(
                        id => id !== created.id
                    );
                    await this.panel.webview.postMessage({
                        command: 'solutionsLoaded',
                        html: this.renderCommentsHtml(this.solutionsComments),
                        hasMore: this.solutionsRemainingIds.length > 0
                    });
                }

                await this.panel.webview.postMessage({
                    command: 'commentPosted',
                    thread: 'solutions'
                });
            } else {
                await this.loadInitialComments(stepId, this.currentStep.step.discussion_proxy, true);
                if (!this.panel || !this.currentStep || this.currentStep.step.id !== stepId) {
                    return;
                }
                if (this.commentsError) {
                    await this.panel.webview.postMessage({
                        command: 'commentPostError',
                        message: t('task.commentsRefreshError', { detail: this.commentsError })
                    });
                } else {
                    await this.panel.webview.postMessage({
                        command: 'replaceComments',
                        html: this.renderCommentsListHtml(),
                        hasMore: this.hasMoreComments,
                        count: this.getCommentCount()
                    });
                    await this.panel.webview.postMessage({ command: 'commentPosted' });
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(`[Comments] Failed to post comment: ${message}`);
            if (this.panel && this.currentStep && this.currentStep.step.id === stepId) {
                await this.panel.webview.postMessage({
                    command: 'commentPostError',
                    parentId,
                    thread,
                    message: t('task.sendError', { detail: message })
                });
            }
        }
    }

    private async respondToCommentEditor(
        message: WebviewMessage,
        data?: Record<string, unknown>,
        error?: string
    ): Promise<void> {
        if (!this.panel || !message.requestId) {
            return;
        }
        await this.panel.webview.postMessage({
            command: 'commentEditorResponse',
            requestId: message.requestId,
            ok: !error,
            data: data || {},
            error
        });
    }

    private async handleCommentEditorRequest(message: WebviewMessage): Promise<void> {
        try {
            switch (message.command) {
                case 'commentEditorToMarkdown': {
                    const markdown = this.commentHtmlToMarkdown(message.html || '');
                    await this.respondToCommentEditor(message, { markdown });
                    return;
                }
                case 'commentEditorToHtml': {
                    const html = this.formatCommentForApi(
                        message.markdown || '',
                        'markdown'
                    );
                    await this.respondToCommentEditor(message, { html });
                    return;
                }
                case 'renderMathPreview': {
                    const formula = (message.formula || '').trim().slice(0, 10000);
                    if (!formula) {
                        await this.respondToCommentEditor(message, { html: '' });
                        return;
                    }
                    const html = katex.renderToString(formula, {
                        displayMode: Boolean(message.display),
                        throwOnError: false,
                        strict: 'ignore',
                        trust: false,
                        output: 'mathml'
                    });
                    await this.respondToCommentEditor(message, { html });
                    return;
                }
                case 'uploadCommentImage': {
                    if (!message.data) {
                        throw new Error(t('task.imageNotTransferred'));
                    }
                    const buffer = Buffer.from(message.data, 'base64');
                    if (buffer.length === 0) {
                        throw new Error(t('task.imageFileEmpty'));
                    }
                    if (buffer.length > 15 * 1024 * 1024) {
                        throw new Error(t('task.imageTooLarge'));
                    }
                    const uploaded = await uploadCommentImage(
                        new Uint8Array(buffer),
                        message.name || 'image.png',
                        message.mimeType || 'image/png'
                    );
                    await this.respondToCommentEditor(message, {
                        url: uploaded.url,
                        width: uploaded.width,
                        height: uploaded.height,
                        alt: uploaded.name || message.name || ''
                    });
                    return;
                }
                case 'loadCommentEditor': {
                    if (!message.commentId) {
                        throw new Error(t('task.commentNotFound'));
                    }
                    const comment = this.findComment(message.commentId);
                    if (!comment) {
                        throw new Error(t('task.commentNotFound'));
                    }
                    await this.respondToCommentEditor(message, {
                        html: this.sanitizeCommentHtml(comment.text || '')
                    });
                    return;
                }
                case 'commentEditorResponse':
                    return;
                default:
                    return;
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            await this.respondToCommentEditor(message, undefined, detail);
        }
    }

    private replaceCachedComment(updated: StepikComment): void {
        const replaceIn = (list: StepikComment[]): void => {
            const index = list.findIndex(comment => comment.id === updated.id);
            if (index >= 0) {
                list[index] = { ...list[index], ...updated };
            }
        };

        replaceIn(this.comments);
        replaceIn(this.pinnedComments);
        replaceIn(this.solutionsComments);
        for (const replies of this.repliesCache.values()) {
            replaceIn(replies);
        }
    }

    private async updateCommentFromEditor(
        commentId: number,
        text: string,
        format: 'html' | 'markdown'
    ): Promise<void> {
        if (!this.panel) {
            return;
        }
        const existing = this.findComment(commentId);
        if (!existing) {
            await this.panel.webview.postMessage({
                command: 'commentActionError',
                commentId,
                message: t('task.commentNotFound')
            });
            return;
        }

        const html = this.formatCommentForApi(text, format);
        if (!this.htmlToText(html) && !/<img\b/i.test(html)) {
            await this.panel.webview.postMessage({
                command: 'commentActionError',
                commentId,
                message: t('task.commentEmpty')
            });
            return;
        }

        try {
            const result = await this.api.updateComment(commentId, html);
            const updated: StepikComment = {
                ...existing,
                ...(result.comment || {}),
                id: commentId,
                text: result.comment?.text || html
            };
            for (const user of result.users) {
                this.commentUsers.set(user.id, user);
            }
            this.rememberSubmissions(result.submissions);
            this.rememberCommentVotes([updated], result.votes);
            this.replaceCachedComment(updated);

            await this.panel.webview.postMessage({
                command: 'commentUpdated',
                commentId,
                bodyHtml: this.renderCommentBodyHtml(updated)
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Comments] Не удалось изменить комментарий ${commentId}: ${detail}`
            );
            await this.panel.webview.postMessage({
                command: 'commentActionError',
                commentId,
                message: t('task.commentUpdateError', { detail })
            });
        }
    }

    private async deleteCommentFromEditor(commentId: number): Promise<void> {
        if (!this.panel) {
            return;
        }
        const comment = this.findComment(commentId);
        if (!comment) {
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            t('task.removeConfirm'),
            { modal: true },
            t('task.deleteConfirmButton')
        );
        if (confirmation !== t('task.deleteConfirmButton')) {
            await this.panel.webview.postMessage({
                command: 'commentActionCancelled',
                commentId
            });
            return;
        }

        try {
            await this.api.deleteComment(commentId);
            const isSolution =
                comment.thread === 'solutions' ||
                this.solutionsComments.some(item => item.id === commentId);

            await this.panel.webview.postMessage({
                command: 'commentDeleted',
                commentId,
                thread: isSolution ? 'solutions' : 'default'
            });

            if (isSolution) {
                await this.loadSolutions(true);
            } else if (this.currentStep) {
                await this.loadInitialComments(
                    this.currentStep.step.id,
                    this.currentStep.step.discussion_proxy,
                    true
                );
                if (!this.commentsError) {
                    await this.sendCommentsReplacement();
                }
            }
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Comments] Не удалось удалить комментарий ${commentId}: ${detail}`
            );
            await this.panel.webview.postMessage({
                command: 'commentActionError',
                commentId,
                message: t('task.commentDeleteError', { detail })
            });
        }
    }

    private async copyCommentLink(commentId: number): Promise<void> {
        if (!this.panel || !this.currentStep) {
            return;
        }
        const comment = this.findComment(commentId);
        if (!comment) {
            return;
        }

        const step = this.currentStep.step;
        const discussionId = comment.parent ?? comment.id;
        const params = new URLSearchParams();
        params.set('discussion', String(discussionId));
        if (comment.parent) {
            params.set('reply', String(comment.id));
        }
        if (
            comment.thread === 'solutions' ||
            this.solutionsComments.some(item => item.id === commentId)
        ) {
            params.set('thread', 'solutions');
        }
        const url = `https://stepik.org/lesson/${step.lesson}/step/${step.position}?${params.toString()}`;

        try {
            await vscode.env.clipboard.writeText(url);
            await this.panel.webview.postMessage({
                command: 'commentLinkCopied',
                commentId,
                url
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            await this.panel.webview.postMessage({
                command: 'commentActionError',
                commentId,
                message: t('task.copyLinkError', { detail })
            });
        }
    }

    private async changeCommentVote(
        commentId: number,
        value: 'epic' | 'abuse'
    ): Promise<void> {
        if (!this.panel) {
            return;
        }

        const comment = this.findComment(commentId);
        const voteId = this.commentVoteIds.get(commentId);
        if (!comment || !voteId) {
            await this.panel.webview.postMessage({
                command: 'voteError',
                commentId,
                vote: this.commentVoteValues.get(commentId) ?? null,
                epicCount: Math.max(0, comment?.epic_count || 0),
                abuseCount: Math.max(0, comment?.abuse_count || 0),
                message: t('task.voteUnavailable')
            });
            return;
        }

        if (this.currentUserId !== undefined && comment.user === this.currentUserId) {
            await this.panel.webview.postMessage({
                command: 'voteError',
                commentId,
                vote: this.commentVoteValues.get(commentId) ?? null,
                epicCount: Math.max(0, Number(comment.epic_count) || 0),
                abuseCount: Math.max(0, Number(comment.abuse_count) || 0),
                message: t('task.voteOwnError')
            });
            return;
        }

        if (this.voteRequests.has(commentId)) {
            return;
        }
        this.voteRequests.add(commentId);

        const previous = this.commentVoteValues.get(commentId) ?? null;
        // Clicking the active button removes the vote; clicking the opposite
        // button changes it. This matches the Stepik web/Android behaviour.
        const next: VoteValue = previous === value ? null : value;

        try {
            const saved = await this.api.saveVote(voteId, next);
            const actual: VoteValue = saved ? saved.value ?? null : next;
            let epic = Math.max(0, Number(comment.epic_count) || 0);
            let abuse = Math.max(0, Number(comment.abuse_count) || 0);

            if (previous === 'epic') {
                epic--;
            } else if (previous === 'abuse') {
                abuse--;
            }
            if (actual === 'epic') {
                epic++;
            } else if (actual === 'abuse') {
                abuse++;
            }

            epic = Math.max(0, epic);
            abuse = Math.max(0, abuse);
            this.applyCommentVoteState(commentId, actual, epic, abuse);

            if (!this.panel) {
                return;
            }
            await this.panel.webview.postMessage({
                command: 'voteUpdated',
                commentId,
                vote: actual,
                epicCount: epic,
                abuseCount: abuse,
                voteDelta: epic - abuse
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Comments] Failed to change vote for comment ${commentId}: ${message}`
            );
            if (!this.panel) {
                return;
            }
            await this.panel.webview.postMessage({
                command: 'voteError',
                commentId,
                vote: previous,
                epicCount: Math.max(0, Number(comment.epic_count) || 0),
                abuseCount: Math.max(0, Number(comment.abuse_count) || 0),
                message: t('task.voteChangeError', { detail: message })
            });
        } finally {
            this.voteRequests.delete(commentId);
        }
    }

    private applyCommentVoteState(
        commentId: number,
        value: VoteValue,
        epicCount: number,
        abuseCount: number
    ): void {
        const apply = (comment: StepikComment) => {
            if (comment.id !== commentId) {
                return;
            }
            comment.epic_count = epicCount;
            comment.abuse_count = abuseCount;
            comment.vote_delta = epicCount - abuseCount;
        };

        for (const comment of this.comments) {
            apply(comment);
        }
        for (const comment of this.pinnedComments) {
            apply(comment);
        }
        for (const comment of this.solutionsComments) {
            apply(comment);
        }
        for (const replies of this.repliesCache.values()) {
            for (const comment of replies) {
                apply(comment);
            }
        }

        this.commentVoteValues.set(commentId, value);
    }

    private findComment(commentId: number): StepikComment | undefined {
        const topLevel =
            this.comments.find(comment => comment.id === commentId) ||
            this.pinnedComments.find(comment => comment.id === commentId) ||
            this.solutionsComments.find(comment => comment.id === commentId);

        if (topLevel) {
            return topLevel;
        }

        // Reply buttons point at the top-level comment, but keep this fallback
        // for nested replies that are already cached.
        for (const replies of this.repliesCache.values()) {
            const reply = replies.find(comment => comment.id === commentId);
            if (reply) {
                return reply;
            }
        }

        return undefined;
    }

    /**
     * Stepik comments accept HTML, so render the composer's Markdown locally
     * and send the resulting safe HTML. Math delimiters ($...$, \(...\), \[...\])
     * are left untouched and are rendered by Stepik/KaTeX when displayed.
     */
    private formatCommentForApi(
        text: string,
        format: 'html' | 'markdown' = 'markdown'
    ): string {
        const normalized = text.replace(/\r\n/g, '\n').trim();
        if (!normalized) {
            return '';
        }

        // The rich editor already produces Stepik-compatible HTML. Only the
        // sanitizer and the <strike> normalization are applied.
        if (format === 'html') {
            return this.sanitizeCommentHtml(normalized);
        }

        // Markdown-it consumes backslash escapes such as \( and \[, which are
        // Stepik's TeX delimiters. Temporary placeholders keep every formula
        // intact while the rest of the comment is rendered as Markdown.
        const math: string[] = [];
        const tokenBase = `\uE000stepik-markdown-math-${crypto.randomBytes(6).toString('hex')}-`;
        const tokenSuffix = '\uE001';
        const protectMath = (value: string): string => {
            const token = `${tokenBase}${math.length}${tokenSuffix}`;
            math.push(value);
            return token;
        };

        let source = normalized;
        source = source.replace(/\$\$[\s\S]+?\$\$/g, match => protectMath(match));
        source = source.replace(/\\\[[\s\S]+?\\\]/g, match => protectMath(match));
        source = source.replace(/\\\([\s\S]+?\\\)/g, match => protectMath(match));
        source = source.replace(
            /(?<!\\)\$(?!\s)((?:\\.|[^$\\])+?)(?<!\s)(?<!\\)\$/g,
            match => protectMath(match)
        );

        const html = this.sanitizeCommentHtml(this.commentMarkdown.render(source));
        return html.replace(
            new RegExp(`${tokenBase}(\\d+)${tokenSuffix}`, 'g'),
            (_match, index: string) => this.escapeHtml(math[Number(index)] ?? '')
        );
    }

    private getComposerToolbarHtml(): string {
        return `
            <div class="composer-toolbar" role="toolbar" aria-label="${t('task.formattingAria')}">
                <button type="button" class="format-btn" data-format="bold" title="${t('task.formatBold')}"><strong>B</strong></button>
                <button type="button" class="format-btn" data-format="italic" title="${t('task.formatItalic')}"><em>I</em></button>
                <button type="button" class="format-btn" data-format="code" title="${t('task.formatCode')}">&lt;/&gt;</button>
                <button type="button" class="format-btn" data-format="link" title="${t('task.formatLink')}">${t('task.formatLinkLabel')}</button>
                <button type="button" class="format-btn" data-format="quote" title="${t('task.formatQuote')}">${t('task.formatQuoteLabel')}</button>
                <button type="button" class="format-btn" data-format="list" title="${t('task.formatList')}">${t('task.formatListLabel')}</button>
                <button type="button" class="format-btn" data-format="codeblock" title="${t('task.formatCodeBlock')}">${t('task.formatCodeLabel')}</button>
                <span class="composer-toolbar-hint">Markdown</span>
            </div>
        `;
    }

    private renderCommentsHtml(comments: StepikComment[]): string {
        return comments
            .map(comment => this.getCommentHtml(comment, this.commentUsers.get(comment.user)))
            .join('');
    }

    private renderCommentsListHtml(): string {
        const pinnedHtml = this.renderCommentsHtml(this.pinnedComments);
        const commentsHtml = this.renderCommentsHtml(this.comments);
        const emptyText = this.commentSort === 'mine'
            ? t('task.commentsEmpty')
            : t('task.commentsEmptyOther');
        const emptyHtml = this.pinnedComments.length + this.comments.length === 0
            ? `<div class="comments-empty">${emptyText}</div>`
            : '';
        return `${pinnedHtml}${commentsHtml}${emptyHtml}`;
    }

    private getCommentCount(): number {
        if (this.commentSort === 'mine') {
            return this.pinnedComments.length + this.comments.length;
        }
        const total = this.currentStep?.step.discussions_count;
        if (typeof total === 'number' && total > 0) {
            return total;
        }
        return this.pinnedComments.length + this.comments.length;
    }

    private async sendCommentsReplacement(): Promise<void> {
        if (!this.panel) {
            return;
        }
        await this.panel.webview.postMessage({
            command: 'replaceComments',
            html: this.renderCommentsListHtml(),
            hasMore: this.hasMoreComments,
            count: this.getCommentCount()
        });
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        switch (message.command) {
            case 'selectLanguage':
                if (message.language && this.currentStep) {
                    try {
                        await this.createSolutionFile(this.currentStep, message.language);
                    } catch (error) {
                        const detail = error instanceof Error ? error.message : String(error);
                        this.outputChannel.appendLine(
                            `[Solutions] Не удалось создать файл решения: ${detail}`
                        );
                        vscode.window.showErrorMessage(
                            t('task.createSolutionFileError', { detail })
                        );
                    }
                }
                break;
            case 'submitQuiz':
                await this.submitQuiz(message);
                break;
            case 'restart':
                if (this.currentStep) {
                    // The user explicitly asked for a fresh attempt and
                    // refreshed dataset/options.
                    await this.createAttemptForStep(this.currentStep.step, true);
                    if (this.panel) {
                        this.panel.webview.html = this.getHtmlContent(this.currentStep.step);
                    }
                }
                break;
            case 'previousStep':
                if (this.previousStep) {
                    await this.showStep(this.previousStep);
                }
                break;
            case 'nextStep':
                if (this.nextStep) {
                    await this.showStep(this.nextStep);
                }
                break;
            case 'loadMoreComments':
                await this.loadMoreComments();
                break;
            case 'loadReplies':
                if (message.commentId) {
                    await this.loadReplies(message.commentId, Boolean(message.more));
                }
                break;
            case 'postComment':
                await this.postComment(
                    message.text || '',
                    message.parentId,
                    message.thread,
                    message.submissionId,
                    message.format === 'html' ? 'html' : 'markdown'
                );
                break;
            case 'vote':
                if (message.commentId && (message.vote === 'epic' || message.vote === 'abuse')) {
                    await this.changeCommentVote(message.commentId, message.vote);
                }
                break;
            case 'commentEditorToMarkdown':
            case 'commentEditorToHtml':
            case 'renderMathPreview':
            case 'uploadCommentImage':
            case 'loadCommentEditor':
                await this.handleCommentEditorRequest(message);
                break;
            case 'updateComment':
                if (message.commentId) {
                    await this.updateCommentFromEditor(
                        message.commentId,
                        message.text || '',
                        message.format === 'html' ? 'html' : 'markdown'
                    );
                }
                break;
            case 'deleteComment':
                if (message.commentId) {
                    await this.deleteCommentFromEditor(message.commentId);
                }
                break;
            case 'copyCommentLink':
                if (message.commentId) {
                    await this.copyCommentLink(message.commentId);
                }
                break;
            case 'openExternalUrl':
                if (message.url && /^https?:\/\//i.test(message.url)) {
                    await vscode.env.openExternal(vscode.Uri.parse(message.url));
                }
                break;
            case 'changeSort':
                if (message.sort && this.currentStep && this.panel) {
                    this.commentSort = message.sort;
                    await this.loadInitialComments(
                        this.currentStep.step.id,
                        this.currentStep.step.discussion_proxy,
                        true
                    );
                    if (this.commentsError) {
                        this.panel.webview.html = this.getHtmlContent(this.currentStep.step);
                    } else {
                        await this.sendCommentsReplacement();
                    }
                }
                break;
            case 'changeSolutionsSort':
                if (message.sort && this.currentStep && this.panel) {
                    this.solutionsSort = message.sort;
                    await this.loadSolutions(true);
                }
                break;
            case 'recheckSolutions':
                if (this.currentStep) {
                    await this.loadSolutionsAvailability(this.currentStep.step, true);
                    await this.notifySolutionsAvailability();
                }
                break;
            case 'loadSolutions':
                await this.loadSolutions();
                break;
            case 'loadMoreSolutions':
                await this.loadMoreSolutions();
                break;
            case 'markVideoViewed':
                if (this.currentStep && this.currentStep.step.block.name === 'video') {
                    await this.markVideoStepViewed(this.currentStep.step.id);
                }
                break;
            case 'videoReady':
                if (this.currentStep && this.currentStep.step.block.name === 'video') {
                    const step = this.currentStep.step;
                    void this.prepareVideoAudio(step).catch(error =>
                        this.postVideoAudioError(step.block.video?.id ?? step.id, error)
                    );
                }
                break;
            case 'openVideoUrl':
                if (message.url && /^https:\/\//i.test(message.url)) {
                    await vscode.env.openExternal(vscode.Uri.parse(message.url));
                }
                break;
            case 'videoTheater':
                void this.setVideoTheater(Boolean(message.active));
                break;
            case 'reloadComments':
                if (this.currentStep && this.panel) {
                    await this.loadInitialComments(
                        this.currentStep.step.id,
                        this.currentStep.step.discussion_proxy
                    );
                    if (this.commentsError) {
                        this.panel.webview.html = this.getHtmlContent(this.currentStep.step);
                    } else {
                        await this.sendCommentsReplacement();
                    }
                }
                break;
        }
    }

    private postQuizStatus(kind: 'info' | 'success' | 'error', text: string): void {
        if (this.panel) {
            void this.panel.webview.postMessage({ command: 'quizStatus', kind, text });
        }
    }

    private buildQuizReply(stepType: string, message: WebviewMessage): QuizReply | undefined {
        if (message.reply) {
            return message.reply;
        }

        const reply: QuizReply = {};
        if (stepType === 'choice') {
            reply.choices = message.choices;
        } else if (stepType === 'string') {
            reply.text = message.text;
        } else if (stepType === 'number') {
            reply.number = message.number;
        }
        return reply;
    }

    private validateQuizReply(stepType: string, reply: QuizReply): string | undefined {
        const dataset = this.getAttemptDataset();

        if (stepType === 'choice') {
            if (!Array.isArray(reply.choices)) {
                return t('task.chooseOption');
            }
            return undefined;
        }

        if (stepType === 'string') {
            if (typeof reply.text !== 'string') {
                return t('task.enterAnswer');
            }
            return undefined;
        }

        if (stepType === 'number') {
            if (typeof reply.number !== 'string' || !reply.number.trim()) {
                return t('task.enterNumber');
            }
            return undefined;
        }

        if (stepType === 'math') {
            if (typeof reply.formula !== 'string' || !reply.formula.trim()) {
                return t('task.enterFormula');
            }
            return undefined;
        }

        if (stepType === 'free-answer') {
            if (typeof reply.text !== 'string' || !reply.text.trim()) {
                return t('task.writeAnswer');
            }
            return undefined;
        }

        if (stepType === 'sorting') {
            const expected = dataset?.options?.length ?? 0;
            if (!Array.isArray(reply.ordering) || reply.ordering.length !== expected) {
                return t('task.orderItems');
            }
            return undefined;
        }

        if (stepType === 'matching') {
            const expected = dataset?.pairs?.length ?? 0;
            if (!Array.isArray(reply.ordering) || reply.ordering.length !== expected) {
                return t('task.matchAll');
            }
            return undefined;
        }

        if (stepType === 'table') {
            const rows = dataset?.rows?.length ?? 0;
            const columns = dataset?.columns?.length ?? 0;
            if (!Array.isArray(reply.choices) || reply.choices.length !== rows) {
                return t('task.fillTable');
            }
            const valid = (reply.choices as TableRowChoice[]).every(
                row => Array.isArray(row.columns) && row.columns.length === columns
            );
            return valid ? undefined : t('task.fillTable');
        }

        if (stepType === 'fill-blanks') {
            const expected = (dataset?.components || []).filter(
                component => component.type !== 'text'
            ).length;
            if (!Array.isArray(reply.blanks) || reply.blanks.length !== expected) {
                return t('task.fillBlanks');
            }
            return undefined;
        }

        if (stepType === 'sql') {
            if (typeof reply.solve_sql !== 'string' || !reply.solve_sql.trim()) {
                return t('task.enterSql');
            }
            return undefined;
        }

        if (stepType === 'html') {
            if (typeof reply.html !== 'string' || !reply.html.trim()) {
                return t('task.enterHtml');
            }
            return undefined;
        }

        if (stepType === 'dataset') {
            if (typeof reply.file !== 'string' || !reply.file.trim()) {
                return t('task.enterDataset');
            }
            return undefined;
        }

        if (stepType === 'chemical') {
            if (!Array.isArray(reply.slots)) {
                return t('task.fillFormulaParts');
            }
            return undefined;
        }

        if (stepType === 'puzzle') {
            return typeof reply.solved === 'boolean' ? undefined : t('task.solvePuzzle');
        }

        return undefined;
    }

    private async submitQuiz(message: WebviewMessage): Promise<void> {
        if (!this.currentStep || !this.currentAttempt) {
            this.postQuizStatus('error', t('task.noActiveAttempt'));
            return;
        }

        const stepType = this.currentStep.step.block.name;
        const stepId = this.currentStep.step.id;
        const reply = this.buildQuizReply(stepType, message);

        if (!reply) {
            this.postQuizStatus('error', t('task.replyBuildError'));
            return;
        }

        // Re-check section access right before sending: the exam session may
        // have expired while the form was open.
        let access: { ok: boolean; reason?: string };
        try {
            access = await this.treeProvider.canSubmit(this.currentStep.section?.id);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.postQuizStatus('error', t('task.sectionAccessError', { detail }));
            return;
        }
        if (!access.ok) {
            this.postQuizStatus(
                'error',
                access.reason || t('task.submitUnavailable')
            );
            return;
        }

        const validationError = this.validateQuizReply(stepType, reply);
        if (validationError) {
            this.postQuizStatus('error', validationError);
            return;
        }

        try {
            this.postQuizStatus('info', t('task.submitting'));
            const submission = await this.api.submitQuiz(this.currentAttempt.id, reply);
            this.postQuizStatus('info', t('task.checking'));
            const result = await this.pollSubmissionResult(submission.id);

            if (result.status === 'correct') {
                // Mark step as passed locally for instant UI update
                this.treeProvider.markStepAsPassed(stepId);
                this.treeProvider.refresh();

                const detail = combineSubmissionFeedback(result.hint, result.feedback);
                this.postQuizStatus(
                    'success',
                    t('task.correctScore', { score: result.score }) +
                        (detail ? `\n${detail}` : '')
                );
                vscode.window.showInformationMessage(
                    t('task.correctScore', { score: result.score })
                );

                // Delay to allow API to update progress, then full refresh
                await new Promise(resolve => setTimeout(resolve, 1000));
                this.treeProvider.forceRefresh();
            } else {
                const detail = combineSubmissionFeedback(result.hint, result.feedback);
                this.postQuizStatus(
                    'error',
                    t('task.wrongAnswer') + (detail ? `\n${detail}` : '')
                );

                const showDetails = t('submit.showDetails');
                vscode.window.showErrorMessage(
                    t('task.wrongAnswer'),
                    showDetails
                ).then(selection => {
                    if (selection === showDetails) {
                        this.outputChannel.show();
                    }
                });

                // Output detailed error to output channel
                this.outputChannel.appendLine('═'.repeat(50));
                this.outputChannel.appendLine(`❌ Quiz Result: ${result.status}`);
                this.outputChannel.appendLine(`Step ID: ${stepId}`);
                this.outputChannel.appendLine(`Score: ${result.score}`);
                if (detail) {
                    this.outputChannel.appendLine(`\nFeedback: ${detail}`);
                }
                this.outputChannel.appendLine('═'.repeat(50));
                this.outputChannel.appendLine('');
            }

            // Any submission can unlock the solutions forum (a correct answer
            // or the configured number of attempts). Recheck it in the
            // background and refresh the submissions for the solution
            // composer without reopening the step.
            this.solutionsAvailabilityCache.delete(stepId);
            void this.loadSolutionSubmissions(stepId, true);
            void this.refreshSolutionsAvailabilityAfterSubmit(stepId);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.postQuizStatus('error', t('task.submitError', { detail }));
            vscode.window.showErrorMessage(t('submit.failed', { detail }));
        }
    }

    private async pollSubmissionResult(
        submissionId: number,
        maxAttempts: number = 30,
        intervalMs: number = 1000
    ): Promise<{ status: string; score: number; hint: string; feedback: string }> {
        for (let i = 0; i < maxAttempts; i++) {
            const submission = await this.api.getSubmission(submissionId);
            
            if (submission.status !== 'evaluation') {
                return submission;
            }

            await new Promise(resolve => setTimeout(resolve, intervalMs));
        }

        throw new Error('Submission evaluation timeout');
    }

    private async createSolutionFile(stepContext: StepContext, language: string): Promise<void> {
        const { step, courseName, lessonTitle } = stepContext;
        
        // Sanitize names for the filesystem. Dots are also normalized so a
        // title like ".." cannot escape the workspace directory.
        const safeName = (name: string) => {
            const cleaned = (name || '')
                .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
                .replace(/^\.+$/, '_')
                .replace(/[. ]+$/g, '')
                .trim()
                .substring(0, 50);
            return cleaned || 'untitled';
        };
        const courseDir = safeName(courseName);
        const lessonDir = safeName(lessonTitle);

        // Solutions live in the active account folder under `~/stepik`, even
        // when another folder (or no folder at all) is open in VS Code.
        let solutionRoot: string;
        try {
            solutionRoot = path.resolve(getActiveSolutionRoot());
            fs.mkdirSync(solutionRoot, { recursive: true });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(
                t('task.createSolutionFolderError', { path: getActiveSolutionRoot(), detail })
            );
            return;
        }

        const dirPath = path.resolve(solutionRoot, courseDir, lessonDir);
        const relativeDir = path.relative(solutionRoot, dirPath);
        if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) {
            vscode.window.showErrorMessage(t('task.invalidCourseName'));
            return;
        }
        
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

        // Open in editor. Stepik often uses versioned language ids like
        // "python3.12", so make sure the editor really uses the Python mode
        // even if the file was created earlier with a .txt extension.
        let doc = await vscode.workspace.openTextDocument(filePath);
        if (language.toLowerCase().startsWith('python')) {
            doc = await vscode.languages.setTextDocumentLanguage(doc, 'python');
        }
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

        // Store step info for submission
        this.storeStepMapping(filePath, step.id, language, stepContext.section?.id);
    }

    private storeStepMapping(
        filePath: string,
        stepId: number,
        language: string,
        sectionId?: number
    ): void {
        const mappingPath = getMappingPath();

        let mapping: {
            [key: string]: { stepId: number; language: string; sectionId?: number };
        } = {};
        
        if (fs.existsSync(mappingPath)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    mapping = parsed;
                }
            } catch {
                this.outputChannel.appendLine(
                    `[Mapping] Не удалось прочитать ${mappingPath}; файл будет перезаписан.`
                );
            }
        } else {
            fs.mkdirSync(path.dirname(mappingPath), { recursive: true });
        }

        mapping[filePath] = { stepId, language, sectionId };

        // Store one canonical entry per file. VS Code may report the drive
        // letter in lowercase while Node keeps it uppercase, which used to
        // create duplicate keys that the submit command could not match.
        const canonicalPath = path.resolve(filePath);
        const canonicalKey = getComparableFilePath(canonicalPath);
        for (const existingPath of Object.keys(mapping)) {
            if (
                existingPath !== canonicalPath &&
                getComparableFilePath(existingPath) === canonicalKey
            ) {
                delete mapping[existingPath];
            }
        }
        if (canonicalPath !== filePath) {
            delete mapping[filePath];
        }
        mapping[canonicalPath] = { stepId, language, sectionId };

        fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));
    }

    private getFileExtension(language: string): string {
        const extensions: { [key: string]: string } = {
            // Python
            'python3': '.py',
            'python': '.py',
            'python2': '.py',
            'python31': '.py',
            // C/C++
            'cpp': '.cpp',
            'c++': '.cpp',
            'cpp11': '.cpp',
            'c++11': '.cpp',
            'cpp14': '.cpp',
            'c++14': '.cpp',
            'cpp17': '.cpp',
            'c++17': '.cpp',
            'cpp20': '.cpp',
            'c++20': '.cpp',
            'c': '.c',
            'c11': '.c',
            // Java
            'java': '.java',
            'java8': '.java',
            'java11': '.java',
            'java17': '.java',
            // JavaScript/TypeScript
            'javascript': '.js',
            'js': '.js',
            'nodejs': '.js',
            'typescript': '.ts',
            'ts': '.ts',
            // Other languages
            'kotlin': '.kt',
            'go': '.go',
            'golang': '.go',
            'rust': '.rs',
            'csharp': '.cs',
            'c#': '.cs',
            'ruby': '.rb',
            'php': '.php',
            'scala': '.scala',
            'haskell': '.hs',
            'hs': '.hs',
            'sql': '.sql',
            'swift': '.swift',
            'r': '.r',
            'perl': '.pl',
            'octave': '.m',
            'matlab': '.m',
            'bash': '.sh',
            'shell': '.sh',
            'clojure': '.clj',
            'mono c#': '.cs',
            'asm32': '.asm',
            'asm64': '.asm',
        };
        // Try exact match first, then lowercase, then without a version suffix.
        // Stepik uses ids like "python3.12", "cpp17", "java21", etc.
        const normalized = language.toLowerCase();
        const base = normalized.replace(/[.\d]+$/, '');
        return extensions[language] || extensions[normalized] || extensions[base] || '.txt';
    }

    private getHtmlContent(step: Step): string {
        const stepType = step.block.name;
        const isCodeTask = stepType === 'code';
        const isQuizTask = ATTEMPT_STEP_TYPES.has(stepType);
        const nonce = crypto.randomBytes(16).toString('hex');
        
        const languages = step.block.options?.code_templates 
            ? Object.keys(step.block.options.code_templates) 
            : [];

        const languageSelector = isCodeTask && languages.length > 0 
            ? this.getLanguageSelectorHtml(languages)
            : '';

        const quizSection = isQuizTask
            ? this.getQuizHtml(step)
            : '';

        const samples = step.block.options?.samples || [];
        const samplesHtml = samples.length > 0
            ? this.getSamplesHtml(samples)
            : '';

        const videoSection = stepType === 'video'
            ? this.getVideoHtml(step)
            : '';
        const taskText = (step.block.text || '').trim();
        const taskContent = taskText
            ? `<div class="task-content">
        ${highlightCodeBlocks(
            this.renderMathInHtml(this.sanitizeStepHtml(taskText)),
            this.getStepCodeLanguage()
        )}
    </div>`
            : '';

        const stepUrl = `https://stepik.org/lesson/${step.lesson}/step/${step.position}`;
        const navigation = this.getNavigationHtml();
        const examBanner = this.getExamBannerHtml();
        const strings = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
        
        return `<!DOCTYPE html>
<html lang="${getLanguage()}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: ${this.panel?.webview.cspSource ?? ''}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src https: data:; media-src https: ${this.panel?.webview.cspSource ?? ''};">
    <title>${t('task.panelTitle', { position: step.position })}</title>
    <style>
        ${this.getStyles()}
    </style>
</head>
<body data-view="task">
    ${stepikBrandHtml()}
    <div class="task-shell">
        <div class="step-header">
            ${navigation}
            <a href="${stepUrl}" class="stepik-link" data-external="true">${t('task.openOnStepik')}</a>
        </div>

        ${examBanner}

        <div class="task-type">${this.escapeHtml(getStepTypeTitle(stepType))}</div>
        ${this.getProgressHtml()}

        ${taskContent}
        ${videoSection}

        ${languageSelector}
        ${quizSection}
        ${samplesHtml}
        ${this.getCommentsSectionHtml()}
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const L = ${strings};
        function t(key, params) {
            const template = L[key] || key;
            if (!params) {
                return template;
            }
            return template.replace(/\\{(\\w+)\\}/g, (match, name) =>
                params[name] === undefined ? match : String(params[name])
            );
        }
        function plural(key, count) {
            const forms = String(L[key] || '').split('|');
            if (L.__lang === 'en') {
                return count === 1 ? (forms[0] || '') : (forms[2] || forms[1] || forms[0] || '');
            }
            const abs = Math.abs(count) % 100;
            const last = abs % 10;
            if (abs > 10 && abs < 20) { return forms[2] || forms[0] || ''; }
            if (last > 1 && last < 5) { return forms[1] || forms[0] || ''; }
            if (last === 1) { return forms[0] || ''; }
            return forms[2] || forms[0] || '';
        }
        window.StepikI18n = { L, t, plural };
        ${this.getScript(stepType, step)}
    </script>
    <script nonce="${nonce}">
        ${getRichCommentEditorScript()}
    </script>
    <script nonce="${nonce}">
        ${this.getCommentsScript()}
    </script>
</body>
</html>`;
    }

    private getNavigationHtml(): string {
        const previousDisabled = this.previousStep ? '' : ' disabled';
        const nextDisabled = this.nextStep ? '' : ' disabled';
        return `
            <div class="step-navigation">
                <button type="button" class="step-nav-btn" data-step-nav="previous"${previousDisabled} title="${t('task.previousStepTitle')}">${t('task.previous')}</button>
                <button type="button" class="step-nav-btn" data-step-nav="next"${nextDisabled} title="${t('task.nextStepTitle')}">${t('task.next')}</button>
            </div>
        `;
    }

    private getExamDeadline(): number | undefined {
        const session = this.currentAccess?.examSession;
        if (!session) {
            return undefined;
        }
        if (session.end_date) {
            const parsed = Date.parse(session.end_date);
            if (!Number.isNaN(parsed)) {
                return parsed;
            }
        }
        if (typeof session.time_left === 'number') {
            return Date.now() + session.time_left * 1000;
        }
        return undefined;
    }

    private getExamBannerHtml(): string {
        const access = this.currentAccess;
        if (!access?.isExam || !access.examSession) {
            return '';
        }
        const seconds = getSessionTimeLeft(access.examSession) ?? 0;
        const deadline = this.getExamDeadline();
        return `
            <div class="exam-banner" id="exam-banner" data-exam-deadline="${deadline ?? ''}">
                <span class="exam-badge">${t('task.exam')}</span>
                <span id="exam-timer">${t('task.examTimeLeft', { time: formatDuration(seconds) })}</span>
                <span class="exam-expired" id="exam-expired" hidden>${t('task.examExpired')}</span>
            </div>
        `;
    }

    private getLanguageSelectorHtml(languages: string[]): string {
        return `
            <div class="language-selector">
                <label>${t('task.selectLanguage')}</label>
                <select id="language-select">
                    <option value="">${t('task.chooseLanguage')}</option>
                    ${languages.map(lang => `<option value="${this.escapeHtml(lang)}">${this.escapeHtml(lang)}</option>`).join('')}
                </select>
                <button id="open-btn" disabled>${t('task.openInEditor')}</button>
            </div>
        `;
    }

    private getQuizContentHtml(content: string): string {
        return highlightCodeBlocks(
            this.renderMathInHtml(this.sanitizeStepHtml(content || '')),
            this.getStepCodeLanguage()
        );
    }

    private htmlToText(html: string): string {
        if (!html) {
            return '';
        }

        return html
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<\/(?:p|div|li|tr|blockquote)>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/\s+/g, ' ')
            .trim();
    }

    private getQuizStatusHtml(): string {
        return `
            <div id="quiz-status" class="quiz-status" role="status" aria-live="polite"></div>
            <div class="quiz-actions">
                <button id="submit-quiz-btn">${t('task.submit')}</button>
                <button id="restart-btn" class="secondary">${t('task.newAttempt')}</button>
            </div>
        `;
    }

    private getQuizErrorHtml(message: string, retry: boolean = true): string {
        return `
            <div class="quiz-section">
                <div class="quiz-error">${this.escapeHtml(message)}</div>
                ${retry ? `<div class="quiz-actions"><button id="restart-btn" class="secondary">${t('task.retry')}</button></div>` : ''}
            </div>
        `;
    }

    private getQuizHtml(step: Step): string {
        const stepType = step.block.name;
        const dataset = this.getAttemptDataset() || {};

        if (stepType !== 'puzzle' && !this.currentAttempt) {
            return this.getQuizErrorHtml(
                t('task.createAttemptFailed')
            );
        }

        if (stepType === 'choice') {
            const options = dataset.options || [];
            const isMultiple = dataset.is_multiple_choice ?? false;
            const inputType = isMultiple ? 'checkbox' : 'radio';
            return `
                <div class="quiz-section">
                    <div class="quiz-options">
                        ${options.map((opt, i) => `
                            <label class="quiz-option">
                                <input type="${inputType}" name="choice" value="${i}" data-index="${i}">
                                <span>${this.getQuizContentHtml(opt)}</span>
                            </label>
                        `).join('')}
                    </div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'string') {
            const textDisabled = dataset.is_text_disabled === true;
            return `
                <div class="quiz-section">
                    ${textDisabled ? `<div class="quiz-warning">${t('task.textOnlyFileWarning')}</div>` : ''}
                    <div class="quiz-input">
                        <input type="text" id="string-input" placeholder="${t('task.answerPlaceholder')}" autocomplete="off">
                    </div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'number') {
            return `
                <div class="quiz-section">
                    <div class="quiz-input">
                        <input type="number" id="number-input" placeholder="${t('task.numberPlaceholder')}" step="any">
                    </div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'math') {
            return `
                <div class="quiz-section">
                    <label class="quiz-label" for="math-input">${t('task.formulaLabel')}</label>
                    <textarea id="math-input" class="quiz-textarea formula-input" rows="2" spellcheck="false" placeholder="${t('task.formulaPlaceholder')}"></textarea>
                    <div class="quiz-hint">${t('task.formulaHint')}</div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'free-answer') {
            return `
                <div class="quiz-section">
                    <label class="quiz-label" for="free-answer-input">${t('task.freeAnswerLabel')}</label>
                    <textarea id="free-answer-input" class="quiz-textarea" rows="7" placeholder="${t('task.freeAnswerPlaceholder')}"></textarea>
                    <div class="quiz-hint">${dataset.is_html_enabled ? t('task.freeAnswerHintHtml') : t('task.freeAnswerHint')}</div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'sorting') {
            const options = dataset.options || [];
            return `
                <div class="quiz-section">
                    <div class="quiz-hint">${t('task.sortingHint')}</div>
                    <ul class="sorting-list" id="sorting-list">
                        ${options.map((option, index) => `
                            <li class="sorting-item" draggable="true" data-index="${index}">
                                <span class="sorting-handle" aria-hidden="true">⠿</span>
                                <span class="sorting-text">${this.getQuizContentHtml(option)}</span>
                                <span class="sorting-controls">
                                    <button type="button" class="icon-btn" data-move="up" title="${t('task.moveUp')}" aria-label="${t('task.moveUp')}">↑</button>
                                    <button type="button" class="icon-btn" data-move="down" title="${t('task.moveDown')}" aria-label="${t('task.moveDown')}">↓</button>
                                </span>
                            </li>
                        `).join('')}
                    </ul>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'matching') {
            const pairs = dataset.pairs || [];
            return `
                <div class="quiz-section">
                    <div class="quiz-hint">${t('task.matchingHint')}</div>
                    <div class="matching-list">
                        ${pairs.map((pair, index) => `
                            <div class="matching-row">
                                <div class="matching-left">${this.getQuizContentHtml(pair.first)}</div>
                                <select class="matching-select" data-left-index="${index}" aria-label="${this.escapeHtml(t('task.matchingAria', { item: this.htmlToText(pair.first) }))}">
                                    ${pairs.map((candidate, candidateIndex) => `
                                        <option value="${candidateIndex}" ${candidateIndex === index ? 'selected' : ''}>${this.escapeHtml(this.htmlToText(candidate.second) || '—')}</option>
                                    `).join('')}
                                </select>
                            </div>
                        `).join('')}
                    </div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'table') {
            const rows = dataset.rows || [];
            const columns = dataset.columns || [];
            const isCheckbox = dataset.is_checkbox ?? false;
            return `
                <div class="quiz-section">
                    ${dataset.description ? `<div class="quiz-hint">${this.getQuizContentHtml(dataset.description)}</div>` : ''}
                    <div class="table-scroll">
                        <table class="quiz-table">
                            <thead>
                                <tr>
                                    <th></th>
                                    ${columns.map(column => `<th>${this.getQuizContentHtml(column)}</th>`).join('')}
                                </tr>
                            </thead>
                            <tbody>
                                ${rows.map((row, rowIndex) => `
                                    <tr>
                                        <th scope="row">${this.getQuizContentHtml(row)}</th>
                                        ${columns.map((column, columnIndex) => `
                                            <td>
                                                <input type="${isCheckbox ? 'checkbox' : 'radio'}"
                                                    ${isCheckbox ? '' : `name="table-row-${rowIndex}"`}
                                                    data-row-index="${rowIndex}"
                                                    data-column-index="${columnIndex}"
                                                    aria-label="${this.escapeHtml(this.htmlToText(row))} — ${this.escapeHtml(this.htmlToText(column))}">
                                            </td>
                                        `).join('')}
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'fill-blanks') {
            const components = dataset.components || [];
            let blankIndex = 0;
            const parts = components.map(component => {
                if (component.type === 'text') {
                    return `<span class="fill-blank-text">${this.getQuizContentHtml(component.text || '')}</span>`;
                }

                const currentIndex = blankIndex++;
                if (component.type === 'select') {
                    const options = component.options || [];
                    return `<select class="blank-select" data-blank-index="${currentIndex}" aria-label="${t('task.blankAria', { number: currentIndex + 1 })}">
                        <option value="">${t('task.blankChoose')}</option>
                        ${options.map(option => `<option value="${this.escapeHtml(option)}">${this.escapeHtml(this.htmlToText(option))}</option>`).join('')}
                    </select>`;
                }

                return `<input type="text" class="blank-input" data-blank-index="${currentIndex}" autocomplete="off" aria-label="${t('task.blankAria', { number: currentIndex + 1 })}">`;
            });
            return `
                <div class="quiz-section">
                    <div class="fill-blanks">${parts.join('')}</div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'sql') {
            return `
                <div class="quiz-section">
                    <label class="quiz-label" for="sql-input">${t('task.sqlLabel')}</label>
                    <textarea id="sql-input" class="quiz-textarea code-input" rows="8" spellcheck="false" placeholder="SELECT ..."></textarea>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'html') {
            const htmlTemplate = step.block.options?.html_template || '';
            const cssTemplate = step.block.options?.css_template || '';
            const checklist = step.block.options?.checklist || [];
            return `
                <div class="quiz-section">
                    <div class="html-editors">
                        <label class="quiz-label" for="html-input">HTML</label>
                        <textarea id="html-input" class="quiz-textarea code-input" rows="14" spellcheck="false">${this.escapeHtml(htmlTemplate)}</textarea>
                        <label class="quiz-label" for="css-input">CSS</label>
                        <textarea id="css-input" class="quiz-textarea code-input" rows="8" spellcheck="false">${this.escapeHtml(cssTemplate)}</textarea>
                    </div>
                    ${checklist.length > 0 ? `
                        <div class="html-checklist">
                            <div class="quiz-hint">${t('task.whatChecked')}</div>
                            <ul>${checklist.map(item => `<li>${this.escapeHtml(item.name || '')}</li>`).join('')}</ul>
                        </div>
                    ` : ''}
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'dataset') {
            let fileHtml: string;
            if (this.currentDatasetFile !== undefined) {
                fileHtml = `<pre class="dataset-file">${this.escapeHtml(this.currentDatasetFile)}</pre>`;
            } else if (this.currentDatasetFileError) {
                fileHtml = `<div class="quiz-error">${t('task.datasetLoadError', { detail: this.escapeHtml(this.currentDatasetFileError) })}</div>`;
            } else {
                fileHtml = `<div class="quiz-hint">${t('task.datasetLoading')}</div>`;
            }

            return `
                <div class="quiz-section">
                    <div class="dataset-header">${t('task.datasetHeader')}</div>
                    ${fileHtml}
                    <label class="quiz-label" for="dataset-input">${t('task.datasetSolutionLabel')}</label>
                    <textarea id="dataset-input" class="quiz-textarea code-input" rows="12" spellcheck="false" placeholder="${t('task.datasetPlaceholder')}"></textarea>
                    <div class="quiz-hint">${t('task.datasetHint')}</div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'chemical') {
            const template = dataset.template || [];
            return `
                <div class="quiz-section">
                    <div class="quiz-hint">${t('task.chemicalHint')}</div>
                    <div class="chemical-slots">
                        ${template.map((slotType, index) => `
                            <div class="chemical-slot" data-slot-index="${index}" data-slot-type="${this.escapeHtml(slotType)}">
                                ${slotType === 'normal' || slotType === 'subsup' ? `
                                    <label>${t('task.partNormal')}<input type="text" data-slot-part="normal" autocomplete="off"></label>
                                ` : ''}
                                ${slotType === 'sub' || slotType === 'subsup' ? `
                                    <label>${t('task.partSub')}<input type="text" data-slot-part="sub" autocomplete="off"></label>
                                ` : ''}
                                ${slotType === 'sup' || slotType === 'subsup' ? `
                                    <label>${t('task.partSup')}<input type="text" data-slot-part="sup" autocomplete="off"></label>
                                ` : ''}
                            </div>
                        `).join('')}
                    </div>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        if (stepType === 'puzzle') {
            return `
                <div class="quiz-section">
                    ${dataset.image_src ? `<img class="puzzle-image" src="${this.escapeHtml(String(dataset.image_src))}" alt="${t('task.puzzleAlt')}">` : ''}
                    <label class="quiz-option">
                        <input type="checkbox" id="puzzle-solved">
                        <span>${t('task.puzzleSolved')}</span>
                    </label>
                    ${this.getQuizStatusHtml()}
                </div>
            `;
        }

        return '';
    }

    private getSamplesHtml(samples: Array<[string, string]>): string {
        return `
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
        `;
    }

    /**
     * Video steps carry their media in `block.video`, not in `block.text`.
     * Render the MP4 variants with native controls, optional subtitle tracks
     * and a quality selector. The poster is shown while the video is loading.
     */
    private getVideoHtml(step: Step): string {
        const video = step.block.video;
        const stepUrl = `https://stepik.org/lesson/${step.lesson}/step/${step.position}`;

        const sources = (video?.urls || [])
            .map(source => ({
                quality: String(source?.quality || '').trim(),
                url: this.normalizeMediaUrl(source?.url)
            }))
            .filter((source): source is { quality: string; url: string } => Boolean(source.url))
            .sort(
                (left, right) =>
                    this.videoQualityValue(right.quality) - this.videoQualityValue(left.quality)
            );

        const subtitles = (step.block.subtitle_files || [])
            .map(subtitle => ({
                language: String(subtitle?.language || '').trim(),
                url: this.normalizeMediaUrl(subtitle?.file)
            }))
            .filter(
                (subtitle): subtitle is { language: string; url: string } =>
                    Boolean(subtitle.url)
            );

        const poster = this.normalizeMediaUrl(video?.thumbnail);
        const originalUrl = this.normalizeMediaUrl(video?.filename);
        const duration = video?.duration ? this.formatVideoDuration(video.duration) : '';

        if (sources.length === 0) {
            const reason = video && video.status && video.status !== 'ready'
                ? t('task.videoProcessing')
                : t('task.videoNoSources');
            return `
                <div class="video-section">
                    ${poster ? `<img class="video-fallback-image" src="${this.escapeHtml(poster)}" alt="${t('task.videoPreviewAlt')}">` : ''}
                    <div class="video-unavailable">
                        <p>${this.escapeHtml(reason)}</p>
                        <a href="${this.escapeHtml(stepUrl)}">${t('task.openStepOnStepik')}</a>
                    </div>
                </div>
            `;
        }

        const sourceTags = sources
            .map(
                source =>
                    `<source src="${this.escapeHtml(source.url)}" type="video/mp4" data-quality="${this.escapeHtml(source.quality)}">`
            )
            .join('\n                    ');

        const trackTags = subtitles
            .map((subtitle, index) => {
                const language = subtitle.language || 'und';
                return `<track kind="subtitles" src="${this.escapeHtml(subtitle.url)}" srclang="${this.escapeHtml(language)}" label="${this.escapeHtml(language)}"${index === 0 ? ' default' : ''}>`;
            })
            .join('\n                    ');

        const qualitySelector = sources.length > 1
            ? `
                <label class="video-quality-label">
                    ${t('task.quality')}
                    <select id="video-quality">
                        ${sources.map((source, index) => `
                            <option value="${this.escapeHtml(source.quality)}"${index === 0 ? ' selected' : ''}>${this.escapeHtml(this.videoQualityLabel(source.quality))}</option>
                        `).join('')}
                    </select>
                </label>
            `
            : '';

        const originalLink = originalUrl
            ? `<a class="video-source-link" href="${this.escapeHtml(originalUrl)}">${t('task.originalVideo')}</a>`
            : '';
        const browserButton = sources[0]
            ? `<button id="video-open-browser" class="video-action-btn" type="button" data-video-url="${this.escapeHtml(sources[0].url)}">${t('task.openInBrowser')}</button>`
            : '';

        return `
            <div class="video-section">
                <div class="video-player-wrap">
                    <video id="stepik-video" controls preload="metadata" playsinline${poster ? ` poster="${this.escapeHtml(poster)}"` : ''}>
                        ${sourceTags}
                        ${trackTags}
                        ${t('task.videoUnsupported')}
                    </video>
                    <audio id="stepik-video-audio" preload="auto"></audio>
                </div>
                <div class="video-toolbar">
                    ${duration ? `<span class="video-duration">${this.escapeHtml(duration)}</span>` : ''}
                    ${qualitySelector}
                    <span id="video-audio-status" class="video-status" role="status" aria-live="polite">${t('task.audioPreparing')}</span>
                    <span id="video-status" class="video-status" role="status" aria-live="polite"></span>
                    <button id="video-audio-enable" class="video-action-btn" type="button" hidden>${t('task.enableAudio')}</button>
                    <button id="video-fullscreen" class="video-action-btn" type="button">${t('task.fullscreen')}</button>
                    ${browserButton}
                    ${originalLink}
                </div>
            </div>
        `;
    }

    private normalizeMediaUrl(value: string | undefined): string | undefined {
        const url = (value || '').trim();
        if (!url) {
            return undefined;
        }
        if (/^https?:\/\//i.test(url)) {
            return url;
        }
        if (url.startsWith('//')) {
            return `https:${url}`;
        }
        if (url.startsWith('/')) {
            return `https://stepik.org${url}`;
        }
        return undefined;
    }

    private videoQualityValue(quality: string): number {
        const parsed = parseInt(quality, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private videoQualityLabel(quality: string): string {
        return /^\d+$/.test(quality) ? `${quality}p` : (quality || t('task.videoFallback'));
    }

    private formatVideoDuration(seconds: number): string {
        const total = Math.max(0, Math.round(seconds));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const remainder = total % 60;
        return hours > 0
            ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
            : `${minutes}:${String(remainder).padStart(2, '0')}`;
    }

    private getCommentsSectionHtml(): string {
        let content: string;

        if (this.commentsError) {
            content = `
                <div class="comments-error">
                    <div>${t('task.commentsLoadError', { detail: this.escapeHtml(this.commentsError) })}</div>
                    <button id="reload-comments" class="secondary">${t('task.retry')}</button>
                </div>
            `;
        } else {
            content = `<div class="comments-list" id="comments-list">${this.renderCommentsListHtml()}</div>`;
        }

        const loadMoreVisible = this.hasMoreComments && !this.commentsError;
        // Stepik shows the solutions tab for every quiz step, even while the
        // forum is still locked. The tab then explains how to unlock it, so a
        // just-solved step does not need a full page reload to reveal it.
        const quizStep = Boolean(this.currentStep && this.isQuizStep(this.currentStep.step));
        const solutionsAvailable =
            quizStep && this.solutionsAvailable && Boolean(this.solutionsThread);
        const solutionsCount = this.solutionsThread?.discussions_count || 0;

        return `
            <div class="comments-section" id="comments-section">
                <div class="discussion-header" id="discussion-header">
                    <div class="discussion-tabs" role="tablist" aria-label="${t('task.discussionAria')}">
                        <button id="tab-comments" class="discussion-tab active" data-view="comments" role="tab" aria-selected="true" title="${t('task.commentsTabTitle')}">
                            ${t('task.comments')} <span class="comments-count" id="comments-count">${this.getCommentCount()}</span>
                        </button>
                        ${quizStep ? `
                            <button id="tab-solutions" class="discussion-tab" data-view="solutions" role="tab" aria-selected="false" title="${t('task.solutionsTabTitle')}">
                                ${t('task.solutions')} <span class="comments-count" id="solutions-count"${solutionsAvailable ? '' : ' style="display:none"'}>${solutionsCount}</span><span class="solutions-lock-icon" id="solutions-lock-icon"${solutionsAvailable ? ' style="display:none"' : ''} title="${t('task.solutionsUnavailable')}">🔒</span>
                            </button>
                        ` : ''}
                    </div>
                    <label class="comments-sort-label" id="comments-sort-wrapper">
                        ${t('task.sortingLabel')}
                        <select id="comment-sort">
                            ${this.getCommentSortOptionsHtml(this.commentSort)}
                        </select>
                    </label>
                </div>
                <div class="discussion-panel" id="comments-panel" role="tabpanel">
                    <div class="comment-composer" id="comment-composer">
                        <div id="new-comment-editor" class="comment-rich-host" data-stepik-rich-editor data-placeholder="${t('task.commentPlaceholder')}"></div>
                        <div class="composer-hint">${t('task.composerHint')}</div>
                        <div class="composer-actions">
                            <button id="post-comment-btn" disabled>${t('task.submit')}</button>
                            <span id="composer-status" class="composer-status"></span>
                        </div>
                    </div>
                    ${content}
                    <div class="comments-actions">
                        <button id="load-more-comments" class="secondary"${loadMoreVisible ? '' : ' style="display:none"'}>${t('task.showMoreComments')}</button>
                        <span id="comments-status" class="comments-status"></span>
                    </div>
                    <div id="comments-sentinel" class="comments-sentinel" aria-hidden="true"></div>
                </div>
                ${quizStep ? `
                    <div class="discussion-panel" id="solutions-panel" role="tabpanel" style="display:none">
                        <div class="solutions-locked" id="solutions-locked"${solutionsAvailable ? ' style="display:none"' : ''}>
                            <div class="solutions-locked-text" id="solutions-locked-text">${this.escapeHtml(this.getSolutionsLockedMessage())}</div>
                            <button id="recheck-solutions" class="secondary">${t('task.recheckSolutions')}</button>
                        </div>
                        <div class="solutions-status" id="solutions-status"></div>
                        <div id="solutions-unlocked"${solutionsAvailable ? '' : ' style="display:none"'}>
                            <div class="comment-composer" id="solution-composer">
                                <label class="solution-submission-label" for="solution-submission">
                                    ${t('task.mySolution')}
                                    <select id="solution-submission"${this.solutionSubmissions.length ? '' : ' disabled'}>
                                        ${this.getSolutionSubmissionOptionsHtml()}
                                    </select>
                                </label>
                                ${this.getSolutionSubmissionHintHtml()}
                                <div id="new-solution-editor" class="comment-rich-host" data-stepik-rich-editor data-placeholder="${t('task.solutionPlaceholder')}" data-disabled data-compact></div>
                                <div class="composer-hint">${t('task.composerHint')}</div>
                                <div class="composer-actions">
                                    <button id="post-solution-btn" disabled>${t('task.submit')}</button>
                                    <span id="solution-composer-status" class="composer-status"></span>
                                </div>
                            </div>
                            <div class="solutions-content" id="solutions-content"></div>
                            <div class="comments-actions">
                                <button id="load-more-solutions" class="secondary" style="display:none">${t('task.showMoreSolutions')}</button>
                                <button id="retry-solutions" class="secondary" style="display:none">${t('task.retrySolutions')}</button>
                            </div>
                            <div id="solutions-sentinel" class="comments-sentinel" aria-hidden="true"></div>
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    /**
     * Explain why the solutions forum is not available yet. Stepik uses the
     * same two modes: solutions open after a correct submission or after a
     * configured number of attempts.
     */
    private getSolutionsLockedMessage(): string {
        const step = this.currentStep?.step;
        if (!step) {
            return t('task.solutionsLockedNone');
        }
        const attempts = step.solutions_unlocked_attempts || 0;
        if (step.is_solutions_unlocked && attempts > 0) {
            const mod10 = attempts % 10;
            const mod100 = attempts % 100;
            const word = pluralize(attempts, 'task.attemptForms');
            return t('task.solutionsLockedAttempts', { attempts, word });
        }
        return t('task.solutionsLockedCorrect');
    }

    private getCommentSortOptionsHtml(sort: CommentSort = this.commentSort): string {
        const options: Array<[CommentSort, string]> = [
            ['new', t('task.sortNew')],
            ['discussed', t('task.sortDiscussed')],
            ['popular', t('task.sortPopular')],
            ['recent', t('task.sortRecent')],
            ['teacher', t('task.sortTeacher')],
            ['mine', t('task.sortMine')]
        ];

        return options
            .map(([value, label]) =>
                `<option value="${value}"${sort === value ? ' selected' : ''}>${label}</option>`
            )
            .join('');
    }

    private getDefaultSolutionSubmission(): Submission | undefined {
        return (
            this.solutionSubmissions.find(submission => submission.status === 'correct') ||
            this.solutionSubmissions[0]
        );
    }

    private getSolutionSubmissionOptionsHtml(): string {
        if (this.solutionSubmissions.length === 0) {
            return `<option value="">${t('task.noSubmittedSolutions')}</option>`;
        }

        const selected = this.getDefaultSolutionSubmission();
        return this.solutionSubmissions
            .map(submission => {
                const status = this.getSubmissionStatusLabel(submission.status);
                const date = this.formatSubmissionDate(submission.time);
                const details = [status, date].filter(Boolean).join(' · ');
                const label = details
                    ? `#${submission.id} · ${details}`
                    : `#${submission.id}`;
                return `<option value="${submission.id}"${
                    selected?.id === submission.id ? ' selected' : ''
                }>${this.escapeHtml(label)}</option>`;
            })
            .join('');
    }

    private getSolutionSubmissionHint(): string {
        if (this.solutionSubmissionsError) {
            return t('task.solutionSubmissionsLoadError', { detail: this.solutionSubmissionsError });
        }
        if (this.solutionSubmissions.length === 0) {
            return t('task.noSubmittedSolutionsHint');
        }
        return '';
    }

    private getSolutionSubmissionHintHtml(): string {
        const hint = this.getSolutionSubmissionHint();
        return `<div class="solution-submission-hint" id="solution-submission-hint"${
            hint ? '' : ' style="display:none"'
        }>${this.escapeHtml(hint)}</div>`;
    }

    private getSubmissionStatusLabel(status: string): string {
        switch ((status || '').toLowerCase()) {
            case 'correct':
                return t('task.statusCorrect');
            case 'wrong':
                return t('task.statusWrong');
            case 'evaluation':
                return t('task.statusEvaluation');
            case 'pending':
                return t('task.statusPending');
            case 'running':
                return t('task.statusRunning');
            case 'compilation_error':
                return t('task.statusCompilationError');
            case 'runtime_error':
                return t('task.statusRuntimeError');
            case 'time_limit_exceeded':
                return t('task.statusTimeLimit');
            case 'memory_limit_exceeded':
                return t('task.statusMemoryLimit');
            case 'rejected':
                return t('task.statusRejected');
            default:
                return status || t('task.statusUnknown');
        }
    }

    private formatSubmissionDate(time?: string): string {
        if (!time) {
            return '';
        }
        const date = new Date(time);
        if (Number.isNaN(date.getTime())) {
            return '';
        }
        const pad = (value: number) => String(value).padStart(2, '0');
        return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(
            date.getHours()
        )}:${pad(date.getMinutes())}`;
    }

    private renderCommentBodyHtml(comment: StepikComment): string {
        if (comment.is_deleted) {
            return `<em class="comment-deleted">${t('task.commentDeleted')}</em>`;
        }
        if (comment.is_banned) {
            return `<em class="comment-deleted">${t('task.commentHidden')}</em>`;
        }
        const submission = comment.submission
            ? this.commentSubmissions.get(comment.submission)
            : undefined;
        const codeLanguage = submission?.reply?.language || this.getStepCodeLanguage();
        return highlightCodeBlocks(
            this.renderMathInHtml(this.sanitizeCommentHtml(comment.text || '')),
            codeLanguage
        );
    }

    private getCommentHtml(comment: StepikComment, user: CommentUser | undefined): string {
        const authorName = user?.full_name?.trim() || t('task.userFallback', { id: comment.user });
        const roleBadge = this.getCommentRoleBadge(comment.user_role);
        const pinnedBadge = comment.is_pinned
            ? `<span class="comment-flag pin">${t('task.pinned')}</span>`
            : '';

        const isTeacher = (comment.user_role || '').toLowerCase() === 'teacher';
        const teacherReplied = Boolean(
            comment.is_staff_replied || this.teacherRepliedParents.has(comment.id)
        );
        const teacherRepliedBadge = comment.parent === null && teacherReplied
            ? `<span class="comment-flag teacher-reply">${t('task.teacherReplied')}</span>`
            : '';
        const teacherCommentBadge = isTeacher
            ? `<span class="comment-flag teacher-comment">${t('task.teacherComment')}</span>`
            : '';
        const solutionBadge = comment.thread === 'solutions'
            ? `<span class="comment-flag solution">${t('task.solutionFlag')}</span>`
            : '';
        const replyBadge = this.commentSort === 'mine' && comment.parent !== null
            ? `<span class="comment-flag reply">${t('task.replyFlag')}</span>`
            : '';

        const classes = ['comment'];
        if (comment.is_pinned) {
            classes.push('pinned');
        }
        if (isTeacher) {
            classes.push('teacher');
        }
        if (teacherReplied && !isTeacher) {
            classes.push('teacher-replied');
        }
        if (comment.thread === 'solutions') {
            classes.push('solution');
        }

        const submission = comment.submission
            ? this.commentSubmissions.get(comment.submission)
            : undefined;
        const codeLanguage = submission?.reply?.language || this.getStepCodeLanguage();

        const body = this.renderCommentBodyHtml(comment);

        const canReply = !comment.is_deleted && !comment.is_banned;
        const repliesButton = comment.parent === null && comment.reply_count > 0
            ? `<button type="button" class="replies-btn" data-comment-id="${comment.id}" data-total="${comment.reply_count}">${t('task.showRepliesCount', { count: comment.reply_count })}</button>`
            : '';
        const replyTarget = comment.parent ?? comment.id;
        const replyButton = canReply
            ? `<button type="button" class="reply-btn" data-comment-id="${comment.id}" data-parent-id="${replyTarget}">${t('task.reply')}</button>`
            : '';
        const isMine = this.currentUserId !== undefined && comment.user === this.currentUserId;
        const canModify =
            canReply &&
            comment.can_edit !== false &&
            (comment.can_edit === true || isMine);
        const canDelete =
            canReply &&
            comment.can_delete !== false &&
            (comment.can_delete === true || isMine);
        const editButton = canModify
            ? `<button type="button" class="comment-action-btn edit-comment-btn" data-comment-id="${comment.id}">${t('task.edit')}</button>`
            : '';
        const deleteButton = canDelete
            ? `<button type="button" class="comment-action-btn delete-comment-btn" data-comment-id="${comment.id}">${t('task.delete')}</button>`
            : '';
        const copyLinkButton = canReply
            ? `<button type="button" class="comment-action-btn copy-comment-link-btn" data-comment-id="${comment.id}" data-parent-id="${comment.parent ?? ''}">${t('task.link')}</button>`
            : '';

        const voteId = this.commentVoteIds.get(comment.id);
        const currentVote = this.commentVoteValues.get(comment.id) ?? null;
        // Stepik rejects votes on one's own comments with HTTP 403. Keep the
        // counts visible but render them as plain text so the user is not
        // invited to perform an action the server will refuse.
        const canVote = Boolean(voteId) &&
            canReply &&
            !isMine &&
            comment.actions?.vote !== false;
        const epicCount = Math.max(0, Number(comment.epic_count) || 0);
        const abuseCount = Math.max(0, Number(comment.abuse_count) || 0);
        const showVoteStats = canReply && (canVote || isMine || epicCount > 0 || abuseCount > 0);
        // Same 20x20 thumbs-up symbol Stepik uses for both vote buttons; the
        // dislike icon is flipped with CSS exactly like the site does it.
        const voteThumbIcon =
            '<span class="ui-like__icon" aria-hidden="true"><svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M20 9.503c0 .415 0 1.276-.555 1.605.124.272.12.623.114.991l-.001.235c0 .773-.321 1.37-.825 1.617.126.276.123.634.12 1.01l-.001.292c.004.457-.156.885-.45 1.203a1.54 1.54 0 01-.376.298c.255.385.265.95.27 1.227.008.45-.151.877-.449 1.203-.3.327-.717.517-1.145.517l-3.743-.002h-.01c-.005.002-.01.002-.015.002H8.023a1.65 1.65 0 00-.132.006 2.077 2.077 0 01-.178.008.858.858 0 01-.254-.034 1.483 1.483 0 01-.404-.22h-.001l-.084-.057c-.179-.119-.353-.245-.527-.37l-.141-.103a.535.535 0 00-.313-.1h-.49V9.984l.538-.362c.258-.173.42-.473.591-.789l.775-1.4C7.93 6.483 8.46 5.53 8.99 4.58l.022-.041a.22.22 0 00.015-.033c.003-.012.003-.052.003-.076l-.003-3.08c0-.399.312-.715.618-.973A1.53 1.53 0 0111.222.11c.435.169.98.467 1.096.932.144.57.288 1.141.422 1.715l.057.236c.086.359.175.73.212 1.11.053.549-.467 2.777-.775 3.774l6.388-.011c.836 0 1.378.643 1.378 1.637zm-20 .976c0-.74.589-1.342 1.313-1.342h2.873c.288 0 .552.099.768.26v10.346a1.28 1.28 0 01-.768.257H1.313C.589 20 0 19.399 0 18.659v-8.18z" fill="currentColor" fill-rule="evenodd"></path></svg></span>';
        const voteControls = canVote
            ? `<span class="comment-vote ui-vote" data-comment-id="${comment.id}" data-current-vote="${currentVote || ''}" data-epic-count="${epicCount}" data-abuse-count="${abuseCount}">
                    <button type="button" class="ui-like ui-vote__like vote-btn vote-up${currentVote === 'epic' ? ' active' : ''}" data-comment-id="${comment.id}" data-vote="epic" data-type="like"${currentVote === 'epic' ? ' data-is-active' : ''} aria-pressed="${currentVote === 'epic' ? 'true' : 'false'}" aria-label="${t('task.like')}" title="${t('task.like')}">${voteThumbIcon}<span class="ui-like__count vote-count vote-up-count">${epicCount}</span></button>
                    <button type="button" class="ui-like ui-vote__like vote-btn vote-down${currentVote === 'abuse' ? ' active' : ''}" data-comment-id="${comment.id}" data-vote="abuse" data-type="dislike"${currentVote === 'abuse' ? ' data-is-active' : ''} aria-pressed="${currentVote === 'abuse' ? 'true' : 'false'}" aria-label="${t('task.dislike')}" title="${t('task.dislike')}">${voteThumbIcon}<span class="ui-like__count vote-count vote-down-count">${abuseCount}</span></button>
                    <span class="vote-status" aria-live="polite"></span>
                </span>`
            : showVoteStats
                ? `<span class="comment-vote comment-vote-static ui-vote" title="${isMine ? t('task.voteOwn') : t('task.voteCount')}">
                    <span class="ui-like ui-vote__like" data-is-inactive data-type="like">${voteThumbIcon}<span class="ui-like__count vote-count vote-up-count">${epicCount}</span></span>
                    <span class="ui-like ui-vote__like" data-is-inactive data-type="dislike">${voteThumbIcon}<span class="ui-like__count vote-count vote-down-count">${abuseCount}</span></span>
                </span>`
                : '';

        return `
            <div class="${classes.join(' ')}" data-comment-id="${comment.id}">
                ${this.getCommentAvatarHtml(user, authorName)}
                <div class="comment-main">
                    <div class="comment-head">
                        <span class="comment-author">${this.escapeHtml(authorName)}</span>
                        ${roleBadge}
                        ${pinnedBadge}
                        ${teacherCommentBadge}
                        ${teacherRepliedBadge}
                        ${solutionBadge}
                        ${replyBadge}
                        <span class="comment-date">${this.escapeHtml(this.formatCommentDate(comment.time))}</span>
                    </div>
                    <div class="comment-body">
                        <div class="comment-text">${body}</div>
                        ${this.renderCommentSubmission(submission, codeLanguage)}
                    </div>
                    <div class="comment-actions">
                        ${voteControls}
                        ${repliesButton}
                        ${replyButton}
                        ${editButton}
                        ${deleteButton}
                        ${copyLinkButton}
                        <span class="comment-action-status" aria-live="polite"></span>
                    </div>
                    <div class="reply-composer" id="reply-composer-${comment.id}" hidden></div>
                    <div class="comment-replies" id="replies-${comment.id}"></div>
                </div>
            </div>
        `;
    }

    /**
     * Solution comments can be attached to any quiz submission, not only to
     * code. The submission is already side-loaded by the comments API, so the
     * answer is rendered from `reply` instead of being fetched again.
     */
    private renderCommentSubmission(
        submission: Submission | undefined,
        fallbackLanguage?: string
    ): string {
        const reply = submission?.reply;
        if (!reply) {
            return '';
        }

        const stepType = this.currentStep?.step.block.name || '';
        const replyType = this.getSubmissionReplyType(reply, stepType);

        if (replyType === 'code') {
            const code = typeof reply.code === 'string' ? reply.code : '';
            if (!code.trim()) {
                return '';
            }

            const language = (reply.language || '').trim();
            const label = language ? `${t('task.codeSolution')} · ${language}` : t('task.codeSolution');
            return this.wrapCommentSubmission(
                label,
                this.renderSubmissionCode(code, language || fallbackLanguage)
            );
        }

        switch (replyType) {
            case 'string':
                return this.renderSubmissionPlainText(reply.text);
            case 'free-answer':
                return this.renderSubmissionFreeAnswer(reply);
            case 'number':
                return this.renderSubmissionPlainText(reply.number);
            case 'math':
                return this.renderSubmissionMath(reply.formula);
            case 'choice':
                return this.renderSubmissionChoice(reply.choices);
            case 'sorting':
                return this.renderSubmissionOrdering(reply.ordering);
            case 'matching':
                return this.renderSubmissionMatching(reply.ordering);
            case 'table':
                return this.renderSubmissionTable(reply.choices);
            case 'fill-blanks':
                return this.renderSubmissionBlanks(reply.blanks);
            case 'sql':
                return this.renderSubmissionSql(reply.solve_sql);
            case 'html':
                return this.renderSubmissionHtml(reply.html, reply.css);
            case 'dataset':
                return this.renderSubmissionDataset(reply.file);
            case 'chemical':
                return this.renderSubmissionChemical(reply.slots);
            case 'puzzle':
                return this.renderSubmissionPuzzle(reply.solved);
            default:
                return this.renderSubmissionFallback(reply);
        }
    }

    private getSubmissionReplyType(
        reply: NonNullable<Submission['reply']>,
        stepType: string
    ): string {
        if (typeof reply.code === 'string' && reply.code.trim()) {
            return 'code';
        }

        // The current step is the most reliable source: a reply object can
        // contain several optional fields, while only one plugin is active.
        if (ANSWERABLE_STEP_TYPES.has(stepType) && stepType !== 'code') {
            return stepType;
        }

        if (typeof reply.solve_sql === 'string') {
            return 'sql';
        }
        if (Array.isArray(reply.slots)) {
            return 'chemical';
        }
        if (typeof reply.solved === 'boolean') {
            return 'puzzle';
        }
        if (typeof reply.number === 'string' || typeof reply.number === 'number') {
            return 'number';
        }
        if (typeof reply.formula === 'string') {
            return 'math';
        }
        if (typeof reply.html === 'string' || typeof reply.css === 'string') {
            return 'html';
        }
        if (typeof reply.file === 'string') {
            return 'dataset';
        }
        if (Array.isArray(reply.blanks)) {
            return 'fill-blanks';
        }
        if (Array.isArray(reply.choices)) {
            const first = reply.choices[0];
            return first && typeof first === 'object' ? 'table' : 'choice';
        }
        if (Array.isArray(reply.ordering)) {
            return 'sorting';
        }
        if (typeof reply.text === 'string') {
            return stepType === 'free-answer' ? 'free-answer' : 'string';
        }
        return 'unknown';
    }

    private wrapCommentSubmission(label: string, content: string): string {
        return `
            <div class="comment-submission">
                <div class="comment-submission-head">${this.escapeHtml(label)}</div>
                ${content}
            </div>
        `;
    }

    private renderSubmissionCode(code: string, language?: string): string {
        const highlighted = highlightCode(code, language);
        const languageClass = highlighted.language === 'plaintext'
            ? ''
            : ` language-${highlighted.language}`;
        return `<pre class="hljs"><code class="hljs${languageClass}">${highlighted.html}</code></pre>`;
    }

    /**
     * Answer text is user-generated, so it goes through the stricter comment
     * sanitizer instead of the step-description one.
     */
    private getSubmissionContentHtml(content: string): string {
        if (!content) {
            return '';
        }
        return highlightCodeBlocks(
            this.renderMathInHtml(this.sanitizeCommentHtml(content)),
            this.getStepCodeLanguage()
        );
    }

    private renderSubmissionPlainText(value: unknown): string {
        const text = typeof value === 'string' || typeof value === 'number'
            ? String(value)
            : '';
        if (!text.trim()) {
            return '';
        }
        return this.wrapCommentSubmission(
            t('task.answer'),
            `<div class="comment-submission-text">${this.escapeHtml(text)}</div>`
        );
    }

    private renderSubmissionFreeAnswer(
        reply: NonNullable<Submission['reply']>
    ): string {
        const text = typeof reply.text === 'string' ? reply.text : '';
        const attachments = Array.isArray(reply.attachments) ? reply.attachments.length : 0;
        if (!text.trim() && attachments === 0) {
            return '';
        }

        if (!text.trim()) {
            return this.wrapCommentSubmission(
                t('task.answer'),
                `<div class="comment-submission-empty">${t('task.attachmentsOnly', { count: attachments })}</div>`
            );
        }

        // Free answers may contain HTML; strip unsafe tags exactly like
        // comments do before putting the answer into the webview.
        const content = this.getSubmissionContentHtml(text);
        return this.wrapCommentSubmission(
            t('task.answer'),
            `<div class="comment-submission-text">${content}</div>`
        );
    }

    private renderSubmissionMath(formula: unknown): string {
        if (typeof formula !== 'string' || !formula.trim()) {
            return '';
        }

        const source = formula.trim();
        const content = /\$|\\\(|\\\[/.test(source)
            ? this.renderMathInHtml(this.escapeHtml(source))
            : this.renderMathInHtml(`$$${this.escapeHtml(source)}$$`);
        return this.wrapCommentSubmission(
            t('task.formula'),
            `<div class="comment-submission-formula">${content}</div>`
        );
    }

    private renderSubmissionChoice(
        choices: boolean[] | TableRowChoice[] | undefined
    ): string {
        if (!Array.isArray(choices)) {
            return '';
        }

        const selected = choices
            .map((choice, index) => choice === true ? index : -1)
            .filter(index => index >= 0);
        if (selected.length === 0) {
            return this.wrapCommentSubmission(
                t('task.selectedOptions'),
                `<div class="comment-submission-empty">${t('task.noOptionsSelected')}</div>`
            );
        }

        const options = this.getAttemptDataset()?.options || [];
        const items = selected.map(index => {
            const option = options[index];
            const content = typeof option === 'string' && option.trim()
                ? this.getSubmissionContentHtml(option)
                : t('task.optionN', { number: index + 1 });
            return `<li>${content}</li>`;
        });

        return this.wrapCommentSubmission(
            t('task.selectedOptions'),
            `<ul class="comment-submission-list">${items.join('')}</ul>`
        );
    }

    private renderSubmissionOrdering(ordering: number[] | undefined): string {
        if (!Array.isArray(ordering) || ordering.length === 0) {
            return '';
        }

        const options = this.getAttemptDataset()?.options || [];
        const items = ordering.map((value, position) => {
            const index = Number(value);
            const option = Number.isInteger(index) ? options[index] : undefined;
            const content = typeof option === 'string' && option.trim()
                ? this.getSubmissionContentHtml(option)
                : t('task.itemN', { number: Number.isInteger(index) ? index + 1 : position + 1 });
            return `<li>${content}</li>`;
        });

        return this.wrapCommentSubmission(
            t('task.orderItemsLabel'),
            `<ol class="comment-submission-list">${items.join('')}</ol>`
        );
    }

    private renderSubmissionMatching(ordering: number[] | undefined): string {
        if (!Array.isArray(ordering) || ordering.length === 0) {
            return '';
        }

        const pairs = this.getAttemptDataset()?.pairs || [];
        const items = ordering.map((value, leftIndex) => {
            const rightIndex = Number(value);
            const left = pairs[leftIndex]?.first;
            const right = Number.isInteger(rightIndex)
                ? pairs[rightIndex]?.second
                : undefined;
            const leftText = typeof left === 'string' && left.trim()
                ? this.getSubmissionContentHtml(left)
                : t('task.itemN', { number: leftIndex + 1 });
            const rightText = typeof right === 'string' && right.trim()
                ? this.getSubmissionContentHtml(right)
                : t('task.itemN', { number: Number.isInteger(rightIndex) ? rightIndex + 1 : '—' });
            return `<li><span class="comment-submission-pair-left">${leftText}</span><span class="comment-submission-pair-arrow" aria-hidden="true">→</span><span class="comment-submission-pair-right">${rightText}</span></li>`;
        });

        return this.wrapCommentSubmission(
            t('task.matchingLabel'),
            `<ul class="comment-submission-list comment-submission-pairs">${items.join('')}</ul>`
        );
    }

    private renderSubmissionTable(
        choices: boolean[] | TableRowChoice[] | undefined
    ): string {
        if (!Array.isArray(choices) || choices.length === 0) {
            return this.wrapCommentSubmission(
                t('task.answerTable'),
                `<div class="comment-submission-empty">${t('task.tableEmpty')}</div>`
            );
        }

        const dataset = this.getAttemptDataset();
        let rows: TableRowChoice[] = [];
        const first = choices[0];
        if (first && typeof first === 'object') {
            rows = (choices as TableRowChoice[]).filter(
                row => Boolean(row) && typeof row === 'object'
            );
        } else {
            // Defensive fallback for an unexpected flat boolean array. The
            // table plugin normally returns TableRowChoice[].
            const flags = choices as boolean[];
            const datasetRows = dataset?.rows || [];
            const datasetColumns = dataset?.columns || [];
            const columnsCount = datasetColumns.length;
            const rowCount = Math.max(
                datasetRows.length,
                columnsCount > 0 ? Math.ceil(flags.length / columnsCount) : 0
            );
            for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
                rows.push({
                    name_row: datasetRows[rowIndex] || t('task.rowN', { number: rowIndex + 1 }),
                    columns: datasetColumns.map((column, columnIndex) => ({
                        name: column,
                        answer: Boolean(flags[rowIndex * columnsCount + columnIndex])
                    }))
                });
            }
        }

        if (rows.length === 0) {
            return this.wrapCommentSubmission(
                t('task.answerTable'),
                `<div class="comment-submission-empty">${t('task.tableEmpty')}</div>`
            );
        }

        const body = rows.map(row => {
            const rowName = typeof row.name_row === 'string' && row.name_row.trim()
                ? this.getSubmissionContentHtml(row.name_row)
                : t('task.row');
            const columns = (Array.isArray(row.columns) ? row.columns : [])
                .filter(column => column && column.answer === true);
            const selected = columns.length > 0
                ? columns.map(column => {
                    const name = typeof column.name === 'string' ? column.name : '';
                    return name.trim() ? this.getSubmissionContentHtml(name) : '—';
                }).join(', ')
                : '<span class="comment-submission-empty">—</span>';
            return `<tr><th scope="row">${rowName}</th><td>${selected}</td></tr>`;
        }).join('');

        return this.wrapCommentSubmission(
            t('task.answerTable'),
            `<table class="comment-submission-table">
                <thead><tr><th scope="col">${t('task.row')}</th><th scope="col">${t('task.selectedColumns')}</th></tr></thead>
                <tbody>${body}</tbody>
            </table>`
        );
    }

    private renderSubmissionBlanks(blanks: string[] | undefined): string {
        if (!Array.isArray(blanks)) {
            return '';
        }
        if (blanks.length === 0) {
            return this.wrapCommentSubmission(
                t('task.filledBlanks'),
                `<div class="comment-submission-empty">${t('task.blanksEmpty')}</div>`
            );
        }

        const items = blanks.map((value, index) => {
            const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
            const content = text
                ? this.escapeHtml(text)
                : '<span class="comment-submission-empty">—</span>';
            return `<li><span class="comment-submission-label">${t('task.blankN', { number: index + 1 })}</span> ${content}</li>`;
        });

        return this.wrapCommentSubmission(
            t('task.filledBlanks'),
            `<ul class="comment-submission-list">${items.join('')}</ul>`
        );
    }

    private renderSubmissionSql(code: unknown): string {
        if (typeof code !== 'string' || !code.trim()) {
            return '';
        }
        return this.wrapCommentSubmission(
            t('task.sqlQuery'),
            this.renderSubmissionCode(code, 'sql')
        );
    }

    private renderSubmissionHtml(htmlCode: unknown, cssCode: unknown): string {
        const html = typeof htmlCode === 'string' ? htmlCode : '';
        const css = typeof cssCode === 'string' ? cssCode : '';
        const parts: string[] = [];

        if (html.trim()) {
            parts.push(
                '<div class="comment-submission-code-label">HTML</div>',
                this.renderSubmissionCode(html, 'html')
            );
        }
        if (css.trim()) {
            parts.push(
                '<div class="comment-submission-code-label">CSS</div>',
                this.renderSubmissionCode(css, 'css')
            );
        }
        if (parts.length === 0) {
            return '';
        }

        return this.wrapCommentSubmission(t('task.codeSolution'), parts.join(''));
    }

    private renderSubmissionDataset(file: unknown): string {
        if (typeof file !== 'string' || !file.trim()) {
            return '';
        }
        return this.wrapCommentSubmission(
            t('task.solutionFile'),
            this.renderSubmissionCode(file, 'plaintext')
        );
    }

    private renderSubmissionChemical(slots: ChemicalSlot[] | undefined): string {
        if (!Array.isArray(slots) || slots.length === 0) {
            return '';
        }

        const formula = slots.map(slot => {
            if (!slot || typeof slot !== 'object') {
                return '';
            }
            const normal = this.escapeHtml(String(slot.normal || ''));
            const sub = slot.sub
                ? `<sub>${this.escapeHtml(String(slot.sub))}</sub>`
                : '';
            const sup = slot.sup
                ? `<sup>${this.escapeHtml(String(slot.sup))}</sup>`
                : '';
            return `${normal}${sub}${sup}`;
        }).join('');

        if (!formula.trim()) {
            return '';
        }

        return this.wrapCommentSubmission(
            t('task.formula'),
            `<div class="comment-submission-formula comment-submission-chemical">${formula}</div>`
        );
    }

    private renderSubmissionPuzzle(solved: unknown): string {
        if (typeof solved !== 'boolean') {
            return '';
        }
        return this.wrapCommentSubmission(
            t('task.puzzleLabel'),
            `<div class="comment-submission-text">${solved ? t('task.solved') : t('task.notSolved')}</div>`
        );
    }

    private renderSubmissionFallback(
        reply: NonNullable<Submission['reply']>
    ): string {
        try {
            const entries = Object.entries(reply).filter(
                ([, value]) => value !== undefined && value !== null
            );
            if (entries.length === 0) {
                return '';
            }
            const json = JSON.stringify(Object.fromEntries(entries), null, 2);
            if (!json || json === '{}') {
                return '';
            }
            return this.wrapCommentSubmission(
                t('task.answer'),
                `<pre class="comment-submission-json">${this.escapeHtml(json)}</pre>`
            );
        } catch {
            return '';
        }
    }

    /**
     * The task language is the most reliable default for code snippets in
     * comments: Stepik does not attach a language to plain <pre> blocks.
     */
    private getStepCodeLanguage(): string | undefined {
        const templates = this.currentStep?.step.block.options?.code_templates;
        if (!templates) {
            return undefined;
        }

        const languages = Object.keys(templates);
        if (languages.length === 0) {
            return undefined;
        }

        return languages.find(language => /^python/i.test(language)) || languages[0];
    }

    private getCommentAvatarHtml(user: CommentUser | undefined, authorName: string): string {
        const initial = this.escapeHtml((authorName.trim().charAt(0) || '?').toUpperCase());
        const avatar = user?.avatar?.trim();

        if (avatar && /^https?:\/\//i.test(avatar)) {
            return `
                <span class="comment-avatar">
                    <span class="comment-avatar-fallback">${initial}</span>
                    <img class="comment-avatar-img" src="${this.escapeHtml(avatar)}" alt="" loading="lazy">
                </span>
            `;
        }

        return `
            <span class="comment-avatar">
                <span class="comment-avatar-fallback">${initial}</span>
            </span>
        `;
    }

    private getCommentRoleBadge(role: string): string {
        const normalized = (role || '').toLowerCase();
        const labels: { [key: string]: string } = {
            teacher: t('task.teacherRole'),
            staff: t('task.staffRole'),
            admin: t('task.adminRole'),
            moderator: t('task.moderatorRole')
        };
        const label = labels[normalized];
        if (!label) {
            return '';
        }
        return `<span class="comment-role ${this.escapeHtml(normalized)}">${label}</span>`;
    }

    private formatCommentDate(iso: string): string {
        if (!iso) {
            return '';
        }

        const date = new Date(iso);
        if (isNaN(date.getTime())) {
            return '';
        }

        try {
            return date.toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch {
            return date.toISOString().slice(0, 16).replace('T', ' ');
        }
    }

    /**
     * Stepik stores some math as HTML-encoded text, for example
     * "\(n \, (1 &lt; n &lt; 1000)\)". A browser decodes such entities when
     * it inserts the HTML, but KaTeX receives the raw source first and treats
     * "&" as an alignment character. Decode entities inside formulas only.
     */
    private decodeMathEntities(tex: string): string {
        const namedEntities: { [key: string]: string } = {
            amp: '&',
            lt: '<',
            gt: '>',
            quot: '"',
            apos: "'",
            nbsp: ' ',
            le: '≤',
            ge: '≥',
            ne: '≠',
            times: '×',
            divide: '÷',
            plusmn: '±',
            minus: '−',
            infin: '∞',
            sum: '∑',
            prod: '∏',
            int: '∫',
            radic: '√',
            deg: '°',
            middot: '·',
            hellip: '…',
            ndash: '–',
            mdash: '—',
            laquo: '«',
            raquo: '»',
            pi: 'π',
            alpha: 'α',
            beta: 'β',
            gamma: 'γ',
            delta: 'δ',
            epsilon: 'ε',
            theta: 'θ',
            lambda: 'λ',
            mu: 'μ',
            sigma: 'σ',
            phi: 'φ',
            omega: 'ω'
        };

        return tex.replace(
            /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g,
            (match: string, entity: string) => {
                if (entity.startsWith('#')) {
                    const hexadecimal = entity[1] === 'x' || entity[1] === 'X';
                    const codePoint = parseInt(
                        entity.slice(hexadecimal ? 2 : 1),
                        hexadecimal ? 16 : 10
                    );
                    if (
                        Number.isFinite(codePoint) &&
                        codePoint > 0 &&
                        codePoint <= 0x10ffff
                    ) {
                        try {
                            return String.fromCodePoint(codePoint);
                        } catch {
                            return match;
                        }
                    }
                    return match;
                }

                const value = namedEntities[entity.toLowerCase()];
                return value !== undefined ? value : match;
            }
        );
    }

    /**
     * KaTeX renders Cyrillic characters as "?" in math mode unless they are
     * wrapped in a text command. Stepik authors often write formulas such as
     * "\dfrac{масса}{рост}" without \text{}, so protect explicit text commands
     * and wrap the remaining Cyrillic runs automatically.
     */
    private prepareMathForKatex(tex: string): string {
        if (!/[\u0400-\u04FF]/.test(tex)) {
            return tex;
        }

        const protectedText: string[] = [];
        const placeholder = (index: number) => `\uE000STEPIKTEXT${index}\uE001`;

        let prepared = tex.replace(
            /\\(?:text|textrm|textnormal|textup|textit|textbf|textsf|texttt|mbox)\s*\{[^{}]*\}/g,
            match => {
                const token = placeholder(protectedText.length);
                protectedText.push(match);
                return token;
            }
        );

        prepared = prepared.replace(
            /[\u0400-\u04FF]+(?:[ \t]+[-\u2013\u2014]?[\u0400-\u04FF]+)*/g,
            match => `\\text{${match}}`
        );

        for (let index = 0; index < protectedText.length; index++) {
            prepared = prepared.replace(placeholder(index), protectedText[index]);
        }

        return prepared;
    }

    /**
     * Render TeX delimiters used by Stepik: $...$, $$...$$, \(...\) and
     * \[...\]. MathML output is used instead of KaTeX HTML so the webview does
     * not need to load KaTeX fonts (CSP only allows remote fonts and data URLs).
     * Code and pre blocks are left untouched.
     */
    private renderMathInHtml(html: string): string {
        if (
            !html ||
            (!html.includes('$') && !html.includes('\\(') && !html.includes('\\['))
        ) {
            return html;
        }

        const rendered: string[] = [];
        const tokenBase = `\uE000stepik-math-${crypto.randomBytes(6).toString('hex')}-`;
        const tokenSuffix = '\uE001';

        const render = (tex: string, displayMode: boolean): string => {
            const source = this.decodeMathEntities(tex).trim();
            if (!source) {
                return '';
            }

            const token = `${tokenBase}${rendered.length}${tokenSuffix}`;
            try {
                const mathml = katex.renderToString(this.prepareMathForKatex(source), {
                    displayMode,
                    output: 'mathml',
                    throwOnError: false,
                    strict: 'ignore',
                    trust: false
                });
                const className = displayMode ? 'math-display' : 'math-inline';
                rendered.push(`<span class="${className}">${mathml}</span>`);
            } catch {
                rendered.push(
                    this.escapeHtml(displayMode ? `\\[${source}\\]` : `\\(${source}\\)`)
                );
            }
            return token;
        };

        const replaceMath = (text: string): string => {
            let value = text;
            value = value.replace(
                /\$\$([\s\S]+?)\$\$/g,
                (_match, tex: string) => render(tex, true)
            );
            value = value.replace(
                /\\\[([\s\S]+?)\\\]/g,
                (_match, tex: string) => render(tex, true)
            );
            value = value.replace(
                /\\\(([\s\S]+?)\\\)/g,
                (_match, tex: string) => render(tex, false)
            );
            value = value.replace(
                /(?<!\\)\$(?!\s)((?:\\.|[^$\\])+?)(?<!\s)(?<!\\)\$/g,
                (_match, tex: string) => render(tex, false)
            );
            return value;
        };

        // Only process text nodes so a dollar sign inside an attribute cannot
        // be mistaken for a formula delimiter.
        const replaceInTextNodes = (text: string): string =>
            text
                .split(/(<\/?[a-zA-Z][^>]*>)/g)
                .map(part => (part.startsWith('<') ? part : replaceMath(part)))
                .join('');

        const protectedBlocks = /<(pre|code|script|style|math)\b[\s\S]*?<\/\1\s*>/gi;
        let result = '';
        let lastIndex = 0;

        for (const match of html.matchAll(protectedBlocks)) {
            const index = match.index ?? 0;
            result += replaceInTextNodes(html.slice(lastIndex, index));
            result += match[0];
            lastIndex = index + match[0].length;
        }
        result += replaceInTextNodes(html.slice(lastIndex));

        return result.replace(
            new RegExp(`${tokenBase}(\\d+)${tokenSuffix}`, 'g'),
            (_match, index: string) => rendered[Number(index)] ?? ''
        );
    }

    /**
     * Task descriptions come from Stepik as HTML and may contain tables,
     * details blocks and inline alignment. Keep that markup, but remove
     * scripts, frames, event handlers and unsafe URLs.
     */
    private sanitizeStepHtml(html: string): string {
        return this.sanitizeHtml(html, true);
    }

    /**
     * Comments are authored on stepik.org and may contain HTML. Only keep a
     * small set of formatting tags and safe URLs before inserting them into
     * the webview.
     */
    private sanitizeCommentHtml(html: string): string {
        // Stepik stores strikethrough as <strike>. Browsers and Turndown emit
        // <s>/<del>, which Stepik silently drops, so normalize before sending.
        const normalized = (html || '')
            .replace(/<\s*(?:s|del)\b([^>]*)>/gi, '<strike$1>')
            .replace(/<\s*\/\s*(?:s|del)\s*>/gi, '</strike>');
        return this.sanitizeHtml(normalized, false);
    }

    private normalizeCommentHtml(html: string): string {
        return (html || '')
            .replace(/<\s*(?:s|del)\b([^>]*)>/gi, '<strike$1>')
            .replace(/<\s*\/\s*(?:s|del)\s*>/gi, '</strike>');
    }

    /** Convert rich editor HTML back to Markdown for the Markdown tab. */
    private commentHtmlToMarkdown(html: string): string {
        const sanitized = this.sanitizeCommentHtml(html);
        if (!sanitized.trim()) {
            return '';
        }
        try {
            return this.commentTurndown
                .turndown(sanitized)
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.outputChannel.appendLine(
                `[Comments] Не удалось преобразовать HTML в Markdown: ${detail}`
            );
            throw new Error(t('task.markdownConvertError', { detail }));
        }
    }

    private sanitizeHtml(html: string, isStep: boolean): string {
        if (!html) {
            return '';
        }

        let clean = html.replace(/<!--[\s\S]*?-->/g, '');

        const blockedTags = [
            'script', 'style', 'iframe', 'object', 'embed', 'template',
            'noscript', 'svg', 'math', 'form', 'textarea', 'select', 'button'
        ];

        for (const tag of blockedTags) {
            // Remove the element together with its content...
            clean = clean.replace(
                new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*${tag}\\s*>`, 'gi'),
                ''
            );
            // ...and any orphan opening tag.
            clean = clean.replace(
                new RegExp(`<\\s*${tag}\\b[^>]*\\/?\\s*>`, 'gi'),
                ''
            );
        }

        clean = clean.replace(
            /<\s*(?:base|link|meta|input|source|track|param)\b[^>]*\/?\s*>/gi,
            ''
        );

        // Remove inline handlers and other attributes that can trigger
        // navigation or network requests. The delimiter before an attribute
        // can be whitespace, a slash or a quote in malformed HTML such as
        // <img/onerror=...>, so all of them must be covered.
        clean = clean.replace(/([\s/"'])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
        clean = clean.replace(/([\s/"'])srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
        clean = clean.replace(/([\s/"'])srcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
        clean = clean.replace(/([\s/"'])ping\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
        clean = clean.replace(/([\s/"'])formaction\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');

        if (isStep) {
            // Preserve alignment/styles used by task descriptions, but drop
            // CSS that can load remote resources.
            clean = clean.replace(
                /([\s/"'])style\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
                (
                    match: string,
                    prefix: string,
                    _wrapped: string,
                    doubleQuoted?: string,
                    singleQuoted?: string,
                    bare?: string
                ) => {
                    const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
                    return /(?:url|expression|image|image-set|cross-fade|@import)\s*\(/i.test(value)
                        ? prefix
                        : match;
                }
            );
        } else {
            clean = clean.replace(/([\s/"'])style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
        }

        // Allow only http(s), absolute paths on stepik.org, anchors and mailto.
        clean = clean.replace(
            /\b(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
            (
                _match: string,
                attr: string,
                _wrapped: string,
                doubleQuoted?: string,
                singleQuoted?: string,
                bare?: string
            ) => {
                const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
                const safeUrl = this.safeCommentUrl(value, attr.toLowerCase() === 'src');
                if (!safeUrl) {
                    return '';
                }
                return `${attr}="${this.escapeHtml(safeUrl)}"`;
            }
        );

        // Strip any remaining tags that are not in the allowlist.
        const allowedTags =
            'a|abbr|b|blockquote|br|caption|code|col|colgroup|dd|del|details|div|dl|dt|em|h[1-6]|hr|i|img|kbd|li|mark|ol|p|pre|q|s|small|span|strike|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|tr|u|ul';
        clean = clean.replace(
            new RegExp(`<\\/?(?!(?:${allowedTags})\\b)[a-z][a-z0-9-]*\\b[^>]*>`, 'gi'),
            ''
        );

        // Tidy up empty attribute lists left after removing unsafe attributes.
        clean = clean.replace(/<([a-z][a-z0-9-]*)\s+>/gi, '<$1>');
        clean = clean.replace(/<\/([a-z][a-z0-9-]*)\s+>/gi, '</$1>');

        return clean;
    }

    private safeCommentUrl(value: string, isImage: boolean): string {
        const url = (value || '').trim();
        if (!url) {
            return '';
        }

        if (/^https?:\/\//i.test(url)) {
            return url;
        }
        if (url.startsWith('//')) {
            return `https:${url}`;
        }
        if (url.startsWith('/')) {
            return `https://stepik.org${url}`;
        }
        if (!isImage && (url.startsWith('#') || /^mailto:/i.test(url))) {
            return url;
        }
        return '';
    }

    private getStyles(): string {
        if (this.stylesCache !== undefined) {
            return this.stylesCache;
        }
        this.stylesCache = `
        [hidden] {
            display: none !important;
        }
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            line-height: 1.6;
        }
        .step-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 16px;
        }
        .step-navigation {
            display: flex;
            gap: 8px;
            margin-bottom: 16px;
        }
        .step-header .step-navigation {
            margin-bottom: 0;
        }
        .step-nav-btn {
            padding: 5px 12px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 4px;
            background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
            color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
            font-size: 13px;
            cursor: pointer;
        }
        .step-nav-btn:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
        }
        .step-nav-btn:disabled {
            opacity: 0.45;
            cursor: default;
        }
        .exam-banner {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 10px;
            padding: 10px 14px;
            margin-bottom: 16px;
            border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
            border-radius: 6px;
            background: var(--vscode-inputValidation-warningBackground, rgba(184, 149, 0, 0.12));
            font-size: 14px;
        }
        .exam-badge {
            padding: 2px 8px;
            border-radius: 999px;
            background: var(--vscode-inputValidation-warningBorder, #b89500);
            color: var(--vscode-editor-background, #1e1e1e);
            font-weight: 600;
            font-size: 12px;
            text-transform: uppercase;
        }
        #exam-timer {
            font-variant-numeric: tabular-nums;
            font-weight: 600;
        }
        .exam-expired {
            color: var(--vscode-errorForeground, #f14c4c);
            font-weight: 600;
        }
        .stepik-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            font-size: 14px;
        }
        .stepik-link:hover {
            text-decoration: underline;
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
        .progress-panel {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            margin: -4px 0 18px;
        }
        .progress-panel-error {
            display: block;
            width: fit-content;
            margin-left: auto;
            padding: 6px 10px;
            border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
            border-radius: 6px;
            color: var(--vscode-errorForeground, var(--vscode-foreground));
            font-size: 12px;
        }
        .progress-streak {
            position: relative;
            display: inline-flex;
            flex: 0 0 auto;
            align-items: center;
            gap: 4px;
            height: 36px;
            padding: 8px;
            box-sizing: border-box;
            border-radius: 4px;
            background: var(--sk-accent-strong, var(--vscode-button-background));
            color: var(--sk-on-accent, var(--vscode-button-foreground));
            cursor: default;
            outline: none;
        }
        .progress-streak:focus-visible {
            outline: 1px solid var(--sk-accent, var(--vscode-focusBorder));
            outline-offset: 4px;
        }
        .progress-streak-icon {
            display: block;
            flex: none;
            width: 20px;
            height: 20px;
        }
        .progress-streak-count {
            color: currentColor;
            opacity: 0.78;
            font-size: 16px;
            font-weight: 400;
            line-height: 18px;
            letter-spacing: 0.3px;
            font-variant-numeric: tabular-nums;
        }
        .progress-course {
            position: relative;
            display: inline-flex;
            flex-direction: column;
            align-items: stretch;
            min-width: 214px;
            color: var(--vscode-foreground);
            font-size: 14px;
            line-height: 22.4px;
            cursor: default;
            outline: none;
        }
        .progress-course-row {
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .progress-course-score {
            font-variant-numeric: tabular-nums;
        }
        .progress-line {
            display: flex;
            align-items: center;
            height: 15px;
            padding: 0 4px;
            box-sizing: border-box;
        }
        .progress-line-track {
            position: relative;
            width: 100%;
            height: 4px;
            border-radius: 2px;
            background: var(--sk-border-strong, var(--vscode-panel-border));
        }
        .progress-line-fill {
            position: absolute;
            top: 0;
            left: 0;
            height: 100%;
            border-radius: 2px;
            background: var(--sk-accent, var(--vscode-charts-green));
        }
        .progress-line-marker {
            position: absolute;
            top: 50%;
            width: 13.5px;
            height: 13.5px;
            box-sizing: border-box;
            border: 3.5px solid var(--sk-bg, var(--vscode-editor-background));
            border-radius: 50%;
            background: var(--sk-border-strong, var(--vscode-panel-border));
            transform: translate(-50%, -50%);
        }
        .progress-course:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 4px;
            border-radius: 2px;
        }
        .progress-tooltip {
            position: absolute;
            top: calc(100% + 10px);
            right: 0;
            z-index: 20;
            min-width: 250px;
            max-width: 330px;
            padding: 10px 12px;
            box-sizing: border-box;
            border: 1px solid var(--sk-border-strong, var(--vscode-panel-border));
            border-radius: 8px;
            background: var(--sk-surface, var(--vscode-editorWidget-background));
            color: var(--sk-muted, var(--vscode-descriptionForeground));
            font-size: 12px;
            font-weight: 400;
            line-height: 1.6;
            letter-spacing: 0.4px;
            box-shadow: var(--sk-shadow, 0 2px 7px rgba(0, 0, 0, 0.3));
            opacity: 0;
            visibility: hidden;
            pointer-events: none;
            transition: opacity 0.15s ease, visibility 0.15s ease;
        }
        .progress-tooltip::before {
            content: '';
            position: absolute;
            top: -9px;
            right: 16px;
            border-width: 0 8px 8px;
            border-style: solid;
            border-color: transparent transparent var(--sk-border-strong, var(--vscode-panel-border)) transparent;
        }
        .progress-tooltip-streak {
            right: auto;
            left: 0;
        }
        .progress-tooltip-streak::before {
            right: auto;
            left: 16px;
        }
        .progress-tooltip-title {
            color: var(--sk-fg, var(--vscode-foreground));
            font-weight: 600;
        }
        .progress-tooltip-line + .progress-tooltip-line {
            margin-top: 2px;
        }
        .progress-tooltip-line span {
            color: var(--sk-fg, var(--vscode-foreground));
        }
        .progress-course:hover .progress-tooltip,
        .progress-course:focus-visible .progress-tooltip,
        .progress-streak:hover .progress-tooltip,
        .progress-streak:focus-visible .progress-tooltip {
            opacity: 1;
            visibility: visible;
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
        .video-section {
            margin-bottom: 24px;
        }
        .video-player-wrap {
            background: #000;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            overflow: hidden;
        }
        .video-player-wrap video {
            display: block;
            width: 100%;
            max-height: 70vh;
            background: #000;
        }
        .video-player-wrap audio {
            display: none;
        }
        .video-action-btn {
            padding: 4px 9px;
            border: none;
            border-radius: 3px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-size: 12px;
            cursor: pointer;
        }
        .video-action-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .video-section.video-theater {
            position: fixed;
            inset: 0;
            z-index: 1000;
            display: flex;
            flex-direction: column;
            margin: 0;
            padding: 0;
            background: #000;
        }
        .video-section:fullscreen {
            display: flex;
            flex-direction: column;
            margin: 0;
            padding: 0;
            background: #000;
        }
        .video-section.video-theater .video-player-wrap,
        .video-section:fullscreen .video-player-wrap {
            flex: 1 1 auto;
            display: flex;
            min-height: 0;
            border: 0;
            border-radius: 0;
            background: #000;
        }
        .video-section.video-theater video,
        .video-section:fullscreen video {
            width: 100%;
            height: 100%;
            max-height: none;
            object-fit: contain;
        }
        .video-section.video-theater .video-toolbar,
        .video-section:fullscreen .video-toolbar {
            flex: 0 0 auto;
            margin: 0;
            padding: 10px 16px;
            max-height: 40vh;
            overflow: auto;
            background: #111;
            color: #eee;
        }
        .video-section.video-theater .video-toolbar a,
        .video-section:fullscreen .video-toolbar a {
            color: #9cdcfe;
        }
        body.video-theater-open {
            overflow: hidden;
        }
        .video-fallback-image {
            display: block;
            max-width: 100%;
            border-radius: 6px;
            margin-bottom: 12px;
        }
        .video-unavailable {
            padding: 14px 16px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
        }
        .video-unavailable p {
            margin: 0 0 8px;
        }
        .video-toolbar {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 14px;
            margin-top: 10px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .video-quality-label {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .video-quality-label select {
            padding: 3px 7px;
            font-size: 12px;
        }
        .video-status {
            flex: 1 1 auto;
            min-height: 16px;
        }
        .video-status.ok {
            color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
        }
        .video-status.error {
            color: var(--vscode-errorForeground);
        }
        .video-source-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        .video-source-link:hover {
            text-decoration: underline;
        }
        .video-duration {
            font-variant-numeric: tabular-nums;
        }
        .math-inline {
            display: inline;
        }
        .math-display {
            display: block;
            margin: 0.75em 0;
            overflow-x: auto;
            overflow-y: hidden;
            text-align: center;
        }
        .math-display math {
            margin: 0 auto;
        }
        math {
            font-size: 1.05em;
        }
        math[display="block"] {
            margin: 0.75em auto;
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
        select, button, input[type="text"], input[type="number"] {
            padding: 8px 12px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            cursor: pointer;
        }
        input[type="text"], input[type="number"] {
            width: 100%;
            box-sizing: border-box;
            cursor: text;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        button:not(:disabled):hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .quiz-section {
            padding: 16px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            margin-bottom: 16px;
        }
        .quiz-options {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 16px;
        }
        .quiz-option {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 12px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
        }
        .quiz-option:hover {
            border-color: var(--vscode-focusBorder);
        }
        .quiz-option input {
            margin-top: 4px;
        }
        .quiz-input {
            margin-bottom: 16px;
        }
        .quiz-actions {
            display: flex;
            gap: 12px;
        }
        .quiz-status {
            margin-top: 12px;
            min-height: 18px;
            white-space: pre-wrap;
            font-size: 13px;
            line-height: 1.45;
        }
        .quiz-status-info {
            color: var(--vscode-descriptionForeground);
        }
        .quiz-status-success {
            color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
        }
        .quiz-status-error {
            color: var(--vscode-errorForeground);
        }
        .quiz-warning,
        .quiz-error {
            padding: 10px 12px;
            border-radius: 4px;
            margin-bottom: 12px;
            white-space: pre-wrap;
        }
        .quiz-warning {
            background: var(--vscode-inputValidation-warningBackground, transparent);
            color: var(--vscode-inputValidation-warningForeground, inherit);
            border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
        }
        .quiz-error {
            background: var(--vscode-inputValidation-errorBackground, transparent);
            color: var(--vscode-inputValidation-errorForeground, inherit);
            border: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
        }
        .quiz-label {
            display: block;
            font-weight: 600;
            margin-bottom: 6px;
        }
        .quiz-hint {
            margin-bottom: 10px;
            font-size: 12px;
            opacity: 0.8;
        }
        .quiz-input input,
        .quiz-textarea,
        .matching-select,
        .blank-input,
        .blank-select,
        .chemical-slot input {
            box-sizing: border-box;
            padding: 7px 9px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 3px;
            font-family: inherit;
            font-size: 13px;
        }
        .quiz-input input {
            width: 100%;
        }
        .quiz-textarea {
            display: block;
            width: 100%;
            resize: vertical;
            margin-bottom: 12px;
        }
        .code-input,
        .formula-input {
            font-family: var(--vscode-editor-font-family);
            tab-size: 4;
        }
        .sorting-list {
            list-style: none;
            margin: 0 0 16px;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .sorting-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 12px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: grab;
        }
        .sorting-item.dragging {
            opacity: 0.45;
            border-style: dashed;
        }
        .sorting-handle {
            opacity: 0.6;
        }
        .sorting-text {
            flex: 1;
            min-width: 0;
        }
        .sorting-controls {
            display: flex;
            gap: 4px;
        }
        .icon-btn {
            padding: 2px 8px;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 14px;
            line-height: 18px;
        }
        .icon-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .matching-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .matching-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(150px, 45%);
            gap: 12px;
            align-items: center;
        }
        .matching-left {
            min-width: 0;
        }
        .matching-select {
            width: 100%;
        }
        .table-scroll {
            overflow-x: auto;
            margin-bottom: 4px;
        }
        .quiz-table {
            border-collapse: collapse;
            width: 100%;
        }
        .quiz-table th,
        .quiz-table td {
            border: 1px solid var(--vscode-panel-border);
            padding: 6px 8px;
            text-align: center;
        }
        .quiz-table thead th {
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .quiz-table tbody th {
            text-align: left;
            font-weight: 600;
        }
        .fill-blanks {
            line-height: 2.3;
        }
        .blank-input {
            width: 140px;
            margin: 0 3px;
        }
        .blank-select {
            min-width: 140px;
            margin: 0 3px;
        }
        .html-editors {
            margin-bottom: 12px;
        }
        .html-checklist ul {
            margin: 6px 0 0 20px;
            padding: 0;
        }
        .dataset-header {
            font-weight: 600;
            margin-bottom: 6px;
        }
        .dataset-file {
            max-height: 240px;
            overflow: auto;
            margin: 0 0 14px;
            padding: 10px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 4px;
            white-space: pre;
        }
        .chemical-slots {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
        }
        .chemical-slot {
            display: flex;
            gap: 8px;
            padding: 10px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .chemical-slot label {
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 12px;
        }
        .puzzle-image {
            display: block;
            max-width: 100%;
            border-radius: 4px;
            margin-bottom: 12px;
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
        .comments-section {
            margin-top: 32px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .discussion-header {
            position: sticky;
            top: 0;
            z-index: 10;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 12px;
            margin: 0 -20px 12px;
            padding: 8px 20px;
            background: var(--vscode-editor-background);
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .discussion-tabs {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 3px;
            border-radius: 6px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
        }
        .discussion-tab {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 5px 12px;
            border: none;
            border-radius: 4px;
            background: transparent;
            color: var(--vscode-foreground);
            font-family: inherit;
            font-size: 13px;
            cursor: pointer;
        }
        .discussion-tab:hover {
            background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
        }
        .discussion-tab.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-weight: 600;
        }
        .discussion-tab.active .comments-count {
            background: rgba(255, 255, 255, 0.2);
            color: inherit;
        }
        .discussion-panel {
            min-height: 60px;
        }
        .solutions-lock-icon {
            font-size: 12px;
            line-height: 1;
            opacity: 0.85;
        }
        .solutions-locked {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 12px;
            margin: 8px 0 16px;
            padding: 12px;
            background: var(--vscode-input-background);
            border: 1px dashed var(--vscode-panel-border);
            border-radius: 4px;
            opacity: 0.95;
        }
        .solutions-locked-text {
            flex: 1 1 260px;
        }
        .comments-count {
            display: inline-block;
            padding: 1px 7px;
            border-radius: 10px;
            font-size: 11px;
            font-weight: normal;
            vertical-align: middle;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .comments-sort-label {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 12px;
            opacity: 0.9;
        }
        .comments-sort-label select {
            padding: 4px 8px;
            font-size: 12px;
        }
        .comment-composer,
        .reply-composer {
            margin: 8px 0 16px;
            padding: 12px;
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .comment-composer textarea,
        .reply-composer textarea {
            width: 100%;
            box-sizing: border-box;
            min-height: 64px;
            resize: vertical;
            padding: 8px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 4px;
            font-family: inherit;
            font-size: inherit;
        }
        .composer-actions {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 8px;
        }
        .composer-status {
            font-size: 12px;
            opacity: 0.85;
        }
        .composer-toolbar {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 4px;
            margin-bottom: 6px;
        }
        .format-btn {
            min-width: 28px;
            height: 26px;
            padding: 0 7px;
            font-size: 12px;
            line-height: 1;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
            border-radius: 3px;
            background: var(--vscode-button-secondaryBackground, transparent);
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            cursor: pointer;
        }
        .format-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
        }
        .format-btn:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 1px;
        }
        .composer-toolbar-hint {
            margin-left: auto;
            font-size: 11px;
            opacity: 0.6;
        }
        .composer-hint {
            margin-top: 4px;
            font-size: 11px;
            opacity: 0.7;
        }
        .stepik-rich-editor {
            overflow: hidden;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 4px;
            background: var(--vscode-input-background);
        }
        .stepik-rich-editor.disabled {
            opacity: 0.65;
        }
        .rich-editor-toolbar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 3px;
            padding: 5px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        }
        .rich-tool,
        .rich-mode {
            min-height: 26px;
            padding: 0 7px;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
            border-radius: 3px;
            background: var(--vscode-button-secondaryBackground, transparent);
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            font-family: inherit;
            font-size: 12px;
            line-height: 1;
            cursor: pointer;
        }
        .rich-tool:hover:not(:disabled),
        .rich-mode:hover:not(:disabled) {
            background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
        }
        .rich-tool:focus-visible,
        .rich-mode:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 1px;
        }
        .rich-tool:disabled,
        .rich-mode:disabled {
            cursor: default;
            opacity: 0.55;
        }
        .rich-toolbar-sep {
            width: 1px;
            height: 18px;
            margin: 0 2px;
            background: var(--vscode-panel-border);
        }
        .rich-editor-modes {
            display: inline-flex;
            margin-left: auto;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
            border-radius: 4px;
            overflow: hidden;
        }
        .rich-editor-modes .rich-mode {
            border: none;
            border-radius: 0;
        }
        .rich-editor-modes .rich-mode.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .rich-editor-surface {
            position: relative;
        }
        .rich-editor-content {
            min-height: 92px;
            max-height: 420px;
            padding: 10px 12px;
            overflow: auto;
            outline: none;
            font-size: 13px;
            line-height: 1.5;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
        .stepik-rich-editor.compact .rich-editor-content {
            min-height: 64px;
        }
        .rich-editor-content:empty::before {
            content: attr(data-placeholder);
            color: var(--vscode-input-placeholderForeground);
            pointer-events: none;
        }
        .rich-editor-content p {
            margin: 0 0 8px;
        }
        .rich-editor-content p:last-child {
            margin-bottom: 0;
        }
        .rich-editor-content pre {
            margin: 8px 0;
            padding: 8px 10px;
            overflow-x: auto;
            border-radius: 4px;
            background: var(--vscode-textCodeBlock-background);
            white-space: pre;
        }
        .rich-editor-content code {
            padding: 1px 3px;
            border-radius: 3px;
            background: var(--vscode-textCodeBlock-background);
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .rich-editor-content pre code {
            padding: 0;
            background: transparent;
        }
        .rich-editor-content img {
            max-width: 100%;
            height: auto;
        }
        .rich-editor-content blockquote {
            margin: 6px 0;
            padding: 2px 0 2px 10px;
            border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
            color: var(--vscode-textBlockQuote-foreground, inherit);
        }
        .rich-editor-content a {
            color: var(--vscode-textLink-foreground);
        }
        .rich-editor-content ul,
        .rich-editor-content ol {
            margin: 6px 0;
            padding-left: 24px;
        }
        .rich-editor-markdown {
            display: block;
            width: 100%;
            box-sizing: border-box;
            min-height: 110px;
            max-height: 420px;
            padding: 10px 12px;
            resize: vertical;
            border: none;
            outline: none;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 13px;
            line-height: 1.5;
        }
        .rich-editor-drop-hint {
            display: none;
            position: absolute;
            inset: 0;
            align-items: center;
            justify-content: center;
            border: 2px dashed var(--vscode-focusBorder);
            border-radius: 4px;
            background: var(--vscode-editorWidget-background);
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            pointer-events: none;
        }
        .stepik-rich-editor.dragging .rich-editor-drop-hint {
            display: flex;
        }
        .rich-editor-status {
            padding: 0 10px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .rich-editor-status:not(:empty) {
            padding: 5px 10px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .rich-dialog-backdrop {
            position: fixed;
            inset: 0;
            z-index: 1000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            background: rgba(0, 0, 0, 0.45);
        }
        .rich-dialog {
            display: flex;
            flex-direction: column;
            width: min(560px, 100%);
            max-height: 90vh;
            overflow: auto;
            border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
            border-radius: 6px;
            background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
            color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
            box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
        }
        .rich-dialog-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 10px 14px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .rich-dialog-title {
            font-weight: 600;
            font-size: 13px;
        }
        .rich-dialog-close {
            padding: 0 4px;
            border: none;
            background: transparent;
            color: inherit;
            font-size: 18px;
            line-height: 1;
            cursor: pointer;
        }
        .rich-dialog-body {
            padding: 14px;
        }
        .rich-field {
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-bottom: 10px;
            font-size: 12px;
        }
        .rich-field input,
        .rich-field select,
        .rich-field textarea {
            width: 100%;
            box-sizing: border-box;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 3px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: 13px;
        }
        .rich-field textarea {
            resize: vertical;
            font-family: var(--vscode-editor-font-family, monospace);
        }
        .rich-checkbox {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 10px;
            font-size: 12px;
        }
        .rich-dialog-hint {
            margin-top: 4px;
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .rich-dialog-hint a {
            color: var(--vscode-textLink-foreground);
        }
        .rich-dialog-preview {
            min-height: 36px;
            margin: 8px 0;
            padding: 8px 10px;
            overflow-x: auto;
            border: 1px dashed var(--vscode-panel-border);
            border-radius: 4px;
            font-size: 13px;
        }
        .rich-dialog-error {
            min-height: 16px;
            padding: 0 14px;
            color: var(--vscode-errorForeground);
            font-size: 12px;
        }
        .rich-dialog-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            padding: 10px 14px 14px;
        }
        .comment-text {
            display: block;
        }
        .comment-action-btn {
            padding: 2px 0;
            border: none;
            background: transparent;
            color: var(--vscode-textLink-foreground);
            font-family: inherit;
            font-size: 12px;
            cursor: pointer;
        }
        .comment-action-btn:hover:not(:disabled) {
            text-decoration: underline;
        }
        .comment-action-btn:disabled {
            opacity: 0.5;
            cursor: default;
        }
        .comment-action-status {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .comment-edit-actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            margin-top: 6px;
        }
        .comment-edit-status {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .solution-submission-label {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 8px;
            font-size: 12px;
        }
        .solution-submission-label select {
            max-width: 100%;
            padding: 4px 8px;
            font-size: 12px;
        }
        .solution-submission-hint {
            margin-bottom: 8px;
            font-size: 12px;
            opacity: 0.85;
        }
        .comment-actions {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 6px;
        }
        .comment-vote {
            display: inline-block;
            margin: 0 4px 0 0;
            white-space: nowrap;
            font-size: 14px;
            line-height: 22px;
            font-variant-numeric: tabular-nums;
            vertical-align: middle;
        }
        .comment-vote .ui-like {
            display: inline-block;
            margin: 0;
            padding: 0;
            border: 0;
            border-radius: 1px;
            background: transparent;
            color: var(--vscode-descriptionForeground, #999);
            font-family: inherit;
            font-size: inherit;
            line-height: inherit;
            cursor: pointer;
            --ui-like-icon-color: var(--vscode-descriptionForeground, #999);
            --ui-like-count-color: var(--vscode-descriptionForeground, #777);
        }
        .comment-vote .ui-vote__like + .ui-vote__like {
            margin-left: 16px;
        }
        .comment-vote .ui-like:not([data-is-inactive]):hover,
        .comment-vote .ui-like[data-is-active] {
            --ui-like-icon-color: var(--vscode-foreground, #ccc);
            --ui-like-count-color: var(--vscode-foreground, #ccc);
        }
        .comment-vote .ui-like:not([data-is-inactive]):hover {
            background: transparent;
        }
        .comment-vote .ui-like[data-is-inactive] {
            cursor: default;
        }
        .comment-vote .ui-like__icon {
            position: relative;
            top: 0.2em;
            display: inline-block;
            width: 1.25em;
            height: 1.25em;
            margin-right: 2px;
            color: var(--ui-like-icon-color, #999);
            vertical-align: baseline;
            transition: color 0.3s;
        }
        .comment-vote .ui-like__icon svg {
            display: block;
            width: 100%;
            height: 100%;
        }
        .comment-vote .ui-like[data-type="dislike"] .ui-like__icon {
            top: 0.35em;
            transform: rotate(180deg);
        }
        .comment-vote .ui-like__count {
            color: var(--ui-like-count-color, #777);
            transition: color 0.3s;
        }
        .comment-vote .ui-like:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }
        .comment-vote-static .ui-like__icon {
            opacity: 0.85;
        }
        .vote-count {
            font-variant-numeric: tabular-nums;
        }
        .vote-status {
            margin-left: 4px;
            color: var(--vscode-errorForeground);
            font-size: 11px;
        }
        .reply-btn {
            display: inline-block;
            padding: 2px 0;
            border: none;
            background: transparent;
            color: var(--vscode-textLink-foreground);
            font-size: 12px;
            cursor: pointer;
        }
        .reply-btn:not(:disabled):hover {
            background: transparent;
            text-decoration: underline;
        }
        .comments-list {
            display: flex;
            flex-direction: column;
        }
        .comment {
            display: flex;
            gap: 10px;
            padding: 12px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .comment.pinned {
            margin: 0 -8px;
            padding: 12px 8px;
            border-radius: 4px;
            background: var(--vscode-inputValidation-warningBackground, transparent);
        }
        .comment.teacher {
            margin: 0 -8px;
            padding: 12px 8px;
            border-left: 3px solid var(--vscode-testing-iconPassed, var(--vscode-charts-green));
            border-radius: 4px;
            background: var(--vscode-inputValidation-infoBackground, transparent);
        }
        .comment.teacher-replied {
            margin: 0 -8px;
            padding: 12px 8px;
            border-left: 3px solid var(--vscode-charts-blue, var(--vscode-textLink-foreground));
            border-radius: 4px;
            background: var(--vscode-inputValidation-infoBackground, transparent);
        }
        .comment.solution {
            border-left: 2px solid var(--vscode-textLink-foreground);
            padding-left: 10px;
        }
        .comment-replies .comment.teacher,
        .comment-replies .comment.teacher-replied,
        .comment-replies .comment.solution {
            margin: 0;
            padding: 8px;
        }
        .comments-list > .comment:last-child {
            border-bottom: none;
        }
        .comments-sentinel {
            height: 1px;
        }
        .replies-loading {
            padding: 4px 0;
            font-size: 12px;
            opacity: 0.7;
        }
        .solutions-status {
            min-height: 18px;
            margin-bottom: 8px;
            font-size: 12px;
            opacity: 0.85;
        }
        .solutions-status.error {
            color: var(--vscode-errorForeground);
        }
        .solutions-content {
            margin-top: 8px;
        }
        .comment-avatar {
            position: relative;
            flex: 0 0 32px;
            width: 32px;
            height: 32px;
        }
        .comment-avatar-img {
            position: absolute;
            inset: 0;
            width: 100%;
            height: 100%;
            border-radius: 50%;
            object-fit: cover;
            background: var(--vscode-editor-background);
        }
        .comment-avatar-fallback {
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 14px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .comment-avatar.broken .comment-avatar-img {
            display: none;
        }
        .comment-main {
            flex: 1;
            min-width: 0;
        }
        .comment-head {
            display: flex;
            align-items: baseline;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 4px;
        }
        .comment-author {
            font-weight: 600;
        }
        .comment-date {
            font-size: 12px;
            opacity: 0.65;
        }
        .comment-role,
        .comment-flag {
            display: inline-block;
            padding: 1px 7px;
            border-radius: 10px;
            font-size: 11px;
            line-height: 16px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .comment-role.teacher {
            background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
            color: var(--vscode-editor-background);
        }
        .comment-role.staff,
        .comment-role.admin,
        .comment-role.moderator {
            background: var(--vscode-textLink-foreground);
            color: var(--vscode-editor-background);
        }
        .comment-flag.pin {
            background: var(--vscode-inputValidation-warningBackground);
            color: var(--vscode-inputValidation-warningForeground);
        }
        .comment-flag.teacher-comment,
        .comment-flag.teacher-reply {
            background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
            color: var(--vscode-editor-background);
        }
        .comment-flag.solution {
            background: var(--vscode-textLink-foreground);
            color: var(--vscode-editor-background);
        }
        .comment-flag.reply {
            background: var(--vscode-button-secondaryBackground, var(--vscode-badge-background));
            color: var(--vscode-button-secondaryForeground, var(--vscode-badge-foreground));
            border: 1px solid var(--vscode-panel-border);
        }
        .comment-body {
            overflow-wrap: anywhere;
        }
        .comment-body p {
            margin: 0.5em 0;
        }
        .comment-body p:first-child {
            margin-top: 0;
        }
        .comment-body p:last-child {
            margin-bottom: 0;
        }
        .comment-body img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
        }
        .comment-body pre {
            padding: 10px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 4px;
            overflow-x: auto;
            white-space: pre-wrap;
        }
        .comment-submission {
            margin-top: 10px;
        }
        .comment-submission-head {
            font-size: 11px;
            opacity: 0.75;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 4px;
        }
        .comment-submission pre {
            margin: 0;
        }
        .comment-submission pre + .comment-submission-code-label {
            margin-top: 10px;
        }
        .comment-submission-text {
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
        .comment-submission-list {
            margin: 0;
            padding-left: 1.5em;
        }
        .comment-submission-list li {
            margin: 0.2em 0;
        }
        .comment-submission-list li > p:first-child {
            margin-top: 0;
        }
        .comment-submission-list li > p:last-child {
            margin-bottom: 0;
        }
        .comment-submission-label {
            font-weight: 600;
        }
        .comment-submission-empty {
            opacity: 0.75;
        }
        .comment-submission-code-label {
            font-size: 10px;
            opacity: 0.65;
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin: 8px 0 3px;
        }
        .comment-submission-json {
            margin: 0;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
        }
        .comment-submission-formula {
            padding: 6px 8px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 4px;
            overflow-x: auto;
        }
        .comment-submission-formula .math-display {
            margin: 0;
        }
        .comment-submission-pair-arrow {
            opacity: 0.7;
            margin: 0 6px;
        }
        .comment-submission-table {
            width: 100%;
            margin: 0;
            border-collapse: collapse;
        }
        .comment-submission-table th,
        .comment-submission-table td {
            padding: 4px 6px;
            border: 1px solid var(--vscode-panel-border);
            text-align: left;
            vertical-align: top;
        }
        .comment-submission-table th {
            font-weight: 600;
        }
        .comment-body code {
            background: var(--vscode-textCodeBlock-background);
            padding: 1px 4px;
            border-radius: 2px;
        }
        .comment-body pre code {
            padding: 0;
            background: transparent;
        }
        .comment-body blockquote {
            margin: 8px 0;
            padding-left: 12px;
            border-left: 3px solid var(--vscode-panel-border);
            opacity: 0.9;
        }
        .comment-body h1,
        .comment-body h2,
        .comment-body h3,
        .comment-body h4,
        .comment-body h5,
        .comment-body h6 {
            margin: 0.7em 0 0.35em;
            line-height: 1.3;
        }
        .comment-body h1 { font-size: 1.4em; }
        .comment-body h2 { font-size: 1.28em; }
        .comment-body h3 { font-size: 1.16em; }
        .comment-body h4,
        .comment-body h5,
        .comment-body h6 { font-size: 1em; }
        .comment-body ul,
        .comment-body ol {
            margin: 0.5em 0;
            padding-left: 1.6em;
        }
        .comment-body li {
            margin: 0.15em 0;
        }
        .comment-body a {
            color: var(--vscode-textLink-foreground);
        }
        .comment-body hr {
            margin: 12px 0;
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
        }
        .comment-body table {
            display: block;
            max-width: 100%;
            margin: 8px 0;
            overflow-x: auto;
            border-collapse: collapse;
        }
        .comment-body th,
        .comment-body td {
            padding: 4px 8px;
            border: 1px solid var(--vscode-panel-border);
            text-align: left;
        }
        .comment-body th {
            background: var(--vscode-sideBarSectionHeader-background);
        }
        .comment-body details {
            margin: 8px 0;
            padding: 6px 10px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .comment-body summary {
            cursor: pointer;
            font-weight: 600;
        }
        .comment-deleted {
            opacity: 0.7;
        }
        .comment-replies {
            margin-top: 8px;
            padding-left: 12px;
            border-left: 2px solid var(--vscode-panel-border);
        }
        .comment-replies:empty {
            display: none;
        }
        .comment-replies .comment {
            border-bottom: none;
            padding-bottom: 0;
        }
        .comment-replies > .comment:first-child {
            padding-top: 4px;
        }
        .replies-btn {
            display: inline-block;
            margin-top: 6px;
            padding: 2px 0;
            border: none;
            background: transparent;
            color: var(--vscode-textLink-foreground);
            font-size: 12px;
            cursor: pointer;
        }
        .replies-btn:not(:disabled):hover {
            background: transparent;
            text-decoration: underline;
        }
        .replies-btn:disabled {
            opacity: 0.7;
            cursor: default;
        }
        .replies-footer {
            display: flex;
            align-items: center;
            flex-wrap: wrap;
            gap: 10px;
            padding: 6px 0 2px;
        }
        .replies-more-btn {
            display: inline-block;
            padding: 2px 0;
            border: none;
            background: transparent;
            color: var(--vscode-textLink-foreground);
            font-size: 12px;
            cursor: pointer;
        }
        .replies-more-btn:not(:disabled):hover {
            background: transparent;
            text-decoration: underline;
        }
        .replies-more-btn:disabled {
            opacity: 0.7;
            cursor: default;
        }
        .replies-status {
            font-size: 12px;
            color: var(--vscode-errorForeground);
        }
        .comments-actions {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-top: 12px;
        }
        .comments-status {
            font-size: 12px;
            color: var(--vscode-errorForeground);
        }
        .comments-empty,
        .comments-error {
            padding: 12px;
            border: 1px dashed var(--vscode-panel-border);
            border-radius: 4px;
            opacity: 0.85;
        }
        .comments-error {
            color: var(--vscode-errorForeground);
            border-color: var(--vscode-errorForeground);
        }
        .comments-error button {
            margin-top: 8px;
        }

        /* Syntax highlighting: same palette as the VS Code Markdown preview. */
        .task-content pre.hljs,
        .quiz-section pre.hljs,
        .comment-body pre.hljs,
        .comment-submission pre.hljs {
            color: var(--vscode-editor-foreground);
        }
        .task-content pre.hljs code,
        .quiz-section pre.hljs code,
        .comment-body pre.hljs code,
        .comment-submission pre.hljs code {
            display: inline-block;
            color: inherit;
            tab-size: 4;
            background: none;
            padding: 0;
            border-radius: 0;
        }
        .hljs-keyword,
        .hljs-literal,
        .hljs-symbol,
        .hljs-name {
            color: #569cd6;
        }
        .hljs-link {
            color: #569cd6;
            text-decoration: underline;
        }
        .hljs-built_in,
        .hljs-type {
            color: #4ec9b0;
        }
        .hljs-number,
        .hljs-class {
            color: #b8d7a3;
        }
        .hljs-string,
        .hljs-meta-string {
            color: #d69d85;
        }
        .hljs-regexp,
        .hljs-template-tag {
            color: #9a5334;
        }
        .hljs-subst,
        .hljs-function,
        .hljs-title,
        .hljs-params,
        .hljs-formula {
            color: #dcdcdc;
        }
        .hljs-comment,
        .hljs-quote {
            color: #57a64a;
            font-style: italic;
        }
        .hljs-doctag {
            color: #608b4e;
        }
        .hljs-meta,
        .hljs-meta-keyword,
        .hljs-tag {
            color: #9b9b9b;
        }
        .hljs-variable,
        .hljs-template-variable {
            color: #bd63c5;
        }
        .hljs-attr,
        .hljs-attribute,
        .hljs-builtin-name {
            color: #9cdcfe;
        }
        .hljs-section {
            color: gold;
        }
        .hljs-emphasis {
            font-style: italic;
        }
        .hljs-strong {
            font-weight: bold;
        }
        .hljs-bullet,
        .hljs-selector-tag,
        .hljs-selector-id,
        .hljs-selector-class,
        .hljs-selector-attr,
        .hljs-selector-pseudo {
            color: #d7ba7d;
        }
        .hljs-addition {
            background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.2));
            color: rgb(155, 185, 85);
            display: inline-block;
            width: 100%;
        }
        .hljs-deletion {
            background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2));
            color: rgb(255, 0, 0);
            display: inline-block;
            width: 100%;
        }
        .vscode-light .hljs-function,
        .vscode-light .hljs-params,
        .vscode-light .hljs-number,
        .vscode-light .hljs-class {
            color: inherit;
        }
        .vscode-light .hljs-comment,
        .vscode-light .hljs-quote,
        .vscode-light .hljs-number,
        .vscode-light .hljs-class,
        .vscode-light .hljs-variable {
            color: #008000;
        }
        .vscode-light .hljs-keyword,
        .vscode-light .hljs-selector-tag,
        .vscode-light .hljs-name,
        .vscode-light .hljs-tag {
            color: #00f;
        }
        .vscode-light .hljs-built_in,
        .vscode-light .hljs-builtin-name {
            color: #007acc;
        }
        .vscode-light .hljs-string,
        .vscode-light .hljs-section,
        .vscode-light .hljs-attribute,
        .vscode-light .hljs-literal,
        .vscode-light .hljs-template-tag,
        .vscode-light .hljs-template-variable,
        .vscode-light .hljs-type {
            color: #a31515;
        }
        .vscode-light .hljs-subst,
        .vscode-light .hljs-selector-attr,
        .vscode-light .hljs-selector-pseudo,
        .vscode-light .hljs-meta,
        .vscode-light .hljs-meta-keyword {
            color: #2b91af;
        }
        .vscode-light .hljs-title,
        .vscode-light .hljs-doctag {
            color: #808080;
        }
        .vscode-light .hljs-attr {
            color: #f00;
        }
        .vscode-light .hljs-symbol,
        .vscode-light .hljs-bullet,
        .vscode-light .hljs-link {
            color: #00b0e8;
        }
        .vscode-light .hljs-emphasis {
            font-style: italic;
        }
        .vscode-light .hljs-strong {
            font-weight: bold;
        }
${stepikThemeCss}
        /* Task panel: keep the shared Stepik palette without fighting the
           webview host's code highlighting and fullscreen video colors. */
        body[data-view="task"] {
            --sk-shell: 1080px;
            padding: 0;
            line-height: 1.65;
        }
        body[data-view="task"] .task-shell {
            max-width: var(--sk-shell);
            margin: 0 auto;
            padding: 20px 24px 48px;
        }
        body[data-view="task"] .step-header {
            padding-bottom: 12px;
            border-bottom: 1px solid var(--sk-border);
        }
        body[data-view="task"] .step-nav-btn {
            padding: 6px 14px;
            border: 1px solid var(--sk-border-strong);
            border-radius: 6px;
            background: var(--sk-surface);
            color: var(--sk-fg);
            font-weight: 600;
        }
        body[data-view="task"] .step-nav-btn:hover:not(:disabled) {
            border-color: var(--sk-accent);
            background: var(--sk-accent-soft);
            color: var(--sk-link);
        }
        body[data-view="task"] .step-nav-btn[data-step-nav="next"] {
            border-color: var(--sk-accent-strong);
            background: var(--sk-accent-strong);
            color: var(--sk-on-accent);
        }
        body[data-view="task"] .step-nav-btn[data-step-nav="next"]:hover:not(:disabled) {
            border-color: var(--sk-accent-hover);
            background: var(--sk-accent-hover);
            color: var(--sk-on-accent);
        }
        body[data-view="task"] .stepik-link {
            color: var(--sk-link);
            font-weight: 500;
        }
        body[data-view="task"] .stepik-link:hover { color: var(--sk-link-hover); }
        body[data-view="task"] .task-type {
            padding: 4px 10px;
            border: 1px solid var(--sk-border);
            border-radius: 999px;
            background: var(--sk-accent-soft);
            color: var(--sk-link);
            font-weight: 600;
        }
        body[data-view="task"] .exam-banner {
            border-color: var(--sk-warning);
            background: color-mix(in srgb, var(--sk-warning) 12%, transparent);
        }
        body[data-view="task"] .exam-badge {
            color: var(--sk-bg);
            background: var(--sk-warning);
        }
        body[data-view="task"] .progress-streak {
            background: var(--sk-accent-strong);
            color: var(--sk-on-accent);
        }
        body[data-view="task"] .progress-streak-count { color: var(--sk-on-accent); opacity: 0.78; }
        body[data-view="task"] .progress-line-track { background: var(--sk-border-strong); }
        body[data-view="task"] .progress-line-fill { background: var(--sk-accent); }
        body[data-view="task"] .progress-line-marker {
            border-color: var(--sk-bg);
            background: var(--sk-border-strong);
        }
        body[data-view="task"] .progress-tooltip {
            border: 1px solid var(--sk-border-strong);
            background: var(--sk-surface);
            color: var(--sk-muted);
            box-shadow: var(--sk-shadow);
        }
        body[data-view="task"] .progress-tooltip::before {
            border-color: transparent transparent var(--sk-border-strong) transparent;
        }
        body[data-view="task"] .progress-tooltip-title,
        body[data-view="task"] .progress-tooltip-line span { color: var(--sk-fg); }
        body[data-view="task"] .language-selector,
        body[data-view="task"] .quiz-section,
        body[data-view="task"] .solutions-locked,
        body[data-view="task"] .comment-composer,
        body[data-view="task"] .reply-composer {
            border: 1px solid var(--sk-border);
            border-radius: 8px;
            background: var(--sk-surface-2);
        }
        body[data-view="task"] .quiz-option,
        body[data-view="task"] .sorting-item,
        body[data-view="task"] .sample {
            border-color: var(--sk-border);
            border-radius: 8px;
            background: var(--sk-surface);
        }
        body[data-view="task"] .quiz-option:hover,
        body[data-view="task"] .sorting-item:hover {
            border-color: var(--sk-accent);
        }
        body[data-view="task"] .quiz-warning {
            border-color: var(--sk-warning);
            background: color-mix(in srgb, var(--sk-warning) 10%, transparent);
            color: var(--sk-fg);
        }
        body[data-view="task"] .quiz-error {
            border-color: var(--sk-danger);
            background: color-mix(in srgb, var(--sk-danger) 10%, transparent);
            color: var(--sk-fg);
        }
        body[data-view="task"] .quiz-status-info { color: var(--sk-muted); }
        body[data-view="task"] .quiz-status-success { color: var(--sk-accent-strong); }
        body[data-view="task"] .quiz-status-error { color: var(--sk-danger); }
        body[data-view="task"] select,
        body[data-view="task"] input[type="text"],
        body[data-view="task"] input[type="number"],
        body[data-view="task"] .quiz-textarea,
        body[data-view="task"] .matching-select,
        body[data-view="task"] .blank-input,
        body[data-view="task"] .blank-select,
        body[data-view="task"] .chemical-slot input,
        body[data-view="task"] .rich-field input,
        body[data-view="task"] .rich-field select,
        body[data-view="task"] .rich-field textarea {
            border-color: var(--sk-border-strong);
            background: var(--sk-surface);
            color: var(--sk-fg);
        }
        body[data-view="task"] select:focus,
        body[data-view="task"] input[type="text"]:focus,
        body[data-view="task"] input[type="number"]:focus,
        body[data-view="task"] .quiz-textarea:focus {
            border-color: var(--sk-accent);
            outline-color: var(--sk-accent);
        }
        body[data-view="task"] #open-btn,
        body[data-view="task"] #submit-quiz-btn,
        body[data-view="task"] #post-comment-btn,
        body[data-view="task"] #post-solution-btn,
        body[data-view="task"] .post-reply-btn,
        body[data-view="task"] .rich-dialog-primary,
        body[data-view="task"] .load-more {
            border: 1px solid var(--sk-accent-strong);
            border-radius: 6px;
            background: var(--sk-accent-strong);
            color: var(--sk-on-accent);
            font-weight: 600;
        }
        body[data-view="task"] #open-btn:hover:not(:disabled),
        body[data-view="task"] #submit-quiz-btn:hover:not(:disabled),
        body[data-view="task"] #post-comment-btn:hover:not(:disabled),
        body[data-view="task"] #post-solution-btn:hover:not(:disabled),
        body[data-view="task"] .post-reply-btn:hover:not(:disabled),
        body[data-view="task"] .rich-dialog-primary:hover:not(:disabled),
        body[data-view="task"] .load-more:hover:not(:disabled) {
            border-color: var(--sk-accent-hover);
            background: var(--sk-accent-hover);
            color: var(--sk-on-accent);
        }
        body[data-view="task"] button.secondary,
        body[data-view="task"] .rich-dialog-cancel,
        body[data-view="task"] .format-btn,
        body[data-view="task"] .rich-tool,
        body[data-view="task"] .rich-mode,
        body[data-view="task"] .video-action-btn {
            border: 1px solid var(--sk-border-strong);
            border-radius: 6px;
            background: var(--sk-surface);
            color: var(--sk-fg);
        }
        body[data-view="task"] button.secondary:hover:not(:disabled),
        body[data-view="task"] .rich-dialog-cancel:hover:not(:disabled),
        body[data-view="task"] .format-btn:hover:not(:disabled),
        body[data-view="task"] .rich-tool:hover:not(:disabled),
        body[data-view="task"] .rich-mode:hover:not(:disabled),
        body[data-view="task"] .video-action-btn:hover:not(:disabled) {
            border-color: var(--sk-accent);
            background: var(--sk-accent-soft);
            color: var(--sk-link);
        }
        body[data-view="task"] .discussion-header {
            margin-right: -24px;
            margin-left: -24px;
            padding-right: 24px;
            padding-left: 24px;
            border-bottom-color: var(--sk-border);
            background: var(--sk-bg);
        }
        body[data-view="task"] .comments-section { border-top-color: var(--sk-border); }
        body[data-view="task"] .discussion-tabs {
            border-color: var(--sk-border);
            border-radius: 8px;
            background: var(--sk-surface-2);
        }
        body[data-view="task"] .discussion-tab { color: var(--sk-muted); }
        body[data-view="task"] .discussion-tab:hover {
            background: var(--sk-accent-soft);
            color: var(--sk-fg);
        }
        body[data-view="task"] .discussion-tab.active {
            background: var(--sk-accent-strong);
            color: var(--sk-on-accent);
        }
        body[data-view="task"] .discussion-tab.active .comments-count {
            background: rgba(255, 255, 255, 0.22);
            color: inherit;
        }
        body[data-view="task"] .comments-count {
            background: var(--sk-accent-soft);
            color: var(--sk-link);
        }
        body[data-view="task"] .comment { border-bottom-color: var(--sk-border); }
        body[data-view="task"] .comment.pinned {
            border-left: 3px solid var(--sk-accent);
            background: var(--sk-accent-soft);
        }
        body[data-view="task"] .comment.teacher,
        body[data-view="task"] .comment.teacher-replied {
            border-left-color: var(--sk-accent);
            background: var(--sk-surface-2);
        }
        body[data-view="task"] .comment.solution { border-left-color: var(--sk-accent); }
        body[data-view="task"] .comment-avatar-img,
        body[data-view="task"] .comment-avatar-fallback { border-radius: 8px; }
        body[data-view="task"] .comment-avatar-fallback {
            background: var(--sk-avatar);
            color: #ffffff;
        }
        body[data-view="task"] .comment-author { color: var(--sk-fg); }
        body[data-view="task"] .comment-date,
        body[data-view="task"] .comment-role,
        body[data-view="task"] .comment-action-status,
        body[data-view="task"] .composer-hint,
        body[data-view="task"] .solutions-status,
        body[data-view="task"] .comments-status { color: var(--sk-muted); }
        body[data-view="task"] .comment-action-btn,
        body[data-view="task"] .reply-btn,
        body[data-view="task"] .replies-btn { color: var(--sk-link); }
        body[data-view="task"] .comment-action-btn:hover:not(:disabled),
        body[data-view="task"] .reply-btn:not(:disabled):hover { color: var(--sk-link-hover); }
        body[data-view="task"] .stepik-rich-editor,
        body[data-view="task"] .rich-editor-markdown {
            border-color: var(--sk-border-strong);
            border-radius: 8px;
            background: var(--sk-surface);
            color: var(--sk-fg);
        }
        body[data-view="task"] .rich-editor-toolbar { background: var(--sk-surface-2); }
        body[data-view="task"] .rich-editor-modes .rich-mode.active {
            background: var(--sk-accent-strong);
            color: var(--sk-on-accent);
        }
        body[data-view="task"] .rich-editor-content a,
        body[data-view="task"] .rich-dialog-hint a { color: var(--sk-link); }
        body[data-view="task"] .rich-dialog {
            border-color: var(--sk-border-strong);
            border-radius: 10px;
            background: var(--sk-surface);
            color: var(--sk-fg);
        }
        body[data-view="task"] .rich-dialog-head { border-bottom-color: var(--sk-border); }
        body[data-view="task"] .rich-dialog-preview { border-color: var(--sk-border-strong); }
        body[data-view="task"] .video-unavailable {
            border-color: var(--sk-border);
            border-radius: 8px;
            background: var(--sk-surface-2);
        }
        body[data-view="task"] .video-toolbar { color: var(--sk-muted); }
        body[data-view="task"] .video-source-link { color: var(--sk-link); }
        body[data-view="task"] .composer-status { color: var(--sk-muted); }
        body[data-view="task"] .comments-empty,
        body[data-view="task"] .comments-error {
            border-color: var(--sk-border-strong);
            background: var(--sk-surface-2);
        }
        @media (max-width: 760px) {
            body[data-view="task"] .task-shell { padding: 16px 14px 36px; }
            body[data-view="task"] .discussion-header {
                margin-right: -14px;
                margin-left: -14px;
                padding-right: 14px;
                padding-left: 14px;
            }
        }
        `;
        return this.stylesCache;
    }

    private getScript(stepType: string, step?: Step): string {
        const dataset = this.getAttemptDataset() || {};
        const checklist: HtmlChecklistItem[] = step?.block.options?.checklist || [];
        const solutionsAvailable = Boolean(
            step && this.isQuizStep(step) && this.solutionsAvailable && this.solutionsThread
        );
        const embed = (value: unknown) => JSON.stringify(value ?? null).replace(/</g, '\\u003c');
        const parts: string[] = [];

        // Shared quiz plumbing: status line, restart and submit binding. The
        // handler are written as plain ES2019 so they run unchanged in the
        // webview sandbox.
        parts.push(String.raw`
            const quizStatusEl = document.getElementById('quiz-status');
            const quizSubmitBtn = document.getElementById('submit-quiz-btn');
            const quizRestartBtn = document.getElementById('restart-btn');

            function setQuizStatus(kind, text) {
                if (!quizStatusEl) return;
                quizStatusEl.className = 'quiz-status' + (kind ? ' quiz-status-' + kind : '');
                quizStatusEl.textContent = text || '';
            }

            window.addEventListener('message', (event) => {
                const data = event.data || {};
                if (data.command === 'quizStatus') {
                    setQuizStatus(data.kind, data.text);
                }
            });

            if (quizRestartBtn) {
                quizRestartBtn.addEventListener('click', () => {
                    setQuizStatus('info', t('task.newAttemptStatus'));
                    vscode.postMessage({ command: 'restart' });
                });
            }

            document.querySelectorAll('[data-step-nav]').forEach((button) => {
                button.addEventListener('click', () => {
                    // Opening a step is asynchronous. Disable both buttons so
                    // a double click cannot queue the same navigation twice.
                    document
                        .querySelectorAll('[data-step-nav]')
                        .forEach((navButton) => { navButton.disabled = true; });
                    const direction = button.getAttribute('data-step-nav');
                    vscode.postMessage({
                        command: direction === 'previous' ? 'previousStep' : 'nextStep'
                    });
                });
            });

            const examBanner = document.getElementById('exam-banner');
            if (examBanner) {
                const examDeadline = Number(examBanner.getAttribute('data-exam-deadline'));
                const examTimer = document.getElementById('exam-timer');
                const examExpired = document.getElementById('exam-expired');
                const pad = (value) => String(value).padStart(2, '0');
                const tickExamTimer = () => {
                    if (!examDeadline || !examTimer) return;
                    const left = Math.max(
                        0,
                        Math.floor((examDeadline - Date.now()) / 1000)
                    );
                    const hours = Math.floor(left / 3600);
                    const minutes = Math.floor((left % 3600) / 60);
                    const seconds = left % 60;
                    const time =
                        (hours > 0 ? hours + ':' + pad(minutes) : String(minutes)) +
                        ':' + pad(seconds);
                    examTimer.textContent = t('task.examTimeLeft', { time: time });
                    if (left <= 0) {
                        if (examExpired) examExpired.hidden = false;
                        document
                            .querySelectorAll('#submit-quiz-btn, #restart-btn, .step-nav-btn')
                            .forEach((button) => { button.disabled = true; });
                    }
                };
                tickExamTimer();
                setInterval(tickExamTimer, 1000);
            }

            function bindQuizSubmit(buildReply) {
                if (!quizSubmitBtn) return;
                quizSubmitBtn.addEventListener('click', () => {
                    const reply = buildReply();
                    if (reply) {
                        vscode.postMessage({ command: 'submitQuiz', reply: reply });
                    }
                });
            }
        `);

        if (stepType === 'code') {
            parts.push(String.raw`
                const languageSelect = document.getElementById('language-select');
                const openBtn = document.getElementById('open-btn');

                if (languageSelect && openBtn) {
                    languageSelect.addEventListener('change', () => {
                        openBtn.disabled = !languageSelect.value;
                    });

                    openBtn.addEventListener('click', () => {
                        if (languageSelect.value) {
                            vscode.postMessage({
                                command: 'selectLanguage',
                                language: languageSelect.value
                            });
                        }
                    });
                }
            `);
        } else if (stepType === 'video') {
            parts.push(String.raw`
                const videoId = ${JSON.stringify(step?.block.video?.id ?? step?.id ?? 0)};
                const stepikVideo = document.getElementById('stepik-video');
                const videoQualitySelect = document.getElementById('video-quality');
                const videoStatusEl = document.getElementById('video-status');
                const audioStatusEl = document.getElementById('video-audio-status');
                const videoAudio = document.getElementById('stepik-video-audio');
                const audioEnableBtn = document.getElementById('video-audio-enable');
                const fullscreenBtn = document.getElementById('video-fullscreen');
                const openBrowserBtn = document.getElementById('video-open-browser');
                const videoSection = document.querySelector('.video-section');
                let audioReady = false;

                const setAudioStatus = (text, kind) => {
                    if (!audioStatusEl) return;
                    audioStatusEl.textContent = text;
                    audioStatusEl.classList.toggle('ok', kind === 'ok');
                    audioStatusEl.classList.toggle('error', kind === 'error');
                };

                const syncAudio = (force) => {
                    if (!audioReady || !videoAudio || !stepikVideo) return;
                    if (
                        force ||
                        Math.abs(videoAudio.currentTime - stepikVideo.currentTime) > 0.3
                    ) {
                        try {
                            videoAudio.currentTime = stepikVideo.currentTime;
                        } catch (error) {}
                    }
                    videoAudio.playbackRate = stepikVideo.playbackRate;
                    videoAudio.volume = stepikVideo.volume;
                    videoAudio.muted = stepikVideo.muted;
                };

                const playAudio = () => {
                    if (!audioReady || !videoAudio || !stepikVideo) return;
                    syncAudio(true);
                    // Never start the audio track while the video is paused.
                    if (stepikVideo.paused) return;
                    const started = videoAudio.play();
                    if (started && started.catch) {
                        started.catch(() => {
                            if (audioEnableBtn) audioEnableBtn.hidden = false;
                            setAudioStatus(
                                t('task.audioEnableHint'),
                                'error'
                            );
                        });
                    }
                };

                const pauseAudio = () => {
                    if (audioReady && videoAudio) {
                        videoAudio.pause();
                    }
                };

                if (stepikVideo) {
                    let viewReported = false;
                    const reportView = () => {
                        if (viewReported) return;
                        viewReported = true;
                        vscode.postMessage({ command: 'markVideoViewed' });
                    };

                    // Report a single view when playback actually starts. The
                    // website uses the same signal to advance course progress.
                    stepikVideo.addEventListener('play', () => {
                        reportView();
                        playAudio();
                    });
                    stepikVideo.addEventListener('playing', playAudio);
                    stepikVideo.addEventListener('pause', pauseAudio);
                    stepikVideo.addEventListener('waiting', pauseAudio);
                    stepikVideo.addEventListener('ended', () => {
                        reportView();
                        pauseAudio();
                    });
                    stepikVideo.addEventListener('seeking', () => syncAudio(true));
                    stepikVideo.addEventListener('seeked', () => syncAudio(true));
                    stepikVideo.addEventListener('ratechange', () => syncAudio(false));
                    stepikVideo.addEventListener('volumechange', () => syncAudio(false));
                    stepikVideo.addEventListener('loadstart', pauseAudio);
                    stepikVideo.addEventListener('timeupdate', () => {
                        if (!stepikVideo.paused) syncAudio(false);
                    });

                    if (audioEnableBtn) {
                        audioEnableBtn.addEventListener('click', () => {
                            audioEnableBtn.hidden = true;
                            playAudio();
                        });
                    }

                    if (videoAudio) {
                        videoAudio.addEventListener('error', () => {
                            audioReady = false;
                            setAudioStatus(t('task.audioPlaybackError'), 'error');
                        });
                        videoAudio.addEventListener('loadedmetadata', () => {
                            syncAudio(true);
                            if (!stepikVideo.paused) playAudio();
                        });
                    }

                    window.addEventListener('message', (event) => {
                        const data = event.data || {};
                        if (data.command === 'videoAudioProgress' && data.videoId === videoId) {
                            const percent = Math.round(data.percent || 0);
                            setAudioStatus(
                                data.phase === 'download'
                                    ? t('task.audioDownloading', { percent: percent })
                                    : t('task.audioExtracting', { percent: percent })
                            );
                            return;
                        }
                        if (data.command === 'videoAudio' && data.videoId === videoId) {
                            if (data.ok && data.url && videoAudio) {
                                videoAudio.src = data.url;
                                videoAudio.load();
                                audioReady = true;
                                setAudioStatus(t('task.audioReady'), 'ok');
                                if (!stepikVideo.paused) playAudio();
                            } else {
                                audioReady = false;
                                setAudioStatus(
                                    data.message || t('task.audioUnavailable'),
                                    'error'
                                );
                            }
                            return;
                        }
                        if (data.command === 'videoViewed') {
                            if (videoStatusEl) {
                                videoStatusEl.textContent = data.ok
                                    ? t('task.viewMarked')
                                    : (data.message || t('task.viewMarkFailed'));
                                videoStatusEl.classList.toggle('ok', Boolean(data.ok));
                                videoStatusEl.classList.toggle('error', !data.ok);
                            }
                        }
                    });

                    vscode.postMessage({ command: 'videoReady' });
                }

                if (openBrowserBtn) {
                    openBrowserBtn.addEventListener('click', () => {
                        const url = openBrowserBtn.getAttribute('data-video-url');
                        if (url) vscode.postMessage({ command: 'openVideoUrl', url });
                    });
                }

                if (fullscreenBtn && videoSection && stepikVideo) {
                    let theater = false;
                    const updateFullscreenButton = () => {
                        const active = theater || Boolean(document.fullscreenElement);
                        fullscreenBtn.textContent = active
                            ? t('task.exitFullscreen')
                            : t('task.fullscreen');
                        document.body.classList.toggle('video-theater-open', theater);
                    };
                    const setTheater = (active) => {
                        theater = active;
                        videoSection.classList.toggle('video-theater', active);
                        if (active) stepikVideo.focus();
                        updateFullscreenButton();
                        vscode.postMessage({ command: 'videoTheater', active });
                    };

                    fullscreenBtn.addEventListener('click', async () => {
                        if (document.fullscreenElement) {
                            try {
                                await document.exitFullscreen();
                            } catch (error) {}
                            updateFullscreenButton();
                            return;
                        }
                        if (theater) {
                            setTheater(false);
                            return;
                        }
                        if (videoSection.requestFullscreen) {
                            try {
                                await videoSection.requestFullscreen();
                                if (document.fullscreenElement) {
                                    updateFullscreenButton();
                                    return;
                                }
                            } catch (error) {
                                // VS Code webviews may deny the Fullscreen API.
                            }
                        }
                        setTheater(true);
                    });

                    document.addEventListener('fullscreenchange', updateFullscreenButton);
                    document.addEventListener('keydown', (event) => {
                        if (event.key === 'Escape' && theater) {
                            setTheater(false);
                        }
                    });
                }

                if (stepikVideo && videoQualitySelect) {
                    videoQualitySelect.addEventListener('change', () => {
                        const source = Array.from(stepikVideo.querySelectorAll('source'))
                            .find((item) => item.dataset.quality === videoQualitySelect.value);
                        if (!source) return;

                        const time = stepikVideo.currentTime;
                        const wasPlaying = !stepikVideo.paused;
                        pauseAudio();
                        stepikVideo.src = source.src;
                        stepikVideo.load();

                        const restore = () => {
                            stepikVideo.removeEventListener('loadedmetadata', restore);
                            if (time > 0) {
                                try { stepikVideo.currentTime = time; } catch (error) {}
                            }
                            syncAudio(true);
                            if (wasPlaying) {
                                const started = stepikVideo.play();
                                if (started && started.catch) started.catch(() => {});
                            }
                        };
                        stepikVideo.addEventListener('loadedmetadata', restore);
                    });
                }
            `);
        } else if (stepType === 'choice') {
            parts.push(String.raw`
                bindQuizSubmit(() => {
                    const inputs = Array.from(document.querySelectorAll('input[name="choice"]'));
                    const choices = new Array(inputs.length).fill(false);
                    inputs.forEach((input) => {
                        choices[Number(input.dataset.index)] = input.checked;
                    });
                    return { choices: choices };
                });
            `);
        } else if (stepType === 'string') {
            parts.push(String.raw`
                const stringInput = document.getElementById('string-input');
                bindQuizSubmit(() => ({
                    text: stringInput ? stringInput.value : '',
                    files: []
                }));
                if (stringInput) {
                    stringInput.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter' && quizSubmitBtn) quizSubmitBtn.click();
                    });
                }
            `);
        } else if (stepType === 'number') {
            parts.push(String.raw`
                const numberInput = document.getElementById('number-input');
                bindQuizSubmit(() => ({
                    number: numberInput ? numberInput.value : ''
                }));
                if (numberInput) {
                    numberInput.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter' && quizSubmitBtn) quizSubmitBtn.click();
                    });
                }
            `);
        } else if (stepType === 'math') {
            parts.push(String.raw`
                const mathInput = document.getElementById('math-input');
                bindQuizSubmit(() => ({
                    formula: mathInput ? mathInput.value : ''
                }));
            `);
        } else if (stepType === 'free-answer') {
            parts.push(String.raw`
                const freeAnswerInput = document.getElementById('free-answer-input');
                bindQuizSubmit(() => ({
                    text: freeAnswerInput ? freeAnswerInput.value : '',
                    attachments: []
                }));
            `);
        } else if (stepType === 'sorting') {
            parts.push(String.raw`
                const sortingList = document.getElementById('sorting-list');

                function sortingItemFrom(target) {
                    if (!target || typeof target.closest !== 'function') return null;
                    return target.closest('.sorting-item');
                }

                if (sortingList) {
                    sortingList.addEventListener('click', (event) => {
                        const button = event.target && event.target.closest
                            ? event.target.closest('[data-move]')
                            : null;
                        if (!button) return;
                        const item = sortingItemFrom(button);
                        if (!item) return;
                        if (button.dataset.move === 'up' && item.previousElementSibling) {
                            sortingList.insertBefore(item, item.previousElementSibling);
                        } else if (button.dataset.move === 'down' && item.nextElementSibling) {
                            sortingList.insertBefore(item.nextElementSibling, item);
                        }
                    });

                    let draggedItem = null;
                    sortingList.addEventListener('dragstart', (event) => {
                        draggedItem = sortingItemFrom(event.target);
                        if (!draggedItem) return;
                        draggedItem.classList.add('dragging');
                        if (event.dataTransfer) {
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', draggedItem.dataset.index || '');
                        }
                    });
                    sortingList.addEventListener('dragover', (event) => {
                        if (!draggedItem) return;
                        event.preventDefault();
                        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                    });
                    sortingList.addEventListener('drop', (event) => {
                        const target = sortingItemFrom(event.target);
                        if (!draggedItem || !target || target === draggedItem) return;
                        event.preventDefault();
                        const rect = target.getBoundingClientRect();
                        const insertBeforeTarget = event.clientY < rect.top + rect.height / 2;
                        sortingList.insertBefore(
                            draggedItem,
                            insertBeforeTarget ? target : target.nextElementSibling
                        );
                    });
                    sortingList.addEventListener('dragend', () => {
                        if (draggedItem) draggedItem.classList.remove('dragging');
                        draggedItem = null;
                    });
                }

                bindQuizSubmit(() => {
                    const items = Array.from(document.querySelectorAll('#sorting-list .sorting-item'));
                    return {
                        ordering: items.map((item) => Number(item.dataset.index))
                    };
                });
            `);
        } else if (stepType === 'matching') {
            parts.push(String.raw`
                const matchingSelects = Array.from(document.querySelectorAll('.matching-select'))
                    .sort((left, right) =>
                        Number(left.dataset.leftIndex) - Number(right.dataset.leftIndex));

                matchingSelects.forEach((select) => {
                    select.dataset.previous = select.value;
                    select.addEventListener('change', () => {
                        const previous = select.dataset.previous || '';
                        matchingSelects.forEach((other) => {
                            if (other !== select && other.value === select.value) {
                                other.value = previous || other.options[0].value;
                            }
                        });
                        select.dataset.previous = select.value;
                    });
                });

                bindQuizSubmit(() => ({
                    ordering: matchingSelects.map((select) => Number(select.value))
                }));
            `);
        } else if (stepType === 'table') {
            parts.push(String.raw`
                const tableRows = ${embed(dataset.rows || [])};
                const tableColumns = ${embed(dataset.columns || [])};

                bindQuizSubmit(() => ({
                    choices: tableRows.map((row, rowIndex) => ({
                        name_row: row,
                        columns: tableColumns.map((column, columnIndex) => {
                            const input = document.querySelector(
                                'input[data-row-index="' + rowIndex + '"]' +
                                '[data-column-index="' + columnIndex + '"]'
                            );
                            return {
                                name: column,
                                answer: input ? input.checked : false
                            };
                        })
                    }))
                }));
            `);
        } else if (stepType === 'fill-blanks') {
            parts.push(String.raw`
                bindQuizSubmit(() => {
                    const blanks = Array.from(
                        document.querySelectorAll('.blank-input, .blank-select')
                    ).sort((left, right) =>
                        Number(left.dataset.blankIndex) - Number(right.dataset.blankIndex));
                    return {
                        blanks: blanks.map((blank) => blank.value)
                    };
                });
            `);
        } else if (stepType === 'sql') {
            parts.push(String.raw`
                const sqlInput = document.getElementById('sql-input');
                bindQuizSubmit(() => ({
                    solve_sql: sqlInput ? sqlInput.value : ''
                }));
            `);
        } else if (stepType === 'dataset') {
            parts.push(String.raw`
                const datasetInput = document.getElementById('dataset-input');
                bindQuizSubmit(() => ({
                    file: datasetInput ? datasetInput.value : ''
                }));
            `);
        } else if (stepType === 'chemical') {
            parts.push(String.raw`
                bindQuizSubmit(() => ({
                    slots: Array.from(document.querySelectorAll('.chemical-slot')).map((slot) => {
                        const part = (name) => {
                            const input = slot.querySelector(
                                'input[data-slot-part="' + name + '"]'
                            );
                            return input ? input.value : '';
                        };
                        return {
                            normal: part('normal'),
                            sub: part('sub'),
                            sup: part('sup')
                        };
                    })
                }));
            `);
        } else if (stepType === 'puzzle') {
            parts.push(String.raw`
                const puzzleSolved = document.getElementById('puzzle-solved');
                bindQuizSubmit(() => ({
                    solved: Boolean(puzzleSolved && puzzleSolved.checked)
                }));
            `);
        } else if (stepType === 'html') {
            parts.push(String.raw`
                const htmlChecklist = ${embed(checklist)};

                function parseRegexExpression(expression) {
                    if (typeof expression !== 'string') return null;
                    const match = expression.match(/^\/([\s\S]*)\/([a-z]*)$/);
                    if (!match) return null;
                    try {
                        return new RegExp(match[1], match[2]);
                    } catch (error) {
                        return null;
                    }
                }

                function matchesExpression(expression, value) {
                    const regex = parseRegexExpression(expression);
                    if (regex) {
                        regex.lastIndex = 0;
                        return regex.test(value);
                    }
                    return value === expression;
                }

                function createHtmlSandbox(html, css) {
                    const host = document.createElement('div');
                    host.setAttribute('aria-hidden', 'true');
                    host.style.cssText =
                        'position:fixed;left:-10000px;top:0;width:1024px;height:768px;' +
                        'overflow:hidden;opacity:0;pointer-events:none;';
                    document.body.appendChild(host);
                    const root = host.attachShadow({ mode: 'open' });
                    const style = document.createElement('style');
                    style.textContent = css || '';
                    root.appendChild(style);

                    const parsed = new DOMParser().parseFromString(html || '', 'text/html');
                    Array.from(parsed.head.childNodes).forEach((node) => {
                        root.appendChild(node.cloneNode(true));
                    });
                    Array.from(parsed.body.childNodes).forEach((node) => {
                        root.appendChild(node.cloneNode(true));
                    });
                    return { host: host, root: root };
                }

                function checkCssStyleValue(element, ruleName, expected) {
                    if (!element || !ruleName) return false;
                    const original = element.getAttribute('style');
                    const before = getComputedStyle(element)
                        .getPropertyValue(ruleName).trim();
                    element.style.setProperty(ruleName, expected, 'important');
                    const after = getComputedStyle(element)
                        .getPropertyValue(ruleName).trim();
                    if (original === null) {
                        element.removeAttribute('style');
                    } else {
                        element.setAttribute('style', original);
                    }
                    return Boolean(before) && before === after;
                }

                const VOID_HTML_TAGS = new Set([
                    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                    'link', 'meta', 'param', 'source', 'track', 'wbr'
                ]);
                const OPTIONAL_HTML_TAGS = new Set([
                    'colgroup', 'dd', 'dt', 'li', 'optgroup', 'option', 'p',
                    'tbody', 'td', 'tfoot', 'th', 'thead', 'tr'
                ]);

                function isValidHtmlSource(source) {
                    if (!source || !source.trim()) return false;
                    const tagPattern =
                        /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\?[\s\S]*?\?>|<\/?([a-zA-Z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*>/g;
                    const stack = [];
                    let match;
                    while ((match = tagPattern.exec(source)) !== null) {
                        const raw = match[0];
                        if (raw.indexOf('<!') === 0 || raw.indexOf('<?') === 0) continue;
                        const name = (match[1] || '').toLowerCase();
                        if (!name) continue;
                        if (raw.indexOf('</') === 0) {
                            const index = stack.lastIndexOf(name);
                            if (index === -1) return false;
                            stack.splice(index, 1);
                        } else if (!VOID_HTML_TAGS.has(name) && !/\/\s*>$/.test(raw)) {
                            stack.push(name);
                        }
                    }
                    return stack.every((name) => OPTIONAL_HTML_TAGS.has(name));
                }

                function isValidCssSource(source) {
                    if (!source || !source.trim()) return true;
                    let depth = 0;
                    let parens = 0;
                    let quote = '';
                    let comment = false;
                    for (let index = 0; index < source.length; index += 1) {
                        const character = source[index];
                        const next = source[index + 1];
                        if (comment) {
                            if (character === '*' && next === '/') {
                                comment = false;
                                index += 1;
                            }
                            continue;
                        }
                        if (quote) {
                            if (character === '\\') {
                                index += 1;
                            } else if (character === quote) {
                                quote = '';
                            }
                            continue;
                        }
                        if (character === '/' && next === '*') {
                            comment = true;
                            index += 1;
                        } else if (character === '"' || character === "'") {
                            quote = character;
                        } else if (character === '{') {
                            depth += 1;
                        } else if (character === '}') {
                            depth -= 1;
                            if (depth < 0) return false;
                        } else if (character === '(') {
                            parens += 1;
                        } else if (character === ')') {
                            parens -= 1;
                            if (parens < 0) return false;
                        }
                    }
                    return depth === 0 && parens === 0 && !quote && !comment;
                }

                function runHtmlTest(test, selector, root, html, css) {
                    const type = test.type;
                    const data = test.data || {};

                    if (type === 'checkSource') {
                        const source = data.sourceType === 'css' ? css : html;
                        return matchesExpression(String(data.sourceExpression || ''), source);
                    }

                    if (type === 'checkValidityOfSources') {
                        const sourceType = String(data.sourceType || 'html + css');
                        const needsHtml = sourceType === 'html' || sourceType === 'html + css';
                        const needsCss = sourceType === 'css' || sourceType === 'html + css';
                        if (needsHtml && !isValidHtmlSource(html)) return false;
                        if (needsCss && !isValidCssSource(css)) return false;
                        return true;
                    }

                    const element = selector ? root.querySelector(selector) : null;

                    if (type === 'hasElement') {
                        if (!element) return false;
                        const childSelector = String(data.childSel || '');
                        return !childSelector || Boolean(element.querySelector(childSelector));
                    }

                    if (!element) return false;

                    if (type === 'checkClass') {
                        return element.classList.contains(String(data.className || ''));
                    }
                    if (type === 'checkAttribute') {
                        return element.getAttribute(String(data.attr || '')) === data.attrValue;
                    }
                    if (type === 'checkContent') {
                        return matchesExpression(String(data.contentExpression || ''), element.innerHTML);
                    }
                    if (type === 'checkCssStyle') {
                        return checkCssStyleValue(
                            element,
                            String(data.ruleName || ''),
                            String(data.value || '')
                        );
                    }
                    return false;
                }

                function runHtmlChecklist(html, css) {
                    const sandbox = createHtmlSandbox(html, css);
                    const results = htmlChecklist.map((item) => {
                        const tests = item.tests || [];
                        let passed = true;
                        for (const test of tests) {
                            let testPassed = false;
                            try {
                                testPassed = runHtmlTest(
                                    test,
                                    item.selector || '',
                                    sandbox.root,
                                    html,
                                    css
                                );
                            } catch (error) {
                                testPassed = false;
                            }
                            if (!testPassed) {
                                passed = false;
                                break;
                            }
                        }
                        return {
                            name: item.name || item.selector || t('task.checklistItem'),
                            passed: passed
                        };
                    });
                    sandbox.host.remove();
                    return results;
                }

                bindQuizSubmit(() => {
                    const htmlInput = document.getElementById('html-input');
                    const cssInput = document.getElementById('css-input');
                    const html = htmlInput ? htmlInput.value : '';
                    const css = cssInput ? cssInput.value : '';
                    const results = runHtmlChecklist(html, css);
                    const failed = results.filter((result) => !result.passed);

                    if (failed.length > 0) {
                        setQuizStatus(
                            'error',
                            t('task.checklistFailed') +
                            failed.map((result) => result.name).join('\n• ')
                        );
                        return null;
                    }

                    return {
                        html: html,
                        css: css,
                        score: 1
                    };
                });
            `);
        }

        return parts.join('\n');
    }

    private getCommentsScript(): string {
        const solutionsAvailable = Boolean(
            this.currentStep &&
                this.isQuizStep(this.currentStep.step) &&
                this.solutionsAvailable &&
                this.solutionsThread
        );
        return `
            (function () {
                const commentsList = document.getElementById('comments-list');
                const loadMoreBtn = document.getElementById('load-more-comments');
                const reloadBtn = document.getElementById('reload-comments');
                const statusEl = document.getElementById('comments-status');
                const countEl = document.getElementById('comments-count');
                const sortSelect = document.getElementById('comment-sort');
                const commentEditorHost = document.getElementById('new-comment-editor');
                const postCommentBtn = document.getElementById('post-comment-btn');
                const composerStatus = document.getElementById('composer-status');
                const solutionEditorHost = document.getElementById('new-solution-editor');
                const postSolutionBtn = document.getElementById('post-solution-btn');
                const solutionComposerStatus = document.getElementById('solution-composer-status');
                const solutionSubmissionSelect = document.getElementById('solution-submission');
                const solutionSubmissionHint = document.getElementById('solution-submission-hint');
                const commentsPanel = document.getElementById('comments-panel');
                const solutionsPanel = document.getElementById('solutions-panel');
                const commentsTab = document.getElementById('tab-comments');
                const solutionsTab = document.getElementById('tab-solutions');
                const solutionsContent = document.getElementById('solutions-content');
                const solutionsStatus = document.getElementById('solutions-status');
                const solutionsCountEl = document.getElementById('solutions-count');
                const solutionsLockIcon = document.getElementById('solutions-lock-icon');
                const solutionsLocked = document.getElementById('solutions-locked');
                const solutionsLockedText = document.getElementById('solutions-locked-text');
                const solutionsUnlocked = document.getElementById('solutions-unlocked');
                const recheckSolutionsBtn = document.getElementById('recheck-solutions');
                const loadMoreSolutionsBtn = document.getElementById('load-more-solutions');
                const retrySolutionsBtn = document.getElementById('retry-solutions');
                const richEditorApi = window.StepikRichEditor;
                const commentEditor = richEditorApi && commentEditorHost
                    ? richEditorApi.create(commentEditorHost, {
                        placeholder: t('task.commentPlaceholder'),
                        onChange: function () { updatePostButton(); }
                    })
                    : null;
                const solutionEditor = richEditorApi && solutionEditorHost
                    ? richEditorApi.create(solutionEditorHost, {
                        placeholder: t('task.solutionPlaceholder'),
                        compact: true,
                        disabled: true,
                        onChange: function () { updateSolutionPostButton(); }
                    })
                    : null;

                let currentView = 'comments';
                let commentSort = '${this.commentSort}';
                let solutionsSort = '${this.solutionsSort}';
                let hasMoreComments = Boolean(loadMoreBtn) && loadMoreBtn.style.display !== 'none';
                let commentsLoading = false;
                let autoLoadPausedUntil = 0;
                let solutionsAvailable = ${solutionsAvailable};
                let solutionsLoaded = false;
                let solutionsLoading = false;
                let solutionsHasMore = false;
                let solutionComposerEnabled = false;
                const editSnapshots = new Map();

                function setStatus(text) {
                    if (statusEl) {
                        statusEl.textContent = text || '';
                    }
                }

                function setComposerStatus(text) {
                    if (composerStatus) {
                        composerStatus.textContent = text || '';
                    }
                }

                function setSolutionComposerStatus(text) {
                    if (solutionComposerStatus) {
                        solutionComposerStatus.textContent = text || '';
                    }
                }

                function getSelectedSubmissionId() {
                    if (!solutionSubmissionSelect) {
                        return null;
                    }
                    const raw = solutionSubmissionSelect.value;
                    if (!raw) {
                        return null;
                    }
                    const id = Number(raw);
                    return Number.isFinite(id) && id > 0 ? id : null;
                }

                function hasSolutionSubmission() {
                    return getSelectedSubmissionId() !== null;
                }

                function updateSolutionPostButton() {
                    if (postSolutionBtn) {
                        postSolutionBtn.disabled =
                            !solutionComposerEnabled ||
                            !hasSolutionSubmission() ||
                            !solutionEditor ||
                            solutionEditor.isEmpty();
                    }
                }

                function applyMarkdownFormat(textarea, format) {
                    if (!textarea) {
                        return;
                    }

                    const backtick = String.fromCharCode(96);
                    const value = textarea.value;
                    const start =
                        typeof textarea.selectionStart === 'number'
                            ? textarea.selectionStart
                            : value.length;
                    const end =
                        typeof textarea.selectionEnd === 'number'
                            ? textarea.selectionEnd
                            : value.length;
                    const selected = value.slice(start, end);
                    const before = value.slice(0, start);
                    const after = value.slice(end);

                    function replaceWith(text, selectionStart, selectionEnd) {
                        textarea.value = before + text + after;
                        textarea.focus();
                        textarea.setSelectionRange(selectionStart, selectionEnd);
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }

                    function wrap(prefix, suffix, placeholder) {
                        const body = selected || placeholder;
                        const text = prefix + body + suffix;
                        const bodyStart = start + prefix.length;
                        replaceWith(text, bodyStart, bodyStart + body.length);
                    }

                    function prefixLines(prefix) {
                        if (selected) {
                            const text = selected
                                .split('\\n')
                                .map(function (line) {
                                    return prefix + line;
                                })
                                .join('\\n');
                            replaceWith(text, start, start + text.length);
                            return;
                        }

                        const lineStart = before.lastIndexOf('\\n') + 1;
                        textarea.value =
                            value.slice(0, lineStart) + prefix + value.slice(lineStart);
                        textarea.focus();
                        const cursor = start + prefix.length;
                        textarea.setSelectionRange(cursor, cursor);
                        textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    }

                    if (format === 'bold') {
                        wrap('**', '**', t('task.markdownBoldPlaceholder'));
                    } else if (format === 'italic') {
                        wrap('*', '*', t('task.markdownItalicPlaceholder'));
                    } else if (format === 'code') {
                        if (selected.indexOf('\\n') !== -1) {
                            const text =
                                backtick + backtick + backtick + '\\n' +
                                selected +
                                '\\n' + backtick + backtick + backtick;
                            replaceWith(text, start + 4, start + 4 + selected.length);
                        } else {
                            wrap(backtick, backtick, t('task.markdownCodePlaceholder'));
                        }
                    } else if (format === 'codeblock') {
                        const body = selected || t('task.markdownCodePlaceholder');
                        const text =
                            backtick + backtick + backtick + '\\n' +
                            body +
                            '\\n' + backtick + backtick + backtick;
                        const bodyStart = start + 4;
                        replaceWith(text, bodyStart, bodyStart + body.length);
                    } else if (format === 'link') {
                        if (selected) {
                            const text = '[' + selected + '](url)';
                            const urlStart = start + selected.length + 3;
                            replaceWith(text, urlStart, urlStart + 3);
                        } else {
                            const text = t('task.markdownLinkPlaceholder');
                            replaceWith(text, start + 1, start + 6);
                        }
                    } else if (format === 'quote') {
                        prefixLines('> ');
                    } else if (format === 'list') {
                        prefixLines('- ');
                    }
                }

                document.addEventListener('mousedown', function (event) {
                    if (
                        event.target instanceof Element &&
                        event.target.closest('.format-btn')
                    ) {
                        // Keep the caret/selection in the textarea when a
                        // toolbar button is pressed.
                        event.preventDefault();
                    }
                });

                document.addEventListener('click', function (event) {
                    if (!(event.target instanceof Element)) {
                        return;
                    }
                    const button = event.target.closest('.format-btn');
                    if (!button) {
                        return;
                    }
                    const composer = button.closest('.comment-composer, .reply-composer');
                    if (!composer) {
                        return;
                    }
                    const textarea = composer.querySelector('textarea');
                    if (!textarea) {
                        return;
                    }
                    event.preventDefault();
                    applyMarkdownFormat(textarea, button.getAttribute('data-format'));
                });

                document.addEventListener('keydown', function (event) {
                    if (!(event.target instanceof HTMLTextAreaElement)) {
                        return;
                    }
                    if (!event.target.closest('.comment-composer, .reply-composer')) {
                        return;
                    }
                    if (!(event.ctrlKey || event.metaKey) || event.altKey) {
                        return;
                    }
                    const formats = {
                        b: 'bold',
                        i: 'italic',
                        e: 'code',
                        k: 'link'
                    };
                    const key = (event.key || '').toLowerCase();
                    const code = (event.code || '').toLowerCase().replace('key', '');
                    const format = formats[key] || formats[code];
                    if (!format) {
                        return;
                    }
                    event.preventDefault();
                    applyMarkdownFormat(event.target, format);
                });

                function setSolutionComposerEnabled(enabled) {
                    solutionComposerEnabled = Boolean(enabled);
                    if (solutionSubmissionSelect) {
                        solutionSubmissionSelect.disabled =
                            !enabled || !hasSolutionSubmission();
                    }
                    const canWrite = Boolean(enabled && hasSolutionSubmission());
                    if (solutionEditor) {
                        solutionEditor.setDisabled(!canWrite);
                    }
                    updateSolutionPostButton();
                }

                function setSolutionsStatus(text, isError) {
                    if (solutionsStatus) {
                        solutionsStatus.textContent = text || '';
                        solutionsStatus.classList.toggle('error', Boolean(isError));
                    }
                }

                function setLoadMoreState(hasMore) {
                    hasMoreComments = Boolean(hasMore);
                    if (!loadMoreBtn) {
                        return;
                    }
                    loadMoreBtn.style.display = hasMore ? '' : 'none';
                    loadMoreBtn.disabled = false;
                    loadMoreBtn.textContent = t('task.showMoreComments');
                }

                function setSolutionsMoreState(hasMore) {
                    solutionsHasMore = Boolean(hasMore);
                    if (!loadMoreSolutionsBtn) {
                        return;
                    }
                    loadMoreSolutionsBtn.style.display = hasMore ? '' : 'none';
                    loadMoreSolutionsBtn.disabled = false;
                    loadMoreSolutionsBtn.textContent = t('task.showMoreSolutions');
                }

                function setView(view) {
                    if (view === 'solutions' && !solutionsPanel) {
                        return;
                    }

                    currentView = view;
                    const showComments = view === 'comments';
                    if (commentsPanel) {
                        commentsPanel.style.display = showComments ? '' : 'none';
                    }
                    if (solutionsPanel) {
                        solutionsPanel.style.display = showComments ? 'none' : '';
                    }
                    if (commentsTab) {
                        commentsTab.classList.toggle('active', showComments);
                        commentsTab.setAttribute('aria-selected', showComments ? 'true' : 'false');
                    }
                    if (solutionsTab) {
                        solutionsTab.classList.toggle('active', !showComments);
                        solutionsTab.setAttribute('aria-selected', showComments ? 'false' : 'true');
                    }
                    if (sortSelect) {
                        sortSelect.value = showComments ? commentSort : solutionsSort;
                    }
                    if (showComments) {
                        setSolutionComposerEnabled(false);
                    } else if (solutionsLoaded && solutionsAvailable) {
                        setSolutionComposerEnabled(true);
                    }

                    setTimeout(function () {
                        if (showComments) {
                            maybeAutoLoadComments();
                        } else {
                            maybeAutoLoadSolutions();
                        }
                    }, 0);
                }

                function ensureSolutionsLoaded() {
                    if (
                        !solutionsPanel ||
                        !solutionsAvailable ||
                        solutionsLoaded ||
                        solutionsLoading
                    ) {
                        return;
                    }

                    solutionsLoading = true;
                    if (retrySolutionsBtn) {
                        retrySolutionsBtn.style.display = 'none';
                    }
                    setSolutionsStatus(t('task.loadingSolutions'));
                    vscode.postMessage({ command: 'loadSolutions' });
                }

                function nearBottom() {
                    const doc = document.documentElement;
                    return window.innerHeight + window.scrollY >= doc.scrollHeight - 300;
                }

                function requestMoreComments() {
                    if (currentView !== 'comments' || !hasMoreComments || commentsLoading) {
                        return;
                    }

                    commentsLoading = true;
                    if (loadMoreBtn) {
                        loadMoreBtn.disabled = true;
                        loadMoreBtn.textContent = t('task.loading');
                        loadMoreBtn.style.display = '';
                    }
                    setStatus('');
                    vscode.postMessage({ command: 'loadMoreComments' });
                }

                function maybeAutoLoadComments() {
                    if (currentView !== 'comments' || !hasMoreComments || commentsLoading) {
                        return;
                    }
                    if (Date.now() < autoLoadPausedUntil) {
                        return;
                    }
                    if (nearBottom()) {
                        requestMoreComments();
                    }
                }

                function requestMoreSolutions() {
                    if (currentView !== 'solutions' || !solutionsHasMore || solutionsLoading) {
                        return;
                    }

                    solutionsLoading = true;
                    if (loadMoreSolutionsBtn) {
                        loadMoreSolutionsBtn.disabled = true;
                        loadMoreSolutionsBtn.textContent = t('task.loading');
                        loadMoreSolutionsBtn.style.display = '';
                    }
                    setSolutionsStatus('');
                    vscode.postMessage({ command: 'loadMoreSolutions' });
                }

                function maybeAutoLoadSolutions() {
                    if (currentView !== 'solutions' || !solutionsLoaded || !solutionsHasMore || solutionsLoading) {
                        return;
                    }
                    if (nearBottom()) {
                        requestMoreSolutions();
                    }
                }

                function maybeAutoLoad() {
                    maybeAutoLoadComments();
                    maybeAutoLoadSolutions();
                }

                function updatePostButton() {
                    if (postCommentBtn) {
                        postCommentBtn.disabled =
                            !commentEditor || commentEditor.isEmpty();
                    }
                }

                function submitComment() {
                    if (!commentEditor || !postCommentBtn || postCommentBtn.disabled) {
                        return;
                    }
                    const payload = commentEditor.getPayload();
                    if (!payload.text) {
                        return;
                    }
                    postCommentBtn.disabled = true;
                    setComposerStatus(t('task.sending'));
                    vscode.postMessage({
                        command: 'postComment',
                        text: payload.text,
                        format: payload.format
                    });
                }

                function submitSolutionComment() {
                    if (!solutionEditor || !postSolutionBtn || postSolutionBtn.disabled) {
                        return;
                    }
                    const payload = solutionEditor.getPayload();
                    if (!payload.text) {
                        return;
                    }
                    const submissionId = getSelectedSubmissionId();
                    if (!submissionId) {
                        setSolutionComposerStatus(
                            t('task.selectSolutionHint')
                        );
                        updateSolutionPostButton();
                        return;
                    }
                    postSolutionBtn.disabled = true;
                    setSolutionComposerStatus(t('task.sending'));
                    vscode.postMessage({
                        command: 'postComment',
                        text: payload.text,
                        format: payload.format,
                        thread: 'solutions',
                        submissionId: submissionId
                    });
                }

                function getReplyEditor(composer) {
                    if (!composer || !richEditorApi) {
                        return null;
                    }
                    const host = composer.querySelector('[data-stepik-rich-editor]');
                    return host ? richEditorApi.get(host.id) || null : null;
                }

                function updateReplyButton(composer) {
                    const editor = getReplyEditor(composer);
                    const button = composer.querySelector('.post-reply-btn');
                    if (button) {
                        button.disabled = !editor || editor.isEmpty();
                    }
                }

                function closeReplyComposer(composer) {
                    if (!composer) {
                        return;
                    }
                    const editor = getReplyEditor(composer);
                    if (editor) {
                        editor.clear();
                    }
                    const status = composer.querySelector('.composer-status');
                    if (status) {
                        status.textContent = '';
                    }
                    const button = composer.querySelector('.post-reply-btn');
                    if (button) {
                        button.disabled = true;
                    }
                    composer.hidden = true;
                    composer.setAttribute('data-open', '0');
                }

                function openReplyComposer(commentId, parentId) {
                    const composer = document.getElementById('reply-composer-' + commentId);
                    if (!composer) {
                        return;
                    }

                    if (composer.getAttribute('data-open') === '1') {
                        closeReplyComposer(composer);
                        return;
                    }

                    if (!composer.querySelector('[data-stepik-rich-editor]')) {
                        composer.innerHTML =
                            '<div class="comment-rich-host" id="reply-editor-' + commentId + '" data-stepik-rich-editor data-placeholder="' + t('task.replyPlaceholder') + '" data-compact></div>' +
                            '<div class="composer-hint">' + t('task.replyHint') + '</div>' +
                            '<div class="composer-actions">' +
                            '<button class="post-reply-btn" data-parent-id="' + parentId + '" disabled>' + t('task.sendReply') + '</button>' +
                            '<button class="cancel-reply-btn secondary" type="button">' + t('task.cancel') + '</button>' +
                            '<span class="composer-status"></span>' +
                            '</div>';

                        const host = composer.querySelector('[data-stepik-rich-editor]');
                        if (host && richEditorApi) {
                            richEditorApi.get(host.id) ||
                                richEditorApi.create(host, {
                                    placeholder: t('task.replyPlaceholder'),
                                    compact: true,
                                    onChange: function () {
                                        updateReplyButton(composer);
                                    }
                                });
                        }
                        composer.addEventListener('rich-editor-submit', function () {
                            submitReply(composer);
                        });
                    } else {
                        const button = composer.querySelector('.post-reply-btn');
                        if (button) {
                            button.setAttribute('data-parent-id', String(parentId));
                        }
                    }

                    composer.hidden = false;
                    composer.setAttribute('data-open', '1');
                    updateReplyButton(composer);
                    const editor = getReplyEditor(composer);
                    if (editor) {
                        editor.focus();
                    }
                }

                function submitReply(composer) {
                    const editor = getReplyEditor(composer);
                    const button = composer.querySelector('.post-reply-btn');
                    if (!editor || !button || button.disabled) {
                        return;
                    }
                    const payload = editor.getPayload();
                    if (!payload.text) {
                        return;
                    }
                    const parentId = Number(button.getAttribute('data-parent-id'));
                    if (!parentId) {
                        return;
                    }
                    button.disabled = true;
                    const status = composer.querySelector('.composer-status');
                    if (status) {
                        status.textContent = t('task.sending');
                    }
                    vscode.postMessage({
                        command: 'postComment',
                        text: payload.text,
                        format: payload.format,
                        parentId: parentId
                    });
                }

                function resetReplyComposer(parentId, message) {
                    const composers = document.querySelectorAll('.reply-composer[data-open="1"]');
                    for (const composer of composers) {
                        const button = composer.querySelector('.post-reply-btn');
                        if (!button || Number(button.getAttribute('data-parent-id')) !== parentId) {
                            continue;
                        }
                        button.disabled = false;
                        const status = composer.querySelector('.composer-status');
                        if (status) {
                            status.textContent = message || '';
                        }
                    }
                }

                function getCommentElement(commentId) {
                    return document.querySelector(
                        '.comment[data-comment-id="' + commentId + '"]'
                    );
                }

                function setCommentActionStatus(comment, text) {
                    if (!comment) {
                        return;
                    }
                    const status = comment.querySelector(
                        '.comment-actions .comment-action-status'
                    );
                    if (status) {
                        status.textContent = text || '';
                    }
                }

                function updateEditSaveButton(hostId) {
                    const editor = richEditorApi ? richEditorApi.get(hostId) : null;
                    const host = document.getElementById(hostId);
                    const save = host
                        ? host.parentElement.querySelector('.save-comment-edit')
                        : null;
                    if (save) {
                        save.disabled = !editor || editor.isEmpty();
                    }
                }

                function startCommentEdit(button) {
                    if (!richEditorApi) {
                        return;
                    }
                    const commentId = Number(button.getAttribute('data-comment-id'));
                    const comment = getCommentElement(commentId);
                    const textEl = comment && comment.querySelector('.comment-text');
                    if (!comment || !textEl) {
                        return;
                    }
                    if (textEl.querySelector('[data-stepik-rich-editor]')) {
                        return;
                    }

                    button.disabled = true;
                    setCommentActionStatus(comment, t('task.loading'));
                    richEditorApi
                        .request('loadCommentEditor', { commentId: commentId })
                        .then(function (data) {
                            editSnapshots.set(commentId, textEl.innerHTML);
                            textEl.innerHTML =
                                '<div class="comment-edit-host" id="comment-edit-host-' +
                                commentId +
                                '" data-stepik-rich-editor data-compact data-placeholder="' + t('task.commentTextPlaceholder') + '"></div>' +
                                '<div class="comment-edit-actions">' +
                                '<button type="button" class="save-comment-edit" data-comment-id="' +
                                commentId +
                                '">' + t('task.save') + '</button>' +
                                '<button type="button" class="cancel-comment-edit secondary" data-comment-id="' +
                                commentId +
                                '">' + t('task.cancel') + '</button>' +
                                '<span class="comment-edit-status"></span>' +
                                '</div>';
                            const host = document.getElementById(
                                'comment-edit-host-' + commentId
                            );
                            const editor = richEditorApi.create(host, {
                                compact: true,
                                placeholder: t('task.commentTextPlaceholder'),
                                onChange: function () {
                                    updateEditSaveButton(host.id);
                                }
                            });
                            editor.setHtml(data.html || '');
                            updateEditSaveButton(host.id);
                            editor.focus();
                            setCommentActionStatus(comment, '');
                            button.disabled = false;
                        })
                        .catch(function (error) {
                            button.disabled = false;
                            setCommentActionStatus(
                                comment,
                                error.message || t('task.commentEditorLoadError')
                            );
                        });
                }

                function cancelCommentEdit(commentId) {
                    const comment = getCommentElement(commentId);
                    const textEl = comment && comment.querySelector('.comment-text');
                    if (!textEl) {
                        return;
                    }
                    const snapshot = editSnapshots.get(commentId);
                    if (typeof snapshot === 'string') {
                        textEl.innerHTML = snapshot;
                    }
                    editSnapshots.delete(commentId);
                    setCommentActionStatus(comment, '');
                }

                function markTeacherReplied(commentId) {
                    const comment = document.querySelector(
                        '.comment[data-comment-id="' + commentId + '"]'
                    );
                    if (!comment) {
                        return;
                    }
                    comment.classList.add('teacher-replied');

                    const head = comment.querySelector('.comment-head');
                    if (!head || head.querySelector('.comment-flag.teacher-reply')) {
                        return;
                    }

                    const badge = document.createElement('span');
                    badge.className = 'comment-flag teacher-reply';
                    badge.textContent = t('task.teacherReplied');
                    const date = head.querySelector('.comment-date');
                    head.insertBefore(badge, date || null);
                }

                function applyVoteToWrapper(wrapper, vote, epicCount, abuseCount) {
                    const current = vote || '';
                    const epic = Math.max(0, Number(epicCount) || 0);
                    const abuse = Math.max(0, Number(abuseCount) || 0);
                    wrapper.setAttribute('data-current-vote', current);
                    wrapper.setAttribute('data-epic-count', String(epic));
                    wrapper.setAttribute('data-abuse-count', String(abuse));

                    const up = wrapper.querySelector('.vote-up');
                    const down = wrapper.querySelector('.vote-down');
                    const upCount = wrapper.querySelector('.vote-up-count');
                    const downCount = wrapper.querySelector('.vote-down-count');
                    if (up) {
                        up.classList.toggle('active', current === 'epic');
                        if (current === 'epic') {
                            up.setAttribute('data-is-active', '');
                        } else {
                            up.removeAttribute('data-is-active');
                        }
                        up.setAttribute('aria-pressed', current === 'epic' ? 'true' : 'false');
                    }
                    if (down) {
                        down.classList.toggle('active', current === 'abuse');
                        if (current === 'abuse') {
                            down.setAttribute('data-is-active', '');
                        } else {
                            down.removeAttribute('data-is-active');
                        }
                        down.setAttribute('aria-pressed', current === 'abuse' ? 'true' : 'false');
                    }
                    if (upCount) {
                        upCount.textContent = String(epic);
                    }
                    if (downCount) {
                        downCount.textContent = String(abuse);
                    }
                }

                function setVoteControls(commentId, vote, epicCount, abuseCount, errorMessage) {
                    const wrappers = document.querySelectorAll(
                        '.comment-vote[data-comment-id="' + commentId + '"]'
                    );
                    for (const wrapper of wrappers) {
                        wrapper.removeAttribute('data-pending');
                        applyVoteToWrapper(wrapper, vote, epicCount, abuseCount);
                        const up = wrapper.querySelector('.vote-up');
                        const down = wrapper.querySelector('.vote-down');
                        if (up) {
                            up.disabled = false;
                        }
                        if (down) {
                            down.disabled = false;
                        }
                        const status = wrapper.querySelector('.vote-status');
                        if (status) {
                            status.textContent = errorMessage || '';
                        }
                    }
                }

                function getRepliesButton(commentId) {
                    return document.querySelector(
                        '.replies-btn[data-comment-id="' + commentId + '"]'
                    );
                }

                function updateRepliesFooter(container, commentId, hasMore) {
                    if (!container) {
                        return;
                    }

                    const existing = container.querySelector('.replies-footer');
                    if (!hasMore) {
                        if (existing) {
                            existing.remove();
                        }
                        return;
                    }

                    if (existing) {
                        const button = existing.querySelector('.replies-more-btn');
                        if (button) {
                            button.disabled = false;
                            button.textContent = t('task.showMoreReplies');
                        }
                        const status = existing.querySelector('.replies-status');
                        if (status) {
                            status.textContent = '';
                        }
                        return;
                    }

                    container.insertAdjacentHTML(
                        'beforeend',
                        '<div class="replies-footer">' +
                            '<button type="button" class="replies-more-btn" data-comment-id="' +
                            commentId +
                            '">' + t('task.showMoreReplies') + '</button>' +
                            '<span class="replies-status"></span>' +
                        '</div>'
                    );
                }

                function appendRepliesHtml(container, html) {
                    if (!container || !html) {
                        return;
                    }
                    const footer = container.querySelector('.replies-footer');
                    if (footer) {
                        footer.insertAdjacentHTML('beforebegin', html);
                    } else {
                        container.insertAdjacentHTML('beforeend', html);
                    }
                }

                function toggleReplies(button, commentId) {
                    const container = document.getElementById('replies-' + commentId);
                    if (!container) {
                        return;
                    }

                    if (container.hasAttribute('hidden')) {
                        container.removeAttribute('hidden');
                        button.textContent = t('task.hideReplies');
                    } else {
                        container.setAttribute('hidden', '');
                        const total = button.getAttribute('data-total');
                        button.textContent = total
                            ? t('task.showRepliesCount', { count: total })
                            : t('task.showReplies');
                    }
                }

                if (loadMoreBtn) {
                    loadMoreBtn.addEventListener('click', function () {
                        requestMoreComments();
                    });
                }

                if (reloadBtn) {
                    reloadBtn.addEventListener('click', function () {
                        reloadBtn.disabled = true;
                        reloadBtn.textContent = t('task.loading');
                        vscode.postMessage({ command: 'reloadComments' });
                    });
                }

                if (sortSelect) {
                    sortSelect.addEventListener('change', function () {
                        if (currentView === 'solutions') {
                            solutionsSort = sortSelect.value;
                            solutionsLoading = true;
                            solutionsLoaded = false;
                            setSolutionComposerEnabled(false);
                            setSolutionsMoreState(false);
                            setSolutionsStatus(t('task.sorting'));
                            vscode.postMessage({
                                command: 'changeSolutionsSort',
                                sort: solutionsSort
                            });
                            return;
                        }

                        commentSort = sortSelect.value;
                        commentsLoading = true;
                        autoLoadPausedUntil = 0;
                        setStatus(t('task.sorting'));
                        if (loadMoreBtn) {
                            loadMoreBtn.style.display = 'none';
                        }
                        vscode.postMessage({
                            command: 'changeSort',
                            sort: commentSort
                        });
                    });
                }

                if (commentEditorHost) {
                    commentEditorHost.addEventListener('rich-editor-submit', function () {
                        submitComment();
                    });
                }

                if (postCommentBtn) {
                    postCommentBtn.addEventListener('click', function () {
                        submitComment();
                    });
                }
                updatePostButton();

                if (solutionEditorHost) {
                    solutionEditorHost.addEventListener('rich-editor-submit', function () {
                        submitSolutionComment();
                    });
                }

                if (solutionSubmissionSelect) {
                    solutionSubmissionSelect.addEventListener('change', updateSolutionPostButton);
                }

                if (postSolutionBtn) {
                    postSolutionBtn.addEventListener('click', function () {
                        submitSolutionComment();
                    });
                }
                updateSolutionPostButton();

                if (commentsTab) {
                    commentsTab.addEventListener('click', function () {
                        setView('comments');
                    });
                }

                if (solutionsTab) {
                    solutionsTab.addEventListener('click', function () {
                        setView('solutions');
                        if (!solutionsAvailable) {
                            setSolutionsStatus(t('task.checkingSolutionsAccess'));
                            vscode.postMessage({ command: 'recheckSolutions' });
                            return;
                        }
                        ensureSolutionsLoaded();
                    });
                }

                if (recheckSolutionsBtn) {
                    recheckSolutionsBtn.addEventListener('click', function () {
                        recheckSolutionsBtn.disabled = true;
                        recheckSolutionsBtn.textContent = t('task.rechecking');
                        setSolutionsStatus(t('task.checkingSolutionsAccess'));
                        vscode.postMessage({ command: 'recheckSolutions' });
                    });
                }

                if (retrySolutionsBtn) {
                    retrySolutionsBtn.addEventListener('click', function () {
                        retrySolutionsBtn.style.display = 'none';
                        ensureSolutionsLoaded();
                    });
                }

                if (loadMoreSolutionsBtn) {
                    loadMoreSolutionsBtn.addEventListener('click', function () {
                        requestMoreSolutions();
                    });
                }

                document.addEventListener('click', function (event) {
                    const target = event.target;
                    if (!target || !target.closest) {
                        return;
                    }

                    const externalLink = target.closest('a[href]');
                    if (
                        externalLink &&
                        !externalLink.closest('[contenteditable="true"]') &&
                        !externalLink.closest('.rich-dialog') &&
                        !externalLink.hasAttribute('data-external')
                    ) {
                        event.preventDefault();
                        vscode.postMessage({
                            command: 'openExternalUrl',
                            url: externalLink.href
                        });
                        return;
                    }

                    const editBtn = target.closest('.edit-comment-btn');
                    if (editBtn) {
                        event.preventDefault();
                        startCommentEdit(editBtn);
                        return;
                    }

                    const saveEditBtn = target.closest('.save-comment-edit');
                    if (saveEditBtn) {
                        event.preventDefault();
                        const commentId = Number(
                            saveEditBtn.getAttribute('data-comment-id')
                        );
                        const editor = richEditorApi
                            ? richEditorApi.get('comment-edit-host-' + commentId)
                            : null;
                        if (!editor || editor.isEmpty()) {
                            return;
                        }
                        const payload = editor.getPayload();
                        saveEditBtn.disabled = true;
                        const comment = getCommentElement(commentId);
                        const status = comment && comment.querySelector('.comment-edit-status');
                        if (status) {
                            status.textContent = t('task.saving');
                        }
                        vscode.postMessage({
                            command: 'updateComment',
                            commentId: commentId,
                            text: payload.text,
                            format: payload.format
                        });
                        return;
                    }

                    const cancelEditBtn = target.closest('.cancel-comment-edit');
                    if (cancelEditBtn) {
                        event.preventDefault();
                        cancelCommentEdit(
                            Number(cancelEditBtn.getAttribute('data-comment-id'))
                        );
                        return;
                    }

                    const deleteBtn = target.closest('.delete-comment-btn');
                    if (deleteBtn) {
                        event.preventDefault();
                        const commentId = Number(deleteBtn.getAttribute('data-comment-id'));
                        const comment = getCommentElement(commentId);
                        deleteBtn.disabled = true;
                        setCommentActionStatus(comment, t('task.confirmDelete'));
                        vscode.postMessage({ command: 'deleteComment', commentId: commentId });
                        return;
                    }

                    const copyLinkBtn = target.closest('.copy-comment-link-btn');
                    if (copyLinkBtn) {
                        event.preventDefault();
                        const commentId = Number(
                            copyLinkBtn.getAttribute('data-comment-id')
                        );
                        copyLinkBtn.disabled = true;
                        vscode.postMessage({
                            command: 'copyCommentLink',
                            commentId: commentId
                        });
                        return;
                    }

                    const voteBtn = target.closest('.vote-btn');
                    if (voteBtn) {
                        event.preventDefault();
                        const wrapper = voteBtn.closest('.comment-vote');
                        if (!wrapper || wrapper.getAttribute('data-pending') === '1') {
                            return;
                        }
                        const commentId = Number(voteBtn.getAttribute('data-comment-id'));
                        const desired = voteBtn.getAttribute('data-vote');
                        if (!commentId || (desired !== 'epic' && desired !== 'abuse')) {
                            return;
                        }

                        const current = wrapper.getAttribute('data-current-vote') || '';
                        const next = current === desired ? '' : desired;
                        let epic = Math.max(0, Number(wrapper.getAttribute('data-epic-count')) || 0);
                        let abuse = Math.max(0, Number(wrapper.getAttribute('data-abuse-count')) || 0);
                        if (current === 'epic') {
                            epic--;
                        } else if (current === 'abuse') {
                            abuse--;
                        }
                        if (next === 'epic') {
                            epic++;
                        } else if (next === 'abuse') {
                            abuse++;
                        }
                        epic = Math.max(0, epic);
                        abuse = Math.max(0, abuse);

                        wrapper.setAttribute('data-pending', '1');
                        applyVoteToWrapper(wrapper, next, epic, abuse);
                        const up = wrapper.querySelector('.vote-up');
                        const down = wrapper.querySelector('.vote-down');
                        if (up) {
                            up.disabled = true;
                        }
                        if (down) {
                            down.disabled = true;
                        }
                        const status = wrapper.querySelector('.vote-status');
                        if (status) {
                            status.textContent = '';
                        }

                        vscode.postMessage({
                            command: 'vote',
                            commentId: commentId,
                            vote: desired
                        });
                        return;
                    }

                    const repliesBtn = target.closest('.replies-btn');
                    if (repliesBtn) {
                        const commentId = Number(repliesBtn.getAttribute('data-comment-id'));
                        if (!commentId) {
                            return;
                        }

                        if (repliesBtn.getAttribute('data-loaded') === '1') {
                            toggleReplies(repliesBtn, commentId);
                            return;
                        }

                        if (repliesBtn.getAttribute('data-loading') === '1') {
                            return;
                        }

                        repliesBtn.setAttribute('data-loading', '1');
                        repliesBtn.disabled = true;
                        repliesBtn.textContent = t('task.loadingReplies');
                        const container = document.getElementById('replies-' + commentId);
                        if (container) {
                            container.removeAttribute('hidden');
                            if (
                                !container.querySelector('.replies-loading') &&
                                !container.querySelector('.comment')
                            ) {
                                container.insertAdjacentHTML(
                                    'beforeend',
                                    '<div class="replies-loading">' + t('task.loadingReplies') + '</div>'
                                );
                            }
                        }
                        vscode.postMessage({
                            command: 'loadReplies',
                            commentId: commentId
                        });
                        return;
                    }

                    const moreRepliesBtn = target.closest('.replies-more-btn');
                    if (moreRepliesBtn) {
                        const commentId = Number(moreRepliesBtn.getAttribute('data-comment-id'));
                        if (!commentId || moreRepliesBtn.disabled) {
                            return;
                        }
                        moreRepliesBtn.disabled = true;
                        moreRepliesBtn.textContent = t('task.loading');
                        const footer = moreRepliesBtn.closest('.replies-footer');
                        const status = footer && footer.querySelector('.replies-status');
                        if (status) {
                            status.textContent = t('task.loadingReplies');
                        }
                        vscode.postMessage({
                            command: 'loadReplies',
                            commentId: commentId,
                            more: true
                        });
                        return;
                    }

                    const replyBtn = target.closest('.reply-btn');
                    if (replyBtn) {
                        event.preventDefault();
                        const commentId = Number(replyBtn.getAttribute('data-comment-id'));
                        const parentId =
                            Number(replyBtn.getAttribute('data-parent-id')) || commentId;
                        if (commentId && parentId) {
                            openReplyComposer(commentId, parentId);
                        }
                        return;
                    }

                    const postReplyBtn = target.closest('.post-reply-btn');
                    if (postReplyBtn) {
                        event.preventDefault();
                        const composer = postReplyBtn.closest('.reply-composer');
                        if (composer) {
                            submitReply(composer);
                        }
                        return;
                    }

                    const cancelReplyBtn = target.closest('.cancel-reply-btn');
                    if (cancelReplyBtn) {
                        event.preventDefault();
                        closeReplyComposer(cancelReplyBtn.closest('.reply-composer'));
                        return;
                    }
                });

                document.addEventListener('error', function (event) {
                    const target = event.target;
                    if (target && target.classList && target.classList.contains('comment-avatar-img')) {
                        const wrapper = target.closest('.comment-avatar');
                        if (wrapper) {
                            wrapper.classList.add('broken');
                        }
                    }
                }, true);

                window.addEventListener('scroll', maybeAutoLoad, { passive: true });
                window.addEventListener('resize', maybeAutoLoad);
                setTimeout(maybeAutoLoad, 0);

                window.addEventListener('message', function (event) {
                    const message = event.data;
                    if (!message || !message.command) {
                        return;
                    }

                    if (message.command === 'appendComments') {
                        commentsLoading = false;
                        if (commentsList) {
                            const empty = commentsList.querySelector('.comments-empty');
                            if (empty) {
                                empty.remove();
                            }
                            if (message.prependHtml) {
                                const firstNormal = commentsList.querySelector('.comment:not(.pinned)');
                                if (firstNormal) {
                                    firstNormal.insertAdjacentHTML('beforebegin', message.prependHtml);
                                } else {
                                    commentsList.insertAdjacentHTML('beforeend', message.prependHtml);
                                }
                            }
                            if (message.html) {
                                commentsList.insertAdjacentHTML('beforeend', message.html);
                            }
                        }
                        setStatus('');
                        setLoadMoreState(Boolean(message.hasMore));
                        setTimeout(maybeAutoLoad, 0);
                    } else if (message.command === 'replaceComments') {
                        commentsLoading = false;
                        if (commentsList) {
                            commentsList.innerHTML = message.html || '';
                        }
                        if (countEl && typeof message.count !== 'undefined') {
                            countEl.textContent = String(message.count);
                        }
                        setStatus('');
                        setLoadMoreState(Boolean(message.hasMore));
                        setTimeout(maybeAutoLoad, 0);
                    } else if (message.command === 'appendReplies') {
                        const container = document.getElementById('replies-' + message.commentId);
                        if (container) {
                            if (message.replace) {
                                container.innerHTML = '';
                            }
                            const loading = container.querySelector('.replies-loading');
                            if (loading) {
                                loading.remove();
                            }
                            appendRepliesHtml(container, message.html || '');
                            container.removeAttribute('hidden');
                            updateRepliesFooter(
                                container,
                                message.commentId,
                                Boolean(message.hasMore)
                            );
                        }

                        const repliesBtn = getRepliesButton(message.commentId);
                        if (repliesBtn) {
                            repliesBtn.disabled = false;
                            repliesBtn.removeAttribute('data-loading');
                            repliesBtn.setAttribute('data-loaded', '1');
                            if (typeof message.total !== 'undefined') {
                                repliesBtn.setAttribute('data-total', String(message.total));
                            }
                            repliesBtn.textContent = t('task.hideReplies');
                        }

                        if (message.teacherReplied) {
                            markTeacherReplied(message.commentId);
                        }

                        setStatus('');
                        setTimeout(maybeAutoLoad, 0);
                    } else if (message.command === 'repliesError') {
                        const btn = getRepliesButton(message.commentId);
                        if (btn) {
                            btn.disabled = false;
                            btn.removeAttribute('data-loading');
                            if (btn.getAttribute('data-loaded') !== '1') {
                                btn.textContent = t('task.retryLoadReplies');
                            }
                        }
                        const container = document.getElementById('replies-' + message.commentId);
                        if (container) {
                            const loading = container.querySelector('.replies-loading');
                            if (loading) {
                                loading.remove();
                            }
                            if (message.more) {
                                const moreBtn = container.querySelector('.replies-more-btn');
                                if (moreBtn) {
                                    moreBtn.disabled = false;
                                    moreBtn.textContent = t('task.showMoreReplies');
                                }
                                const footer = container.querySelector('.replies-footer');
                                const status = footer && footer.querySelector('.replies-status');
                                if (status) {
                                    status.textContent =
                                        message.message || t('task.repliesLoadError', { detail: '' });
                                }
                            }
                        }
                        setStatus(message.message || t('task.repliesLoadError', { detail: '' }));
                    } else if (message.command === 'voteUpdated') {
                        setVoteControls(
                            Number(message.commentId),
                            message.vote,
                            message.epicCount,
                            message.abuseCount,
                            ''
                        );
                    } else if (message.command === 'voteError') {
                        setVoteControls(
                            Number(message.commentId),
                            message.vote,
                            message.epicCount,
                            message.abuseCount,
                            message.message || t('task.voteChangeError', { detail: '' })
                        );
                    } else if (message.command === 'commentUpdated') {
                        const commentId = Number(message.commentId);
                        const comment = getCommentElement(commentId);
                        const textEl = comment && comment.querySelector('.comment-text');
                        if (textEl) {
                            textEl.innerHTML = message.bodyHtml || '';
                        }
                        editSnapshots.delete(commentId);
                        setCommentActionStatus(comment, t('task.saved'));
                        setTimeout(function () {
                            setCommentActionStatus(comment, '');
                        }, 2500);
                    } else if (message.command === 'commentDeleted') {
                        const comment = getCommentElement(Number(message.commentId));
                        if (comment) {
                            comment.remove();
                        }
                        editSnapshots.delete(Number(message.commentId));
                        if (countEl && currentView === 'comments') {
                            const current = Number(countEl.textContent) || 0;
                            countEl.textContent = String(Math.max(0, current - 1));
                        }
                    } else if (message.command === 'commentLinkCopied') {
                        const buttons = document.querySelectorAll(
                            '.copy-comment-link-btn[data-comment-id="' +
                                Number(message.commentId) +
                                '"]'
                        );
                        for (const button of buttons) {
                            button.disabled = false;
                            button.textContent = t('task.copied');
                            setTimeout(function () {
                                button.textContent = t('task.link');
                            }, 2000);
                        }
                    } else if (message.command === 'commentActionCancelled') {
                        const comment = getCommentElement(Number(message.commentId));
                        const button = comment && comment.querySelector('.delete-comment-btn');
                        if (button) {
                            button.disabled = false;
                        }
                        setCommentActionStatus(comment, '');
                    } else if (message.command === 'commentActionError') {
                        const comment = getCommentElement(Number(message.commentId));
                        if (comment) {
                            const edit = comment.querySelector('.edit-comment-btn');
                            const remove = comment.querySelector('.delete-comment-btn');
                            const copy = comment.querySelector('.copy-comment-link-btn');
                            if (edit) {
                                edit.disabled = false;
                            }
                            if (remove) {
                                remove.disabled = false;
                            }
                            if (copy) {
                                copy.disabled = false;
                            }
                            const editStatus = comment.querySelector('.comment-edit-status');
                            if (editStatus) {
                                editStatus.textContent = message.message || '';
                            }
                        }
                        setCommentActionStatus(comment, message.message || t('task.error'));
                    } else if (message.command === 'commentsError') {
                        commentsLoading = false;
                        autoLoadPausedUntil = Date.now() + 15000;
                        setStatus(message.message || t('task.commentsLoadError', { detail: '' }));
                        if (loadMoreBtn) {
                            loadMoreBtn.disabled = false;
                            loadMoreBtn.textContent = t('task.retry');
                            loadMoreBtn.style.display = '';
                        }
                    } else if (message.command === 'commentPosted') {
                        if (message.thread === 'solutions') {
                            if (solutionEditor) {
                                solutionEditor.clear();
                            }
                            updateSolutionPostButton();
                            setSolutionComposerStatus(t('task.solutionSent'));
                            setTimeout(function () {
                                if (
                                    solutionComposerStatus &&
                                    solutionComposerStatus.textContent === t('task.solutionSent')
                                ) {
                                    setSolutionComposerStatus('');
                                }
                            }, 2500);
                            return;
                        }

                        if (commentEditor) {
                            commentEditor.clear();
                        }
                        updatePostButton();
                        setComposerStatus(t('task.commentSent'));
                        setTimeout(function () {
                            if (composerStatus && composerStatus.textContent === t('task.commentSent')) {
                                setComposerStatus('');
                            }
                        }, 2500);
                    } else if (message.command === 'commentPostError') {
                        if (message.parentId) {
                            resetReplyComposer(
                                Number(message.parentId),
                                message.message || t('task.sendFailed')
                            );
                        } else if (message.thread === 'solutions') {
                            setSolutionComposerEnabled(true);
                            setSolutionComposerStatus(message.message || t('task.sendFailed'));
                        } else {
                            updatePostButton();
                            setComposerStatus(message.message || t('task.sendFailed'));
                        }
                    } else if (message.command === 'replyPosted') {
                        const composers = document.querySelectorAll('.reply-composer[data-open="1"]');
                        for (const composer of composers) {
                            const button = composer.querySelector('.post-reply-btn');
                            if (
                                button &&
                                Number(button.getAttribute('data-parent-id')) === Number(message.commentId)
                            ) {
                                closeReplyComposer(composer);
                            }
                        }
                    } else if (message.command === 'solutionSubmissionsLoaded') {
                        if (solutionSubmissionSelect) {
                            const previous = solutionSubmissionSelect.value;
                            solutionSubmissionSelect.innerHTML = message.optionsHtml || '';
                            if (
                                previous &&
                                Array.from(solutionSubmissionSelect.options).some(
                                    function (option) {
                                        return option.value === previous;
                                    }
                                )
                            ) {
                                solutionSubmissionSelect.value = previous;
                            }
                            solutionSubmissionSelect.disabled = !message.hasSubmissions;
                        }
                        if (solutionSubmissionHint) {
                            solutionSubmissionHint.textContent = message.hint || '';
                            solutionSubmissionHint.style.display = message.hint ? '' : 'none';
                        }
                        setSolutionComposerEnabled(solutionsLoaded && solutionsAvailable);
                    } else if (message.command === 'solutionsAvailability') {
                        solutionsAvailable = Boolean(message.available);
                        if (solutionsCountEl) {
                            solutionsCountEl.textContent = String(message.count || 0);
                            solutionsCountEl.style.display = solutionsAvailable ? '' : 'none';
                        }
                        if (solutionsLockIcon) {
                            solutionsLockIcon.style.display = solutionsAvailable ? 'none' : '';
                        }
                        if (solutionsLocked) {
                            solutionsLocked.style.display = solutionsAvailable ? 'none' : '';
                        }
                        if (solutionsUnlocked) {
                            solutionsUnlocked.style.display = solutionsAvailable ? '' : 'none';
                        }
                        if (solutionsLockedText) {
                            solutionsLockedText.textContent = message.message || '';
                        }
                        if (recheckSolutionsBtn) {
                            recheckSolutionsBtn.disabled = false;
                            recheckSolutionsBtn.textContent = t('task.recheckSolutions');
                        }
                        if (!solutionsAvailable) {
                            solutionsLoaded = false;
                            solutionsLoading = false;
                            setSolutionComposerEnabled(false);
                            setSolutionsMoreState(false);
                            if (currentView === 'solutions') {
                                setSolutionsStatus('');
                            }
                        } else if (currentView === 'solutions') {
                            ensureSolutionsLoaded();
                        }
                    } else if (message.command === 'solutionsLoaded') {
                        solutionsLoading = false;
                        solutionsLoaded = true;
                        setSolutionComposerEnabled(true);
                        if (retrySolutionsBtn) {
                            retrySolutionsBtn.style.display = 'none';
                        }
                        if (solutionsContent) {
                            if (message.html) {
                                solutionsContent.innerHTML = message.html;
                            } else {
                                solutionsContent.innerHTML =
                                    '<div class="comments-empty">' + t('task.solutionsEmpty') + '</div>';
                            }
                        }
                        setSolutionsStatus('');
                        setSolutionsMoreState(Boolean(message.hasMore));
                        setTimeout(maybeAutoLoadSolutions, 0);
                    } else if (message.command === 'appendSolutions') {
                        solutionsLoading = false;
                        if (solutionsContent && message.html) {
                            const empty = solutionsContent.querySelector('.comments-empty');
                            if (empty) {
                                empty.remove();
                            }
                            solutionsContent.insertAdjacentHTML('beforeend', message.html);
                        }
                        setSolutionsStatus('');
                        setSolutionsMoreState(Boolean(message.hasMore));
                        setTimeout(maybeAutoLoadSolutions, 0);
                    } else if (message.command === 'solutionsError') {
                        solutionsLoading = false;
                        solutionsLoaded = false;
                        setSolutionComposerEnabled(false);
                        if (retrySolutionsBtn) {
                            retrySolutionsBtn.style.display = '';
                        }
                        setSolutionsMoreState(false);
                        setSolutionsStatus(message.message || t('task.solutionsLoadError', { detail: '' }), true);
                    }
                });
            })();
        `;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
