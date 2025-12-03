import * as vscode from 'vscode';
import { StepikApi, Course, Lesson, Step, Section, Unit } from '../api/stepikApi';

type TreeItemType = 'course' | 'section' | 'lesson' | 'step';

interface TreeItemData {
    type: TreeItemType;
    course?: Course;
    section?: Section;
    lesson?: Lesson;
    step?: Step;
    courseName?: string;
    lessonTitle?: string;
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
                return this.createCourseItem(element.course!);
            case 'section':
                return this.createSectionItem(element.section!);
            case 'lesson':
                return this.createLessonItem(element.lesson!);
            case 'step':
                return this.createStepItem(element.step!, element.courseName!, element.lessonTitle!);
        }
    }

    async getChildren(element?: TreeItemData): Promise<TreeItemData[]> {
        try {
            if (!element) {
                // Root - show courses
                const courses = await this.api.getUserCourses();
                return courses.map(course => ({ type: 'course' as const, course }));
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
                    
                    // Sort by unit position
                    const unitPositions = new Map(units.map(u => [u.lesson, u.position]));
                    return lessons
                        .sort((a, b) => (unitPositions.get(a.id) || 0) - (unitPositions.get(b.id) || 0))
                        .map(lesson => ({ 
                            type: 'lesson' as const, 
                            lesson,
                            courseName: element.courseName
                        }));
                }

                case 'lesson': {
                    // Show steps
                    const steps = await this.api.getSteps(element.lesson!.steps);
                    return steps
                        .sort((a, b) => a.position - b.position)
                        .map(step => ({ 
                            type: 'step' as const, 
                            step,
                            courseName: element.courseName,
                            lessonTitle: element.lesson!.title
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

    private createCourseItem(course: Course): vscode.TreeItem {
        const item = new vscode.TreeItem(course.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('book');
        item.contextValue = 'course';
        return item;
    }

    private createSectionItem(section: Section): vscode.TreeItem {
        const item = new vscode.TreeItem(section.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'section';
        return item;
    }

    private createLessonItem(lesson: Lesson): vscode.TreeItem {
        const item = new vscode.TreeItem(lesson.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('file-text');
        item.contextValue = 'lesson';
        return item;
    }

    private createStepItem(step: Step, courseName: string, lessonTitle: string): vscode.TreeItem {
        const stepType = step.block.name;
        const label = `Step ${step.position}: ${this.getStepTypeLabel(stepType)}`;
        
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = this.getStepIcon(stepType);
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
}
