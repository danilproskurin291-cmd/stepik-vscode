# Stepik for VS Code (Fork)

[[RU]](README.md)

> **Fork:** [su-mt/stepik-vscode](https://github.com/su-mt/stepik-vscode).
> **Author:** Danil Proskurin (꧁༒☬𝔉𝔜𝔡𝔡𝔡𝔡𝔰𝔰☬༒꧂).
> Solve [Stepik](https://stepik.org) problems directly in VS Code.

The project is distributed under GPL-3.0. This version adds comments with a
rich editor, the solutions forum, Markdown formatting, voting, formula
rendering, exams, step navigation, a built-in video player, per-account
workspaces, ZIP archives of solutions, and a progress panel.

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [First launch](#first-launch)
- [OAuth setup](#oauth-setup)
- [Login and course selection](#login-and-course-selection)
- [Interface](#interface)
- [Solving problems](#solving-problems)
- [Exams](#exams)
- [Video](#video)
- [Comments and solutions](#comments-and-solutions)
- [Math](#math)
- [Commands and shortcuts](#commands-and-shortcuts)
- [Solutions folder](#solutions-folder)
- [Accounts and archives](#accounts-and-archives)
- [Updating and uninstalling](#updating-and-uninstalling)
- [Troubleshooting](#troubleshooting)
- [Building from source](#building-from-source)
- [Limitations](#limitations)
- [Author](#author)
- [License](#license)

## Features

- OAuth login to Stepik;
- course, section, lesson, and step tree in the sidebar;
- passed and started progress markers;
- problem statement and answer form in a dedicated panel;
- **Back** and **Next** buttons for navigation inside a section;
- background preloading of neighbouring steps;
- solution submission from the editor;
- `~/stepik/<account-name>` solutions folder organized by course and lesson;
- a separate folder and ZIP archive for every Stepik account;
- the solutions folder is created automatically and does not need to be opened
  in VS Code;
- all graded Stepik problem types;
- exam sections with a timer and submission lock;
- built-in video player;
- progress panel with a day streak, points, percent complete, and points
  remaining to a certificate;
- comments, replies, voting, and sorting;
- solutions forum for every graded problem type;
- rich comment editor with live preview, Markdown mode, formulas, images, and
  code blocks;
- copy-link, edit, and delete actions for your own comments;
- KaTeX/MathML formula rendering.

## Requirements

- VS Code 1.85 or newer;
- a [stepik.org](https://stepik.org) account;
- your own Stepik OAuth application (takes a couple of minutes, see below);
- Node.js 18+ for building from source.

The extension is not an official Stepik client. It uses the public Stepik API
and your OAuth credentials.

## Installation

### Prebuilt VSIX

1. Open the
   [Releases](https://github.com/danilproskurin291-cmd/stepik-vscode/releases)
   page.
2. Download the latest `stepik-vscode-fork-0.4.4.vsix`.
3. Install it in one of these ways:
   - from a terminal:

     ```bash
     code --install-extension stepik-vscode-fork-0.4.4.vsix
     ```

   - or in VS Code: **Extensions → … → Install from VSIX…**, then select the
     downloaded file.
4. Reload the window: **Developer: Reload Window**.

After installation, a Stepik icon appears in the activity bar.

### From source

Node.js 18+ is required.

```bash
npm ci
npm run build
npx @vscode/vsce package
code --install-extension stepik-vscode-fork-0.4.4.vsix
```

Build output: `dist/extension.js` and `dist/audioWorker.js`.
Installable package: `stepik-vscode-fork-0.4.4.vsix`.

## First launch

1. Click the **Stepik** icon in the activity bar.
2. Log in with the icon in the panel title or the **Stepik: Login** command.
3. Enter your Stepik OAuth application credentials.
4. Choose a course with **Stepik: Select Course**.
5. Open any step in the tree.

After login the extension automatically creates the
`~/stepik/<account-name>` solutions folder. It does not need to be opened as a
workspace. If you used version 0.4.1 or older, the contents of `~/.stepik` are
migrated into the first account folder automatically, and the old folder is
kept as `~/.stepik.backup-<time>`. See [Solutions folder](#solutions-folder) and
[Accounts and archives](#accounts-and-archives) for details.

## OAuth setup

The extension uses OAuth 2.0 with the `client-credentials` grant. It needs the
`client id` and `client secret` of your Stepik application. Your Stepik account
password is never entered in the extension.

1. Sign in to Stepik and open
   <https://stepik.org/oauth2/applications/>.
2. Click **New application**.
3. Fill in the fields:
   - **Name** — anything, for example `Stepik VS Code`;
   - **Client type** — `confidential`;
   - **Authorization grant type** — `client-credentials`;
   - **Redirect uris** — may be left empty.
4. Save the application.
5. Copy the **Client ID** and **Client Secret**.

In VS Code, run **Stepik: Login** and paste the Client ID first, then the Client
Secret. The secret is entered as a password.

The credentials are stored in VS Code `SecretStorage`, not in regular settings.
The access token is refreshed automatically while the Client ID and Client
Secret are stored. **Stepik: Logout** archives the solutions first, then
removes the saved credentials and closes the task panel.

To switch Stepik accounts, run **Stepik: Logout**, then **Stepik: Login** with
the credentials of another application. The current account is archived, and
the new account gets a separate folder.

## Login and course selection

- **Stepik: Login** — sign in with Client ID and Client Secret.
- **Stepik: Logout** — archive the solutions, sign out, and remove the saved
  credentials.
- **Stepik: Archive Account Solutions** — archive the current account without
  signing out.
- **Stepik: Select Course** — choose one of your courses.
- **Stepik: Browse Courses** — course catalog with recommendations and search.
- **Stepik: Refresh** — reload the course tree and progress.

The selected course is saved and restored on the next launch.

The course picker lists the courses you are enrolled in and a
**Choose another course…** item. It opens the catalog:

- **Recommended** — Stepik's relevance-ranked selection;
- **Popular** — Stepik's curated list of popular courses;
- **My courses** — courses from your profile.

The catalog supports search by title and description, a **free-only** filter,
and links to stepik.org. Courses keep Stepik's own order: relevance for search
and recommendations, popularity for the Popular tab. Scrolling to the bottom
loads the next 20 courses automatically, while one more page is prefetched in
the background so normal-speed scrolling stays smooth.

A free course you are not enrolled in yet can be joined right from the catalog
with the **Enroll in course** button: the extension creates the enrollment in
your Stepik account, selects the course, and opens it in the tree. Paid courses
that are not in your profile are never enrolled locally — the **Buy on
Stepik ↗** button opens the course page on stepik.org to complete the purchase
and enrollment.

## Interface

### Sidebar

The **Stepik** view shows the selected course tree:

- sections;
- lessons;
- steps.

Colours and icons indicate the state:

- green — the step or lesson is passed;
- yellow — the step is started but not passed;
- lock — the material is locked or unavailable;
- an exam section shows a **Start Exam** action.

The view title contains buttons for course selection, refresh, logout, and
login.

### Task panel

Opening a step opens the **Stepik Task** panel beside the editor. It contains:

- **← Back** and **Next →** buttons;
- the **Open on Stepik ↗** link;
- the problem type;
- the problem statement;
- an answer form, or a language selector for code problems;
- comments and the solutions tab.

For code problems, the solution file opens in the editor while the task panel
stays beside it.

### Progress panel

The progress block is shown in the top-right corner of the task panel:

- **day streak** — how many days in a row you have studied; hover to see the
  maximum streak;
- **points** — earned and maximum (`269 / 2181`);
- **progress line** — a bar with markers for the regular and distinction
  certificate thresholds;
- **certificate** — hover over the points to see how many points remain and the
  estimated study time.

The values come from Stepik and are refreshed when steps are opened.

## Solving problems

### Code problems

1. Open a **code** step in the tree.
2. Choose a programming language in the task panel.
3. Click **Open in Editor**.
4. The extension creates and opens a file at
   `~/stepik/<account-name>/<course>/<lesson>/step-<number>.<extension>`.
5. Write your solution and save the file.
6. Submit it:
   - with the cloud-upload button in the editor title, or
   - with the **Stepik: Submit Solution** command.

The extension reuses the latest attempt. The result appears in a notification,
and error details are written to **Output → Stepik**.

If the file was not created by opening a step or was moved after creation,
submission fails because the extension cannot find the file-to-step mapping.
Open the step from the tree again in that case.

The template file is created only once. If the file already exists, the
extension does not overwrite it, so you can keep working safely.

### Quizzes and other problem types

The task panel supports every graded Stepik type:

- **choice** — one or more options;
- **string** — text answer;
- **number** — numeric answer;
- **math** — plain or LaTeX formula;
- **free-answer** — long text;
- **sorting** — drag and drop plus ↑/↓ buttons;
- **matching** — dropdown lists;
- **table** — checkboxes or radio buttons;
- **fill-blanks** — text inputs and dropdowns;
- **SQL** — SQL query;
- **HTML/CSS** — HTML and CSS editors with a requirements checklist;
- **dataset** — attempt data and a solution field;
- **chemical** — chemical formula slots;
- **puzzle** — assembled-puzzle checkbox;
- **code** — a solution file in the editor.

Typical workflow:

1. Open a step.
2. Fill in the form or select options.
3. Click **Submit**.
4. Wait for the result. A wrong answer shows a message or details in
   **Output → Stepik**.
5. **New attempt** creates a fresh attempt for quiz problems.

For `string` problems that accept only a file and for `free-answer` problems
with attachments, there is a limitation: the extension submits text only.
Attach files on the Stepik website.

`text` and `random-tasks` steps are shown as material. Opening them marks them
as viewed, so course progress is updated.

### Solutions forum

The **Solutions** tab is available for every graded problem type. While the
forum is locked, the tab explains the unlock condition and shows a **Check
again** button.

Solutions usually unlock:

- after a correct answer;
- or after a configured number of attempts.

After you submit an answer, the extension rechecks forum access automatically.

In the forum you can:

- switch between comments and solutions;
- sort the discussion;
- expand replies;
- attach one of your submitted solutions with the **My solution** list;
- view the attached answer: code, selected options, sorting order, matching
  pairs, table cells, blank values, SQL/HTML, or a dataset file;
- see teacher solutions.

If Stepik returns `403` or `404`, the forum is considered unavailable until the
next check.

## Exams

If a section is an exam, its steps stay hidden until the exam starts.

1. Click **Start Exam** on the exam section.
2. Confirm the start.
3. The extension creates a Stepik exam session through the API and opens the
   first step.
4. The task panel shows a **Time left …** timer.

When time runs out, submission buttons are locked. The exam cannot be started
again.

If an exam is already active on the website or in another window, the extension
continues the existing session and opens its steps without creating a new one.
An active session is restored after a window reload.

Do not open the same exam in several windows at once: the timer and session
state may diverge.

## Video

Video steps open in the built-in player. It provides:

- quality selection;
- subtitles when Stepik provides them;
- a poster and duration;
- a link to the original;
- a **Fullscreen** button;
- an **Open in browser** button.

Opening a step posts a view record to Stepik, so course progress advances
without visiting the website.

The Chromium build inside VS Code does not decode AAC audio in MP4 files. On
first open, the extension downloads the video in the background, extracts the
audio track, encodes it to MP3, and caches it. Progress is shown below the
player. Later opens use the cache immediately.

If sound does not start automatically, press **Enable sound**. If VS Code
denies the Fullscreen API, the player switches to a theater overlay that fills
the panel. **Open in browser** opens the video in the browser, where true
fullscreen and native sound are available.

## Comments and solutions

The Stepik discussion is shown at the bottom of the task panel.

### Comments

- the first page of comments loads when a step is opened;
- more pages load on scroll or with **Show more comments**;
- pinned comments appear in a separate block;
- replies open with **Show replies (N)**;
- author, avatar, role, date, deleted comments, and pinned comments are shown;
- code is highlighted;
- HTML from Stepik is sanitized before insertion.

Comments are available on every step, including `text` and `video`.

### Sorting

The following orders are available:

- **Newest first**;
- **Most discussed**;
- **Most liked**;
- **Recent activity**;
- **Teacher replies first**;
- **My comments** — your own comments and replies to other users.

### Teacher highlighting

- teacher comments are highlighted and marked **Teacher reply**;
- the parent comment gets a border and a **Teacher replied** badge;
- badges update after loading replies and after posting your own reply.

### Posting a comment

The rich editor with a live preview is shown by default. Use the **Markdown**
button on the editor toolbar to switch to raw Markdown, and **Preview** to
switch back.

1. Scroll the task panel to the discussion.
2. Type in the **Write a comment…** field.
3. Use the formatting toolbar if needed:
   - **B**, **I**, **U**, strikethrough, and inline code;
   - superscript and subscript text;
   - quote, bulleted list, and numbered list;
   - code block with a language selector;
   - LaTeX formula with a live preview and a link to the reference;
   - image: insert from a file or drag and drop it into the editor;
   - link with separate URL and text fields.
4. Click **Send** or press `Ctrl+Enter`.

To reply to a specific comment, click **Reply** below it. Your own comments
have **Edit**, **Delete**, and **Link** actions; the last one copies a direct
link to the comment.

Markdown mode supports headings, lists, quotes, tables, strikethrough, inline
code, fenced code, links, autolinks, and formulas. Raw HTML is not executed:
Markdown is rendered with `html: false`, and the result is sanitized.

### Comment voting

- thumb-icon buttons with counters show the current score, matching Stepik;
- clicking the active button removes the vote;
- switching between like and dislike changes the vote;
- counters update optimistically and roll back on error;
- buttons are hidden when Stepik does not allow voting;
- your own comments show static counts without buttons, because Stepik does
  not allow voting for your own comments.

### Solutions forum

The **Solutions** tab is next to **Comments**. It is available for every graded
Stepik type, not only for code problems.

- tabs switch the discussion without visiting the website;
- the tab header stays pinned while scrolling;
- sorting and pagination also work for solutions;
- replies load with a button;
- the new-solution form lets you attach one of your submissions with
  **My solution**;
- teacher solutions are highlighted.

## Math

Formulas render in problem statements, answer options, and comments.

Supported syntax:

- `$...$` and `$$...$$`;
- `\(...\)` and `\[...\]`;
- `\dfrac`, `\sqrt`, fractions, powers, integrals, and other KaTeX commands.

KaTeX emits MathML, so no external fonts or relaxed CSP are required. Cyrillic
inside formulas is automatically wrapped in `\text{...}`. Content inside
`<pre>`, `<code>`, `<script>`, `<style>`, and existing `<math>` blocks is not
parsed.

In the comment editor, the **Formula** button opens a dialog with a live KaTeX
preview and a link to
<http://en.wikibooks.org/wiki/LaTeX/Mathematics>. The formula is inserted as
`\(...\)`.

Inline formulas stay inline with the surrounding text, while display formulas
are centered on their own line.

## Commands and shortcuts

Command palette: `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS).

| Command | Action |
| --- | --- |
| **Stepik: Login** | Sign in with Client ID and Client Secret |
| **Stepik: Logout** | Archive solutions, sign out, and remove saved credentials |
| **Stepik: Archive Account Solutions** | Create a ZIP archive of the current account |
| **Stepik: Refresh** | Reload the tree and progress |
| **Stepik: Select Course** | Choose a course |
| **Stepik: Browse Courses** | Catalog, recommendations, and course search |
| **Stepik: Submit Solution** | Submit the current solution file |

**Stepik: Open Step** and **Stepik: Start Exam** are invoked from the UI and
are hidden from the command palette.

Shortcuts in the comment or solution editor:

| Keys | Action |
| --- | --- |
| `Ctrl+B` | Bold |
| `Ctrl+I` | Italic |
| `Ctrl+E` | Inline code |
| `Ctrl+K` | Link |
| `Ctrl+Enter` | Send a comment or solution |

On macOS, use `Cmd` instead of `Ctrl`. The extension has no separate user
settings: everything is configured by logging in and selecting a course.

## Solutions folder

Solutions are stored in `~/stepik/<account-name>`, regardless of which folder
is open in VS Code:

```text
~/stepik/
├── DanilProskurin/
│   ├── Course 1/
│   │   ├── Lesson 1/
│   │   │   ├── step-1.py
│   │   │   └── step-2.py
│   │   └── Lesson 2/
│   │       └── step-1.cpp
│   └── .stepik/
│       ├── account.json
│       └── mapping.json
└── archive/
    └── 1405465614.zip
```

Files are named `step-<number>.<extension>`. The extension is chosen from the
problem language: Python uses `.py`, C++ uses `.cpp`, Java uses `.java`, and so
on.

The `.stepik/mapping.json` service file maps absolute file paths to Stepik
steps. Without it, the submit command does not know which solution belongs to
which step. `.stepik/account.json` stores the immutable account ID and name.

Therefore:

- `~/stepik` does not need to be opened as a workspace — the extension creates
  it automatically on login;
- you can work in any project: solutions are still saved in
  `~/stepik/<account-name>`;
- do not move solution files manually without reopening the step.

If `~/stepik` is opened in VS Code anyway, the extension keeps working as
usual.

## Accounts and archives

- An account is identified by an immutable Stepik ID and its display name.
  Names may repeat, IDs never do. Two accounts with the same name therefore get
  different folders: `<name>` and `<name> (<ID>)`.
- Before logout or an account switch, the extension creates a ZIP archive at
  `~/stepik/archive/<ID>.zip`. It contains all solutions and the `.stepik`
  folder with `account.json` and `mapping.json`.
- You can create the archive manually with
  **Stepik: Archive Account Solutions**.
- If archiving fails, logout is cancelled: credentials are kept and no data is
  lost.
- On the first launch of 0.4.2, the old `~/.stepik` folder is migrated into the
  current account folder. Paths in `mapping.json` are rewritten, and the old
  folder is kept as `~/.stepik.backup-<time>`.

## Updating and uninstalling

### Updating

1. Download the new `.vsix` from **Releases**.
2. Install it over the old version:
   **Extensions → … → Install from VSIX…**.
3. Reload the window.

Saved OAuth credentials, the selected course, and solution files stay in place.

### Uninstalling

1. Open **Extensions** and find **Stepik**.
2. Click **Uninstall**.
3. Reload the window.

You can also delete the `~/stepik` folder with your solutions and archives.
Back it up first if you need the files. The **Stepik: Logout** command creates
an archive first, then removes the saved credentials from VS Code.

## Troubleshooting

### Login fails

- Make sure the Stepik application uses `confidential` client type and the
  `client-credentials` grant type.
- Copy the Client ID and Client Secret again, without extra spaces.
- Make sure you use the credentials of the application you created.
- Check **Output → Stepik** and the error notification.

### No courses are listed

- Make sure you are enrolled in the course on stepik.org.
- Run **Stepik: Refresh**.
- Log out and log in again if the account changed.

### A step does not open

- The section may be locked until previous lessons are completed.
- An exam section requires pressing **Start Exam**.
- Check whether the exam time has expired.

### Submission does not work

- Make sure the `~/stepik/<account-name>` folder is writable.
- Reopen the step from the tree to create or update the file-to-step mapping.
- Check that the file was not moved after creation.
- For an exam, check that the session is active and time has not expired.

### An answer is rejected

- For `string` with a file-only answer, the extension submits text only.
- Attachments in `free-answer` are not supported.
- Check the answer format: a number for `number`, a formula for `math`.
- For HTML/CSS, check the checklist items in the panel.

### Solutions do not open

- The forum may unlock after a correct answer or after several attempts.
- Press **Check again**.
- If Stepik returns `403/404`, access is restricted on Stepik's side.

### No sound in a video

- Wait for the download and conversion to finish; progress is shown below the
  player.
- Press **Enable sound** if autoplay is blocked.
- Press **Open in browser**; native sound and fullscreen work there.

### API errors

- Open **Output → Stepik**.
- Run **Stepik: Refresh**.
- Reload the window: **Developer: Reload Window**.
- The Stepik API may change without notice; if the error persists, check the
  repository Issues.

## Building from source

Node.js 18+ is required.

```bash
npm ci
npm run build
npx @vscode/vsce package
```

Type check:

```bash
npx tsc --noEmit
```

Build output: `dist/extension.js` and `dist/audioWorker.js`.
Installable package: `stepik-vscode-fork-0.4.4.vsix`.

## Limitations

- a Stepik account and your own OAuth application are required;
- posting comments, voting, and the solutions forum depend on account
  permissions and Stepik restrictions;
- file answers and `free-answer` attachments are not supported;
- this is not an official Stepik client;
- the Stepik API may change without notice;
- the built-in player depends on the codecs and Chromium capabilities in
  VS Code.

## Author

The project author is **Danil Proskurin**  
Alias: **꧁༒☬𝔉𝔜𝔡𝔡𝔡𝔡𝔰𝔰☬༒꧂**

Repository: <https://github.com/danilproskurin291-cmd/stepik-vscode>

Original project: <https://github.com/su-mt/stepik-vscode>

## License

GNU General Public License v3.0. See [LICENSE.txt](LICENSE.txt).
