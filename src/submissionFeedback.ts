/**
 * Stepik sometimes returns the same feedback text in both `hint` and
 * `feedback` (for example, the custom wrong-answer explanation of a choice
 * step). Showing both fields as-is makes the explanation appear twice.
 */
function normalize(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

export function combineSubmissionFeedback(
    hint?: string | null,
    feedback?: string | null
): string {
    const hintText = (hint || '').trim();
    const feedbackText = (feedback || '').trim();

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
