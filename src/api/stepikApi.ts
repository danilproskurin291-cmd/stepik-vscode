import { StepikAuth } from '../auth';
import { t } from '../i18n';

const BASE_URL = 'https://stepik.org/api';
const REQUEST_TIMEOUT_MS = 30_000;
const IDS_PER_REQUEST = 100;

function chunkItems<T>(items: T[], size: number = IDS_PER_REQUEST): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size));
    }
    return result;
}

async function fetchWithTimeout(
    url: string,
    init: RequestInit = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(t('api.timeout', { seconds: Math.round(timeoutMs / 1000) }));
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/** Stepik uses several key shapes for a single exam session. */
interface ExamSessionPayload {
    'exam-sessions'?: ExamSession[] | ExamSession;
    exam_sessions?: ExamSession[] | ExamSession;
    'exam-session'?: ExamSession;
}

function extractExamSession(data: ExamSessionPayload): ExamSession | undefined {
    const plural = data['exam-sessions'] ?? data.exam_sessions;
    if (Array.isArray(plural)) {
        return plural[0];
    }
    if (plural && typeof plural === 'object') {
        return plural;
    }
    return data['exam-session'];
}

export interface Course {
    id: number;
    title: string;
    sections: number[];
    is_certificate_issued?: boolean;
    is_certificate_auto_issued?: boolean;
    certificate_regular_threshold?: number | null;
    certificate_distinction_threshold?: number | null;
    user_certificate?: number | null;
    time_to_complete?: number | null;
    progress: string;  // progress ID like "course-12345"
    begin_date?: string | null;
    end_date?: string | null;
    soft_deadline?: string | null;
    hard_deadline?: string | null;
    grading_policy?: string;
    is_active?: boolean;
    summary?: string;
    cover?: string | null;
    learners_count?: number;
    review_summary?: number | null;
    is_paid?: boolean;
    price?: string | null;
    display_price?: string | null;
    workload?: string | null;
    language?: string;
    is_public?: boolean;
    is_popular?: boolean;
    with_certificate?: boolean;
    create_date?: string;
    update_date?: string;
    canonical_url?: string;
}

/** Rating details from /course-review-summaries. */
export interface CourseReviewSummary {
    id: number;
    course: number;
    average: number;
    count: number;
    distribution?: number[];
}

export interface Progress {
    id: string;
    is_passed: boolean;
    n_steps: number;
    n_steps_passed: number;
    score: string;
    cost: number;
}

/** Identity returned by /stepics/1. The account id is immutable. */
export interface CurrentUser {
    id: number;
    fullName?: string;
    alias?: string | null;
    avatar?: string | null;
}

export interface UserActivitySummary {
    days: number;
    id: number;
    max_strike: number;
    recent_strike: number;
    solved: number;
    solved_today: number;
    pins: number[];
}

/** Per-day activity used by the profile heatmap (up to 365 days). */
export interface UserActivity {
    id: number;
    pins: number[];
}

export interface SocialProfile {
    id?: number;
    type?: string;
    url?: string;
    name?: string;
    [key: string]: unknown;
}

/** Public user record with the counters shown in the profile sidebar. */
export interface StepikUser {
    id: number;
    profile?: number;
    is_private?: boolean;
    is_active?: boolean;
    is_guest?: boolean;
    is_organization?: boolean;
    is_author?: boolean;
    short_bio?: string;
    details?: string;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    alias?: string | null;
    avatar?: string | null;
    cover?: string | null;
    city?: string | null;
    knowledge?: number;
    knowledge_rank?: number | null;
    reputation?: number;
    reputation_rank?: number | null;
    join_date?: string;
    social_profiles?: SocialProfile[];
    solved_steps_count?: number;
    created_courses_count?: number;
    created_lessons_count?: number;
    issued_certificates_count?: number;
    followers_count?: number;
}

/** Private profile settings returned by /profiles/{id}. */
export interface StepikProfile {
    id: number;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    is_private?: boolean;
    avatar?: string | null;
    language?: string;
    city?: string | null;
    short_bio?: string;
    details?: string;
    notification_status?: number;
    is_staff?: boolean;
    is_creator?: boolean;
    is_web_push_enabled?: boolean;
    is_vote_notifications_enabled?: boolean;
    last_login?: string;
    [key: string]: unknown;
}

export interface Certificate {
    id: number;
    course?: number;
    user?: number;
    type?: string;
    issue_date?: string;
    update_date?: string;
    grade?: number;
    url?: string;
    preview_url?: string;
    course_title?: string;
    course_title_en?: string;
    course_language?: string;
    course_is_public?: boolean;
    is_public?: boolean;
    saved_fullname?: string;
    user_rank?: number;
    user_rank_max?: number;
    leaderboard_size?: number;
    [key: string]: unknown;
}

/** Unread counters for the notification bell and the filter tabs. */
export interface NotificationStatus {
    id: number;
    learn: number;
    review: number;
    comments: number;
    teach: number;
    default: number;
    total: number;
}

export interface NotificationTargetCourse {
    course_id?: number;
    course_title?: string;
    course_cover?: string | null;
    course_url?: string;
    section_position?: number | string;
    unit_position?: number | string;
    [key: string]: unknown;
}

export interface NotificationTarget {
    step_id?: number;
    step_url?: string;
    step_position?: number | string;
    lesson_id?: number;
    lesson_url?: string;
    lesson_title?: string;
    courses?: NotificationTargetCourse[];
    [key: string]: unknown;
}

export interface NotificationContextData {
    actor_name?: string;
    actor_url?: string;
    comment_preview_text?: string;
    discussion_preview_text?: string;
    discussion_url?: string;
    submission_id?: number;
    submission_status?: string;
    submission_time?: string;
    comment_is_solutions_thread?: boolean;
    vote_target_type?: 'comment' | 'lesson' | string;
    [key: string]: unknown;
}

export interface NotificationContext {
    action_url?: string;
    target?: NotificationTarget;
    data?: NotificationContextData;
    [key: string]: unknown;
}

/**
 * One Stepik notification. `courses` is a relationship id list in the JSON
 * API; some responses inline the related course objects instead.
 */
export interface StepikNotification {
    id: number;
    is_unread: boolean;
    is_muted?: boolean;
    is_favorite: boolean;
    time: string;
    type: string;
    action: string;
    level?: string;
    priority?: string;
    html_text?: string;
    context?: NotificationContext;
    courses?: Array<number | { id?: number; title?: string; cover?: string | null }>;
}

export interface NotificationQuery {
    page?: number;
    pageSize?: number;
    isUnread?: boolean;
    isFavorite?: boolean;
    type?: string;
    course?: number;
    order?: string;
}

export interface NotificationPage {
    notifications: StepikNotification[];
    page: number;
    hasNext: boolean;
}

export interface Section {
    id: number;
    title: string;
    units: number[];
    course: number;
    position: number;
    progress: string;  // progress ID
    is_active?: boolean;
    is_exam?: boolean;
    is_exam_without_progress?: boolean;
    is_random_exam?: boolean;
    exam_duration_minutes?: number;
    exam_session?: number | ExamSession | null;
    proctor_session?: number | ProctorSession | null;
    required_section?: number | null;
    required_percent?: number;
    is_requirement_satisfied?: boolean;
    begin_date?: string | null;
    end_date?: string | null;
    soft_deadline?: string | null;
    hard_deadline?: string | null;
    grading_policy?: string;
}

export interface Unit {
    id: number;
    lesson: number;
    section: number;
    position: number;
    assignments?: number[];
    is_active?: boolean;
    begin_date?: string | null;
    end_date?: string | null;
    soft_deadline?: string | null;
    hard_deadline?: string | null;
    grading_policy?: string;
}

export interface Lesson {
    id: number;
    title: string;
    steps: number[];
    progress: string;  // progress ID like "lesson-12345"
}

export interface ExamSession {
    id: number;
    begin_date?: string | null;
    end_date?: string | null;
    time_left?: number | null;
    section?: number;
    random_exam?: number | null;
}

export interface ProctorSession {
    id: number;
    start_date?: string | null;
    end_date?: string | null;
    start_url?: string;
    is_finished?: boolean;
}

export interface Assignment {
    id: number;
    unit: number;
    step: number;
    lesson?: number;
}

export interface ChoiceOption {
    text: string;
    is_correct?: boolean;
    feedback?: string;
}

/** One item of the HTML/CSS checker. */
export interface HtmlChecklistTest {
    type: string;
    data?: { [key: string]: unknown };
}

export interface HtmlChecklistItem {
    name?: string;
    selector?: string;
    tests?: HtmlChecklistTest[];
}

/** One quality variant of a Stepik-hosted video. */
export interface VideoUrl {
    quality: string;
    url: string;
}

/** Subtitle track attached to a video step. */
export interface VideoSubtitleFile {
    file: string;
    language: string;
}

/**
 * Video metadata. Stepik stores videos on its CDN and exposes the available
 * MP4 variants plus a poster and the original source in `filename`.
 */
export interface StepVideo {
    id: number;
    thumbnail: string;
    urls: VideoUrl[];
    duration: number;
    status: string;
    upload_date?: string;
    filename?: string;
}

export interface Step {
    id: number;
    lesson: number;
    position: number;
    status: string;
    progress: string;  // progress ID like "step-12345"
    discussions_count?: number;
    discussion_proxy?: string;
    discussion_threads?: string[];
    is_solutions_unlocked?: boolean;
    solutions_unlocked_attempts?: number;
    block: {
        name: string;
        text: string;
        video?: StepVideo;
        subtitle_files?: VideoSubtitleFile[];
        options?: {
            code_templates?: { [key: string]: string };
            limits?: { [key: string]: { time: number; memory: number } };
            samples?: Array<[string, string]>;
            // Quiz options
            is_multiple_choice?: boolean;
            options?: ChoiceOption[];
            // String/Number options
            pattern?: string;
            case_sensitive?: boolean;
            use_re?: boolean;
            match_substring?: boolean;
            // HTML/CSS quiz
            html_template?: string;
            css_template?: string;
            checklist?: HtmlChecklistItem[];
            // Dataset/code limits
            time_limit?: number;
            is_run_user_code_allowed?: boolean;
            // Free answer
            is_attachments_enabled?: boolean;
            is_html_enabled?: boolean;
            manual_scoring?: boolean;
        };
    };
}

export interface MatchingPair {
    first: string;
    second: string;
}

export interface FillBlanksComponent {
    type: string;  // "text", "input" or "select"
    text?: string;
    options?: string[];
}

export interface TableColumnChoice {
    name: string;
    answer: boolean;
}

export interface TableRowChoice {
    name_row: string;
    columns: TableColumnChoice[];
}

/**
 * Datasets are generated per attempt by Stepik. Their shape depends on the
 * quiz plugin, so this interface describes a union of the known shapes.
 * The API can also return an empty string instead of an object.
 */
export interface AttemptDataset {
    is_multiple_choice?: boolean;
    options?: string[];
    pairs?: MatchingPair[];
    rows?: string[];
    columns?: string[];
    description?: string;
    is_checkbox?: boolean;
    components?: FillBlanksComponent[];
    is_file_disabled?: boolean;
    is_text_disabled?: boolean;
    is_attachments_enabled?: boolean;
    is_html_enabled?: boolean;
    template?: string[];
    image_src?: string;
    level?: number;
    file?: string;
}

export interface Attempt {
    id: number;
    step: number;
    dataset?: AttemptDataset | string | null;
    dataset_url?: string | null;
    time_left?: number | null;
    status?: string;
}

export interface Submission {
    id: number;
    status: string;
    score: number;
    hint: string;
    feedback: string;
    time?: string;
    reply?: {
        code?: string;
        language?: string;
        html?: string;
        css?: string;
        file?: string;
        text?: string;
        number?: string;
        formula?: string;
        ordering?: number[];
        blanks?: string[];
        solve_sql?: string;
        choices?: boolean[] | TableRowChoice[];
        slots?: ChemicalSlot[];
        solved?: boolean;
        score?: number;
        [key: string]: unknown;
    } | null;
}

export interface ChemicalSlot {
    normal: string;
    sub: string;
    sup: string;
}

export interface QuizReply {
    choices?: boolean[] | TableRowChoice[];  // choice / table
    text?: string;                          // string / free-answer
    number?: string;                        // number
    formula?: string;                       // math
    ordering?: number[];                    // sorting / matching
    blanks?: string[];                      // fill-blanks
    solve_sql?: string;                     // sql
    html?: string;                          // html
    css?: string;                           // html
    file?: string;                          // dataset
    slots?: ChemicalSlot[];                 // chemical
    solved?: boolean;                       // puzzle
    attachments?: unknown[];                // free-answer
    files?: unknown[];                      // string
    score?: number;                         // html checker result
}

export interface CommentUser {
    id: number;
    full_name: string;
    avatar?: string | null;
}

export type VoteValue = 'epic' | 'abuse' | null;

/**
 * Stepik stores one vote relation per comment and current user. The relation
 * exists even before the user votes; its value is null in that case.
 */
export interface CommentVote {
    id: string;
    value: VoteValue;
}

export interface StepikComment {
    id: number;
    parent: number | null;
    user: number;
    user_role: string;
    time: string;
    last_time?: string;
    text: string;
    reply_count: number;
    is_deleted: boolean;
    is_banned?: boolean;
    is_pinned?: boolean;
    is_staff_replied?: boolean;
    vote_delta?: number;
    epic_count?: number;
    abuse_count?: number;
    /**
     * Id of the current user's vote relation. The Android client expects a
     * string, but accept an embedded object as a defensive fallback.
     */
    vote?: string | CommentVote | null;
    actions?: {
        vote?: boolean;
        edit?: boolean;
        delete?: boolean;
        [key: string]: unknown;
    };
    can_edit?: boolean;
    can_delete?: boolean;
    thread?: string;
    submission?: number | null;
    edited_at?: string | null;
    replies?: number[];
}

export interface CommentsPage {
    comments: StepikComment[];
    users: CommentUser[];
    votes: CommentVote[];
    submissions?: Submission[];
    page: number;
    hasNext: boolean;
}

/**
 * A discussion proxy contains the full list of top-level comment ids in
 * several site-provided orders. Pinned comments are always first.
 */
export interface DiscussionProxy {
    id: string;
    discussions: number[];
    discussions_most_liked: number[];
    discussions_most_active: number[];
    discussions_recent_activity: number[];
}

export interface DiscussionThread {
    id: string;
    thread: string;
    discussions_count: number;
    discussion_proxy: string;
}

export class StepikApiError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = 'StepikApiError';
    }
}

