"use strict";var q=Object.create;var k=Object.defineProperty;var B=Object.getOwnPropertyDescriptor;var U=Object.getOwnPropertyNames;var H=Object.getPrototypeOf,V=Object.prototype.hasOwnProperty;var R=(n,e)=>{for(var t in e)k(n,t,{get:e[t],enumerable:!0})},D=(n,e,t,s)=>{if(e&&typeof e=="object"||typeof e=="function")for(let o of U(e))!V.call(n,o)&&o!==t&&k(n,o,{get:()=>e[o],enumerable:!(s=B(e,o))||s.enumerable});return n};var l=(n,e,t)=>(t=n!=null?q(H(n)):{},D(e||!n||!n.__esModule?k(t,"default",{value:n,enumerable:!0}):t,n)),K=n=>D(k({},"__esModule",{value:!0}),n);var Y={};R(Y,{activate:()=>J,deactivate:()=>z});module.exports=K(Y);var m=l(require("vscode"));var b=l(require("vscode")),j="stepik.clientId",A="stepik.clientSecret",y="stepik.accessToken",x=class{secretStorage;constructor(e){this.secretStorage=e.secrets}async login(){let e=await b.window.showInputBox({prompt:"Enter your Stepik Client ID",placeHolder:"Client ID from https://stepik.org/oauth2/applications/",ignoreFocusOut:!0});if(!e)return!1;let t=await b.window.showInputBox({prompt:"Enter your Stepik Client Secret",placeHolder:"Client Secret",password:!0,ignoreFocusOut:!0});if(!t)return!1;try{let s=await this.getAccessToken(e,t);return await this.secretStorage.store(j,e),await this.secretStorage.store(A,t),await this.secretStorage.store(y,s),b.window.showInformationMessage("Successfully logged in to Stepik!"),!0}catch(s){return b.window.showErrorMessage(`Failed to login: ${s}`),!1}}async getAccessToken(e,t){let s=Buffer.from(`${e}:${t}`).toString("base64"),o=await fetch("https://stepik.org/oauth2/token/",{method:"POST",headers:{Authorization:`Basic ${s}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials"});if(!o.ok)throw new Error(`HTTP ${o.status}: ${o.statusText}`);return(await o.json()).access_token}async logout(){await this.secretStorage.delete(j),await this.secretStorage.delete(A),await this.secretStorage.delete(y),b.window.showInformationMessage("Logged out from Stepik")}async isLoggedIn(){return!!await this.secretStorage.get(y)}async getToken(){return await this.secretStorage.get(y)}};var a=l(require("vscode")),T=class{constructor(e){this.api=e}_onDidChangeTreeData=new a.EventEmitter;onDidChangeTreeData=this._onDidChangeTreeData.event;refresh(){this._onDidChangeTreeData.fire()}getTreeItem(e){switch(e.type){case"course":return this.createCourseItem(e.course);case"section":return this.createSectionItem(e.section);case"lesson":return this.createLessonItem(e.lesson);case"step":return this.createStepItem(e.step,e.courseName,e.lessonTitle)}}async getChildren(e){try{if(!e)return(await this.api.getUserCourses()).map(s=>({type:"course",course:s}));switch(e.type){case"course":return(await this.api.getSections(e.course.sections)).sort((s,o)=>s.position-o.position).map(s=>({type:"section",section:s,courseName:e.course.title}));case"section":{let t=await this.api.getUnits(e.section.units),s=t.map(i=>i.lesson),o=await this.api.getLessons(s),r=new Map(t.map(i=>[i.lesson,i.position]));return o.sort((i,c)=>(r.get(i.id)||0)-(r.get(c.id)||0)).map(i=>({type:"lesson",lesson:i,courseName:e.courseName}))}case"lesson":return(await this.api.getSteps(e.lesson.steps)).sort((s,o)=>s.position-o.position).map(s=>({type:"step",step:s,courseName:e.courseName,lessonTitle:e.lesson.title}));default:return[]}}catch(t){return String(t).includes("Not authenticated")?a.window.showWarningMessage("Please login to Stepik first","Login").then(s=>{s==="Login"&&a.commands.executeCommand("stepik.login")}):a.window.showErrorMessage(`Error loading data: ${t}`),[]}}createCourseItem(e){let t=new a.TreeItem(e.title,a.TreeItemCollapsibleState.Collapsed);return t.iconPath=new a.ThemeIcon("book"),t.contextValue="course",t}createSectionItem(e){let t=new a.TreeItem(e.title,a.TreeItemCollapsibleState.Collapsed);return t.iconPath=new a.ThemeIcon("folder"),t.contextValue="section",t}createLessonItem(e){let t=new a.TreeItem(e.title,a.TreeItemCollapsibleState.Collapsed);return t.iconPath=new a.ThemeIcon("file-text"),t.contextValue="lesson",t}createStepItem(e,t,s){let o=e.block.name,r=`Step ${e.position}: ${this.getStepTypeLabel(o)}`,i=new a.TreeItem(r,a.TreeItemCollapsibleState.None);return i.iconPath=this.getStepIcon(o),i.contextValue="step",i.command={command:"stepik.openStep",title:"Open Step",arguments:[{step:e,courseName:t,lessonTitle:s}]},i}getStepTypeLabel(e){return{code:"Code",choice:"Quiz",text:"Text",string:"Short Answer",number:"Number",math:"Math",sorting:"Sorting",matching:"Matching","fill-blanks":"Fill Blanks","free-answer":"Free Answer",video:"Video"}[e]||e}getStepIcon(e){let t={code:"code",choice:"checklist",text:"book",video:"play-circle",string:"whole-word",number:"symbol-number"};return new a.ThemeIcon(t[e]||"circle-outline")}};var W="https://stepik.org/api",C=class{constructor(e){this.auth=e}async request(e,t={}){let s=await this.auth.getToken();if(!s)throw new Error("Not authenticated. Please login first.");let o=await fetch(`${W}${e}`,{...t,headers:{Authorization:`Bearer ${s}`,"Content-Type":"application/json",...t.headers}});if(!o.ok)throw new Error(`API Error: ${o.status} ${o.statusText}`);return o.json()}async getCurrentUser(){return{id:(await this.request("/stepics/1")).users[0].id}}async getUserCourses(){let e=await this.getCurrentUser(),s=(await this.request(`/user-courses?user=${e.id}&page=1`))["user-courses"].map(r=>r.course);return s.length===0?[]:(await this.request(`/courses?ids[]=${s.join("&ids[]=")}`)).courses}async getSections(e){return e.length===0?[]:(await this.request(`/sections?ids[]=${e.join("&ids[]=")}`)).sections}async getUnits(e){return e.length===0?[]:(await this.request(`/units?ids[]=${e.join("&ids[]=")}`)).units}async getLessons(e){return e.length===0?[]:(await this.request(`/lessons?ids[]=${e.join("&ids[]=")}`)).lessons}async getStep(e){return(await this.request(`/steps/${e}`)).steps[0]}async getSteps(e){return e.length===0?[]:(await this.request(`/steps?ids[]=${e.join("&ids[]=")}`)).steps}async createAttempt(e){return(await this.request("/attempts",{method:"POST",body:JSON.stringify({attempt:{step:e}})})).attempts[0]}async submitSolution(e,t,s){return(await this.request("/submissions",{method:"POST",body:JSON.stringify({submission:{attempt:e,reply:{language:t,code:s}}})})).submissions[0]}async getSubmission(e){return(await this.request(`/submissions/${e}`)).submissions[0]}async getStepProgress(e){try{return(await this.request(`/progresses/step-${e}`)).progresses[0]||null}catch{return null}}};var d=l(require("vscode")),w=l(require("path")),u=l(require("fs")),P=class{constructor(e,t){this.context=e;this.api=t}panel;currentStep;async showStep(e){this.currentStep=e;let{step:t,courseName:s,lessonTitle:o}=e;this.panel||(this.panel=d.window.createWebviewPanel("stepikStep","Stepik Task",d.ViewColumn.Beside,{enableScripts:!0,retainContextWhenHidden:!0}),this.panel.onDidDispose(()=>{this.panel=void 0}),this.panel.webview.onDidReceiveMessage(r=>this.handleMessage(r),void 0,this.context.subscriptions)),this.panel.title=`Step ${t.position}`,this.panel.webview.html=this.getHtmlContent(t)}async handleMessage(e){switch(e.command){case"selectLanguage":e.language&&this.currentStep&&await this.createSolutionFile(this.currentStep,e.language);break}}async createSolutionFile(e,t){let{step:s,courseName:o,lessonTitle:r}=e,i=O=>O.replace(/[<>:"/\\|?*]/g,"_").substring(0,50),c=i(o),g=i(r),v=d.workspace.workspaceFolders?.[0];if(!v){d.window.showErrorMessage("Please open a workspace folder first");return}let f=w.join(v.uri.fsPath,c,g);u.mkdirSync(f,{recursive:!0});let L=this.getFileExtension(t),M=`step-${s.position}${L}`,S=w.join(f,M),F=s.block.options?.code_templates?.[t]||"";u.existsSync(S)||u.writeFileSync(S,F);let _=await d.workspace.openTextDocument(S);await d.window.showTextDocument(_,d.ViewColumn.One),this.storeStepMapping(S,s.id,t)}storeStepMapping(e,t,s){let o=d.workspace.workspaceFolders?.[0];if(!o)return;let r=w.join(o.uri.fsPath,".stepik","mapping.json"),i={};u.existsSync(r)?i=JSON.parse(u.readFileSync(r,"utf8")):u.mkdirSync(w.dirname(r),{recursive:!0}),i[e]={stepId:t,language:s},u.writeFileSync(r,JSON.stringify(i,null,2))}getFileExtension(e){return{python3:".py",python:".py",cpp:".cpp",cpp11:".cpp",cpp14:".cpp",cpp17:".cpp",cpp20:".cpp",c:".c",c11:".c",java:".java",java8:".java",java11:".java",java17:".java",javascript:".js",typescript:".ts",kotlin:".kt",go:".go",rust:".rs",csharp:".cs",ruby:".rb",php:".php",scala:".scala",haskell:".hs",sql:".sql"}[e]||".txt"}getHtmlContent(e){let t=e.block.name==="code",s=e.block.options?.code_templates?Object.keys(e.block.options.code_templates):[],o=t&&s.length>0?`
                <div class="language-selector">
                    <label>Select Language:</label>
                    <select id="language-select">
                        <option value="">-- Choose --</option>
                        ${s.map(c=>`<option value="${c}">${c}</option>`).join("")}
                    </select>
                    <button id="open-btn" disabled>Open in Editor</button>
                </div>
            `:"",r=e.block.options?.samples||[],i=r.length>0?`
                <div class="samples">
                    <h3>Samples</h3>
                    ${r.map(([c,g],v)=>`
                        <div class="sample">
                            <div class="sample-header">Sample ${v+1}</div>
                            <div class="sample-io">
                                <div class="sample-input">
                                    <strong>Input:</strong>
                                    <pre>${this.escapeHtml(c)}</pre>
                                </div>
                                <div class="sample-output">
                                    <strong>Output:</strong>
                                    <pre>${this.escapeHtml(g)}</pre>
                                </div>
                            </div>
                        </div>
                    `).join("")}
                </div>
            `:"";return`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
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
        select, button {
            padding: 8px 12px;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 4px;
            cursor: pointer;
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        button:not(:disabled):hover {
            background: var(--vscode-button-hoverBackground);
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
    </style>
</head>
<body>
    <div class="task-type">${e.block.name.toUpperCase()}</div>
    
    <div class="task-content">
        ${e.block.text}
    </div>
    
    ${o}
    ${i}
    
    <script>
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
    </script>
</body>
</html>`}escapeHtml(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")}};var p=l(require("vscode")),E=l(require("fs")),N=l(require("path")),I=class{constructor(e,t){this.api=e;this.treeProvider=t}async submitCurrentFile(){let e=p.window.activeTextEditor;if(!e){p.window.showErrorMessage("No active file to submit");return}let t=e.document.uri.fsPath,s=this.getStepMapping(t);if(!s){p.window.showErrorMessage("This file is not associated with a Stepik step. Open a step from the tree first.");return}let{stepId:o,language:r}=s,i=e.document.getText();await p.window.withProgress({location:p.ProgressLocation.Notification,title:"Submitting solution...",cancellable:!1},async c=>{try{c.report({message:"Creating attempt..."});let g=await this.api.createAttempt(o);c.report({message:"Sending code..."});let v=await this.api.submitSolution(g.id,r,i);c.report({message:"Waiting for result..."});let f=await this.pollSubmissionResult(v.id);this.showResult(f),this.treeProvider.refresh()}catch(g){p.window.showErrorMessage(`Submission failed: ${g}`)}})}getStepMapping(e){let t=p.workspace.workspaceFolders?.[0];if(!t)return;let s=N.join(t.uri.fsPath,".stepik","mapping.json");return E.existsSync(s)?JSON.parse(E.readFileSync(s,"utf8"))[e]:void 0}async pollSubmissionResult(e,t=30,s=1e3){for(let o=0;o<t;o++){let r=await this.api.getSubmission(e);if(r.status!=="evaluation")return r;await new Promise(i=>setTimeout(i,s))}throw new Error("Submission evaluation timeout")}showResult(e){if(e.status==="correct")p.window.showInformationMessage(`\u2705 Correct! Score: ${e.score}`,"OK");else{let s=e.hint||e.feedback||"Wrong answer";p.window.showErrorMessage(`\u274C ${e.status}: ${s}`,"OK")}}};var $,h;async function J(n){let e=new x(n);$=new C(e),h=new T($);let t=new P(n,$),s=new I($,h),o=m.window.createTreeView("stepikCourses",{treeDataProvider:h,showCollapseAll:!0});n.subscriptions.push(m.commands.registerCommand("stepik.login",async()=>{await e.login(),h.refresh()}),m.commands.registerCommand("stepik.logout",async()=>{await e.logout(),h.refresh()}),m.commands.registerCommand("stepik.refresh",()=>{h.refresh()}),m.commands.registerCommand("stepik.openStep",async r=>{await t.showStep(r)}),m.commands.registerCommand("stepik.submit",async()=>{await s.submitCurrentFile()}),o),await e.isLoggedIn()&&h.refresh()}function z(){}0&&(module.exports={activate,deactivate});
