"use strict";var U=Object.create;var k=Object.defineProperty;var W=Object.getOwnPropertyDescriptor;var V=Object.getOwnPropertyNames;var K=Object.getPrototypeOf,J=Object.prototype.hasOwnProperty;var Y=(c,e)=>{for(var t in e)k(c,t,{get:e[t],enumerable:!0})},z=(c,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of V(e))!J.call(c,i)&&i!==t&&k(c,i,{get:()=>e[i],enumerable:!(s=W(e,i))||s.enumerable});return c};var l=(c,e,t)=>(t=c!=null?U(K(c)):{},z(e||!c||!c.__esModule?k(t,"default",{value:c,enumerable:!0}):t,c)),G=c=>z(k({},"__esModule",{value:!0}),c);var se={};Y(se,{activate:()=>ee,deactivate:()=>te});module.exports=G(se);var d=l(require("vscode")),L=l(require("fs")),O=l(require("path")),N=l(require("os"));var f=l(require("vscode")),_="stepik.clientId",D="stepik.clientSecret",y="stepik.accessToken",x=class{secretStorage;constructor(e){this.secretStorage=e.secrets}async login(){let e=await f.window.showInputBox({prompt:"Enter your Stepik Client ID",placeHolder:"Client ID from https://stepik.org/oauth2/applications/",ignoreFocusOut:!0});if(!e)return!1;let t=await f.window.showInputBox({prompt:"Enter your Stepik Client Secret",placeHolder:"Client Secret",password:!0,ignoreFocusOut:!0});if(!t)return!1;try{let s=await this.getAccessToken(e,t);return await this.secretStorage.store(_,e),await this.secretStorage.store(D,t),await this.secretStorage.store(y,s),f.window.showInformationMessage("Successfully logged in to Stepik!"),!0}catch(s){return f.window.showErrorMessage(`Failed to login: ${s}`),!1}}async getAccessToken(e,t){let s=Buffer.from(`${e}:${t}`).toString("base64"),i=await fetch("https://stepik.org/oauth2/token/",{method:"POST",headers:{Authorization:`Basic ${s}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});if(!i.ok)throw new Error(`HTTP ${i.status}: ${i.statusText}`);return(await i.json()).access_token}async logout(){await this.secretStorage.delete(_),await this.secretStorage.delete(D),await this.secretStorage.delete(y),f.window.showInformationMessage("Logged out from Stepik")}async isLoggedIn(){return!!await this.secretStorage.get(y)}async getToken(){return await this.secretStorage.get(y)}};var n=l(require("vscode")),q=new n.ThemeColor("charts.green"),B=new n.ThemeColor("charts.yellow"),C=class{constructor(e,t){this.api=e;this.context=t;this.restoreSelectedCourse()}_onDidChangeTreeData=new n.EventEmitter;onDidChangeTreeData=this._onDidChangeTreeData.event;selectedCourse;localPassedSteps=new Set;async restoreSelectedCourse(){let e=this.context.globalState.get("selectedCourseId");if(e)try{let t=await this.api.getCourse(e);t&&(this.selectedCourse=t,this.refresh())}catch{this.context.globalState.update("selectedCourseId",void 0)}}async selectCourse(){let t=(await this.api.getUserCourses()).map(i=>({label:i.title,description:`${i.sections.length} sections`,course:i})),s=await n.window.showQuickPick(t,{placeHolder:"Select a course",title:"Stepik: Select Course"});s&&(this.selectedCourse=s.course,await this.context.globalState.update("selectedCourseId",s.course.id),this.refresh())}getSelectedCourse(){return this.selectedCourse}clearCourseSelection(){this.selectedCourse=void 0,this.context.globalState.update("selectedCourseId",void 0),this.refresh()}markStepAsPassed(e){this.localPassedSteps.add(e)}clearLocalPassedSteps(){this.localPassedSteps.clear()}refresh(){this._onDidChangeTreeData.fire()}forceRefresh(){this.clearLocalPassedSteps(),this._onDidChangeTreeData.fire(void 0)}getTreeItem(e){switch(e.type){case"section":return this.createSectionItem(e.section,e.progressMap);case"lesson":return this.createLessonItem(e.lesson,e.progressMap);case"step":return this.createStepItem(e.step,e.courseName,e.lessonTitle,e.progressMap);default:return new n.TreeItem("Unknown")}}async getChildren(e){try{if(!e){if(!this.selectedCourse)return[];let t=await this.api.getSections(this.selectedCourse.sections),s=t.map(o=>o.progress).filter(o=>o),i=await this.api.getProgressByIds(s);return t.sort((o,r)=>o.position-r.position).map(o=>({type:"section",section:o,courseName:this.selectedCourse.title,progressMap:i}))}switch(e.type){case"section":{let t=await this.api.getUnits(e.section.units),s=t.map(p=>p.lesson),i=await this.api.getLessons(s),o=i.map(p=>p.progress).filter(p=>p),r=await this.api.getProgressByIds(o),a=new Map(t.map(p=>[p.lesson,p.position]));return i.sort((p,h)=>(a.get(p.id)||0)-(a.get(h.id)||0)).map(p=>({type:"lesson",lesson:p,courseName:e.courseName,progressMap:r}))}case"lesson":{let t=await this.api.getSteps(e.lesson.steps),s=t.map(o=>o.progress).filter(o=>o),i=await this.api.getProgressByIds(s);return t.sort((o,r)=>o.position-r.position).map(o=>({type:"step",step:o,courseName:e.courseName,lessonTitle:e.lesson.title,progressMap:i}))}default:return[]}}catch(t){return String(t).includes("Not authenticated")?n.window.showWarningMessage("Please login to Stepik first","Login").then(s=>{s==="Login"&&n.commands.executeCommand("stepik.login")}):n.window.showErrorMessage(`Error loading data: ${t}`),[]}}createSectionItem(e,t){let s=new n.TreeItem(e.title,n.TreeItemCollapsibleState.Collapsed),i=t?.get(e.progress);return i?i.is_passed?s.iconPath=new n.ThemeIcon("folder",q):i.n_steps_passed>0?s.iconPath=new n.ThemeIcon("folder",B):s.iconPath=new n.ThemeIcon("folder"):s.iconPath=new n.ThemeIcon("folder"),s.contextValue="section",s}createLessonItem(e,t){let s=new n.TreeItem(e.title,n.TreeItemCollapsibleState.Collapsed),i=t?.get(e.progress);return i?i.is_passed?s.iconPath=new n.ThemeIcon("file-text",q):i.n_steps_passed>0?s.iconPath=new n.ThemeIcon("file-text",B):s.iconPath=new n.ThemeIcon("file-text"):s.iconPath=new n.ThemeIcon("file-text"),s.contextValue="lesson",s}createStepItem(e,t,s,i){let o=e.block.name,r=`Step ${e.position}: ${this.getStepTypeLabel(o)}`,a=new n.TreeItem(r,n.TreeItemCollapsibleState.None),p=i?.get(e.progress),h=this.localPassedSteps.has(e.id)||p?.is_passed||!1,b=this.getStepIconName(o);return h?a.iconPath=new n.ThemeIcon(b,q):a.iconPath=new n.ThemeIcon(b),a.contextValue="step",a.command={command:"stepik.openStep",title:"Open Step",arguments:[{step:e,courseName:t,lessonTitle:s}]},a}getStepTypeLabel(e){return{code:"Code",choice:"Quiz",text:"Text",string:"Short Answer",number:"Number",math:"Math",sorting:"Sorting",matching:"Matching","fill-blanks":"Fill Blanks","free-answer":"Free Answer",video:"Video"}[e]||e}getStepIcon(e){let t={code:"code",choice:"checklist",text:"book",video:"play-circle",string:"whole-word",number:"symbol-number"};return new n.ThemeIcon(t[e]||"circle-outline")}getStepIconName(e){return{code:"code",choice:"checklist",text:"book",video:"play-circle",string:"whole-word",number:"symbol-number"}[e]||"circle-outline"}};var X="https://stepik.org/api",P=class{constructor(e){this.auth=e}async request(e,t={}){let s=await this.auth.getToken();if(!s)throw new Error("Not authenticated. Please login first.");let i=await fetch(`${X}${e}`,{...t,headers:{Authorization:`Bearer ${s}`,"Content-Type":"application/json",...t.headers}});if(!i.ok)throw new Error(`API Error: ${i.status} ${i.statusText}`);return i.json()}async getCurrentUser(){return{id:(await this.request("/stepics/1")).users[0].id}}async getUserCourses(){let e=await this.getCurrentUser(),s=(await this.request(`/user-courses?user=${e.id}&page=1`))["user-courses"].map(o=>o.course);return s.length===0?[]:(await this.request(`/courses?ids[]=${s.join("&ids[]=")}`)).courses}async getCourse(e){try{return(await this.request(`/courses/${e}`)).courses[0]}catch{return}}async getSections(e){return e.length===0?[]:(await this.request(`/sections?ids[]=${e.join("&ids[]=")}`)).sections}async getUnits(e){return e.length===0?[]:(await this.request(`/units?ids[]=${e.join("&ids[]=")}`)).units}async getLessons(e){return e.length===0?[]:(await this.request(`/lessons?ids[]=${e.join("&ids[]=")}`)).lessons}async getStep(e){return(await this.request(`/steps/${e}`)).steps[0]}async getSteps(e){return e.length===0?[]:(await this.request(`/steps?ids[]=${e.join("&ids[]=")}`)).steps}async createAttempt(e){return(await this.request("/attempts",{method:"POST",body:JSON.stringify({attempt:{step:e}})})).attempts[0]}async getAttempt(e){let t=await this.request(`/attempts?step=${e}&user=me`);return t.attempts.length>0?t.attempts[0]:this.createAttempt(e)}async submitSolution(e,t,s){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:{language:t,code:s}}})})).submissions[0]}async submitQuiz(e,t){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:t}})})).submissions[0]}async getSubmission(e){return(await this.request(`/submissions/${e}`)).submissions[0]}async getProgressByIds(e){let t=new Map;if(e.length===0)return t;try{let s=e.filter(r=>r);if(s.length===0)return t;let i=s.map(r=>`ids[]=${r}`).join("&"),o=await this.request(`/progresses?${i}`);for(let r of o.progresses)t.set(r.id,r)}catch{}return t}async getStepProgress(e){try{return(await this.request(`/progresses/step-${e}`)).progresses[0]||null}catch{return null}}async getStepsProgress(e){let t=new Map;if(e.length===0)return t;try{let s=e.map(o=>`step-${o}`).join("&ids[]="),i=await this.request(`/progresses?ids[]=${s}`);for(let o of i.progresses){let r=parseInt(o.id.replace("step-",""));t.set(r,o.is_passed)}}catch{}return t}async getCourseProgress(e){try{return(await this.request(`/progresses/course-${e}`)).progresses[0]||null}catch{return null}}};var u=l(require("vscode")),w=l(require("path")),g=l(require("fs")),T=class{constructor(e,t,s,i){this.context=e;this.api=t;this.treeProvider=s;this.outputChannel=i}panel;currentStep;currentAttempt;async showStep(e){this.currentStep=e;let{step:t}=e;this.panel||(this.panel=u.window.createWebviewPanel("stepikStep","Stepik Task",u.ViewColumn.Beside,{enableScripts:!0,retainContextWhenHidden:!0}),this.panel.onDidDispose(()=>{this.panel=void 0}),this.panel.webview.onDidReceiveMessage(i=>this.handleMessage(i),void 0,this.context.subscriptions)),["choice","string","number"].includes(t.block.name)&&(this.currentAttempt=await this.api.createAttempt(t.id)),this.panel.title=`Step ${t.position}`,this.panel.webview.html=this.getHtmlContent(t)}async handleMessage(e){switch(e.command){case"selectLanguage":e.language&&this.currentStep&&await this.createSolutionFile(this.currentStep,e.language);break;case"submitQuiz":await this.submitQuiz(e);break;case"restart":this.currentStep&&(this.currentAttempt=await this.api.createAttempt(this.currentStep.step.id),this.panel&&(this.panel.webview.html=this.getHtmlContent(this.currentStep.step)));break}}async submitQuiz(e){if(!this.currentStep||!this.currentAttempt){u.window.showErrorMessage("No active quiz");return}let t=this.currentStep.step.block.name,s=this.currentStep.step.id,i={};t==="choice"?i.choices=e.choices:t==="string"?i.text=e.text:t==="number"&&(i.number=e.number);try{let o=await this.api.submitQuiz(this.currentAttempt.id,i),r=await this.pollSubmissionResult(o.id);r.status==="correct"?(this.treeProvider.markStepAsPassed(s),this.treeProvider.refresh(),u.window.showInformationMessage(`\u2705 Correct! Score: ${r.score}`),await new Promise(a=>setTimeout(a,1e3)),this.treeProvider.forceRefresh()):(u.window.showErrorMessage("\u274C Wrong answer","Show Details").then(a=>{a==="Show Details"&&this.outputChannel.show()}),this.outputChannel.appendLine("\u2550".repeat(50)),this.outputChannel.appendLine(`\u274C Quiz Result: ${r.status}`),this.outputChannel.appendLine(`Step ID: ${s}`),this.outputChannel.appendLine(`Score: ${r.score}`),r.hint&&this.outputChannel.appendLine(`
Hint: ${r.hint}`),r.feedback&&this.outputChannel.appendLine(`
Feedback: ${r.feedback}`),this.outputChannel.appendLine("\u2550".repeat(50)),this.outputChannel.appendLine(""))}catch(o){u.window.showErrorMessage(`Submission failed: ${o}`)}}async pollSubmissionResult(e,t=30,s=1e3){for(let i=0;i<t;i++){let o=await this.api.getSubmission(e);if(o.status!=="evaluation")return o;await new Promise(r=>setTimeout(r,s))}throw new Error("Submission evaluation timeout")}async createSolutionFile(e,t){let{step:s,courseName:i,lessonTitle:o}=e,r=Q=>Q.replace(/[<>:"/\\|?*]/g,"_").substring(0,50),a=r(i),p=r(o),h=u.workspace.workspaceFolders?.[0];if(!h){u.window.showErrorMessage("Please open a workspace folder first");return}let b=w.join(h.uri.fsPath,a,p);g.mkdirSync(b,{recursive:!0});let M=this.getFileExtension(t),F=`step-${s.position}${M}`,S=w.join(b,F),R=s.block.options?.code_templates?.[t]||"";g.existsSync(S)||g.writeFileSync(S,R);let H=await u.workspace.openTextDocument(S);await u.window.showTextDocument(H,u.ViewColumn.One),this.storeStepMapping(S,s.id,t)}storeStepMapping(e,t,s){let i=u.workspace.workspaceFolders?.[0];if(!i)return;let o=w.join(i.uri.fsPath,".stepik","mapping.json"),r={};g.existsSync(o)?r=JSON.parse(g.readFileSync(o,"utf8")):g.mkdirSync(w.dirname(o),{recursive:!0}),r[e]={stepId:t,language:s},g.writeFileSync(o,JSON.stringify(r,null,2))}getFileExtension(e){let t={python3:".py",python:".py",python2:".py",python31:".py",cpp:".cpp","c++":".cpp",cpp11:".cpp","c++11":".cpp",cpp14:".cpp","c++14":".cpp",cpp17:".cpp","c++17":".cpp",cpp20:".cpp","c++20":".cpp",c:".c",c11:".c",java:".java",java8:".java",java11:".java",java17:".java",javascript:".js",js:".js",nodejs:".js",typescript:".ts",ts:".ts",kotlin:".kt",go:".go",golang:".go",rust:".rs",csharp:".cs","c#":".cs",ruby:".rb",php:".php",scala:".scala",haskell:".hs",hs:".hs",sql:".sql",swift:".swift",r:".r",perl:".pl",octave:".m",matlab:".m",bash:".sh",shell:".sh",clojure:".clj","mono c#":".cs",asm32:".asm",asm64:".asm"};return t[e]||t[e.toLowerCase()]||".txt"}getHtmlContent(e){let t=e.block.name,s=t==="code",i=["choice","string","number"].includes(t),o=e.block.options?.code_templates?Object.keys(e.block.options.code_templates):[],r=s&&o.length>0?this.getLanguageSelectorHtml(o):"",a=i?this.getQuizHtml(e):"",p=e.block.options?.samples||[],h=p.length>0?this.getSamplesHtml(p):"",b=`https://stepik.org/lesson/${e.lesson}/step/${e.position}`;return`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${this.getStyles()}
    </style>
</head>
<body>
    <div class="step-header">
        <a href="${b}" class="stepik-link">Open on Stepik \u2197</a>
    </div>
    
    <div class="task-type">${e.block.name.toUpperCase()}</div>
    
    <div class="task-content">
        ${e.block.text}
    </div>
    
    ${r}
    ${a}
    ${h}
    
    <script>
        ${this.getScript(t)}
    </script>
</body>
</html>`}getLanguageSelectorHtml(e){return`
            <div class="language-selector">
                <label>Select Language:</label>
                <select id="language-select">
                    <option value="">-- Choose --</option>
                    ${e.map(t=>`<option value="${t}">${t}</option>`).join("")}
                </select>
                <button id="open-btn" disabled>Open in Editor</button>
            </div>
        `}getQuizHtml(e){let t=e.block.name,s=this.currentAttempt?.dataset?.options||[],i=this.currentAttempt?.dataset?.is_multiple_choice??!1;if(t==="choice"){let o=i?"checkbox":"radio";return`
                <div class="quiz-section">
                    <div class="quiz-options">
                        ${s.map((r,a)=>`
                            <label class="quiz-option">
                                <input type="${o}" name="choice" value="${a}" data-index="${a}">
                                <span>${r}</span>
                            </label>
                        `).join("")}
                    </div>
                    <div class="quiz-actions">
                        <button id="submit-quiz-btn">Submit</button>
                        <button id="restart-btn" class="secondary">Restart</button>
                    </div>
                </div>
            `}else{if(t==="string")return`
                <div class="quiz-section">
                    <div class="quiz-input">
                        <input type="text" id="string-input" placeholder="Enter your answer...">
                    </div>
                    <div class="quiz-actions">
                        <button id="submit-quiz-btn">Submit</button>
                        <button id="restart-btn" class="secondary">Restart</button>
                    </div>
                </div>
            `;if(t==="number")return`
                <div class="quiz-section">
                    <div class="quiz-input">
                        <input type="number" id="number-input" placeholder="Enter a number..." step="any">
                    </div>
                    <div class="quiz-actions">
                        <button id="submit-quiz-btn">Submit</button>
                        <button id="restart-btn" class="secondary">Restart</button>
                    </div>
                </div>
            `}return""}getSamplesHtml(e){return`
            <div class="samples">
                <h3>Samples</h3>
                ${e.map(([t,s],i)=>`
                    <div class="sample">
                        <div class="sample-header">Sample ${i+1}</div>
                        <div class="sample-io">
                            <div class="sample-input">
                                <strong>Input:</strong>
                                <pre>${this.escapeHtml(t)}</pre>
                            </div>
                            <div class="sample-output">
                                <strong>Output:</strong>
                                <pre>${this.escapeHtml(s)}</pre>
                            </div>
                        </div>
                    </div>
                `).join("")}
            </div>
        `}getStyles(){return`
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            line-height: 1.6;
        }
        .step-header {
            margin-bottom: 16px;
            text-align: right;
        }
        .stepik-link {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            font-size: 14px;
        }
        .stepik-link:hover {
            text-decoration: underline;
        }
        .task-type {
            display: inline-block;
            padding: 4px 8px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 4px;
            font-size: 12px;
            margin-bottom: 16px;
        }
        .task-content {
            margin-bottom: 24px;
        }
        .task-content img {
            max-width: 100%;
        }
        .task-content pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
        }
        .task-content code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 2px;
        }
        .language-selector {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 16px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            margin-bottom: 16px;
        }
        select, button, input[type="text"], input[type="number"] {
            padding: 8px 12px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            cursor: pointer;
        }
        input[type="text"], input[type="number"] {
            width: 100%;
            box-sizing: border-box;
            cursor: text;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        button:not(:disabled):hover {
            background: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .quiz-section {
            padding: 16px;
            background: var(--vscode-input-background);
            border-radius: 4px;
            margin-bottom: 16px;
        }
        .quiz-options {
            display: flex;
            flex-direction: column;
            gap: 12px;
            margin-bottom: 16px;
        }
        .quiz-option {
            display: flex;
            align-items: flex-start;
            gap: 8px;
            padding: 12px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            cursor: pointer;
        }
        .quiz-option:hover {
            border-color: var(--vscode-focusBorder);
        }
        .quiz-option input {
            margin-top: 4px;
        }
        .quiz-input {
            margin-bottom: 16px;
        }
        .quiz-actions {
            display: flex;
            gap: 12px;
        }
        .samples {
            margin-top: 24px;
        }
        .sample {
            margin-bottom: 16px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        .sample-header {
            padding: 8px 12px;
            background: var(--vscode-sideBarSectionHeader-background);
            font-weight: bold;
        }
        .sample-io {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 16px;
            padding: 12px;
        }
        .sample-input pre, .sample-output pre {
            margin: 8px 0 0;
            padding: 8px;
            background: var(--vscode-textCodeBlock-background);
            border-radius: 4px;
            white-space: pre-wrap;
        }
        `}getScript(e){return e==="code"?`
                const vscode = acquireVsCodeApi();
                const select = document.getElementById('language-select');
                const btn = document.getElementById('open-btn');
                
                if (select && btn) {
                    select.addEventListener('change', () => {
                        btn.disabled = !select.value;
                    });
                    
                    btn.addEventListener('click', () => {
                        if (select.value) {
                            vscode.postMessage({ 
                                command: 'selectLanguage', 
                                language: select.value 
                            });
                        }
                    });
                }
            `:e==="choice"?`
                const vscode = acquireVsCodeApi();
                const submitBtn = document.getElementById('submit-quiz-btn');
                const restartBtn = document.getElementById('restart-btn');
                const inputs = document.querySelectorAll('input[name="choice"]');
                
                submitBtn.addEventListener('click', () => {
                    const choices = [];
                    inputs.forEach((input, index) => {
                        choices[index] = input.checked;
                    });
                    vscode.postMessage({ 
                        command: 'submitQuiz', 
                        choices: choices 
                    });
                });
                
                restartBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'restart' });
                });
            `:e==="string"?`
                const vscode = acquireVsCodeApi();
                const submitBtn = document.getElementById('submit-quiz-btn');
                const restartBtn = document.getElementById('restart-btn');
                const input = document.getElementById('string-input');
                
                submitBtn.addEventListener('click', () => {
                    vscode.postMessage({ 
                        command: 'submitQuiz', 
                        text: input.value 
                    });
                });
                
                restartBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'restart' });
                });
                
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') submitBtn.click();
                });
            `:e==="number"?`
                const vscode = acquireVsCodeApi();
                const submitBtn = document.getElementById('submit-quiz-btn');
                const restartBtn = document.getElementById('restart-btn');
                const input = document.getElementById('number-input');
                
                submitBtn.addEventListener('click', () => {
                    vscode.postMessage({ 
                        command: 'submitQuiz', 
                        number: input.value 
                    });
                });
                
                restartBtn.addEventListener('click', () => {
                    vscode.postMessage({ command: 'restart' });
                });
                
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') submitBtn.click();
                });
            `:""}escapeHtml(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}};var m=l(require("vscode")),E=l(require("fs")),j=l(require("path")),I=class{constructor(e,t,s){this.api=e;this.treeProvider=t;this.outputChannel=s}async submitCurrentFile(){let e=m.window.activeTextEditor;if(!e){m.window.showErrorMessage("No active file to submit");return}let t=e.document.uri.fsPath,s=this.getStepMapping(t);if(!s){m.window.showErrorMessage("This file is not associated with a Stepik step. Open a step from the tree first.");return}let{stepId:i,language:o}=s,r=e.document.getText();await m.window.withProgress({location:m.ProgressLocation.Notification,title:"Submitting solution...",cancellable:!1},async a=>{try{a.report({message:"Creating attempt..."});let p=await this.api.createAttempt(i);a.report({message:"Sending code..."});let h=await this.api.submitSolution(p.id,o,r);a.report({message:"Waiting for result..."});let b=await this.pollSubmissionResult(h.id);this.showResult(b,i),b.status==="correct"&&(await new Promise(M=>setTimeout(M,1e3)),this.treeProvider.forceRefresh())}catch(p){m.window.showErrorMessage(`Submission failed: ${p}`)}})}getStepMapping(e){let t=m.workspace.workspaceFolders?.[0];if(!t)return;let s=j.join(t.uri.fsPath,".stepik","mapping.json");return E.existsSync(s)?JSON.parse(E.readFileSync(s,"utf8"))[e]:void 0}async pollSubmissionResult(e,t=30,s=1e3){for(let i=0;i<t;i++){let o=await this.api.getSubmission(e);if(o.status!=="evaluation")return o;await new Promise(r=>setTimeout(r,s))}throw new Error("Submission evaluation timeout")}showResult(e,t){e.status==="correct"?(this.treeProvider.markStepAsPassed(t),this.treeProvider.refresh(),m.window.showInformationMessage(`\u2705 Correct! Score: ${e.score}`,"OK")):(m.window.showErrorMessage("\u274C Wrong solution","Show Details").then(i=>{i==="Show Details"&&this.outputChannel.show()}),this.outputChannel.appendLine("\u2550".repeat(50)),this.outputChannel.appendLine(`\u274C Submission Result: ${e.status}`),this.outputChannel.appendLine(`Step ID: ${t}`),this.outputChannel.appendLine(`Score: ${e.score}`),e.hint&&this.outputChannel.appendLine(`
