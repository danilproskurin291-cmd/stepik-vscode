import { Section, Step, Unit } from './api/stepikApi';

/**
 * Everything the webview needs to render one step and to validate access to
 * its section. Keeping this in a shared module avoids a dependency cycle
 * between the tree provider and the webview.
 */
export interface StepContext {
    step: Step;
    courseName: string;
    lessonTitle: string;
    section?: Section;
    sectionTitle?: string;
    unit?: Unit;
    unitId?: number;
}
