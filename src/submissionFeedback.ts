/**
 * Stepik sometimes returns the same feedback text in both `hint` and
 * `feedback` (for example, the custom wrong-answer explanation of a choice
 * step). Showing both fields as-is makes the explanation appear twice.
 *
 * Fill-blanks steps return `feedback` as an object such as
 * `{ blanks_feedback: [true, false, ...] }`, not a string. Accept unknown
 * values here so a structured feedback never breaks the submission UI.
 */
function normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function toFeedbackText(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }
    if (typeof value === 'string') {
        return value.trim();
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    if (Array.isArray(value)) {
        return value
            .map(item => toFeedbackText(item))
            .filter(Boolean)
            .join('\n');
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        for (const key of ['text', 'message', 'content', 'feedback', 'hint']) {
            const nested = toFeedbackText(record[key]);
            if (nested) {
                return nested;
            }
        }
    }
    return '';
}

export function combineSubmissionFeedback(
    hint?: unknown,
    feedback?: unknown
): string {
    const hintText = toFeedbackText(hint);
    const feedbackText = toFeedbackText(feedback);

    if (!hintText) {
        return feedbackText;
    }
    if (!feedbackText) {
        return hintText;
    }
    if (normalize(hintText) === normalize(feedbackText)) {
        return hintText;
    }
    return `${hintText}\n${feedbackText}`;
}
