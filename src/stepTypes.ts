import { t } from './i18n';

/**
 * Human-readable names for Stepik step block types.
 *
 * Stepik exposes the type as an English slug in `step.block.name`. The tree
 * and the task panel must use the same localized labels, otherwise adding a
 * new type in one place leaves it untranslated in the other.
 */
const STEP_TYPE_KEYS: { [key: string]: string } = {
    'text': 'stepType.text',
    'video': 'stepType.video',
    'choice': 'stepType.choice',
    'string': 'stepType.string',
    'number': 'stepType.number',
    'math': 'stepType.math',
    'free-answer': 'stepType.freeAnswer',
    'sorting': 'stepType.sorting',
    'matching': 'stepType.matching',
    'table': 'stepType.table',
    'fill-blanks': 'stepType.fillBlanks',
    'sql': 'stepType.sql',
    'html': 'stepType.html',
    'dataset': 'stepType.dataset',
    'chemical': 'stepType.chemical',
    'puzzle': 'stepType.puzzle',
    'code': 'stepType.code',
    'random-tasks': 'stepType.randomTasks',
    'parsons': 'stepType.parsons',
    'pycharm': 'stepType.pycharm',
    'linux-code': 'stepType.linux',
    'schulte': 'stepType.schulte',
    'trik': 'stepType.trik',
    'external-grader': 'stepType.externalGrader',
    'lti-consumer': 'stepType.lti',
    'manual-score': 'stepType.manualScore',
    'admin': 'stepType.admin'
};

export function getStepTypeLabel(type: string): string {
    const key = STEP_TYPE_KEYS[type];
    return key ? t(key) : type;
}

/** Same label with a capital first letter, for badges and headings. */
export function getStepTypeTitle(type: string): string {
    const label = getStepTypeLabel(type);
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}
