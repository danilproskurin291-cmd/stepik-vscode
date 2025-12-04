"use strict";var U=Object.create;var k=Object.defineProperty;var W=Object.getOwnPropertyDescriptor;var V=Object.getOwnPropertyNames;var K=Object.getPrototypeOf,J=Object.prototype.hasOwnProperty;var Y=(a,e)=>{for(var t in e)k(a,t,{get:e[t],enumerable:!0})},_=(a,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of V(e))!J.call(a,r)&&r!==t&&k(a,r,{get:()=>e[r],enumerable:!(s=W(e,r))||s.enumerable});return a};var m=(a,e,t)=>(t=a!=null?U(K(a)):{},_(e||!a||!a.__esModule?k(t,"default",{value:a,enumerable:!0}):t,a)),G=a=>_(k({},"__esModule",{value:!0}),a);var se={};Y(se,{activate:()=>ee,deactivate:()=>te});module.exports=G(se);var d=m(require("vscode")),M=m(require("fs")),j=m(require("path")),N=m(require("os"));var w=m(require("vscode")),z="stepik.clientId",B="stepik.clientSecret",y="stepik.accessToken",x=class{secretStorage;constructor(e){this.secretStorage=e.secrets}async login(){let e=await w.window.showInputBox({prompt:"Enter your Stepik Client ID",placeHolder:"Client ID from https://stepik.org/oauth2/applications/",ignoreFocusOut:!0});if(!e)return!1;let t=await w.window.showInputBox({prompt:"Enter your Stepik Client Secret",placeHolder:"Client Secret",password:!0,ignoreFocusOut:!0});if(!t)return!1;try{let s=await this.getAccessToken(e,t);return await this.secretStorage.store(z,e),await this.secretStorage.store(B,t),await this.secretStorage.store(y,s),w.window.showInformationMessage("Successfully logged in to Stepik!"),!0}catch(s){return w.window.showErrorMessage(`Failed to login: ${s}`),!1}}async getAccessToken(e,t){let s=Buffer.from(`${e}:${t}`).toString("base64"),r=await fetch("https://stepik.org/oauth2/token/",{method:"POST",headers:{Authorization:`Basic ${s}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});if(!r.ok)throw new Error(`HTTP ${r.status}: ${r.statusText}`);return(await r.json()).access_token}async logout(){await this.secretStorage.delete(z),await this.secretStorage.delete(B),await this.secretStorage.delete(y),w.window.showInformationMessage("Logged out from Stepik")}async isLoggedIn(){return!!await this.secretStorage.get(y)}async getToken(){return await this.secretStorage.get(y)}};var n=m(require("vscode")),q=new n.ThemeColor("charts.green"),L=new n.ThemeColor("charts.yellow"),P=class{constructor(e){this.api=e}_onDidChangeTreeData=new n.EventEmitter;onDidChangeTreeData=this._onDidChangeTreeData.event;refresh(){this._onDidChangeTreeData.fire()}getTreeItem(e){switch(e.type){case"course":return this.createCourseItem(e.course,e.courseProgress);case"section":return this.createSectionItem(e.section);case"lesson":return this.createLessonItem(e.lesson,e.progressMap);case"step":return this.createStepItem(e.step,e.courseName,e.lessonTitle,e.progressMap)}}async getChildren(e){try{if(!e){let t=await this.api.getUserCourses(),s=t.map(o=>o.progress).filter(o=>o),r=await this.api.getProgressByIds(s);return t.map(o=>({type:"course",course:o,courseProgress:r.get(o.progress)}))}switch(e.type){case"course":return(await this.api.getSections(e.course.sections)).sort((s,r)=>s.position-r.position).map(s=>({type:"section",section:s,courseName:e.course.title}));case"section":{let t=await this.api.getUnits(e.section.units),s=t.map(c=>c.lesson),r=await this.api.getLessons(s),o=r.map(c=>c.progress).filter(c=>c),i=await this.api.getProgressByIds(o),p=new Map(t.map(c=>[c.lesson,c.position]));return r.sort((c,h)=>(p.get(c.id)||0)-(p.get(h.id)||0)).map(c=>({type:"lesson",lesson:c,courseName:e.courseName,progressMap:i}))}case"lesson":{let t=await this.api.getSteps(e.lesson.steps),s=t.map(o=>o.progress).filter(o=>o),r=await this.api.getProgressByIds(s);return t.sort((o,i)=>o.position-i.position).map(o=>({type:"step",step:o,courseName:e.courseName,lessonTitle:e.lesson.title,progressMap:r}))}default:return[]}}catch(t){return String(t).includes("Not authenticated")?n.window.showWarningMessage("Please login to Stepik first","Login").then(s=>{s==="Login"&&n.commands.executeCommand("stepik.login")}):n.window.showErrorMessage(`Error loading data: ${t}`),[]}}createCourseItem(e,t){let s=new n.TreeItem(e.title,n.TreeItemCollapsibleState.Collapsed);return e.is_certificate_issued||t?.is_passed?s.iconPath=new n.ThemeIcon("book",q):t&&t.n_steps_passed>0?s.iconPath=new n.ThemeIcon("book",L):s.iconPath=new n.ThemeIcon("book"),s.contextValue="course",s}createSectionItem(e){let t=new n.TreeItem(e.title,n.TreeItemCollapsibleState.Collapsed);return t.iconPath=new n.ThemeIcon("folder"),t.contextValue="section",t}createLessonItem(e,t){let s=new n.TreeItem(e.title,n.TreeItemCollapsibleState.Collapsed),r=t?.get(e.progress);return r?r.is_passed?s.iconPath=new n.ThemeIcon("file-text",q):r.n_steps_passed>0?s.iconPath=new n.ThemeIcon("file-text",L):s.iconPath=new n.ThemeIcon("file-text"):s.iconPath=new n.ThemeIcon("file-text"),s.contextValue="lesson",s}createStepItem(e,t,s,r){let o=e.block.name,i=`Step ${e.position}: ${this.getStepTypeLabel(o)}`,p=new n.TreeItem(i,n.TreeItemCollapsibleState.None),h=r?.get(e.progress)?.is_passed||!1,v=this.getStepIconName(o);return h?p.iconPath=new n.ThemeIcon(v,q):p.iconPath=new n.ThemeIcon(v),p.contextValue="step",p.command={command:"stepik.openStep",title:"Open Step",arguments:[{step:e,courseName:t,lessonTitle:s}]},p}getStepTypeLabel(e){return{code:"Code",choice:"Quiz",text:"Text",string:"Short Answer",number:"Number",math:"Math",sorting:"Sorting",matching:"Matching","fill-blanks":"Fill Blanks","free-answer":"Free Answer",video:"Video"}[e]||e}getStepIcon(e){let t={code:"code",choice:"checklist",text:"book",video:"play-circle",string:"whole-word",number:"symbol-number"};return new n.ThemeIcon(t[e]||"circle-outline")}getStepIconName(e){return{code:"code",choice:"checklist",text:"book",video:"play-circle",string:"whole-word",number:"symbol-number"}[e]||"circle-outline"}};var X="https://stepik.org/api",T=class{constructor(e){this.auth=e}async request(e,t={}){let s=await this.auth.getToken();if(!s)throw new Error("Not authenticated. Please login first.");let r=await fetch(`${X}${e}`,{...t,headers:{Authorization:`Bearer ${s}`,"Content-Type":"application/json",...t.headers}});if(!r.ok)throw new Error(`API Error: ${r.status} ${r.statusText}`);return r.json()}async getCurrentUser(){return{id:(await this.request("/stepics/1")).users[0].id}}async getUserCourses(){let e=await this.getCurrentUser(),s=(await this.request(`/user-courses?user=${e.id}&page=1`))["user-courses"].map(o=>o.course);return s.length===0?[]:(await this.request(`/courses?ids[]=${s.join("&ids[]=")}`)).courses}async getSections(e){return e.length===0?[]:(await this.request(`/sections?ids[]=${e.join("&ids[]=")}`)).sections}async getUnits(e){return e.length===0?[]:(await this.request(`/units?ids[]=${e.join("&ids[]=")}`)).units}async getLessons(e){return e.length===0?[]:(await this.request(`/lessons?ids[]=${e.join("&ids[]=")}`)).lessons}async getStep(e){return(await this.request(`/steps/${e}`)).steps[0]}async getSteps(e){return e.length===0?[]:(await this.request(`/steps?ids[]=${e.join("&ids[]=")}`)).steps}async createAttempt(e){return(await this.request("/attempts",{method:"POST",body:JSON.stringify({attempt:{step:e}})})).attempts[0]}async getAttempt(e){let t=await this.request(`/attempts?step=${e}&user=me`);return t.attempts.length>0?t.attempts[0]:this.createAttempt(e)}async submitSolution(e,t,s){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:{language:t,code:s}}})})).submissions[0]}async submitQuiz(e,t){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:t}})})).submissions[0]}async getSubmission(e){return(await this.request(`/submissions/${e}`)).submissions[0]}async getProgressByIds(e){let t=new Map;if(e.length===0)return t;try{let s=e.filter(i=>i);if(s.length===0)return t;let r=s.map(i=>`ids[]=${i}`).join("&"),o=await this.request(`/progresses?${r}`);for(let i of o.progresses)t.set(i.id,i)}catch{}return t}async getStepProgress(e){try{return(await this.request(`/progresses/step-${e}`)).progresses[0]||null}catch{return null}}async getStepsProgress(e){let t=new Map;if(e.length===0)return t;try{let s=e.map(o=>`step-${o}`).join("&ids[]="),r=await this.request(`/progresses?ids[]=${s}`);for(let o of r.progresses){let i=parseInt(o.id.replace("step-",""));t.set(i,o.is_passed)}}catch{}return t}async getCourseProgress(e){try{return(await this.request(`/progresses/course-${e}`)).progresses[0]||null}catch{return null}}};var u=m(require("vscode")),f=m(require("path")),g=m(require("fs")),C=class{constructor(e,t,s){this.context=e;this.api=t;this.treeProvider=s}panel;currentStep;currentAttempt;async showStep(e){this.currentStep=e;let{step:t}=e;this.panel||(this.panel=u.window.createWebviewPanel("stepikStep","Stepik Task",u.ViewColumn.Beside,{enableScripts:!0,retainContextWhenHidden:!0}),this.panel.onDidDispose(()=>{this.panel=void 0}),this.panel.webview.onDidReceiveMessage(r=>this.handleMessage(r),void 0,this.context.subscriptions)),["choice","string","number"].includes(t.block.name)&&(this.currentAttempt=await this.api.createAttempt(t.id)),this.panel.title=`Step ${t.position}`,this.panel.webview.html=this.getHtmlContent(t)}async handleMessage(e){switch(e.command){case"selectLanguage":e.language&&this.currentStep&&await this.createSolutionFile(this.currentStep,e.language);break;case"submitQuiz":await this.submitQuiz(e);break;case"restart":this.currentStep&&(this.currentAttempt=await this.api.createAttempt(this.currentStep.step.id),this.panel&&(this.panel.webview.html=this.getHtmlContent(this.currentStep.step)));break}}async submitQuiz(e){if(!this.currentStep||!this.currentAttempt){u.window.showErrorMessage("No active quiz");return}let t=this.currentStep.step.block.name,s={};t==="choice"?s.choices=e.choices:t==="string"?s.text=e.text:t==="number"&&(s.number=e.number);try{let r=await this.api.submitQuiz(this.currentAttempt.id,s),o=await this.pollSubmissionResult(r.id);if(o.status==="correct")u.window.showInformationMessage(`\u2705 Correct! Score: ${o.score}`),this.treeProvider.refresh();else{let i=o.hint||o.feedback||"Wrong answer";u.window.showErrorMessage(`\u274C ${o.status}: ${i}`)}}catch(r){u.window.showErrorMessage(`Submission failed: ${r}`)}}async pollSubmissionResult(e,t=30,s=1e3){for(let r=0;r<t;r++){let o=await this.api.getSubmission(e);if(o.status!=="evaluation")return o;await new Promise(i=>setTimeout(i,s))}throw new Error("Submission evaluation timeout")}async createSolutionFile(e,t){let{step:s,courseName:r,lessonTitle:o}=e,i=Q=>Q.replace(/[<>:"/\\|?*]/g,"_").substring(0,50),p=i(r),c=i(o),h=u.workspace.workspaceFolders?.[0];if(!h){u.window.showErrorMessage("Please open a workspace folder first");return}let v=f.join(h.uri.fsPath,p,c);g.mkdirSync(v,{recursive:!0});let O=this.getFileExtension(t),F=`step-${s.position}${O}`,S=f.join(v,F),R=s.block.options?.code_templates?.[t]||"";g.existsSync(S)||g.writeFileSync(S,R);let H=await u.workspace.openTextDocument(S);await u.window.showTextDocument(H,u.ViewColumn.One),this.storeStepMapping(S,s.id,t)}storeStepMapping(e,t,s){let r=u.workspace.workspaceFolders?.[0];if(!r)return;let o=f.join(r.uri.fsPath,".stepik","mapping.json"),i={};g.existsSync(o)?i=JSON.parse(g.readFileSync(o,"utf8")):g.mkdirSync(f.dirname(o),{recursive:!0}),i[e]={stepId:t,language:s},g.writeFileSync(o,JSON.stringify(i,null,2))}getFileExtension(e){return{python3:".py",python:".py",cpp:".cpp",cpp11:".cpp",cpp14:".cpp",cpp17:".cpp",cpp20:".cpp",c:".c",c11:".c",java:".java",java8:".java",java11:".java",java17:".java",javascript:".js",typescript:".ts",kotlin:".kt",go:".go",rust:".rs",csharp:".cs",ruby:".rb",php:".php",scala:".scala",haskell:".hs",sql:".sql"}[e]||".txt"}getHtmlContent(e){let t=e.block.name,s=t==="code",r=["choice","string","number"].includes(t),o=e.block.options?.code_templates?Object.keys(e.block.options.code_templates):[],i=s&&o.length>0?this.getLanguageSelectorHtml(o):"",p=r?this.getQuizHtml(e):"",c=e.block.options?.samples||[],h=c.length>0?this.getSamplesHtml(c):"";return`<!DOCTYPE html>
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
        `}getQuizHtml(e){let t=e.block.name,s=this.currentAttempt?.dataset?.options||[],r=this.currentAttempt?.dataset?.is_multiple_choice??!1;if(t==="choice"){let o=r?"checkbox":"radio";return`
                <div class="quiz-section">
                    <div class="quiz-options">
                        ${s.map((i,p)=>`
                            <label class="quiz-option">
                                <input type="${o}" name="choice" value="${p}" data-index="${p}">
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
                ${e.map(([t,s],r)=>`
                    <div class="sample">
                        <div class="sample-header">Sample ${r+1}</div>
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
            `:""}escapeHtml(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}};var l=m(require("vscode")),E=m(require("fs")),D=m(require("path")),I=class{constructor(e,t){this.api=e;this.treeProvider=t}async submitCurrentFile(){let e=l.window.activeTextEditor;if(!e){l.window.showErrorMessage("No active file to submit");return}let t=e.document.uri.fsPath,s=this.getStepMapping(t);if(!s){l.window.showErrorMessage("This file is not associated with a Stepik step. Open a step from the tree first.");return}let{stepId:r,language:o}=s,i=e.document.getText();await l.window.withProgress({location:l.ProgressLocation.Notification,title:"Submitting solution...",cancellable:!1},async p=>{try{p.report({message:"Creating attempt..."});let c=await this.api.createAttempt(r);p.report({message:"Sending code..."});let h=await this.api.submitSolution(c.id,o,i);p.report({message:"Waiting for result..."});let v=await this.pollSubmissionResult(h.id);this.showResult(v),this.treeProvider.refresh()}catch(c){l.window.showErrorMessage(`Submission failed: ${c}`)}})}getStepMapping(e){let t=l.workspace.workspaceFolders?.[0];if(!t)return;let s=D.join(t.uri.fsPath,".stepik","mapping.json");return E.existsSync(s)?JSON.parse(E.readFileSync(s,"utf8"))[e]:void 0}async pollSubmissionResult(e,t=30,s=1e3){for(let r=0;r<t;r++){let o=await this.api.getSubmission(e);if(o.status!=="evaluation")return o;await new Promise(i=>setTimeout(i,s))}throw new Error("Submission evaluation timeout")}showResult(e){if(e.status==="correct")l.window.showInformationMessage(`\u2705 Correct! Score: ${e.score}`,"OK");else{let s=e.hint||e.feedback||"Wrong answer";l.window.showErrorMessage(`\u274C ${e.status}: ${s}`,"OK")}}};var $,b,A=j.join(N.homedir(),".stepik");async function Z(){let a=d.workspace.workspaceFolders;M.existsSync(A)?(!a||a.length===0)&&await d.window.showInformationMessage("Open Stepik workspace folder (~/.stepik)?","Open","Later")==="Open"&&await d.commands.executeCommand("vscode.openFolder",d.Uri.file(A)):await d.window.showInformationMessage("Stepik workspace folder not found. Create ~/.stepik for storing your solutions?","Create","Cancel")==="Create"&&(M.mkdirSync(A,{recursive:!0}),await d.window.showInformationMessage("Workspace folder created. Open it now?","Open","Later")==="Open"&&await d.commands.executeCommand("vscode.openFolder",d.Uri.file(A)))}async function ee(a){let e=new x(a);$=new T(e),b=new P($);let t=new C(a,$,b),s=new I($,b),r=d.window.createTreeView("stepikCourses",{treeDataProvider:b,showCollapseAll:!0});a.subscriptions.push(d.commands.registerCommand("stepik.login",async()=>{await e.login(),b.refresh()}),d.commands.registerCommand("stepik.logout",async()=>{await e.logout(),b.refresh()}),d.commands.registerCommand("stepik.refresh",()=>{b.refresh()}),d.commands.registerCommand("stepik.openStep",async o=>{await t.showStep(o)}),d.commands.registerCommand("stepik.submit",async()=>{await s.submitCurrentFile()}),r),await e.isLoggedIn()&&b.refresh(),await Z()}function te(){}0&&(module.exports={activate,deactivate});