Hint: ${e.hint}`),e.feedback&&this.outputChannel.appendLine(`
Feedback: ${e.feedback}`),this.outputChannel.appendLine("\u2550".repeat(50)),this.outputChannel.appendLine(""))}};var $,v,A=O.join(N.homedir(),".stepik");async function Z(){let c=d.workspace.workspaceFolders;L.existsSync(A)?(!c||c.length===0)&&await d.window.showInformationMessage("Open Stepik workspace folder (~/.stepik)?","Open","Later")==="Open"&&await d.commands.executeCommand("vscode.openFolder",d.Uri.file(A)):await d.window.showInformationMessage("Stepik workspace folder not found. Create ~/.stepik for storing your solutions?","Create","Cancel")==="Create"&&(L.mkdirSync(A,{recursive:!0}),await d.window.showInformationMessage("Workspace folder created. Open it now?","Open","Later")==="Open"&&await d.commands.executeCommand("vscode.openFolder",d.Uri.file(A)))}async function ee(c){let e=d.window.createOutputChannel("Stepik"),t=new x(c);$=new P(t),v=new C($,c);let s=new T(c,$,v,e),i=new I($,v,e),o=d.window.createTreeView("stepikCourses",{treeDataProvider:v,showCollapseAll:!0}),r=()=>{let a=v.getSelectedCourse();o.title=a?`Stepik: ${a.title}`:"Stepik: Select Course"};r(),c.subscriptions.push(d.commands.registerCommand("stepik.login",async()=>{await t.login(),v.refresh()}),d.commands.registerCommand("stepik.logout",async()=>{await t.logout(),v.refresh()}),d.commands.registerCommand("stepik.refresh",()=>{v.forceRefresh()}),d.commands.registerCommand("stepik.selectCourse",async()=>{await v.selectCourse(),r()}),d.commands.registerCommand("stepik.openStep",async a=>{await s.showStep(a)}),d.commands.registerCommand("stepik.submit",async()=>{await i.submitCurrentFile()}),o,e),await t.isLoggedIn()&&v.refresh(),await Z()}function te(){}0&&(module.exports={activate,deactivate});
