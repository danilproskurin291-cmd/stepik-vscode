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

    constructor(private api: StepikApi) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItemData): vscode.TreeItem {
        switch (element.type) {
            case 'course':
                return this.createCourseItem(element.course!, element.courseProgress);
            case 'section':
                return this.createSectionItem(element.section!);
            case 'lesson':
                return this.createLessonItem(element.lesson!, element.progressMap);
            case 'step':
                return this.createStepItem(element.step!, element.courseName!, element.lessonTitle!, element.progressMap);
        }
    }

    async getChildren(element?: TreeItemData): Promise<TreeItemData[]> {
        try {
            if (!element) {
                // Root - show courses with their progress
                const courses = await this.api.getUserCourses();
                
                // Get progress for all courses
                const progressIds = courses.map(c => c.progress).filter(p => p);
                const progressMap = await this.api.getProgressByIds(progressIds);
                
                return courses.map(course => ({ 
                    type: 'course' as const, 
                    course,
                    courseProgress: progressMap.get(course.progress)
                }));
            }

            switch (element.type) {
                case 'course': {
                    // Show sections
                    const sections = await this.api.getSections(element.course!.sections);
                    return sections
                        .sort((a, b) => a.position - b.position)
                        .map(section => ({ 
                            type: 'section' as const, 
                            section,
                            courseName: element.course!.title 
                        }));
                }

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

    private createCourseItem(course: Course, courseProgress?: Progress): vscode.TreeItem {
        const item = new vscode.TreeItem(course.title, vscode.TreeItemCollapsibleState.Collapsed);
        
        // Course status: certificate/passed = green, started (n_steps_passed > 0) = yellow, not started = default
        if (course.is_certificate_issued || courseProgress?.is_passed) {
            item.iconPath = new vscode.ThemeIcon('book', STATUS_PASSED);
        } else if (courseProgress && courseProgress.n_steps_passed > 0) {
            item.iconPath = new vscode.ThemeIcon('book', STATUS_STARTED);
        } else {
            item.iconPath = new vscode.ThemeIcon('book');
        }
        item.contextValue = 'course';
        return item;
    }

    private createSectionItem(section: Section): vscode.TreeItem {
        const item = new vscode.TreeItem(section.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
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
        
        // Step status: passed = green, not passed = default
        const progress = progressMap?.get(step.progress);
        const isPassed = progress?.is_passed || false;
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
