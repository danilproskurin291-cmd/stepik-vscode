import { StepikAuth } from '../auth';
export interface Course {
    id: number;
    title: string;
    sections: number[];
}
export interface Section {
    id: number;
    title: string;
    units: number[];
    course: number;
    position: number;
}
export interface Unit {
    id: number;
    lesson: number;
    section: number;
    position: number;
}
export interface Lesson {
    id: number;
    title: string;
    steps: number[];
}
export interface Step {
    id: number;
    lesson: number;
    position: number;
    status: string;
    block: {
        name: string;
        text: string;
        options?: {
            code_templates?: {
                [key: string]: string;
            };
            limits?: {
                [key: string]: {
                    time: number;
                    memory: number;
                };
            };
            samples?: Array<[string, string]>;
        };
    };
}
export interface Submission {
    id: number;
    status: string;
    score: number;
    hint: string;
    feedback: string;
}
export declare class StepikApi {
    private auth;
    constructor(auth: StepikAuth);
    private request;
    getCurrentUser(): Promise<{
        id: number;
    }>;
    getUserCourses(): Promise<Course[]>;
    getSections(sectionIds: number[]): Promise<Section[]>;
    getUnits(unitIds: number[]): Promise<Unit[]>;
    getLessons(lessonIds: number[]): Promise<Lesson[]>;
    getStep(stepId: number): Promise<Step>;
    getSteps(stepIds: number[]): Promise<Step[]>;
    createAttempt(stepId: number): Promise<{
        id: number;
    }>;
    submitSolution(attemptId: number, language: string, code: string): Promise<Submission>;
    getSubmission(submissionId: number): Promise<Submission>;
    getStepProgress(stepId: number): Promise<{
        is_passed: boolean;
    } | null>;
}
//# sourceMappingURL=stepikApi.d.ts.map