export class StepikApi {
    private readonly inflightRequests = new Map<string, Promise<unknown>>();
    private readonly responseCache = new Map<
        string,
        { expires: number; value: unknown }
    >();
    private cacheGeneration = 0;

    constructor(private auth: StepikAuth) {}

    /**
     * Keep short-lived copies of read-only responses. The webview preloads the
     * previous and next steps, so opening one of them reuses a warm response
     * instead of waiting for the network. Writes invalidate the affected
     * entries explicitly; `POST /views` intentionally does not, because it
     * fires on every step open and must not throw away the preload cache.
     */
    private cachedRequest<T>(endpoint: string, ttlMs: number): Promise<T> {
        const hit = this.responseCache.get(endpoint);
        if (hit && hit.expires > Date.now()) {
            return Promise.resolve(hit.value as T);
        }
        const generation = this.cacheGeneration;
        return this.request<T>(endpoint).then(value => {
            // A write may have invalidated the cache while this read was in
            // flight. Do not store the old response in that case.
            if (generation === this.cacheGeneration) {
                this.responseCache.set(endpoint, {
                    expires: Date.now() + ttlMs,
                    value
                });
            }
            return value;
        });
    }

    private invalidateCache(prefixes: string[]): void {
        this.cacheGeneration++;
        for (const key of Array.from(this.responseCache.keys())) {
            if (prefixes.some(prefix => key.startsWith(prefix))) {
                this.responseCache.delete(key);
            }
        }
    }

