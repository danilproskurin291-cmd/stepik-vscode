import * as vscode from 'vscode';
import { StepikApi, Course, Lesson, Step, Section, Unit, Progress } from '../api/stepikApi';

type TreeItemType = 'course' | 'section' | 'lesson' | 'step';

// Status colors
const STATUS_PASSED = new vscode.ThemeColor('charts.green');
const STATUS_STARTED = new vscode.ThemeColor('charts.yellow');

interface TreeItemData {
    type: TreeItemType;
    course?: Course;
    section?: Section;
    lesson?: Lesson;
    step?: Step;
    courseName?: string;
    lessonTitle?: string;
    progressMap?: Map<string, Progress>;  // Map of progress ID to Progress
    courseProgress?: Progress;  // For course status
}

export class StepikTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItemData | undefined | null | void> = 
        new vscode.EventEmitter<TreeItemData | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItemData | undefined | null | void> = 
        this._onDidChangeTreeData.event;

    private selectedCourse: Course | undefined;
    private localPassedSteps: Set<number> = new Set();  // Locally marked as passed (before API refresh)

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
            description: `${course.sections.length} sections`,
            course
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a course',
            title: 'Stepik: Select Course'
        });

        if (selected) {
            this.selectedCourse = selected.course;
            await this.context.globalState.update('selectedCourseId', selected.course.id);
            this.refresh();
        }
    }

    getSelectedCourse(): Course | undefined {
        return this.selectedCourse;
    }

    clearCourseSelection(): void {
        this.selectedCourse = undefined;
        this.context.globalState.update('selectedCourseId', undefined);
        this.refresh();
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

    // Force full refresh by firing event for root
    forceRefresh(): void {
        this.clearLocalPassedSteps();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        switch (element.type) {
            case 'section':
                return this.createSectionItem(element.section!, element.progressMap);
            case 'lesson':
                return this.createLessonItem(element.lesson!, element.progressMap);
            case 'step':
                return this.createStepItem(element.step!, element.courseName!, element.lessonTitle!, element.progressMap);
            default:
                return new vscode.TreeItem('Unknown');
        }
    }

    async getChildren(element?: TreeItemData): Promise<TreeItemData[]> {
        try {
            if (!element) {
                // Root - show selected course sections or prompt to select
                if (!this.selectedCourse) {
                    // No course selected - show message item
                    return [];
                }

                // Show sections of selected course with their progress
                const sections = await this.api.getSections(this.selectedCourse.sections);
                
                // Get progress for all sections
                const progressIds = sections.map(s => s.progress).filter(p => p);
                const progressMap = await this.api.getProgressByIds(progressIds);
                
                return sections
                    .sort((a, b) => a.position - b.position)
                    .map(section => ({ 
                        type: 'section' as const, 
                        section,
                        courseName: this.selectedCourse!.title,
                        progressMap
                    }));
            }

            switch (element.type) {
                case 'section': {
                    // Show lessons via units
                    const units = await this.api.getUnits(element.section!.units);
                    const lessonIds = units.map(u => u.lesson);
                    const lessons = await this.api.getLessons(lessonIds);
                    
                    // Get progress for all lessons
                    const progressIds = lessons.map(l => l.progress).filter(p => p);
                    const progressMap = await this.api.getProgressByIds(progressIds);
                    
                    // Sort by unit position
                    const unitPositions = new Map(units.map(u => [u.lesson, u.position]));
                    return lessons
                        .sort((a, b) => (unitPositions.get(a.id) || 0) - (unitPositions.get(b.id) || 0))
                        .map(lesson => ({ 
                            type: 'lesson' as const, 
                            lesson,
                            courseName: element.courseName,
                            progressMap
                        }));
                }

                case 'lesson': {
                    // Show steps
                    const steps = await this.api.getSteps(element.lesson!.steps);
                    
                    // Get progress for all steps
                    const progressIds = steps.map(s => s.progress).filter(p => p);
                    const progressMap = await this.api.getProgressByIds(progressIds);
                    
                    return steps
                        .sort((a, b) => a.position - b.position)
                        .map(step => ({ 
                            type: 'step' as const, 
                            step,
                            courseName: element.courseName,
                            lessonTitle: element.lesson!.title,
                            progressMap
                        }));
                }

                default:
                    return [];
            }
        } catch (error) {
            if (String(error).includes('Not authenticated')) {
                vscode.window.showWarningMessage('Please login to Stepik first', 'Login')
                    .then((selection: string | undefined) => {
                        if (selection === 'Login') {
                            vscode.commands.executeCommand('stepik.login');
                        }
                    });
            } else {
                vscode.window.showErrorMessage(`Error loading data: ${error}`);
            }
            return [];
        }
    }

    private createSectionItem(section: Section, progressMap?: Map<string, Progress>): vscode.TreeItem {
        const item = new vscode.TreeItem(section.title, vscode.TreeItemCollapsibleState.Collapsed);
        
        // Section status based on progress
        const progress = progressMap?.get(section.progress);
        
        if (progress) {
            if (progress.is_passed) {
                // All lessons passed = green
                item.iconPath = new vscode.ThemeIcon('folder', STATUS_PASSED);
            } else if (progress.n_steps_passed > 0) {
                // At least one step passed = yellow
                item.iconPath = new vscode.ThemeIcon('folder', STATUS_STARTED);
            } else {
                // None passed = default
                item.iconPath = new vscode.ThemeIcon('folder');
            }
        } else {
            item.iconPath = new vscode.ThemeIcon('folder');
        }
        
        item.contextValue = 'section';
        return item;
    }

    private createLessonItem(lesson: Lesson, progressMap?: Map<string, Progress>): vscode.TreeItem {
        const item = new vscode.TreeItem(lesson.title, vscode.TreeItemCollapsibleState.Collapsed);
        
        // Lesson status based on progress
        const progress = progressMap?.get(lesson.progress);
        
        if (progress) {
            if (progress.is_passed) {
                // All steps passed = green
                item.iconPath = new vscode.ThemeIcon('file-text', STATUS_PASSED);
            } else if (progress.n_steps_passed > 0) {
                // At least one step passed = yellow
                item.iconPath = new vscode.ThemeIcon('file-text', STATUS_STARTED);
            } else {
                // None passed = default
                item.iconPath = new vscode.ThemeIcon('file-text');
            }
        } else {
            item.iconPath = new vscode.ThemeIcon('file-text');
        }
        
        item.contextValue = 'lesson';
        return item;
    }

    private createStepItem(step: Step, courseName: string, lessonTitle: string, progressMap?: Map<string, Progress>): vscode.TreeItem {
        const stepType = step.block.name;
        const label = `Step ${step.position}: ${this.getStepTypeLabel(stepType)}`;
        
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        
        // Step status: passed = green (check local cache first, then API progress)
        const progress = progressMap?.get(step.progress);
        const isPassed = this.localPassedSteps.has(step.id) || progress?.is_passed || false;
        const iconName = this.getStepIconName(stepType);
        
        if (isPassed) {
            item.iconPath = new vscode.ThemeIcon(iconName, STATUS_PASSED);
        } else {
            item.iconPath = new vscode.ThemeIcon(iconName);
        }
        
        item.contextValue = 'step';
        item.command = {
            command: 'stepik.openStep',
            title: 'Open Step',
            arguments: [{ step, courseName, lessonTitle }]
        };
        return item;
    }

    private getStepTypeLabel(type: string): string {
        const labels: { [key: string]: string } = {
            'code': 'Code',
            'choice': 'Quiz',
            'text': 'Text',
            'string': 'Short Answer',
            'number': 'Number',
            'math': 'Math',
            'sorting': 'Sorting',
            'matching': 'Matching',
            'fill-blanks': 'Fill Blanks',
            'free-answer': 'Free Answer',
            'video': 'Video'
        };
        return labels[type] || type;
    }

    private getStepIcon(type: string): vscode.ThemeIcon {
        const icons: { [key: string]: string } = {
            'code': 'code',
            'choice': 'checklist',
            'text': 'book',
            'video': 'play-circle',
            'string': 'whole-word',
            'number': 'symbol-number'
        };
        return new vscode.ThemeIcon(icons[type] || 'circle-outline');
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
