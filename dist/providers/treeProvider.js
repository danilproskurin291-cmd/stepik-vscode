"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StepikTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
class StepikTreeProvider {
    api;
    _onDidChangeTreeData = new vscode.EventEmitter();
    onDidChangeTreeData = this._onDidChangeTreeData.event;
    constructor(api) {
        this.api = api;
    }
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    getTreeItem(element) {
        switch (element.type) {
            case 'course':
                return this.createCourseItem(element.course);
            case 'section':
                return this.createSectionItem(element.section);
            case 'lesson':
                return this.createLessonItem(element.lesson);
            case 'step':
                return this.createStepItem(element.step, element.courseName, element.lessonTitle);
        }
    }
    async getChildren(element) {
        try {
            if (!element) {
                // Root - show courses
                const courses = await this.api.getUserCourses();
                return courses.map(course => ({ type: 'course', course }));
            }
            switch (element.type) {
                case 'course': {
                    // Show sections
                    const sections = await this.api.getSections(element.course.sections);
                    return sections
                        .sort((a, b) => a.position - b.position)
                        .map(section => ({
                        type: 'section',
                        section,
                        courseName: element.course.title
                    }));
                }
                case 'section': {
                    // Show lessons via units
                    const units = await this.api.getUnits(element.section.units);
                    const lessonIds = units.map(u => u.lesson);
                    const lessons = await this.api.getLessons(lessonIds);
                    // Sort by unit position
                    const unitPositions = new Map(units.map(u => [u.lesson, u.position]));
                    return lessons
                        .sort((a, b) => (unitPositions.get(a.id) || 0) - (unitPositions.get(b.id) || 0))
                        .map(lesson => ({
                        type: 'lesson',
                        lesson,
                        courseName: element.courseName
                    }));
                }
                case 'lesson': {
                    // Show steps
                    const steps = await this.api.getSteps(element.lesson.steps);
                    return steps
                        .sort((a, b) => a.position - b.position)
                        .map(step => ({
                        type: 'step',
                        step,
                        courseName: element.courseName,
                        lessonTitle: element.lesson.title
                    }));
                }
                default:
                    return [];
            }
        }
        catch (error) {
            if (String(error).includes('Not authenticated')) {
                vscode.window.showWarningMessage('Please login to Stepik first', 'Login')
                    .then((selection) => {
                    if (selection === 'Login') {
                        vscode.commands.executeCommand('stepik.login');
                    }
                });
            }
            else {
                vscode.window.showErrorMessage(`Error loading data: ${error}`);
            }
            return [];
        }
    }
    createCourseItem(course) {
        const item = new vscode.TreeItem(course.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('book');
        item.contextValue = 'course';
        return item;
    }
    createSectionItem(section) {
        const item = new vscode.TreeItem(section.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'section';
        return item;
    }
    createLessonItem(lesson) {
        const item = new vscode.TreeItem(lesson.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('file-text');
        item.contextValue = 'lesson';
        return item;
    }
    createStepItem(step, courseName, lessonTitle) {
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
    getStepTypeLabel(type) {
        const labels = {
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
    getStepIcon(type) {
        const icons = {
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
exports.StepikTreeProvider = StepikTreeProvider;
//# sourceMappingURL=treeProvider.js.map