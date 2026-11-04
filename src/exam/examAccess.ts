import { Course, ExamSession, Section } from '../api/stepikApi';
import { t } from '../i18n';

export interface SectionAccess {
    isExam: boolean;
    isActive: boolean;
    isStarted: boolean;
    isFinished: boolean;
    isHardDeadlinePassed: boolean;
    isSoftDeadlinePassed: boolean;
    requirementsSatisfied: boolean;
    canStartExam: boolean;
    canOpenStep: boolean;
    canSubmit: boolean;
    examSession?: ExamSession;
    examFinished: boolean;
    reason?: string;
    description?: string;
    beginDate?: Date;
    endDate?: Date;
    softDeadline?: Date;
    hardDeadline?: Date;
}

function parseDate(value?: string | null): Date | undefined {
    if (!value) {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function effectiveDate(
    sectionValue?: string | null,
    courseValue?: string | null
): Date | undefined {
    return parseDate(sectionValue) || parseDate(courseValue);
}

function formatDate(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

export function formatDuration(totalSeconds: number): string {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    }
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function isExamSessionActive(
    session: ExamSession | undefined,
    now: number = Date.now()
): boolean {
    if (!session) {
        return false;
    }
    const endDate = parseDate(session.end_date);
    if (endDate) {
        // The deadline is authoritative. `time_left` is a snapshot from the
        // moment the session was fetched and may still be positive after the
        // deadline, so it must not keep a finished exam open.
        return endDate.getTime() > now;
    }
    return typeof session.time_left === 'number' && session.time_left > 0;
}

export function getSessionTimeLeft(
    session: ExamSession | undefined,
    now: number = Date.now()
): number | undefined {
    if (!session) {
        return undefined;
    }
    const endDate = parseDate(session.end_date);
    if (endDate) {
        return Math.max(0, Math.floor((endDate.getTime() - now) / 1000));
    }
    if (typeof session.time_left === 'number') {
        return Math.max(0, Math.floor(session.time_left));
    }
    return undefined;
}

export function getSectionAccess(
    section: Section,
    course?: Course,
    session?: ExamSession,
    now: number = Date.now()
): SectionAccess {
    const beginDate = effectiveDate(section.begin_date, course?.begin_date);
    const endDate = effectiveDate(section.end_date, course?.end_date);
    const softDeadline = effectiveDate(section.soft_deadline, course?.soft_deadline);
    const hardDeadline = effectiveDate(section.hard_deadline, course?.hard_deadline);

    const isActive = section.is_active !== false;
    const isStarted = !beginDate || beginDate.getTime() <= now;
    const isFinished = Boolean(endDate && endDate.getTime() <= now);
    const isHardDeadlinePassed = Boolean(hardDeadline && hardDeadline.getTime() <= now);
    const isSoftDeadlinePassed = Boolean(softDeadline && softDeadline.getTime() <= now);
    const requirementsSatisfied = section.is_requirement_satisfied !== false;
    const isExam = section.is_exam === true;
    const examSession = isExamSessionActive(session, now) ? session : undefined;
    const examFinished = isExam && Boolean(session) && !examSession;

    const canStartExam = Boolean(
        isExam &&
        !examSession &&
        !examFinished &&
        isActive &&
        isStarted &&
        !isFinished &&
        !isHardDeadlinePassed &&
        (requirementsSatisfied || section.is_exam_without_progress === true)
    );

    let reason: string | undefined;
    if (!isActive) {
        reason = t('exam.sectionHidden');
    } else if (isFinished) {
        reason = endDate
            ? t('exam.sectionClosedAt', { date: formatDate(endDate) })
            : t('exam.sectionClosed');
    } else if (isHardDeadlinePassed) {
        reason = hardDeadline
            ? t('exam.deadlinePassedAt', { date: formatDate(hardDeadline) })
            : t('exam.deadlinePassed');
    } else if (!isStarted && beginDate) {
        reason = t('exam.sectionOpensAt', { date: formatDate(beginDate) });
    } else if (!requirementsSatisfied) {
        const percent = section.required_percent;
        reason = percent
            ? t('exam.requirementPercent', { percent })
            : t('exam.requirement');
    } else if (isExam && !examSession) {
        reason = examFinished
            ? t('exam.finishedNoRestart')
            : t('exam.notStarted');
    }

    let description: string | undefined;
    if (isExam) {
        if (examSession) {
            const timeLeft = getSessionTimeLeft(examSession, now);
            description = timeLeft !== undefined
                ? t('exam.timeLeft', { time: formatDuration(timeLeft) })
                : t('exam.inProgress');
        } else if (canStartExam) {
            description = t('exam.duration', {
                minutes: section.exam_duration_minutes || 120
            });
        } else if (examFinished) {
            description = t('exam.finished');
        } else {
            description = t('exam.unavailable');
        }
    } else if (isHardDeadlinePassed) {
        description = t('exam.expired');
    } else if (isSoftDeadlinePassed) {
        description = t('exam.softDeadlinePassed');
    } else if (!requirementsSatisfied) {
        description = t('exam.requirementShort');
    }

    const canOpenStep = Boolean(
        isActive &&
        isStarted &&
        !isFinished &&
        !isHardDeadlinePassed &&
        requirementsSatisfied &&
        (!isExam || Boolean(examSession))
    );

    const canSubmit = Boolean(
        isActive &&
        isStarted &&
        !isFinished &&
        !isHardDeadlinePassed &&
        requirementsSatisfied &&
        (!isExam || Boolean(examSession))
    );

    return {
        isExam,
        isActive,
        isStarted,
        isFinished,
        isHardDeadlinePassed,
        isSoftDeadlinePassed,
        requirementsSatisfied,
        canStartExam,
        canOpenStep,
        canSubmit,
        examSession,
        examFinished,
        reason,
        description,
        beginDate,
        endDate,
        softDeadline,
        hardDeadline
    };
}
