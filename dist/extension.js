"use strict";var Q=Object.create;var k=Object.defineProperty;var W=Object.getOwnPropertyDescriptor;var V=Object.getOwnPropertyNames;var K=Object.getPrototypeOf,J=Object.prototype.hasOwnProperty;var Y=(a,e)=>{for(var t in e)k(a,t,{get:e[t],enumerable:!0})},z=(a,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let o of V(e))!J.call(a,o)&&o!==t&&k(a,o,{get:()=>e[o],enumerable:!(s=W(e,o))||s.enumerable});return a};var l=(a,e,t)=>(t=a!=null?Q(K(a)):{},z(e||!a||!a.__esModule?k(t,"default",{value:a,enumerable:!0}):t,a)),G=a=>z(k({},"__esModule",{value:!0}),a);var se={};Y(se,{activate:()=>ee,deactivate:()=>te});module.exports=G(se);var d=l(require("vscode")),q=l(require("fs")),D=l(require("path")),O=l(require("os"));var w=l(require("vscode")),B="stepik.clientId",L="stepik.clientSecret",y="stepik.accessToken",x=class{secretStorage;constructor(e){this.secretStorage=e.secrets}async login(){let e=await w.window.showInputBox({prompt:"Enter your Stepik Client ID",placeHolder:"Client ID from https://stepik.org/oauth2/applications/",ignoreFocusOut:!0});if(!e)return!1;let t=await w.window.showInputBox({prompt:"Enter your Stepik Client Secret",placeHolder:"Client Secret",password:!0,ignoreFocusOut:!0});if(!t)return!1;try{let s=await this.getAccessToken(e,t);return await this.secretStorage.store(B,e),await this.secretStorage.store(L,t),await this.secretStorage.store(y,s),w.window.showInformationMessage("Successfully logged in to Stepik!"),!0}catch(s){return w.window.showErrorMessage(`Failed to login: ${s}`),!1}}async getAccessToken(e,t){let s=Buffer.from(`${e}:${t}`).toString("base64"),o=await fetch("https://stepik.org/oauth2/token/",{method:"POST",headers:{Authorization:`Basic ${s}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});if(!o.ok)throw new Error(`HTTP ${o.status}: ${o.statusText}`);return(await o.json()).access_token}async logout(){await this.secretStorage.delete(B),await this.secretStorage.delete(L),await this.secretStorage.delete(y),w.window.showInformationMessage("Logged out from Stepik")}async isLoggedIn(){return!!await this.secretStorage.get(y)}async getToken(){return await this.secretStorage.get(y)}};var n=l(require("vscode")),P=new n.ThemeColor("charts.green"),_=new n.ThemeColor("charts.yellow"),T=class{constructor(e){this.api=e}_onDidChangeTreeData=new n.EventEmitter;onDidChangeTreeData=this._onDidChangeTreeData.event;refresh(){this._onDidChangeTreeData.fire()}getTreeItem(e){switch(e.type){case"course":return this.createCourseItem(e.course,e.courseProgress);case"section":return this.createSectionItem(e.section,e.progressMap);case"lesson":return this.createLessonItem(e.lesson,e.progressMap);case"step":return this.createStepItem(e.step,e.courseName,e.lessonTitle,e.progressMap)}}async getChildren(e){try{if(!e){let t=await this.api.getUserCourses(),s=t.map(r=>r.progress).filter(r=>r),o=await this.api.getProgressByIds(s);return t.map(r=>({type:"course",course:r,courseProgress:o.get(r.progress)}))}switch(e.type){case"course":{let t=await this.api.getSections(e.course.sections),s=t.map(r=>r.progress).filter(r=>r),o=await this.api.getProgressByIds(s);return t.sort((r,i)=>r.position-i.position).map(r=>({type:"section",section:r,courseName:e.course.title,progressMap:o}))}case"section":{let t=await this.api.getUnits(e.section.units),s=t.map(c=>c.lesson),o=await this.api.getLessons(s),r=o.map(c=>c.progress).filter(c=>c),i=await this.api.getProgressByIds(r),p=new Map(t.map(c=>[c.lesson,c.position]));return o.sort((c,h)=>(p.get(c.id)||0)-(p.get(h.id)||0)).map(c=>({type:"lesson",lesson:c,courseName:e.courseName,progressMap:i}))}case"lesson":{let t=await this.api.getSteps(e.lesson.steps),s=t.map(r=>r.progress).filter(r=>r),o=await this.api.getProgressByIds(s);return t.sort((r,i)=>r.position-i.position).map(r=>({type:"step",step:r,courseName:e.courseName,lessonTitle:e.lesson.title,progressMap:o}))}default:return[]}}catch(t){return String(t).includes("Not authenticated")?n.window.showWarningMessage("Please login to Stepik first","Login").then(s=>{s==="Login"&&n.commands.executeCommand("stepik.login")}):n.window.showErrorMessage(`Error loading data: ${t}`),[]}}createCourseItem(e,t){let s=new n.TreeItem(e.title,n.TreeItemCollapsibleState.Collapsed);return e.is_certificate_issued||t?.is_passed?s.iconPath=new n.ThemeIcon("book",P):t&&t.n_steps_passed>0?s.iconPath=new n.ThemeIcon("book",_):s.iconPath=new n.ThemeIcon("book"),s.contextValue="course",s}createSectionItem(e,t){let s=new n.TreeItem(e.title,n.TreeItemCollapsibleState.Collapsed),o=t?.get(e.progress);return o?o.is_passed?s.iconPath=new n.ThemeIcon("folder",P):o.n_steps_passed>0?s.iconPath=new n.ThemeIcon("folder",_):s.iconPath=new n.ThemeIcon("folder"):s.iconPath=new n.ThemeIcon("folder"),s.contextValue="section",s}createLessonItem(e,t){let s=new n.TreeItem(e.title,n.TreeItemCollapsibleState.Collapsed),o=t?.get(e.progress);return o?o.is_passed?s.iconPath=new n.ThemeIcon("file-text",P):o.n_steps_passed>0?s.iconPath=new n.ThemeIcon("file-text",_):s.iconPath=new n.ThemeIcon("file-text"):s.iconPath=new n.ThemeIcon("file-text"),s.contextValue="lesson",s}createStepItem(e,t,s,o){let r=e.block.name,i=`Step ${e.position}: ${this.getStepTypeLabel(r)}`,p=new n.TreeItem(i,n.TreeItemCollapsibleState.None),h=o?.get(e.progress)?.is_passed||!1,b=this.getStepIconName(r);return h?p.iconPath=new n.ThemeIcon(b,P):p.iconPath=new n.ThemeIcon(b),p.contextValue="step",p.command={command:"stepik.openStep",title:"Open Step",arguments:[{step:e,courseName:t,lessonTitle:s}]},p}getStepTypeLabel(e){return{code:"Code",choice:"Quiz",text:"Text",string:"Short Answer",number:"Number",math:"Math",sorting:"Sorting",matching:"Matching","fill-blanks":"Fill Blanks","free-answer":"Free Answer",video:"Video"}[e]||e}getStepIcon(e){let t={code:"code",choice:"checklist",text:"book",video:"play-circle",string:"whole-word",number:"symbol-number"};return new n.ThemeIcon(t[e]||"circle-outline")}getStepIconName(e){return{code:"code",choice:"checklist",text:"book",video:"play-circle",string:"whole-word",number:"symbol-number"}[e]||"circle-outline"}};var X="https://stepik.org/api",C=class{constructor(e){this.auth=e}async request(e,t={}){let s=await this.auth.getToken();if(!s)throw new Error("Not authenticated. Please login first.");let o=await fetch(`${X}${e}`,{...t,headers:{Authorization:`Bearer ${s}`,"Content-Type":"application/json",...t.headers}});if(!o.ok)throw new Error(`API Error: ${o.status} ${o.statusText}`);return o.json()}async getCurrentUser(){return{id:(await this.request("/stepics/1")).users[0].id}}async getUserCourses(){let e=await this.getCurrentUser(),s=(await this.request(`/user-courses?user=${e.id}&page=1`))["user-courses"].map(r=>r.course);return s.length===0?[]:(await this.request(`/courses?ids[]=${s.join("&ids[]=")}`)).courses}async getSections(e){return e.length===0?[]:(await this.request(`/sections?ids[]=${e.join("&ids[]=")}`)).sections}async getUnits(e){return e.length===0?[]:(await this.request(`/units?ids[]=${e.join("&ids[]=")}`)).units}async getLessons(e){return e.length===0?[]:(await this.request(`/lessons?ids[]=${e.join("&ids[]=")}`)).lessons}async getStep(e){return(await this.request(`/steps/${e}`)).steps[0]}async getSteps(e){return e.length===0?[]:(await this.request(`/steps?ids[]=${e.join("&ids[]=")}`)).steps}async createAttempt(e){return(await this.request("/attempts",{method:"POST",body:JSON.stringify({attempt:{step:e}})})).attempts[0]}async getAttempt(e){let t=await this.request(`/attempts?step=${e}&user=me`);return t.attempts.length>0?t.attempts[0]:this.createAttempt(e)}async submitSolution(e,t,s){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:{language:t,code:s}}})})).submissions[0]}async submitQuiz(e,t){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:t}})})).submissions[0]}async getSubmission(e){return(await this.request(`/submissions/${e}`)).submissions[0]}async getProgressByIds(e){let t=new Map;if(e.length===0)return t;try{let s=e.filter(i=>i);if(s.length===0)return t;let o=s.map(i=>`ids[]=${i}`).join("&"),r=await this.request(`/progresses?${o}`);for(let i of r.progresses)t.set(i.id,i)}catch{}return t}async getStepProgress(e){try{return(await this.request(`/progresses/step-${e}`)).progresses[0]||null}catch{return null}}async getStepsProgress(e){let t=new Map;if(e.length===0)return t;try{let s=e.map(r=>`step-${r}`).join("&ids[]="),o=await this.request(`/progresses?ids[]=${s}`);for(let r of o.progresses){let i=parseInt(r.id.replace("step-",""));t.set(i,r.is_passed)}}catch{}return t}async getCourseProgress(e){try{return(await this.request(`/progresses/course-${e}`)).progresses[0]||null}catch{return null}}};var u=l(require("vscode")),f=l(require("path")),g=l(require("fs")),I=class{constructor(e,t,s){this.context=e;this.api=t;this.treeProvider=s}panel;currentStep;currentAttempt;async showStep(e){this.currentStep=e;let{step:t}=e;this.panel||(this.panel=u.window.createWebviewPanel("stepikStep","Stepik Task",u.ViewColumn.Beside,{enableScripts:!0,retainContextWhenHidden:!0}),this.panel.onDidDispose(()=>{this.panel=void 0}),this.panel.webview.onDidReceiveMessage(o=>this.handleMessage(o),void 0,this.context.subscriptions)),["choice","string","number"].includes(t.block.name)&&(this.currentAttempt=await this.api.createAttempt(t.id)),this.panel.title=`Step ${t.position}`,this.panel.webview.html=this.getHtmlContent(t)}async handleMessage(e){switch(e.command){case"selectLanguage":e.language&&this.currentStep&&await this.createSolutionFile(this.currentStep,e.language);break;case"submitQuiz":await this.submitQuiz(e);break;case"restart":this.currentStep&&(this.currentAttempt=await this.api.createAttempt(this.currentStep.step.id),this.panel&&(this.panel.webview.html=this.getHtmlContent(this.currentStep.step)));break}}async submitQuiz(e){if(!this.currentStep||!this.currentAttempt){u.window.showErrorMessage("No active quiz");return}let t=this.currentStep.step.block.name,s={};t==="choice"?s.choices=e.choices:t==="string"?s.text=e.text:t==="number"&&(s.number=e.number);try{let o=await this.api.submitQuiz(this.currentAttempt.id,s),r=await this.pollSubmissionResult(o.id);if(r.status==="correct")u.window.showInformationMessage(`\u2705 Correct! Score: ${r.score}`),this.treeProvider.refresh();else{let i=r.hint||r.feedback||"Wrong answer";u.window.showErrorMessage(`\u274C ${r.status}: ${i}`)}}catch(o){u.window.showErrorMessage(`Submission failed: ${o}`)}}async pollSubmissionResult(e,t=30,s=1e3){for(let o=0;o<t;o++){let r=await this.api.getSubmission(e);if(r.status!=="evaluation")return r;await new Promise(i=>setTimeout(i,s))}throw new Error("Submission evaluation timeout")}async createSolutionFile(e,t){let{step:s,courseName:o,lessonTitle:r}=e,i=U=>U.replace(/[<>:"/\\|?*]/g,"_").substring(0,50),p=i(o),c=i(r),h=u.workspace.workspaceFolders?.[0];if(!h){u.window.showErrorMessage("Please open a workspace folder first");return}let b=f.join(h.uri.fsPath,p,c);g.mkdirSync(b,{recursive:!0});let N=this.getFileExtension(t),F=`step-${s.position}${N}`,S=f.join(b,F),R=s.block.options?.code_templates?.[t]||"";g.existsSync(S)||g.writeFileSync(S,R);let H=await u.workspace.openTextDocument(S);await u.window.showTextDocument(H,u.ViewColumn.One),this.storeStepMapping(S,s.id,t)}storeStepMapping(e,t,s){let o=u.workspace.workspaceFolders?.[0];if(!o)return;let r=f.join(o.uri.fsPath,".stepik","mapping.json"),i={};g.existsSync(r)?i=JSON.parse(g.readFileSync(r,"utf8")):g.mkdirSync(f.dirname(r),{recursive:!0}),i[e]={stepId:t,language:s},g.writeFileSync(r,JSON.stringify(i,null,2))}getFileExtension(e){let t={python3:".py",python:".py",python2:".py",python31:".py",cpp:".cpp","c++":".cpp",cpp11:".cpp","c++11":".cpp",cpp14:".cpp","c++14":".cpp",cpp17:".cpp","c++17":".cpp",cpp20:".cpp","c++20":".cpp",c:".c",c11:".c",java:".java",java8:".java",java11:".java",java17:".java",javascript:".js",js:".js",nodejs:".js",typescript:".ts",ts:".ts",kotlin:".kt",go:".go",golang:".go",rust:".rs",csharp:".cs","c#":".cs",ruby:".rb",php:".php",scala:".scala",haskell:".hs",hs:".hs",sql:".sql",swift:".swift",r:".r",perl:".pl",octave:".m",matlab:".m",bash:".sh",shell:".sh",clojure:".clj","mono c#":".cs",asm32:".asm",asm64:".asm"};return t[e]||t[e.toLowerCase()]||".txt"}getHtmlContent(e){let t=e.block.name,s=t==="code",o=["choice","string","number"].includes(t),r=e.block.options?.code_templates?Object.keys(e.block.options.code_templates):[],i=s&&r.length>0?this.getLanguageSelectorHtml(r):"",p=o?this.getQuizHtml(e):"",c=e.block.options?.samples||[],h=c.length>0?this.getSamplesHtml(c):"",b=`https://stepik.org/lesson/${e.lesson}/step/${e.position}`;return`<!DOCTYPE html>
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
    
    ${i}
    ${p}
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
        `}getQuizHtml(e){let t=e.block.name,s=this.currentAttempt?.dataset?.options||[],o=this.currentAttempt?.dataset?.is_multiple_choice??!1;if(t==="choice"){let r=o?"checkbox":"radio";return`
                <div class="quiz-section">
                    <div class="quiz-options">
                        ${s.map((i,p)=>`
                            <label class="quiz-option">
                                <input type="${r}" name="choice" value="${p}" data-index="${p}">
                                <span>${i}</span>
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
                ${e.map(([t,s],o)=>`
                    <div class="sample">
                        <div class="sample-header">Sample ${o+1}</div>
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
            `:""}escapeHtml(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}};var m=l(require("vscode")),$=l(require("fs")),j=l(require("path")),E=class{constructor(e,t){this.api=e;this.treeProvider=t}async submitCurrentFile(){let e=m.window.activeTextEditor;if(!e){m.window.showErrorMessage("No active file to submit");return}let t=e.document.uri.fsPath,s=this.getStepMapping(t);if(!s){m.window.showErrorMessage("This file is not associated with a Stepik step. Open a step from the tree first.");return}let{stepId:o,language:r}=s,i=e.document.getText();await m.window.withProgress({location:m.ProgressLocation.Notification,title:"Submitting solution...",cancellable:!1},async p=>{try{p.report({message:"Creating attempt..."});let c=await this.api.createAttempt(o);p.report({message:"Sending code..."});let h=await this.api.submitSolution(c.id,r,i);p.report({message:"Waiting for result..."});let b=await this.pollSubmissionResult(h.id);this.showResult(b),this.treeProvider.refresh()}catch(c){m.window.showErrorMessage(`Submission failed: ${c}`)}})}getStepMapping(e){let t=m.workspace.workspaceFolders?.[0];if(!t)return;let s=j.join(t.uri.fsPath,".stepik","mapping.json");return $.existsSync(s)?JSON.parse($.readFileSync(s,"utf8"))[e]:void 0}async pollSubmissionResult(e,t=30,s=1e3){for(let o=0;o<t;o++){let r=await this.api.getSubmission(e);if(r.status!=="evaluation")return r;await new Promise(i=>setTimeout(i,s))}throw new Error("Submission evaluation timeout")}showResult(e){if(e.status==="correct")m.window.showInformationMessage(`\u2705 Correct! Score: ${e.score}`,"OK");else{let s=e.hint||e.feedback||"Wrong answer";m.window.showErrorMessage(`\u274C ${e.status}: ${s}`,"OK")}}};var M,v,A=D.join(O.homedir(),".stepik");async function Z(){let a=d.workspace.workspaceFolders;q.existsSync(A)?(!a||a.length===0)&&await d.window.showInformationMessage("Open Stepik workspace folder (~/.stepik)?","Open","Later")==="Open"&&await d.commands.executeCommand("vscode.openFolder",d.Uri.file(A)):await d.window.showInformationMessage("Stepik workspace folder not found. Create ~/.stepik for storing your solutions?","Create","Cancel")==="Create"&&(q.mkdirSync(A,{recursive:!0}),await d.window.showInformationMessage("Workspace folder created. Open it now?","Open","Later")==="Open"&&await d.commands.executeCommand("vscode.openFolder",d.Uri.file(A)))}async function ee(a){let e=new x(a);M=new C(e),v=new T(M);let t=new I(a,M,v),s=new E(M,v),o=d.window.createTreeView("stepikCourses",{treeDataProvider:v,showCollapseAll:!0});a.subscriptions.push(d.commands.registerCommand("stepik.login",async()=>{await e.login(),v.refresh()}),d.commands.registerCommand("stepik.logout",async()=>{await e.logout(),v.refresh()}),d.commands.registerCommand("stepik.refresh",()=>{v.refresh()}),d.commands.registerCommand("stepik.openStep",async r=>{await t.showStep(r)}),d.commands.registerCommand("stepik.submit",async()=>{await s.submitCurrentFile()}),o),await e.isLoggedIn()&&v.refresh(),await Z()}function te(){}0&&(module.exports={activate,deactivate});
