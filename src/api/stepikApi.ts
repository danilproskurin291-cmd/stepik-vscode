import { StepikAuth } from '../auth';

const BASE_URL = 'https://stepik.org/api';

export interface Course {
    id: number;
    title: string;
    sections: number[];
    is_certificate_issued?: boolean;
    progress: string;  // progress ID like "course-12345"
}

export interface Progress {
    id: string;
    is_passed: boolean;
    n_steps: number;
    n_steps_passed: number;
    score: string;
    cost: number;
}

export interface Section {
    id: number;
    title: string;
    units: number[];
    course: number;
    position: number;
    progress: string;  // progress ID
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
    progress: string;  // progress ID like "lesson-12345"
}

export interface ChoiceOption {
    text: string;
    is_correct?: boolean;
}

export interface Step {
    id: number;
    lesson: number;
    position: number;
    status: string;
    progress: string;  // progress ID like "step-12345"
    block: {
        name: string;
        text: string;
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
        };
    };
}

export interface Attempt {
    id: number;
    step: number;
    dataset?: {
        is_multiple_choice?: boolean;
        options?: string[];
    };
}

export interface Submission {
    id: number;
    status: string;
    score: number;
    hint: string;
    feedback: string;
}

export interface QuizReply {
    choices?: boolean[];  // For choice/multichoice
    text?: string;        // For string
    number?: string;      // For number
}

export class StepikApi {
    constructor(private auth: StepikAuth) {}

    private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
        const token = await this.auth.getToken();
        if (!token) {
            throw new Error('Not authenticated. Please login first.');
        }

        const response = await fetch(`${BASE_URL}${endpoint}`, {
            ...options,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<T>;
    }

    async getCurrentUser(): Promise<{ id: number }> {
        const data = await this.request<{ users: Array<{ id: number }> }>('/stepics/1');
        return { id: data.users[0].id };
    }

    async getUserCourses(): Promise<Course[]> {
        const user = await this.getCurrentUser();
        const data = await this.request<{ 
            'user-courses': Array<{ course: number }>;
            courses: Course[];
        }>(`/user-courses?user=${user.id}&page=1`);
        
        // Need to fetch full course details
        const courseIds = data['user-courses'].map(uc => uc.course);
        if (courseIds.length === 0) {
            return [];
        }
        
        const coursesData = await this.request<{ courses: Course[] }>(
            `/courses?ids[]=${courseIds.join('&ids[]=')}`
        );
        return coursesData.courses;
    }

    async getSections(sectionIds: number[]): Promise<Section[]> {
        if (sectionIds.length === 0) {
            return [];
        }
        const data = await this.request<{ sections: Section[] }>(
            `/sections?ids[]=${sectionIds.join('&ids[]=')}`
        );
        return data.sections;
    }

    async getUnits(unitIds: number[]): Promise<Unit[]> {
        if (unitIds.length === 0) {
            return [];
        }
        const data = await this.request<{ units: Unit[] }>(
            `/units?ids[]=${unitIds.join('&ids[]=')}`
        );
        return data.units;
    }

    async getLessons(lessonIds: number[]): Promise<Lesson[]> {
        if (lessonIds.length === 0) {
            return [];
        }
        const data = await this.request<{ lessons: Lesson[] }>(
            `/lessons?ids[]=${lessonIds.join('&ids[]=')}`
        );
        return data.lessons;
    }

    async getStep(stepId: number): Promise<Step> {
        const data = await this.request<{ steps: Step[] }>(`/steps/${stepId}`);
        return data.steps[0];
    }

    async getSteps(stepIds: number[]): Promise<Step[]> {
        if (stepIds.length === 0) {
            return [];
        }
        const data = await this.request<{ steps: Step[] }>(
            `/steps?ids[]=${stepIds.join('&ids[]=')}`
        );
        return data.steps;
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
        return data.attempts[0];
    }

    async getAttempt(stepId: number): Promise<Attempt> {
        const data = await this.request<{ attempts: Attempt[] }>(`/attempts?step=${stepId}&user=me`);
        if (data.attempts.length > 0) {
            return data.attempts[0];
        }
        return this.createAttempt(stepId);
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
        return data.submissions[0];
    }

    async getSubmission(submissionId: number): Promise<Submission> {
        const data = await this.request<{ submissions: Submission[] }>(
            `/submissions/${submissionId}`
        );
        return data.submissions[0];
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
            const idsQuery = validIds.map(id => `ids[]=${id}`).join('&');
            const data = await this.request<{ progresses: Progress[] }>(
                `/progresses?${idsQuery}`
            );
            for (const progress of data.progresses) {
                result.set(progress.id, progress);
            }
        } catch {
            // Ignore errors
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
            const ids = stepIds.map(id => `step-${id}`).join('&ids[]=');
            const data = await this.request<{ progresses: Array<{ id: string; is_passed: boolean }> }>(
                `/progresses?ids[]=${ids}`
            );
            for (const progress of data.progresses) {
                const stepId = parseInt(progress.id.replace('step-', ''));
                result.set(stepId, progress.is_passed);
            }
        } catch {
            // Ignore errors
        }
        return result;
    }

    async getCourseProgress(courseId: number): Promise<Progress | null> {
        try {
            const data = await this.request<{ progresses: Progress[] }>(
                `/progresses/course-${courseId}`
            );
            return data.progresses[0] || null;
        } catch {
            return null;
        }
    }
}
