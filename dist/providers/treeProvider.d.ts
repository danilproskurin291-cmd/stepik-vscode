import * as vscode from 'vscode';
import { StepikApi, Course, Lesson, Step, Section } from '../api/stepikApi';
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
export declare class StepikTreeProvider implements vscode.TreeDataProvider<TreeItemData> {
    private api;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<TreeItemData | undefined | null | void>;
    constructor(api: StepikApi);
    refresh(): void;
    getTreeItem(element: TreeItemData): vscode.TreeItem;
    getChildren(element?: TreeItemData): Promise<TreeItemData[]>;
    private createCourseItem;
    private createSectionItem;
    private createLessonItem;
    private createStepItem;
    private getStepTypeLabel;
    private getStepIcon;
}
export {};
//# sourceMappingURL=treeProvider.d.ts.map