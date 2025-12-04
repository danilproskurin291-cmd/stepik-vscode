"use strict";var N=Object.create;var y=Object.defineProperty;var O=Object.getOwnPropertyDescriptor;var F=Object.getOwnPropertyNames;var H=Object.getPrototypeOf,R=Object.prototype.hasOwnProperty;var Q=(n,e)=>{for(var t in e)y(n,t,{get:e[t],enumerable:!0})},q=(n,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let i of F(e))!R.call(n,i)&&i!==t&&y(n,i,{get:()=>e[i],enumerable:!(s=O(e,i))||s.enumerable});return n};var m=(n,e,t)=>(t=n!=null?N(H(n)):{},q(e||!n||!n.__esModule?y(t,"default",{value:n,enumerable:!0}):t,n)),U=n=>q(y({},"__esModule",{value:!0}),n);var K={};Q(K,{activate:()=>W,deactivate:()=>J});module.exports=U(K);var g=m(require("vscode"));var v=m(require("vscode")),A="stepik.clientId",z="stepik.clientSecret",k="stepik.accessToken",x=class{secretStorage;constructor(e){this.secretStorage=e.secrets}async login(){let e=await v.window.showInputBox({prompt:"Enter your Stepik Client ID",placeHolder:"Client ID from https://stepik.org/oauth2/applications/",ignoreFocusOut:!0});if(!e)return!1;let t=await v.window.showInputBox({prompt:"Enter your Stepik Client Secret",placeHolder:"Client Secret",password:!0,ignoreFocusOut:!0});if(!t)return!1;try{let s=await this.getAccessToken(e,t);return await this.secretStorage.store(A,e),await this.secretStorage.store(z,t),await this.secretStorage.store(k,s),v.window.showInformationMessage("Successfully logged in to Stepik!"),!0}catch(s){return v.window.showErrorMessage(`Failed to login: ${s}`),!1}}async getAccessToken(e,t){let s=Buffer.from(`${e}:${t}`).toString("base64"),i=await fetch("https://stepik.org/oauth2/token/",{method:"POST",headers:{Authorization:`Basic ${s}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});if(!i.ok)throw new Error(`HTTP ${i.status}: ${i.statusText}`);return(await i.json()).access_token}async logout(){await this.secretStorage.delete(A),await this.secretStorage.delete(z),await this.secretStorage.delete(k),v.window.showInformationMessage("Logged out from Stepik")}async isLoggedIn(){return!!await this.secretStorage.get(k)}async getToken(){return await this.secretStorage.get(k)}};var a=m(require("vscode")),T=class{constructor(e){this.api=e}_onDidChangeTreeData=new a.EventEmitter;onDidChangeTreeData=this._onDidChangeTreeData.event;refresh(){this._onDidChangeTreeData.fire()}getTreeItem(e){switch(e.type){case"course":return this.createCourseItem(e.course);case"section":return this.createSectionItem(e.section);case"lesson":return this.createLessonItem(e.lesson);case"step":return this.createStepItem(e.step,e.courseName,e.lessonTitle)}}async getChildren(e){try{if(!e)return(await this.api.getUserCourses()).map(s=>({type:"course",course:s}));switch(e.type){case"course":return(await this.api.getSections(e.course.sections)).sort((s,i)=>s.position-i.position).map(s=>({type:"section",section:s,courseName:e.course.title}));case"section":{let t=await this.api.getUnits(e.section.units),s=t.map(r=>r.lesson),i=await this.api.getLessons(s),o=new Map(t.map(r=>[r.lesson,r.position]));return i.sort((r,p)=>(o.get(r.id)||0)-(o.get(p.id)||0)).map(r=>({type:"lesson",lesson:r,courseName:e.courseName}))}case"lesson":return(await this.api.getSteps(e.lesson.steps)).sort((s,i)=>s.position-i.position).map(s=>({type:"step",step:s,courseName:e.courseName,lessonTitle:e.lesson.title}));default:return[]}}catch(t){return String(t).includes("Not authenticated")?a.window.showWarningMessage("Please login to Stepik first","Login").then(s=>{s==="Login"&&a.commands.executeCommand("stepik.login")}):a.window.showErrorMessage(`Error loading data: ${t}`),[]}}createCourseItem(e){let t=new a.TreeItem(e.title,a.TreeItemCollapsibleState.Collapsed);return t.iconPath=new a.ThemeIcon("book"),t.contextValue="course",t}createSectionItem(e){let t=new a.TreeItem(e.title,a.TreeItemCollapsibleState.Collapsed);return t.iconPath=new a.ThemeIcon("folder"),t.contextValue="section",t}createLessonItem(e){let t=new a.TreeItem(e.title,a.TreeItemCollapsibleState.Collapsed);return t.iconPath=new a.ThemeIcon("file-text"),t.contextValue="lesson",t}createStepItem(e,t,s){let i=e.block.name,o=`Step ${e.position}: ${this.getStepTypeLabel(i)}`,r=new a.TreeItem(o,a.TreeItemCollapsibleState.None);return r.iconPath=this.getStepIcon(i),r.contextValue="step",r.command={command:"stepik.openStep",title:"Open Step",arguments:[{step:e,courseName:t,lessonTitle:s}]},r}getStepTypeLabel(e){return{code:"Code",choice:"Quiz",text:"Text",string:"Short Answer",number:"Number",math:"Math",sorting:"Sorting",matching:"Matching","fill-blanks":"Fill Blanks","free-answer":"Free Answer",video:"Video"}[e]||e}getStepIcon(e){let t={code:"code",choice:"checklist",text:"book",video:"play-circle",string:"whole-word",number:"symbol-number"};return new a.ThemeIcon(t[e]||"circle-outline")}};var V="https://stepik.org/api",C=class{constructor(e){this.auth=e}async request(e,t={}){let s=await this.auth.getToken();if(!s)throw new Error("Not authenticated. Please login first.");let i=await fetch(`${V}${e}`,{...t,headers:{Authorization:`Bearer ${s}`,"Content-Type":"application/json",...t.headers}});if(!i.ok)throw new Error(`API Error: ${i.status} ${i.statusText}`);return i.json()}async getCurrentUser(){return{id:(await this.request("/stepics/1")).users[0].id}}async getUserCourses(){let e=await this.getCurrentUser(),s=(await this.request(`/user-courses?user=${e.id}&page=1`))["user-courses"].map(o=>o.course);return s.length===0?[]:(await this.request(`/courses?ids[]=${s.join("&ids[]=")}`)).courses}async getSections(e){return e.length===0?[]:(await this.request(`/sections?ids[]=${e.join("&ids[]=")}`)).sections}async getUnits(e){return e.length===0?[]:(await this.request(`/units?ids[]=${e.join("&ids[]=")}`)).units}async getLessons(e){return e.length===0?[]:(await this.request(`/lessons?ids[]=${e.join("&ids[]=")}`)).lessons}async getStep(e){return(await this.request(`/steps/${e}`)).steps[0]}async getSteps(e){return e.length===0?[]:(await this.request(`/steps?ids[]=${e.join("&ids[]=")}`)).steps}async createAttempt(e){return(await this.request("/attempts",{method:"POST",body:JSON.stringify({attempt:{step:e}})})).attempts[0]}async getAttempt(e){let t=await this.request(`/attempts?step=${e}&user=me`);return t.attempts.length>0?t.attempts[0]:this.createAttempt(e)}async submitSolution(e,t,s){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:{language:t,code:s}}})})).submissions[0]}async submitQuiz(e,t){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:t}})})).submissions[0]}async getSubmission(e){return(await this.request(`/submissions/${e}`)).submissions[0]}async getStepProgress(e){try{return(await this.request(`/progresses/step-${e}`)).progresses[0]||null}catch{return null}}};var c=m(require("vscode")),w=m(require("path")),d=m(require("fs")),P=class{constructor(e,t){this.context=e;this.api=t}panel;currentStep;currentAttempt;async showStep(e){this.currentStep=e;let{step:t}=e;this.panel||(this.panel=c.window.createWebviewPanel("stepikStep","Stepik Task",c.ViewColumn.Beside,{enableScripts:!0,retainContextWhenHidden:!0}),this.panel.onDidDispose(()=>{this.panel=void 0}),this.panel.webview.onDidReceiveMessage(i=>this.handleMessage(i),void 0,this.context.subscriptions)),["choice","string","number"].includes(t.block.name)&&(this.currentAttempt=await this.api.createAttempt(t.id)),this.panel.title=`Step ${t.position}`,this.panel.webview.html=this.getHtmlContent(t)}async handleMessage(e){switch(e.command){case"selectLanguage":e.language&&this.currentStep&&await this.createSolutionFile(this.currentStep,e.language);break;case"submitQuiz":await this.submitQuiz(e);break;case"restart":this.currentStep&&(this.currentAttempt=await this.api.createAttempt(this.currentStep.step.id),this.panel&&(this.panel.webview.html=this.getHtmlContent(this.currentStep.step)));break}}async submitQuiz(e){if(!this.currentStep||!this.currentAttempt){c.window.showErrorMessage("No active quiz");return}let t=this.currentStep.step.block.name,s={};t==="choice"?s.choices=e.choices:t==="string"?s.text=e.text:t==="number"&&(s.number=e.number);try{let i=await this.api.submitQuiz(this.currentAttempt.id,s),o=await this.pollSubmissionResult(i.id);if(o.status==="correct")c.window.showInformationMessage(`\u2705 Correct! Score: ${o.score}`);else{let r=o.hint||o.feedback||"Wrong answer";c.window.showErrorMessage(`\u274C ${o.status}: ${r}`)}}catch(i){c.window.showErrorMessage(`Submission failed: ${i}`)}}async pollSubmissionResult(e,t=30,s=1e3){for(let i=0;i<t;i++){let o=await this.api.getSubmission(e);if(o.status!=="evaluation")return o;await new Promise(r=>setTimeout(r,s))}throw new Error("Submission evaluation timeout")}async createSolutionFile(e,t){let{step:s,courseName:i,lessonTitle:o}=e,r=j=>j.replace(/[<>:"/\\|?*]/g,"_").substring(0,50),p=r(i),l=r(o),h=c.workspace.workspaceFolders?.[0];if(!h){c.window.showErrorMessage("Please open a workspace folder first");return}let f=w.join(h.uri.fsPath,p,l);d.mkdirSync(f,{recursive:!0});let M=this.getFileExtension(t),L=`step-${s.position}${M}`,S=w.join(f,L),D=s.block.options?.code_templates?.[t]||"";d.existsSync(S)||d.writeFileSync(S,D);let _=await c.workspace.openTextDocument(S);await c.window.showTextDocument(_,c.ViewColumn.One),this.storeStepMapping(S,s.id,t)}storeStepMapping(e,t,s){let i=c.workspace.workspaceFolders?.[0];if(!i)return;let o=w.join(i.uri.fsPath,".stepik","mapping.json"),r={};d.existsSync(o)?r=JSON.parse(d.readFileSync(o,"utf8")):d.mkdirSync(w.dirname(o),{recursive:!0}),r[e]={stepId:t,language:s},d.writeFileSync(o,JSON.stringify(r,null,2))}getFileExtension(e){return{python3:".py",python:".py",cpp:".cpp",cpp11:".cpp",cpp14:".cpp",cpp17:".cpp",cpp20:".cpp",c:".c",c11:".c",java:".java",java8:".java",java11:".java",java17:".java",javascript:".js",typescript:".ts",kotlin:".kt",go:".go",rust:".rs",csharp:".cs",ruby:".rb",php:".php",scala:".scala",haskell:".hs",sql:".sql"}[e]||".txt"}getHtmlContent(e){let t=e.block.name,s=t==="code",i=["choice","string","number"].includes(t),o=e.block.options?.code_templates?Object.keys(e.block.options.code_templates):[],r=s&&o.length>0?this.getLanguageSelectorHtml(o):"",p=i?this.getQuizHtml(e):"",l=e.block.options?.samples||[],h=l.length>0?this.getSamplesHtml(l):"";return`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${this.getStyles()}
    </style>
</head>
<body>
    <div class="task-type">${e.block.name.toUpperCase()}</div>
    
    <div class="task-content">
        ${e.block.text}
    </div>
    
    ${r}
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
        `}getQuizHtml(e){let t=e.block.name,s=this.currentAttempt?.dataset?.options||[],i=this.currentAttempt?.dataset?.is_multiple_choice??!1;if(t==="choice"){let o=i?"checkbox":"radio";return`
                <div class="quiz-section">
                    <div class="quiz-options">
                        ${s.map((r,p)=>`
                            <label class="quiz-option">
                                <input type="${o}" name="choice" value="${p}" data-index="${p}">
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
            `:""}escapeHtml(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}};var u=m(require("vscode")),E=m(require("fs")),B=m(require("path")),I=class{constructor(e,t){this.api=e;this.treeProvider=t}async submitCurrentFile(){let e=u.window.activeTextEditor;if(!e){u.window.showErrorMessage("No active file to submit");return}let t=e.document.uri.fsPath,s=this.getStepMapping(t);if(!s){u.window.showErrorMessage("This file is not associated with a Stepik step. Open a step from the tree first.");return}let{stepId:i,language:o}=s,r=e.document.getText();await u.window.withProgress({location:u.ProgressLocation.Notification,title:"Submitting solution...",cancellable:!1},async p=>{try{p.report({message:"Creating attempt..."});let l=await this.api.createAttempt(i);p.report({message:"Sending code..."});let h=await this.api.submitSolution(l.id,o,r);p.report({message:"Waiting for result..."});let f=await this.pollSubmissionResult(h.id);this.showResult(f),this.treeProvider.refresh()}catch(l){u.window.showErrorMessage(`Submission failed: ${l}`)}})}getStepMapping(e){let t=u.workspace.workspaceFolders?.[0];if(!t)return;let s=B.join(t.uri.fsPath,".stepik","mapping.json");return E.existsSync(s)?JSON.parse(E.readFileSync(s,"utf8"))[e]:void 0}async pollSubmissionResult(e,t=30,s=1e3){for(let i=0;i<t;i++){let o=await this.api.getSubmission(e);if(o.status!=="evaluation")return o;await new Promise(r=>setTimeout(r,s))}throw new Error("Submission evaluation timeout")}showResult(e){if(e.status==="correct")u.window.showInformationMessage(`\u2705 Correct! Score: ${e.score}`,"OK");else{let s=e.hint||e.feedback||"Wrong answer";u.window.showErrorMessage(`\u274C ${e.status}: ${s}`,"OK")}}};var $,b;async function W(n){let e=new x(n);$=new C(e),b=new T($);let t=new P(n,$),s=new I($,b),i=g.window.createTreeView("stepikCourses",{treeDataProvider:b,showCollapseAll:!0});n.subscriptions.push(g.commands.registerCommand("stepik.login",async()=>{await e.login(),b.refresh()}),g.commands.registerCommand("stepik.logout",async()=>{await e.logout(),b.refresh()}),g.commands.registerCommand("stepik.refresh",()=>{b.refresh()}),g.commands.registerCommand("stepik.openStep",async o=>{await t.showStep(o)}),g.commands.registerCommand("stepik.submit",async()=>{await s.submitCurrentFile()}),i),await e.isLoggedIn()&&b.refresh()}function J(){}0&&(module.exports={activate,deactivate});