    /** Drop every cached response, for example after login or logout. */
    clearCache(): void {
        this.cacheGeneration++;
        this.responseCache.clear();
        this.inflightRequests.clear();
    }

    private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        const method = (options.method || 'GET').toUpperCase();
        const canShare = method === 'GET' && !options.body;

        // Several panels/tree refreshes may ask for the same resource at the
        // same time. Share one network request instead of duplicating it.
        if (canShare) {
            const pending = this.inflightRequests.get(endpoint);
            if (pending) {
                return pending as Promise<T>;
            }
        }

        const promise = this.performRequest<T>(endpoint, options);
        if (canShare) {
            this.inflightRequests.set(endpoint, promise);
            void promise.then(
                () => this.inflightRequests.delete(endpoint),
                () => this.inflightRequests.delete(endpoint)
            );
        }
        return promise;
    }

    private async performRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        const token = await this.auth.getToken();
        if (!token) {
            throw new Error('Not authenticated. Please login first.');
        }

        const response = await fetchWithTimeout(`${BASE_URL}${endpoint}`, {
            ...options,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            // Stepik returns a useful JSON detail for 4xx responses. Keep it in
            // the error message so the output channel explains what went wrong.
            let detail = '';
            try {
                const body = await response.text();
                if (body) {
                    try {
                        const parsed = JSON.parse(body) as { detail?: unknown };
                        detail = parsed.detail ? String(parsed.detail) : body.slice(0, 300);
                    } catch {
                        detail = body.slice(0, 300);
                    }
                }
            } catch {
                // Ignore a secondary body-read error.
            }
            const message = response.status === 401
                ? t('api.sessionExpired')
                : detail
                    ? t('api.errorDetail', {
                          status: response.status,
                          statusText: response.statusText,
                          detail
                      })
                    : t('api.error', {
                          status: response.status,
                          statusText: response.statusText
                      });
            throw new StepikApiError(message, response.status);
        }

        if (response.status === 204) {
            return {} as T;
        }

        const text = await response.text();
        if (!text.trim()) {
            return {} as T;
        }
        return JSON.parse(text) as T;
    }

    async getCurrentUser(): Promise<CurrentUser> {
        const data = await this.cachedRequest<{
            users?: Array<{
                id: number;
                full_name?: string;
                first_name?: string;
                last_name?: string;
                alias?: string | null;
                avatar?: string | null;
            }>;
        }>('/stepics/1', 5 * 60_000);
        const user = data.users?.[0];
        if (!user) {
            throw new Error(t('api.userNotFound'));
        }

        const composedName = [user.first_name, user.last_name]
            .map(part => (part || '').trim())
            .filter(Boolean)
            .join(' ');
        const fullName = (user.full_name || composedName || user.alias || '').trim();
        return {
            id: user.id,
            fullName: fullName || undefined,
            alias: user.alias ?? undefined,
            avatar: user.avatar ?? undefined
        };
    }

    async getUserCourses(): Promise<Course[]> {
        const user = await this.getCurrentUser();

        // /user-courses is paginated (20 items per page by default). Load all
        // pages instead of silently dropping courses after the first one.
        const courseIds: number[] = [];
        for (let page = 1; ; page++) {
            const data = await this.request<{
                'user-courses': Array<{ course: number }>;
                meta?: { has_next?: boolean };
            }>(`/user-courses?user=${user.id}&page=${page}`);
            const items = data['user-courses'] || [];
            courseIds.push(...items.map(uc => uc.course));
            if (!data.meta?.has_next || items.length === 0) {
                break;
            }
        }

        if (courseIds.length === 0) {
            return [];
        }

        const courses: Course[] = [];
        for (let i = 0; i < courseIds.length; i += 100) {
            const chunk = courseIds.slice(i, i + 100);
            const coursesData = await this.request<{ courses: Course[] }>(
                `/courses?ids[]=${chunk.join('&ids[]=')}`
            );
            courses.push(...(coursesData.courses || []));
        }
        return courses;
    }

    /**
     * Enroll the current user in a course.
     *
     * Stepik's own web app and mobile clients POST the same envelope to
     * `/enrollments`. OAuth bearers are accepted here, so no website CSRF
     * token is needed. Paid courses must be bought on stepik.org first; the
     * caller is responsible for enforcing that rule.
     */
    async enrollCourse(courseId: number): Promise<void> {
        if (!Number.isInteger(courseId) || courseId <= 0) {
            throw new Error(t('api.invalidCourseId'));
        }

        await this.request('/enrollments', {
            method: 'POST',
            body: JSON.stringify({
                enrollment: {
                    course: courseId
                }
            })
        });
    }

    async getCourse(courseId: number): Promise<Course | undefined> {
        try {
            const data = await this.request<{ courses: Course[] }>(`/courses/${courseId}`);
            return data.courses[0];
        } catch {
            return undefined;
        }
    }

    /**
     * Course ids in the same relevance order as Stepik's own search page.
     *
     * The public `/courses?search=...` endpoint is sorted by creation date,
     * which makes a search look like a list of random new courses. Stepik's
     * website uses `/search-results` instead, so the catalog does the same:
     * no query returns the top courses, a query returns relevant matches.
     */
    async searchCatalogCourseIds(
        search: string,
        page: number,
        freeOnly: boolean = false
    ): Promise<{ courseIds: number[]; hasNext: boolean }> {
        const params = new URLSearchParams();
        params.set('type', 'course');
        params.set('page', String(page));
        if (freeOnly) {
            params.set('is_paid', 'false');
        }
        const query = search.trim();
        if (query) {
            params.set('query', query);
        }
        const data = await this.request<{
            'search-results': Array<{ course: number }>;
            meta?: { has_next?: boolean };
        }>(`/search-results?${params.toString()}`);
        return {
            courseIds: (data['search-results'] || [])
                .map(result => result.course)
                .filter(id => Number.isInteger(id) && id > 0),
            hasNext: Boolean(data.meta?.has_next)
        };
    }

    /** Ordered course ids from a curated Stepik list such as "Популярные курсы". */
    async getCourseListCourseIds(listId: number): Promise<number[]> {
        const data = await this.request<{
            'course-lists': Array<{ courses?: number[] }>;
        }>(`/course-lists/${listId}`);
        const list = (data['course-lists'] || [])[0];
        return (list?.courses || []).filter(id => Number.isInteger(id) && id > 0);
    }

    /** Fetch courses by id while preserving the order of the given ids. */
    async getCoursesByIds(courseIds: number[]): Promise<Course[]> {
        if (courseIds.length === 0) {
            return [];
        }

        const byId = new Map<number, Course>();
        for (const part of chunkItems(courseIds)) {
            const data = await this.request<{ courses: Course[] }>(
                `/courses?${part.map(id => `ids[]=${id}`).join('&')}`
            );
            for (const course of data.courses || []) {
                byId.set(course.id, course);
            }
        }

        return courseIds
            .map(id => byId.get(id))
            .filter((course): course is Course => Boolean(course));
    }

    async getCourseReviewSummaries(
        courseIds: number[]
    ): Promise<Map<number, CourseReviewSummary>> {
        const result = new Map<number, CourseReviewSummary>();
        if (courseIds.length === 0) {
            return result;
        }

        for (const part of chunkItems(courseIds)) {
            const query = part.map(id => `ids[]=${id}`).join('&');
            try {
                const data = await this.request<{
                    'course-review-summaries': CourseReviewSummary[];
                }>(`/course-review-summaries?${query}`);
                for (const summary of data['course-review-summaries'] || []) {
                    // `ids[]` contains review-summary ids from
                    // `course.review_summary`; keep both keys so callers can
                    // look the summary up by either id or course.
                    result.set(summary.id, summary);
                    result.set(summary.course, summary);
                }
            } catch (error) {
                // Ratings are decorative: a failed summary request must not
                // hide the catalog itself.
                console.warn('[Stepik] Failed to load course review summaries:', error);
            }
        }
        return result;
    }

    async getSections(sectionIds: number[]): Promise<Section[]> {
        if (sectionIds.length === 0) {
            return [];
        }
        const sections: Section[] = [];
        for (const part of chunkItems(sectionIds)) {
            const data = await this.request<{ sections: Section[] }>(
                `/sections?ids[]=${part.join('&ids[]=')}`
            );
            sections.push(...(data.sections || []));
        }
        return sections;
    }

    async getSection(sectionId: number): Promise<Section | undefined> {
        const sections = await this.getSections([sectionId]);
        return sections[0];
    }

    async getUnits(unitIds: number[]): Promise<Unit[]> {
        if (unitIds.length === 0) {
            return [];
        }
        const units: Unit[] = [];
        for (const part of chunkItems(unitIds)) {
            const data = await this.request<{ units: Unit[] }>(
                `/units?ids[]=${part.join('&ids[]=')}`
            );
            units.push(...(data.units || []));
        }
        return units;
    }

    async getLessons(lessonIds: number[]): Promise<Lesson[]> {
        if (lessonIds.length === 0) {
            return [];
        }
        const lessons: Lesson[] = [];
        for (const part of chunkItems(lessonIds)) {
            const data = await this.request<{ lessons: Lesson[] }>(
                `/lessons?ids[]=${part.join('&ids[]=')}`
            );
            lessons.push(...(data.lessons || []));
        }
        return lessons;
    }

    async getStep(stepId: number): Promise<Step> {
        const data = await this.request<{ steps: Step[] }>(`/steps/${stepId}`);
        return data.steps[0];
    }

    /**
     * Mark a step as viewed. The Stepik web client posts this every time a
     * step is opened. The assignment id links the view to the course unit;
     * without it text steps are not counted as passed.
     */
    async markStepViewed(stepId: number, assignmentId?: number | null): Promise<void> {
        await this.request<{ views?: unknown[] }>('/views', {
            method: 'POST',
            body: JSON.stringify({
                view: {
                    step: String(stepId),
                    assignment: assignmentId != null ? String(assignmentId) : null
                }
            })
        });
    }

    async getSteps(stepIds: number[]): Promise<Step[]> {
        if (stepIds.length === 0) {
            return [];
        }
        const steps: Step[] = [];
        for (const part of chunkItems(stepIds)) {
            const data = await this.request<{ steps: Step[] }>(
                `/steps?ids[]=${part.join('&ids[]=')}`
            );
            steps.push(...(data.steps || []));
        }
        return steps;
    }

    async getAssignments(assignmentIds: number[]): Promise<Assignment[]> {
        if (assignmentIds.length === 0) {
            return [];
        }
        const assignments: Assignment[] = [];
        for (const part of chunkItems(assignmentIds)) {
            const data = await this.request<{ assignments: Assignment[] }>(
                `/assignments?ids[]=${part.join('&ids[]=')}`
            );
            assignments.push(...(data.assignments || []));
        }
        return assignments;
    }

    /**
     * Return the assignment id that links a step to a unit. Stepik's `view`
     * endpoint needs this id for course progress to be recalculated; without
     * it the view is stored globally and text steps stay unpassed.
     */
    async getAssignmentIdForStep(unitId: number, stepId: number): Promise<number | undefined> {
        const units = await this.getUnits([unitId]);
        const unit = units[0];
        if (!unit || !unit.assignments || unit.assignments.length === 0) {
            return undefined;
        }
        const assignments = await this.getAssignments(unit.assignments);
        return assignments.find(assignment => assignment.step === stepId)?.id;
    }

    async getExamSession(sessionId: number): Promise<ExamSession | undefined> {
        try {
            const data = await this.request<ExamSessionPayload>(
                `/exam-sessions/${sessionId}`
            );
            return extractExamSession(data);
        } catch (error) {
            // Some API versions expose only the list endpoint.
            try {
                const data = await this.request<ExamSessionPayload>(
                    `/exam-sessions?ids[]=${sessionId}`
                );
                return extractExamSession(data);
            } catch {
                throw error;
            }
        }
    }

    /**
     * Start an exam exactly like the Stepik web client: create an
     * `exam-session` for the section. The server decides whether the user is
     * allowed to start; the timer lives in the returned session.
     */
    async createExamSession(sectionId: number): Promise<ExamSession> {
        const data = await this.request<ExamSessionPayload>('/exam-sessions', {
            method: 'POST',
            body: JSON.stringify({
                exam_session: {
                    section: sectionId
                }
            })
        });

        const session = extractExamSession(data);
        if (!session) {
            throw new Error(t('api.examSessionMissing'));
        }
        return session;
    }

    /**
     * Load comments for a step. Pass parent = null for top-level comments,
     * or a comment id to load its direct replies.
     */
    async getComments(
        stepId: number,
        page: number = 1,
        parent: number | null = null
    ): Promise<CommentsPage> {
        const parentParam = parent === null ? 'null' : String(parent);
        const endpoint = `/comments?target=${stepId}&parent=${parentParam}&page=${page}&page_size=20`;
        const data = await this.cachedRequest<{
            meta?: { page?: number; has_next?: boolean };
            comments: StepikComment[];
            submissions?: Submission[];
            users?: CommentUser[];
            votes?: CommentVote[];
        }>(endpoint, 60_000);

        return {
            comments: data.comments || [],
            users: data.users || [],
            votes: data.votes || [],
            submissions: data.submissions || [],
            page: data.meta?.page ?? page,
            hasNext: data.meta?.has_next ?? false
        };
    }

    /**
     * Load comments authored by one user on a step. Unlike the discussion
     * proxy, this endpoint also returns replies, so it can be used for the
     * "Мои комментарии" view.
     */
    async getUserComments(
        stepId: number,
        userId: number,
        page: number = 1
    ): Promise<CommentsPage> {
        const data = await this.cachedRequest<{
            meta?: { page?: number; has_next?: boolean };
            comments: StepikComment[];
            submissions?: Submission[];
            users?: CommentUser[];
            votes?: CommentVote[];
        }>(
            `/comments?target=${stepId}&user=${userId}&page=${page}&page_size=100`,
            60_000
        );

        return {
            comments: data.comments || [],
            users: data.users || [],
            votes: data.votes || [],
            submissions: data.submissions || [],
            page: data.meta?.page ?? page,
            hasNext: data.meta?.has_next ?? false
        };
    }

    /**
     * The discussion proxy contains the ordered lists of all top-level
     * comments. Stepik exposes a separate order for date, popularity,
     * activity and recent updates.
     */
    async getDiscussionProxy(proxyId: string): Promise<DiscussionProxy | undefined> {
        const data = await this.cachedRequest<{
            'discussion-proxies': DiscussionProxy[];
        }>(`/discussion-proxies/${encodeURIComponent(proxyId)}`, 60_000);

        return data['discussion-proxies']?.[0];
    }

    /**
     * Discussion threads are named "default" and "solutions". The solutions
     * thread has its own proxy and is only returned for users who unlocked it.
     */
    async getDiscussionThread(
        threadId: string,
        forceRefresh: boolean = false
    ): Promise<DiscussionThread | undefined> {
        const endpoint = `/discussion-threads/${encodeURIComponent(threadId)}`;
        const data = forceRefresh
            ? await this.request<{ 'discussion-threads': DiscussionThread[] }>(endpoint)
            : await this.cachedRequest<{ 'discussion-threads': DiscussionThread[] }>(
                  endpoint,
                  60_000
              );

        return data['discussion-threads']?.[0];
    }

    async getDiscussionThreads(
        threadIds: string[],
        forceRefresh: boolean = false
    ): Promise<DiscussionThread[]> {
        if (threadIds.length === 0) {
            return [];
        }

        const query = threadIds.map(id => `ids[]=${encodeURIComponent(id)}`).join('&');
        const endpoint = `/discussion-threads?${query}`;
        const data = forceRefresh
            ? await this.request<{ 'discussion-threads': DiscussionThread[] }>(endpoint)
            : await this.cachedRequest<{ 'discussion-threads': DiscussionThread[] }>(
                  endpoint,
                  60_000
              );

        return data['discussion-threads'] || [];
    }

    /**
     * Comments can be loaded in batches by id. Stepik also returns all direct
     * replies to every requested comment in the same response.
     */
    async getCommentsByIds(ids: number[]): Promise<{
        comments: StepikComment[];
        users: CommentUser[];
        votes: CommentVote[];
        submissions: Submission[];
    }> {
        if (ids.length === 0) {
            return { comments: [], users: [], votes: [], submissions: [] };
        }

        const query = ids.map(id => `ids[]=${id}`).join('&');
        const data = await this.cachedRequest<{
            comments: StepikComment[];
            users?: CommentUser[];
            votes?: CommentVote[];
            submissions?: Submission[];
        }>(`/comments?${query}`, 60_000);

        return {
            comments: data.comments || [],
            users: data.users || [],
            votes: data.votes || [],
            submissions: data.submissions || []
        };
    }

    /**
     * Load the current user's submissions for a step. Stepik requires a
     * concrete user id here: the special value "me" is rejected with 400.
     */
    async getUserSubmissions(stepId: number): Promise<Submission[]> {
        const user = await this.getCurrentUser();
        const data = await this.cachedRequest<{ submissions: Submission[] }>(
            `/submissions?step=${stepId}&user=${user.id}&order=desc&page=1`,
            60_000
        );
        return data.submissions || [];
    }

    /**
     * Create a top-level comment (parent omitted) or a reply. Stepik expects
     * HTML in the text field and a thread name for non-default forums.
     * A top-level comment in the solutions thread must also reference the
     * author's submission, otherwise the API responds with 400 Bad Request.
     */
    async createComment(
        target: number,
        text: string,
        parent?: number,
        thread?: string,
        submission?: number
    ): Promise<{
        comment: StepikComment;
        users: CommentUser[];
        votes: CommentVote[];
        submissions: Submission[];
    }> {
        const comment: {
            target: number;
            text: string;
            parent?: number;
            thread?: string;
            submission?: string;
        } = { target, text };

        if (parent) {
            comment.parent = parent;
        }
        if (thread) {
            comment.thread = thread;
        }
        if (submission && !parent && thread === 'solutions') {
            // Stepik's WriteCommentSerializer declares submission as a string.
            comment.submission = String(submission);
        }

        const data = await this.request<{
            comments: StepikComment[];
            users?: CommentUser[];
            votes?: CommentVote[];
            submissions?: Submission[];
        }>('/comments', {
            method: 'POST',
            body: JSON.stringify({ comment })
        });

        // Comment lists, proxy orders and thread counters all change after a
        // new comment or reply.
        this.invalidateCache([
            '/comments',
            '/discussion-proxies',
            '/discussion-threads'
        ]);

        return {
            comment: data.comments[0],
            users: data.users || [],
            votes: data.votes || [],
            submissions: data.submissions || []
        };
    }

    /**
     * Edit an existing comment. Stepik accepts PUT /comments/{id} with the
     * comment id and HTML text; PATCH is rejected with 403.
     */
    async updateComment(commentId: number, text: string): Promise<{
        comment: StepikComment;
        users: CommentUser[];
        votes: CommentVote[];
        submissions: Submission[];
    }> {
        const data = await this.request<{
            comments: StepikComment[];
            users?: CommentUser[];
            votes?: CommentVote[];
            submissions?: Submission[];
        }>(`/comments/${commentId}`, {
            method: 'PUT',
            body: JSON.stringify({
                comment: {
                    id: commentId,
                    text
                }
            })
        });

        this.invalidateCache(['/comments', '/discussion-proxies']);
        return {
            comment: data.comments[0],
            users: data.users || [],
            votes: data.votes || [],
            submissions: data.submissions || []
        };
    }

    /** Soft-delete a comment authored by the current user. */
    async deleteComment(commentId: number): Promise<void> {
        await this.request(`/comments/${commentId}`, {
            method: 'DELETE'
        });
        this.invalidateCache(['/comments', '/discussion-proxies', '/discussion-threads']);
    }

    /**
     * Load one page of direct replies to a comment. Stepik caps page_size at
     * 20 items, even when a larger value is requested, so callers that need a
     * bigger batch must combine several pages.
     */
    async getCommentReplies(
        commentId: number,
        page: number = 1,
        pageSize: number = 20
    ): Promise<CommentsPage> {
        const data = await this.cachedRequest<{
            meta?: { page?: number; has_next?: boolean };
            comments: StepikComment[];
            submissions?: Submission[];
            users?: CommentUser[];
            votes?: CommentVote[];
        }>(
            `/comments?parent=${commentId}&page=${page}&page_size=${pageSize}`,
            60_000
        );

        return {
            comments: (data.comments || []).filter(comment => comment.parent === commentId),
            users: data.users || [],
            votes: data.votes || [],
            submissions: data.submissions || [],
            page: data.meta?.page ?? page,
            hasNext: data.meta?.has_next ?? false
        };
    }

    /**
     * Save (or clear) the current user's vote for a comment. Stepik expects a
     * full vote object in the body and id in the path. Sending value = null
     * removes an existing like/dislike.
     */
    async saveVote(voteId: string, value: VoteValue): Promise<CommentVote | undefined> {
        const data = await this.request<{ votes?: CommentVote[] }>(
            `/votes/${encodeURIComponent(voteId)}`,
            {
                method: 'PUT',
                body: JSON.stringify({
                    vote: {
                        id: voteId,
                        value
                    }
                })
            }
        );

        // Votes are embedded in comment responses, so refresh them next time.
        this.invalidateCache(['/comments']);

        return data.votes?.[0];
    }

    async createAttempt(stepId: number): Promise<Attempt> {
        const data = await this.request<{ attempts: Attempt[] }>('/attempts', {
            method: 'POST',
            body: JSON.stringify({
                attempt: {
                    step: stepId
                }
            })
        });
        this.invalidateCache(['/attempts']);
        return data.attempts[0];
    }

    async getAttempts(stepId: number): Promise<Attempt[]> {
        const data = await this.cachedRequest<{ attempts: Attempt[] }>(
            `/attempts?step=${stepId}&user=me`,
            60_000
        );
        return (data.attempts || []).sort((left, right) => right.id - left.id);
    }

    /**
     * Reuse the latest attempt instead of POSTing a new one every time a step
     * is opened. Stepik's web client keeps one attempt per step and lets the
     * user send several submissions into it.
     */
    async getAttempt(stepId: number): Promise<Attempt> {
        try {
            const attempts = await this.getAttempts(stepId);
            const latest = attempts.find(
                attempt => attempt.status !== 'outdated' && attempt.status !== 'cleanedup'
            );
            if (latest) {
                return latest;
            }
        } catch (error) {
            // Older Stepik deployments may reject the attempts listing. Do
            // not break the whole task because of that; a fresh attempt is a
            // safe fallback.
            console.warn('[Stepik] Failed to load attempts:', error);
        }
        return this.createAttempt(stepId);
    }

    async getOrCreateAttempt(stepId: number): Promise<Attempt> {
        return this.getAttempt(stepId);
    }

    async submitSolution(attemptId: number, language: string, code: string): Promise<Submission> {
        const data = await this.request<{ submissions: Submission[] }>('/submissions', {
            method: 'POST',
            body: JSON.stringify({
                submission: {
                    attempt: attemptId,
                    reply: {
                        language: language,
                        code: code
                    }
                }
            })
        });
        this.invalidateAfterSubmission();
        return data.submissions[0];
    }

    async submitQuiz(attemptId: number, reply: QuizReply): Promise<Submission> {
        const data = await this.request<{ submissions: Submission[] }>('/submissions', {
            method: 'POST',
            body: JSON.stringify({
                submission: {
                    attempt: attemptId,
                    reply: reply
                }
            })
        });
        this.invalidateAfterSubmission();
        return data.submissions[0];
    }

    /**
     * A submission updates attempt status, submissions shown in comments and
     * can unlock the solutions thread. Drop every affected read cache so the
     * reopened step and its preloaded neighbours see the new state.
     */
    private invalidateAfterSubmission(): void {
        this.invalidateCache([
            '/attempts',
            '/submissions',
            '/comments',
            '/discussion-proxies',
            '/discussion-threads'
        ]);
    }

    async getSubmission(submissionId: number): Promise<Submission> {
        const data = await this.request<{ submissions: Submission[] }>(
            `/submissions/${submissionId}`
        );
        return data.submissions[0];
    }

    /**
     * Data challenges expose a randomized input file through dataset_url.
     * The endpoint is plain text, not JSON, so it cannot use request<T>().
     */
    async getAttemptFile(attemptId: number, datasetUrl?: string | null): Promise<string> {
        const token = await this.auth.getToken();
        if (!token) {
            throw new Error('Not authenticated. Please login first.');
        }

        const endpoint = datasetUrl || `/attempts/${attemptId}/file`;
        const url = /^https?:\/\//i.test(endpoint)
            ? endpoint
            : `https://stepik.org${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

        const response = await fetchWithTimeout(url, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new StepikApiError(
                `API Error: ${response.status} ${response.statusText}`,
                response.status
            );
        }

        return response.text();
    }

    async getProgressByIds(progressIds: string[]): Promise<Map<string, Progress>> {
        const result = new Map<string, Progress>();
        if (progressIds.length === 0) {
            return result;
        }
        try {
            // Filter out null/undefined and create query string
            const validIds = progressIds.filter(id => id);
            if (validIds.length === 0) {
                return result;
            }
            for (const part of chunkItems(validIds)) {
                const idsQuery = part.map(id => `ids[]=${encodeURIComponent(id)}`).join('&');
                const data = await this.request<{ progresses: Progress[] }>(
                    `/progresses?${idsQuery}`
                );
                for (const progress of data.progresses || []) {
                    result.set(progress.id, progress);
                }
            }
        } catch (error) {
            // Progress is cosmetic; do not break the whole tree if it fails.
            console.warn('[Stepik] Failed to load progress:', error);
        }
        return result;
    }

    async getStepProgress(stepId: number): Promise<{ is_passed: boolean } | null> {
        try {
            const data = await this.request<{ progresses: Array<{ is_passed: boolean }> }>(
                `/progresses/step-${stepId}`
            );
            return data.progresses[0] || null;
        } catch {
            return null;
        }
    }

    async getStepsProgress(stepIds: number[]): Promise<Map<number, boolean>> {
        const result = new Map<number, boolean>();
        if (stepIds.length === 0) {
            return result;
        }
        try {
            for (const part of chunkItems(stepIds)) {
                const ids = part.map(id => `step-${id}`).join('&ids[]=');
                const data = await this.request<{ progresses: Array<{ id: string; is_passed: boolean }> }>(
                    `/progresses?ids[]=${ids}`
                );
                for (const progress of data.progresses || []) {
                    const stepId = parseInt(progress.id.replace('step-', ''));
                    result.set(stepId, progress.is_passed);
                }
            }
        } catch (error) {
            console.warn('[Stepik] Failed to load step progress:', error);
        }
        return result;
    }

    async getCourseProgress(courseId: number): Promise<Progress | null> {
        try {
            // Course progress ids have the form `78-<course id>`. The old
            // `course-<id>` form is not recognized by the API.
            const data = await this.cachedRequest<{ progresses: Progress[] }>(
                `/progresses/78-${courseId}`,
                60_000
            );
            return data.progresses[0] || null;
        } catch {
            return null;
        }
    }

    async getUserActivitySummary(userId: number): Promise<UserActivitySummary | null> {
        try {
            const data = await this.cachedRequest<{
                'user-activity-summaries'?: UserActivitySummary[];
            }>(`/user-activity-summaries/${userId}`, 60_000);
            return data['user-activity-summaries']?.[0] || null;
        } catch {
            return null;
        }
    }

    /** Full per-day activity (365 days) used by the profile heatmap. */
    async getUserActivity(userId: number): Promise<UserActivity | null> {
        try {
            const data = await this.cachedRequest<{
                'user-activities'?: UserActivity[];
            }>(`/user-activities/${userId}`, 60_000);
            return data['user-activities']?.[0] || null;
        } catch {
            return null;
        }
    }

    async getCertificates(userId: number): Promise<Certificate[]> {
        try {
            const data = await this.cachedRequest<{ certificates?: Certificate[] }>(
                `/certificates?order=-id&page=1&user=${userId}`,
                60_000
            );
            return data.certificates || [];
        } catch {
            return [];
        }
    }

    /** Public user record with the counters shown on the profile page. */
    async getUser(userId: number): Promise<StepikUser | null> {
        try {
            const data = await this.cachedRequest<{ users?: StepikUser[] }>(
                `/users/${userId}`,
                60_000
            );
            return data.users?.[0] || null;
        } catch (error) {
            console.warn('[Stepik] Failed to load user:', error);
            return null;
        }
    }

    /** Private profile record belonging to the current account. */
    async getProfile(userId: number): Promise<StepikProfile | null> {
        try {
            const data = await this.cachedRequest<{ profiles?: StepikProfile[] }>(
                `/profiles/${userId}`,
                60_000
            );
            return data.profiles?.[0] || null;
        } catch (error) {
            console.warn('[Stepik] Failed to load profile:', error);
            return null;
        }
    }

    /**
     * Unread notification counters. Unlike the list itself this is fetched
     * fresh every time, because the status bar depends on it.
     */
    async getNotificationStatus(userId?: number): Promise<NotificationStatus | null> {
        const id = userId ?? (await this.getCurrentUser()).id;
        const data = await this.request<{
            'notification-statuses'?: NotificationStatus[];
        }>(`/notification-statuses/${id}`);
        return data['notification-statuses']?.[0] || null;
    }

    async getNotifications(query: NotificationQuery = {}): Promise<NotificationPage> {
        const params = new URLSearchParams();
        const page = Math.max(1, Math.floor(Number(query.page) || 1));
        params.set('page', String(page));
        if (query.pageSize) {
            params.set('page_size', String(Math.max(1, Math.floor(query.pageSize))));
        }
        if (query.isUnread !== undefined) {
            params.set('is_unread', String(query.isUnread));
        }
        if (query.isFavorite !== undefined) {
            params.set('is_favorite', String(query.isFavorite));
        }
        if (query.type && query.type !== 'all') {
            params.set('type', query.type);
        }
        if (query.course) {
            params.set('course', String(query.course));
        }
        params.set('order', query.order || '-time,-id');

        const data = await this.request<{
            notifications?: StepikNotification[];
            meta?: { page?: number; has_next?: boolean };
        }>(`/notifications?${params.toString()}`);

        return {
            notifications: data.notifications || [],
            page: data.meta?.page ?? page,
            hasNext: Boolean(data.meta?.has_next)
        };
    }

    /**
     * Update one notification. Stepik only accepts PUT here; the body needs
     * the id even though it is already present in the path.
     */
    async updateNotification(
        notificationId: number,
        changes: { is_unread?: boolean; is_favorite?: boolean; is_muted?: boolean }
    ): Promise<StepikNotification | null> {
        const data = await this.request<{ notifications?: StepikNotification[] }>(
            `/notifications/${notificationId}`,
            {
                method: 'PUT',
                body: JSON.stringify({
                    notification: {
                        id: notificationId,
                        ...changes
                    }
                })
            }
        );
        return data.notifications?.[0] || null;
    }

    /**
     * Mark every notification matching the current filters as read. The
     * endpoint accepts either `type` or `course` at the top level, not inside
     * a `notification` envelope.
     */
    async markAllNotificationsRead(filters: {
        type?: string;
        course?: number;
    } = {}): Promise<string | undefined> {
        const body: { type?: string; course?: number } = {};
        if (filters.type && filters.type !== 'all') {
            body.type = filters.type;
        }
        if (filters.course) {
            body.course = filters.course;
        }
        const data = await this.request<{ status_text?: string }>(
            '/notifications/mark-as-read',
            {
                method: 'POST',
                body: JSON.stringify(body)
            }
        );
        return data.status_text;
    }
}
