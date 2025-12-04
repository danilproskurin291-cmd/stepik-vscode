"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StepikApi = void 0;
const BASE_URL = 'https://stepik.org/api';
class StepikApi {
    auth;
    constructor(auth) {
        this.auth = auth;
    }
    async request(endpoint, options = {}) {
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
        return response.json();
    }
    async getCurrentUser() {
        const data = await this.request('/stepics/1');
        return { id: data.users[0].id };
    }
    async getUserCourses() {
        const user = await this.getCurrentUser();
        const data = await this.request(`/user-courses?user=${user.id}&page=1`);
        // Need to fetch full course details
        const courseIds = data['user-courses'].map(uc => uc.course);
        if (courseIds.length === 0) {
            return [];
        }
        const coursesData = await this.request(`/courses?ids[]=${courseIds.join('&ids[]=')}`);
        return coursesData.courses;
    }
    async getSections(sectionIds) {
        if (sectionIds.length === 0) {
            return [];
        }
        const data = await this.request(`/sections?ids[]=${sectionIds.join('&ids[]=')}`);
        return data.sections;
    }
    async getUnits(unitIds) {
        if (unitIds.length === 0) {
            return [];
        }
        const data = await this.request(`/units?ids[]=${unitIds.join('&ids[]=')}`);
        return data.units;
    }
    async getLessons(lessonIds) {
        if (lessonIds.length === 0) {
            return [];
        }
        const data = await this.request(`/lessons?ids[]=${lessonIds.join('&ids[]=')}`);
        return data.lessons;
    }
    async getStep(stepId) {
        const data = await this.request(`/steps/${stepId}`);
        return data.steps[0];
    }
    async getSteps(stepIds) {
        if (stepIds.length === 0) {
            return [];
        }
        const data = await this.request(`/steps?ids[]=${stepIds.join('&ids[]=')}`);
        return data.steps;
    }
    async createAttempt(stepId) {
        const data = await this.request('/attempts', {
            method: 'POST',
            body: JSON.stringify({
                attempt: {
                    step: stepId
                }
            })
        });
        return data.attempts[0];
    }
    async submitSolution(attemptId, language, code) {
        const data = await this.request('/submissions', {
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
    async getSubmission(submissionId) {
        const data = await this.request(`/submissions/${submissionId}`);
        return data.submissions[0];
    }
    async getStepProgress(stepId) {
        try {
            const data = await this.request(`/progresses/step-${stepId}`);
            return data.progresses[0] || null;
        }
        catch {
            return null;
        }
    }
}
exports.StepikApi = StepikApi;
//# sourceMappingURL=stepikApi.js.map