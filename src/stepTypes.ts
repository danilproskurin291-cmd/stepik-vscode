/**
 * Human-readable names for Stepik step block types.
 *
 * Stepik exposes the type as an English slug in `step.block.name`. The tree
 * and the task panel must use the same Russian labels, otherwise adding a new
 * type in one place leaves it untranslated in the other.
 */
const STEP_TYPE_LABELS: { [key: string]: string } = {
    'text': 'текст',
    'video': 'видео',
    'choice': 'тест',
    'string': 'короткий ответ',
    'number': 'число',
    'math': 'формула',
    'free-answer': 'развёрнутый ответ',
    'sorting': 'сортировка',
    'matching': 'сопоставление',
    'table': 'таблица',
    'fill-blanks': 'пропуски',
    'sql': 'SQL-запрос',
    'html': 'HTML/CSS',
    'dataset': 'файл данных',
    'chemical': 'химическая формула',
    'puzzle': 'пазл',
    'code': 'код',
    'random-tasks': 'случайные задания',
    'parsons': 'задача Парсонса',
    'pycharm': 'задача PyCharm',
    'linux-code': 'задача Linux',
    'schulte': 'таблица Шульте',
    'trik': 'задача ТРИК',
    'external-grader': 'внешняя проверка',
    'lti-consumer': 'внешний курс LTI',
    'manual-score': 'ручная проверка',
    'admin': 'служебное задание'
};

export function getStepTypeLabel(type: string): string {
    return STEP_TYPE_LABELS[type] || type;
}

/** Same label with a capital first letter, for badges and headings. */
export function getStepTypeTitle(type: string): string {
    const label = getStepTypeLabel(type);
    return label ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}
