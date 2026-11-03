import * as vscode from 'vscode';
import {
    StepikApi,
    StepikApiError,
    Course,
    Lesson,
    Step,
    Section,
    Unit,
    Progress,
    ExamSession
} from '../api/stepikApi';
import { StepContext } from '../stepContext';
import { getStepTypeLabel } from '../stepTypes';
import {
    SectionAccess,
    formatDuration,
    getSectionAccess,
    getSessionTimeLeft
} from '../exam/examAccess';

type TreeItemType = 'section' | 'lesson' | 'step' | 'examAction' | 'info';

// Status colors
const STATUS_PASSED = new vscode.ThemeColor('charts.green');
const STATUS_STARTED = new vscode.ThemeColor('charts.yellow');
const STATUS_LOCKED = new vscode.ThemeColor('disabledForeground');

interface TreeItemData {
    type: TreeItemType;
    course?: Course;
    section?: Section;
    lesson?: Lesson;
    step?: Step;
    unit?: Unit;
    courseName?: string;
    lessonTitle?: string;
    progressMap?: Map<string, Progress>;  // Map of progress ID to Progress
    courseProgress?: Progress;  // For course status
    access?: SectionAccess;
    infoText?: string;
    infoIcon?: string;
}

export class StepikTreeProvider implements vscode.TreeDataProvider<TreeItemData>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItemData | undefined | null | void> =
        new vscode.EventEmitter<TreeItemData | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItemData | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private selectedCourse: Course | undefined;
    private localPassedSteps: Set<number> = new Set();  // Locally marked as passed (before API refresh)
    private readonly cache = new Map<string, { expires: number; value: unknown }>();
    private examRefreshTimer: NodeJS.Timeout | undefined;

    constructor(
        private api: StepikApi,
        private context: vscode.ExtensionContext
    ) {
        // Restore selected course from storage
        this.restoreSelectedCourse();
    }

    private async restoreSelectedCourse(): Promise<void> {
        const courseId = this.context.globalState.get<number>('selectedCourseId');
        if (courseId) {
            try {
                const course = await this.api.getCourse(courseId);
                if (course) {
                    this.selectedCourse = course;
                    this.refresh();
                }
            } catch {
                // Course not found or not accessible, clear selection
                this.context.globalState.update('selectedCourseId', undefined);
            }
        }
    }

    async selectCourse(): Promise<void> {
        const courses = await this.api.getUserCourses();

        const items = courses.map(course => ({
            label: course.title,
            description: `${course.sections.length} секций`,
            course
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Выберите курс',
            title: 'Stepik: выбор курса'
        });

        if (selected) {
            this.selectedCourse = selected.course;
            await this.context.globalState.update('selectedCourseId', selected.course.id);
            this.forceRefresh();
        }
    }

    getSelectedCourse(): Course | undefined {
        return this.selectedCourse;
    }

    clearCourseSelection(): void {
        this.selectedCourse = undefined;
        this.context.globalState.update('selectedCourseId', undefined);
        this.forceRefresh();
    }

    // Mark step as passed locally (instant UI update)
    markStepAsPassed(stepId: number): void {
        this.localPassedSteps.add(stepId);
    }

    // Clear local passed steps (after API refresh)
    clearLocalPassedSteps(): void {
        this.localPassedSteps.clear();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    /**
     * Clear cached sections/sessions after an exam starts or a submission
     * changes progress. The tree is cheap to rebuild, and stale exam state is
     * worse than one extra API call.
     */
    forceRefresh(): void {
        this.clearLocalPassedSteps();
        this.cache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    dispose(): void {
        if (this.examRefreshTimer) {
            clearInterval(this.examRefreshTimer);
            this.examRefreshTimer = undefined;
        }
        this.cache.clear();
    }

    private async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
        const hit = this.cache.get(key);
        if (hit && hit.expires > Date.now()) {
            return hit.value as T;
        }
        const value = await load();
        this.cache.set(key, { expires: Date.now() + ttlMs, value });
        return value;
    }

    private idsKey(prefix: string, ids: Array<number | string>): string {
        return `${prefix}:${ids.slice().map(String).sort().join(',')}`;
    }

    /** Short-lived cache for progress maps; forceRefresh clears it. */
    private getProgressByIds(progressIds: string[]): Promise<Map<string, Progress>> {
        return this.cached(
            this.idsKey('progress', progressIds),
            15_000,
            () => this.api.getProgressByIds(progressIds)
        );
    }

    private async getSession(section: Section, force: boolean = false): Promise<ExamSession | undefined> {
        const raw = section.exam_session;
        if (!raw) {
            return undefined;
        }
        if (typeof raw === 'object') {
            return raw;
        }
        const sessionId = Number(raw);
        if (!Number.isFinite(sessionId) || sessionId <= 0) {
            return undefined;
        }
        const key = `exam-session:${sessionId}`;
        if (force) {
            this.cache.delete(key);
        }
        return this.cached(key, 10_000, () => this.api.getExamSession(sessionId));
    }

    private async getAccessForSection(section: Section, force: boolean = false): Promise<SectionAccess> {
        const session = await this.getSession(section, force);
        return getSectionAccess(section, this.selectedCourse, session);
    }

    async getSectionAccessById(
        sectionId: number,
        force: boolean = false
    ): Promise<{ section: Section; access: SectionAccess } | undefined> {
        const key = `section:${sectionId}`;
        if (force) {
            this.cache.delete(key);
        }
        const section = await this.cached(key, 15_000, () => this.api.getSection(sectionId));
        if (!section) {
            return undefined;
        }
        const access = await this.getAccessForSection(section, force);
        return { section, access };
    }

    async canSubmit(sectionId: number | undefined): Promise<{ ok: boolean; reason?: string }> {
        if (!sectionId) {
            return { ok: true };
        }
        const state = await this.getSectionAccessById(sectionId, true);
        if (!state) {
            return { ok: false, reason: 'Не удалось проверить доступ к секции.' };
        }
        return {
            ok: state.access.canSubmit,
            reason: state.access.reason || 'Отправка решений для этой секции сейчас недоступна.'
        };
    }

    private async getNavigationEntries(section: Section): Promise<StepContext[]> {
        const key = `navigation:${section.id}`;
        return this.cached(key, 60_000, async () => {
            const units = await this.cached(
                this.idsKey('units', section.units),
                60_000,
                () => this.api.getUnits(section.units)
            );
            const sortedUnits = units
                .filter(unit => unit.is_active !== false)
                .sort((a, b) => a.position - b.position);
            const lessons = await this.cached(
                this.idsKey('lessons', sortedUnits.map(unit => unit.lesson)),
                60_000,
                () => this.api.getLessons(sortedUnits.map(unit => unit.lesson))
            );
            const lessonMap = new Map(lessons.map(lesson => [lesson.id, lesson]));
            const allStepIds = sortedUnits.flatMap(unit => {
                const lesson = lessonMap.get(unit.lesson);
                return lesson ? lesson.steps : [];
            });
            const steps = await this.cached(
                this.idsKey('steps', allStepIds),
                60_000,
                () => this.api.getSteps(allStepIds)
            );
            const stepMap = new Map(steps.map(step => [step.id, step]));
            const entries: StepContext[] = [];

            for (const unit of sortedUnits) {
                const lesson = lessonMap.get(unit.lesson);
                if (!lesson) {
                    continue;
                }
                for (const stepId of lesson.steps) {
                    const step = stepMap.get(stepId);
                    if (!step) {
                        continue;
                    }
                    entries.push({
                        step,
                        courseName: this.selectedCourse?.title || '',
                        lessonTitle: lesson.title,
                        section,
                        sectionTitle: section.title,
                        unit,
                        unitId: unit.id
                    });
                }
            }

            entries.sort((left, right) => {
                const leftUnit = left.unit?.position ?? 0;
                const rightUnit = right.unit?.position ?? 0;
                if (leftUnit !== rightUnit) {
                    return leftUnit - rightUnit;
                }
                return left.step.position - right.step.position;
            });
            return entries;
        });
    }

    async getFirstStep(sectionId: number): Promise<StepContext | undefined> {
        const state = await this.getSectionAccessById(sectionId, true);
        if (!state) {
            return undefined;
        }
        const entries = await this.getNavigationEntries(state.section);
        return entries[0];
    }

    async getStepNeighbors(
        stepContext: StepContext
    ): Promise<{ previous?: StepContext; next?: StepContext }> {
        if (!stepContext.section) {
            return {};
        }
        const entries = await this.getNavigationEntries(stepContext.section);
        const index = entries.findIndex(entry => entry.step.id === stepContext.step.id);
        if (index < 0) {
            return {};
        }
        return {
            previous: index > 0 ? entries[index - 1] : undefined,
            next: index + 1 < entries.length ? entries[index + 1] : undefined
        };
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        switch (element.type) {
            case 'section':
                return this.createSectionItem(element);
            case 'lesson':
                return this.createLessonItem(element.lesson!, element.progressMap);
            case 'step':
                return this.createStepItem(element);
            case 'examAction':
                return this.createExamActionItem(element);
            case 'info':
                return this.createInfoItem(element);
            default:
                return new vscode.TreeItem('Неизвестный элемент');
        }
    }

    async getChildren(element?: TreeItemData): Promise<TreeItemData[]> {
        try {
            if (!element) {
                // Root - show selected course sections or prompt to select
                if (!this.selectedCourse) {
                    return [];
                }

                const course = this.selectedCourse;
                const sections = await this.cached(
                    this.idsKey(`sections:${course.id}`, course.sections),
                    30_000,
                    () => this.api.getSections(course.sections)
                );

                // Get progress for all sections
                const progressIds = sections.map(section => section.progress).filter(Boolean);
                const progressMap = await this.getProgressByIds(progressIds);

                const visibleSections = sections
                    .filter(section => section.is_active !== false)
                    .sort((a, b) => a.position - b.position);

                const items: TreeItemData[] = [];
                for (const section of visibleSections) {
                    let access: SectionAccess | undefined;
                    try {
                        access = await this.getAccessForSection(section);
                    } catch (error) {
                        // A failed exam-session request must not hide an
                        // ordinary section; fall back to the section fields.
                        this.logError(`Не удалось проверить доступ к секции ${section.id}`, error);
                    }
                    items.push({
                        type: 'section',
                        section,
                        courseName: course.title,
                        progressMap,
                        access
                    });
                }
                // Refresh the countdown only while an exam session is really
                // active. A finished session stays in `section.exam_session`
                // on some courses and used to keep the timer running forever.
                this.updateExamTimer(
                    items.some(item => Boolean(item.access?.examSession))
                );
                return items;
            }

            switch (element.type) {
                case 'section': {
                    const section = element.section!;
                    const access = element.access || (await this.getAccessForSection(section));

                    if (access.isExam && !access.examSession) {
                        if (access.canStartExam) {
                            return [{
                                type: 'examAction',
                                section,
                                courseName: element.courseName,
                                access
                            }];
                        }
                        return [{
                            type: 'info',
                            section,
                            courseName: element.courseName,
                            access,
                            infoText: access.reason || 'Экзамен недоступен',
                            infoIcon: 'lock'
                        }];
                    }

                    if (!access.canOpenStep) {
                        return [{
                            type: 'info',
                            section,
                            courseName: element.courseName,
                            access,
                            infoText: access.reason || 'Секция недоступна',
                            infoIcon: 'lock'
                        }];
                    }

                    // Show lessons via units
                    const units = await this.cached(
                        this.idsKey('units', section.units),
                        60_000,
                        () => this.api.getUnits(section.units)
                    );
                    const activeUnits = units.filter(unit => unit.is_active !== false);
                    const lessons = await this.cached(
                        this.idsKey('lessons', activeUnits.map(unit => unit.lesson)),
                        60_000,
                        () => this.api.getLessons(activeUnits.map(unit => unit.lesson))
                    );

                    // Get progress for all lessons
                    const progressIds = lessons.map(lesson => lesson.progress).filter(Boolean);
                    const progressMap = await this.getProgressByIds(progressIds);

                    const unitByLesson = new Map(activeUnits.map(unit => [unit.lesson, unit]));
                    return lessons
                        .sort((a, b) => {
                            const left = unitByLesson.get(a.id)?.position ?? 0;
                            const right = unitByLesson.get(b.id)?.position ?? 0;
                            return left - right;
                        })
                        .map(lesson => ({
                            type: 'lesson' as const,
                            lesson,
                            courseName: element.courseName,
                            section,
                            unit: unitByLesson.get(lesson.id),
                            access,
                            progressMap
                        }));
                }

                case 'lesson': {
                    // Show steps
                    const steps = await this.cached(
                        this.idsKey('steps', element.lesson!.steps),
                        60_000,
                        () => this.api.getSteps(element.lesson!.steps)
                    );

                    // Get progress for all steps
                    const progressIds = steps.map(step => step.progress).filter(Boolean);
                    const progressMap = await this.getProgressByIds(progressIds);

                    return steps
                        .sort((a, b) => a.position - b.position)
                        .map(step => ({
                            type: 'step' as const,
                            step,
                            courseName: element.courseName,
                            lessonTitle: element.lesson!.title,
                            section: element.section,
                            unit: element.unit,
                            progressMap
                        }));
                }

                default:
                    return [];
            }
        } catch (error) {
            this.handleTreeError(error);
            return [];
        }
    }

    private handleTreeError(error: unknown): void {
        const isAuthError =
            error instanceof StepikApiError && error.status === 401;
        if (isAuthError || String(error).includes('Not authenticated') || String(error).includes('Сессия Stepik')) {
            vscode.window.showWarningMessage(
                'Сессия Stepik истекла. Выполните вход заново.',
                'Войти'
            ).then(selection => {
                if (selection === 'Войти') {
                    vscode.commands.executeCommand('stepik.login');
                }
            });
            return;
        }
        this.logError('Ошибка загрузки данных Stepik', error);
        vscode.window.showErrorMessage(`Ошибка загрузки данных Stepik: ${error}`);
    }

    private logError(message: string, error: unknown): void {
        console.warn(`[Stepik] ${message}: ${error}`);
    }

    private updateExamTimer(hasActiveExam: boolean): void {
        if (hasActiveExam && !this.examRefreshTimer) {
            this.examRefreshTimer = setInterval(() => this.refresh(), 30_000);
        } else if (!hasActiveExam && this.examRefreshTimer) {
            clearInterval(this.examRefreshTimer);
            this.examRefreshTimer = undefined;
        }
    }

    private createSectionItem(element: TreeItemData): vscode.TreeItem {
        const section = element.section!;
        const access =
            element.access ||
            getSectionAccess(section, this.selectedCourse);
        const item = new vscode.TreeItem(
            section.title,
            vscode.TreeItemCollapsibleState.Collapsed
        );

        const progress = element.progressMap?.get(section.progress);

        if (access.isExam) {
            if (access.examSession) {
                item.iconPath = new vscode.ThemeIcon('watch', STATUS_STARTED);
            } else if (access.canStartExam) {
                item.iconPath = new vscode.ThemeIcon('play-circle', STATUS_STARTED);
            } else {
                item.iconPath = new vscode.ThemeIcon('lock', STATUS_LOCKED);
            }
        } else if (!access.canOpenStep) {
            item.iconPath = new vscode.ThemeIcon('lock', STATUS_LOCKED);
        } else if (progress) {
            if (progress.is_passed) {
                item.iconPath = new vscode.ThemeIcon('folder', STATUS_PASSED);
            } else if (progress.n_steps_passed > 0) {
                item.iconPath = new vscode.ThemeIcon('folder', STATUS_STARTED);
            } else {
                item.iconPath = new vscode.ThemeIcon('folder');
            }
        } else {
            item.iconPath = new vscode.ThemeIcon('folder');
        }

        item.description = access.description;
        item.tooltip = this.getSectionTooltip(section, access);
        item.contextValue = access.isExam ? 'examSection' : 'section';
        return item;
    }

    private getSectionTooltip(section: Section, access: SectionAccess): string {
        const lines: string[] = [section.title];
        if (access.isExam) {
            lines.push('Экзаменационная секция');
            if (access.examSession) {
                const timeLeft = getSessionTimeLeft(access.examSession);
                if (timeLeft !== undefined) {
                    lines.push(`Осталось: ${formatDuration(timeLeft)}`);
                }
                lines.push('Нажмите на секцию, чтобы продолжить экзамен.');
            } else if (access.canStartExam) {
                lines.push(`Длительность: ${section.exam_duration_minutes || 120} мин.`);
                lines.push('Раскройте секцию и нажмите «Начать экзамен».');
            } else if (access.reason) {
                lines.push(access.reason);
            }
        } else if (access.reason) {
            lines.push(access.reason);
        }
        return lines.join('\n');
    }

    private createLessonItem(lesson: Lesson, progressMap?: Map<string, Progress>): vscode.TreeItem {
        const item = new vscode.TreeItem(lesson.title, vscode.TreeItemCollapsibleState.Collapsed);

        // Lesson status based on progress
        const progress = progressMap?.get(lesson.progress);

        if (progress) {
            if (progress.is_passed) {
                item.iconPath = new vscode.ThemeIcon('file-text', STATUS_PASSED);
            } else if (progress.n_steps_passed > 0) {
                item.iconPath = new vscode.ThemeIcon('file-text', STATUS_STARTED);
            } else {
                item.iconPath = new vscode.ThemeIcon('file-text');
            }
        } else {
            item.iconPath = new vscode.ThemeIcon('file-text');
        }

        item.contextValue = 'lesson';
        return item;
    }

    private createStepItem(element: TreeItemData): vscode.TreeItem {
        const step = element.step!;
        const stepType = step.block.name;
        const label = `Шаг ${step.position}: ${getStepTypeLabel(stepType)}`;

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

        // Step status: passed = green (check local cache first, then API progress)
        const progress = element.progressMap?.get(step.progress);
        const isPassed = this.localPassedSteps.has(step.id) || progress?.is_passed || false;
        const iconName = this.getStepIconName(stepType);

        if (isPassed) {
            item.iconPath = new vscode.ThemeIcon(iconName, STATUS_PASSED);
        } else {
            item.iconPath = new vscode.ThemeIcon(iconName);
        }

        const context: StepContext = {
            step,
            courseName: element.courseName || '',
            lessonTitle: element.lessonTitle || '',
            section: element.section,
            sectionTitle: element.section?.title,
            unit: element.unit,
            unitId: element.unit?.id
        };

        item.contextValue = 'step';
        item.command = {
            command: 'stepik.openStep',
            title: 'Открыть шаг',
            arguments: [context]
        };
        return item;
    }

    private createExamActionItem(element: TreeItemData): vscode.TreeItem {
        const section = element.section!;
        const minutes = section.exam_duration_minutes || 120;
        const item = new vscode.TreeItem(
            '▶ Начать экзамен',
            vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon('play', STATUS_STARTED);
        item.description = `${minutes} мин`;
        item.tooltip = 'Создать экзаменационную сессию и открыть первый шаг.';
        item.contextValue = 'examAction';
        item.command = {
            command: 'stepik.startExam',
            title: 'Начать экзамен',
            arguments: [{ sectionId: section.id, sectionTitle: section.title }]
        };
        return item;
    }

    private createInfoItem(element: TreeItemData): vscode.TreeItem {
        const item = new vscode.TreeItem(
            element.infoText || 'Недоступно',
            vscode.TreeItemCollapsibleState.None
        );
        item.iconPath = new vscode.ThemeIcon(element.infoIcon || 'lock', STATUS_LOCKED);
        item.tooltip = element.access?.reason || element.infoText;
        item.contextValue = 'info';
        return item;
    }

    private getStepIconName(type: string): string {
        const icons: { [key: string]: string } = {
            'code': 'code',
            'choice': 'checklist',
            'text': 'book',
            'video': 'play-circle',
            'string': 'whole-word',
            'number': 'symbol-number'
        };
        return icons[type] || 'circle-outline';
    }
}
