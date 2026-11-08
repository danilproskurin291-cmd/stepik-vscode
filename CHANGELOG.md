# Changelog

## [0.4.14] - 2026-11-08

### Fixed

- Fill-blanks submissions no longer fail with
  `(e || "").trim is not a function`. Stepik returns `feedback` as
  `{ blanks_feedback: [...] }` for these steps, and the extension tried to
  treat it as a string. The answer was actually submitted, but the panel
  reported a submission error instead of showing the result.
- Wrong-answer feedback for fill-blanks now lists the correct and incorrect
  blank numbers.

## [0.4.13] - 2026-11-08

### Fixed

- Formulas now render with KaTeX HTML output and bundled web fonts instead of
  MathML. Chromium does not support the `mathvariant` attribute, so `\mathbb{N}`,
  `\mathbb{Z}`, `\mathbb{Q}`, `\mathbb{R}`, `\mathbb{C}`, `\mathcal`,
  `\mathfrak` and matrices were displayed as plain letters or broken layouts.
  The hidden MathML copy is kept for screen readers.
- Stepik line-break spacing such as `\\ [10pt]` is normalized and no longer
  printed as literal text inside a formula.
- Formulas inside matching and fill-blanks dropdowns are converted to readable
  Unicode text (`ℕ`, `ℤ`, `x²`, `(1)/(2)`, `∅`) because native `<option>`
  elements cannot contain KaTeX markup.

## [0.4.12] - 2026-11-08

### Fixed

- Reopening a step no longer creates a new attempt and wipes the submitted
  answer. Stepik rejects the `user=me` filter with `400 Bad Request`, so the
  extension now resolves the current user id and requests `/attempts` with it.
- A failed attempts request no longer falls back to creating a new attempt;
  only a successfully loaded empty list starts a fresh one.
- Answers from an older attempt left by a previous extension version are
  restored, while an attempt created by an explicit **Start over** stays empty.
  Restart exclusions are persisted across extension reloads.
- String attempt ids returned by the Stepik API are matched against numeric
  ids, and delayed step loads can no longer overwrite the answer of a newer
  step after fast navigation.

## [0.4.11] - 2026-11-08

### Added

- Solved quiz steps now reopen with the answer that was submitted to Stepik.
  Choice, string, number, math, free-answer, sorting, matching, table,
  fill-blanks, SQL, HTML, dataset, chemical, and puzzle answers are restored.
- A solved (or still reviewed) task is read-only until the user explicitly
  presses **Edit** or **Start over**, so an answer is never submitted again by
  accident.
- The task panel shows a solved or pending banner with the score and feedback,
  and a wrong-answer banner when a previous attempt was incorrect.

### Fixed

- Fill-blanks tasks now prefill both text inputs and selects from the saved
  submission, require every blank to be filled, and reject select values that
  are not in the task dataset. Select options returned as plain strings or
  `{ text }` objects are both supported.
- Attempt datasets returned as a JSON string are parsed before rendering.
- Submission polling no longer fails after a long manual review; the pending
  answer stays visible instead of showing a submission error.
- A delayed submission result is ignored if the user has already navigated to
  another step.

## [0.4.10] - 2026-11-08

### Fixed

- The profile activity calendar is now anchored to the right edge and shows the
  most recent weeks. It no longer scrolls horizontally: only the weeks that fit
  the panel width are rendered, and the calendar rebuilds when the panel is
  resized.
- Weekday labels in the activity calendar are now aligned with their actual
  rows (Mon, Wed, Fri, Sun) instead of being packed into the first four rows.
- Recent activity now appears on the right edge of the calendar. Stepik
  returns daily pins newest-first, but the extension treated them as
  oldest-first, so yesterday's solved tasks were drawn almost a year in the
  past.

## [0.4.9] - 2026-11-07

### Fixed

- Random-task steps no longer open as an empty panel: the task view now
  explains that Stepik generates the task on its side and links to the step.
- Step tree icons now reflect the actual type for math, sorting, matching,
  table, fill-blanks, SQL, HTML, dataset, free-answer, and random-task steps.

## [0.4.8] - 2026-11-07

### Fixed

- Stepik tabs no longer show a black icon on a dark editor background. All
  webview panels now use a high-contrast green Stepik badge that stays readable
  in light, dark, and high-contrast themes.
- The task panel now shows the Stepik icon in its editor tab instead of the
  generic file icon.
- The activity bar icon is now a crisp filled Stepik mark instead of a thin
  black outline, so it renders correctly in every VS Code theme.

## [0.4.7] - 2026-11-04

### Added

- Stepik-style visual theme shared by every webview: brand top bar, accent
  palette, typography, cards, buttons, progress bars, and the heatmap. Light,
  dark, and high-contrast VS Code themes are supported without losing
  readability.
- Switchable interface language. The new `stepik.language` setting accepts
  `auto`, `ru`, and `en`; `auto` follows the VS Code display language.
- **Stepik: Change Interface Language** command and a title-bar button in the
  Stepik view. The change applies to open panels immediately.
- Russian and English dictionaries for panels, tree items, notifications,
  authentication prompts, output messages, and errors. Russian plurals are
  handled with proper plural forms.
- New 128×128 marketplace icon and a Stepik-green gallery banner.
- Privacy-safe screenshots and rewritten README files covering OAuth setup,
  login, the catalog, the task panel, notifications, and the profile.

### Changed

- Profile header typography was adjusted so long names wrap without overlapping
  the avatar or the user ID.
- Session-expiry detection now recognizes both Russian and English Stepik
  messages.
- Documentation is synchronized across `README.md` and `README.en.md`.

### Fixed

- Webviews could keep stale HTML after an extension update; panels now rebuild
  their markup on reload.
- Profile padding and line height no longer clip descenders in long names.
- The English interface no longer falls back to Russian for profile counters,
  certificate labels, and profile error messages.
- Quiz result notifications and the language-change confirmation use the
  selected interface language instead of the previous one.

## [0.4.6] - 2026-11-04

### Added

- Background notification watcher with persisted catch-up state. New events are
  shown as VS Code toasts, and unread notifications are restored after a
  restart.
- Notifications panel with history, unread counters, mark-as-read actions, and
  a dedicated empty state.
- Profile improvements: hover details, profile editing, and a public preview of
  the profile as other learners see it.

### Fixed

- Certificate progress and completion counters now match the values returned by
  Stepik.

## [0.4.5] - 2026-11-04

### Added

- Infinite scrolling in the course catalog. When the last cards approach the
  viewport, the next 20 courses are appended automatically.
- The page after the visible one is prefetched in the background together with
  its cover images, so scrolling at a normal pace continues without a pause.
  The **Load more** button remains as a fallback and for retrying errors.
- Free courses can be joined directly from the catalog with the **Записаться на
  курс** button. It creates a real enrollment in the user's Stepik account,
  selects the course, and opens it in the tree. An already enrolled course
  keeps the **Выбрать курс** action.

### Changed

- Catalog pagination appends only the new cards instead of rebuilding the whole
  grid. This keeps the scroll position stable and avoids reloading covers.
- Paid courses that are not in the user's profile cannot be selected in the
  catalog: the card opens stepik.org so the course can be purchased or joined
  there. The extension host repeats the check, so a crafted webview message
  cannot bypass it.

## [0.4.4] - 2026-11-04

### Added

- Course catalog opened from **Stepik: Select Course → Выбрать другой курс…**
  and from the new **Stepik: Browse Courses** command. It has tabs for
  recommended courses, Stepik's curated popular courses, and your enrolled
  courses.
- Catalog search uses the same relevance ranking as the Stepik website, so
  results are useful courses instead of the newest empty publications.
- Catalog keeps Stepik's own course order: relevance for search and
  recommendations, popularity for the Popular tab. There is also a **free-only**
  filter and **Show more** pagination.
- Course cards with covers, ratings from Stepik review summaries, learner
  counts, workload, language, price, and certificate badges. A course that is
  not in your profile links to stepik.org so you can enroll on the website.

### Changed

- Course selection and catalog selection now share the same update path, so
  the course tree refreshes immediately after a course is chosen.

## [0.4.3] - 2026-11-04

### Fixed

- Submitting a solution no longer fails with **This file is not associated with
  a Stepik step** when Windows reports the drive letter in a different case.
  The mapping lookup now compares resolved paths case-insensitively and checks
  every account folder, the shared folder, and legacy backups.
- The **Open on Stepik** link in the task header opens a single browser tab
  again. The rich comment editor no longer intercepts links outside its own
  preview, so VS Code's built-in webview handler is the only one that opens the
  step.

## [0.4.2] - 2026-11-04

### Added

- Per-account workspaces under `~/stepik/<name>/`. The extension stores the
  immutable Stepik account ID and display name, so two accounts with the same
  name get separate folders (`<name> (<ID>)`) and cannot overwrite each other.
- Automatic migration of the legacy `~/.stepik` folder into the first account
  workspace. Mapping paths are rewritten, and the old folder is kept as
  `.stepik.backup-<timestamp>`.
- **Stepik: Archive Account Solutions** and an automatic archive before logout
  or an account switch. The ZIP is written to
  `~/stepik/archive/<account-ID>.zip` and contains all solutions plus
  `.stepik/account.json`.
- Rich comment editor with a live preview by default and a Markdown mode
  toggle. The toolbar supports bold, italic, underline, strikethrough, inline
  code, superscript, subscript, quotes, bulleted and numbered lists, code
  blocks with a language, a formula editor with live KaTeX preview, image
  upload and drag-and-drop, and links with separate URL and text fields.
- Copy-link, edit, and delete actions for comments. Own comments show static
  like and dislike counts instead of interactive voting buttons.
- Progress panel pinned to the top-right of the task panel with a day streak,
  earned and maximum points, a Stepik-style progress line with certificate
  threshold markers, and hover tooltips for the maximum streak, points
  remaining to a certificate, and estimated study time.

### Fixed

- The Markdown textarea no longer appears under the rich editor surface.
- Voting on your own comment no longer causes a Stepik HTTP 403. The host
  rejects the action with a clear message, and the UI shows only the counts.

### Changed

- Comment like and dislike controls now use Stepik's compact thumb icon and
  counter style instead of emoji pill buttons.
- Logout and account switching archive the current account first. If archiving
  fails, the credentials are kept and logout is cancelled.

## [0.4.1] - 2026-11-03

### Changed

- Renamed the extension package to `stepik-vscode-fork` and changed the display
  name to **Stepik Fork**. The Marketplace already has an extension named
  `stepik-vscode`, so the fork uses a unique name.
- Added an explicit **Fork** label to the README and the activity bar title.

## [0.4.0] - 2026-11-03

### Added

- Solution files are now always stored in `~/.stepik`, regardless of which
  folder is open in VS Code (or when no folder is open at all). The extension
  creates the folder automatically, so it no longer has to be opened as a
  workspace.
- The file-to-step mapping is kept in `~/.stepik/.stepik/mapping.json`.
  Mappings from folders that were opened as a workspace before 0.4.0 are still
  read as a fallback, so existing solutions can be submitted without reopening
  the step.

### Changed

- The first-run prompt that offered to create and open `~/.stepik` was removed.
  The solutions folder is prepared when the extension starts.

## [0.3.3] - 2026-11-03

### Fixed

- The submission attached to a solution comment is now rendered for every quiz
  type, not only `code`. Choice, string, number, math, free-answer, sorting,
  matching, table, fill-blanks, SQL, HTML/CSS, dataset, chemical, and puzzle
  answers are shown in the solutions forum.
- If the author's dataset is unavailable, choice, sorting, and matching answers
  fall back to readable option numbers instead of disappearing, and an unknown
  reply shape is shown as formatted JSON.
- Answer text and option markup from other users are sanitized with the comment
  sanitizer before they are inserted into the webview.

## [0.3.2] - 2026-11-03

### Added

- The previous and next steps are preloaded in the background after a step is
  opened. Navigation with **Назад** / **Далее** reuses cached comments, solutions
  metadata, submissions, and the existing attempt instead of repeating the
  network requests.
- Read-only Stepik responses (comments, discussion proxies and threads, attempt
  lists, user submissions) are cached for a short time. Writes invalidate the
  affected entries; `POST /views` deliberately keeps the preload cache intact.

### Fixed

- A finished exam session is no longer treated as active because of a stale
  `time_left` value. When `end_date` exists, it is authoritative for both the
  active state and the countdown.
- An expired exam cannot be reopened from cached section data, and the tree
  stops its 30-second refresh timer when no session is actually active.
- Exam navigation reuses the session of the current section, so opening the
  next exam step does not wait for an extra section/session request or get
  blocked by a lagging section response.
- Double-clicking **Назад** / **Далее** no longer queues the same navigation
  twice; both buttons are disabled while the next step opens.
- Logging out clears the API response cache, the stored user id, and the open
  task panel, so a different account cannot see the previous user's data.

## [0.3.1] - 2026-11-03

### Fixed

- The **Решения** tab is now shown for every quiz step, including choice tests,
  even while the forum is locked. This matches stepik.org and makes the tab
  appear immediately instead of only after reopening the step.
- A locked solutions forum now explains how it unlocks (after a correct answer
  or after the configured number of attempts) and offers a **Проверить снова**
  button.
- After a quiz submission the extension rechecks the solutions forum in the
  background. The tab unlocks and loads solutions without reopening the step.
- Locked threads hidden by the batch `/discussion-threads` response are now
  queried individually, so an unlocked forum is not missed.

## [0.3.0] - 2026-11-03

### Added

- The solutions forum is now detected for every graded Stepik step type, not
  only for `code`. Choice, string, number, math, sorting, matching, table,
  fill-blanks, SQL, HTML, dataset, chemical, puzzle, and other quiz steps show
  the **Решения** tab when Stepik unlocks it for the account.
- The discussion section is explicitly available on material steps too. Text
  and video steps load comments the same way as graded problems.

### Fixed

- The course title in the sidebar no longer repeats the **Stepik:** prefix.
  A course whose title already starts with `Stepik:` is shown without the
  duplicated prefix inside the Stepik activity-bar container.

### Changed

- Step metadata for the solutions forum is cached for five minutes, and a
  locked forum is not rechecked for a minute. A new submission invalidates the
  cache so the forum can appear on the next open.
- The user's submissions are loaded lazily when the **Решения** tab is opened
  instead of on every step open.
- Identical concurrent GET requests are merged, progress maps are cached for
  15 seconds, and the webview CSS is built only once.

## [0.2.2] - 2026-11-03

### Fixed

- Step type names are now translated to Russian everywhere. The tree and the
  task panel badge share one dictionary, so types such as `table`, `SQL`,
  `HTML/CSS`, `dataset`, `random-tasks`, Parsons, PyCharm, Linux, Schulte,
  TRIK, external grader, LTI, manual score, chemical, puzzle, and admin are no
  longer shown as raw English slugs.
- Answer feedback is no longer duplicated when Stepik returns the same text in
  both `hint` and `feedback` (for example, the explanation after a wrong
  choice answer).

## [0.2.1] - 2026-11-03

### Fixed

- Removed the duplicated Back/Next navigation. The single pair of buttons
  stays in the task header, so it is no longer shown twice.

## [0.2.0] - 2026-11-03

### Added

- **Exam sections.** An exam no longer exposes its steps until the user
  presses **«Начать экзамен»**. Starting creates a real `exam-session` through
  the Stepik API, shows a countdown in the task panel, and restores the active
  session after a window reload. Steps and submissions stay blocked when the
  exam is not started or its time is over.
- **Back / Next navigation** inside the current section. The buttons respect
  section access and exam state, so they cannot be used to bypass the exam
  guard.
- A view record is now posted for every opened step, including the `assignment`
  id. This is what makes `text` steps count as passed and updates course
  progress on stepik.org, the same way the website does.

### Fixed

- Opening a quiz no longer creates a new attempt every time. The latest attempt
  is reused; **«Новая попытка»** still creates a fresh one explicitly.
- OAuth access tokens are refreshed automatically using the stored client
  credentials, and API requests now have a timeout and chunk large id lists.
- Empty `204` API responses no longer break JSON parsing.
- Course sections, units and steps are cached briefly, so the tree does not
  refetch the whole course on every expand/collapse.

### Changed

- Submissions re-check section access immediately before sending, so a quiz
  answer cannot be submitted after the exam session has expired.

## [0.1.4] - 2026-11-03

### Fixed

- Code blocks in task descriptions are now syntax-highlighted. Text steps and
  quiz prompts use the same highlight.js pipeline and VS Code color palette as
  comments, including language classes such as `language-python`.

## [0.1.3] - 2026-11-03

### Fixed

- Cached video audio is now accepted by the webview resource loader. The
  global storage URI uses the `vscode-userdata` scheme, while `asWebviewUri`
  serves cached files as `file` resources, so the webview rejected them with
  HTTP 401 and showed "Не удалось воспроизвести звук." The storage path is now
  passed to `localResourceRoots` as a `file` URI.

## [0.1.2] - 2026-11-03

### Added

- Sound for video steps. The webview cannot decode the AAC track inside Stepik
  MP4 files, so the extension extracts the audio in a background worker, encodes
  it to MP3, caches it in global storage, and plays it in sync with the video.
  A progress indicator shows download and transcoding status, and an "Enable
  sound" button appears if autoplay is blocked.
- Fullscreen playback. The player tries the native Fullscreen API and falls back
  to a theater overlay that fills the webview. A new "Open in browser" button
  opens the video in the browser for true fullscreen and native sound.

### Changed

- The webview content security policy now allows locally cached audio files from
  extension storage.

## [0.1.1] - 2026-11-03

### Added

- Native playback for video steps: MP4 quality variants, poster, subtitles,
  duration, and a link to the original video.
- Automatic view reporting on first playback so Stepik advances course
  progress for video steps.

### Fixed

- "Open on Stepik" now opens a single page instead of two. External links are
  handled only by VS Code's built-in webview link handler.

## [0.1.0] - 2026-11-02

### Added

- Stepik discussions under the problem panel: pagination, pinned comments,
  replies, deleted comments, roles, and avatars.
- Comment sorting: newest, most discussed, most liked, recent activity,
  teacher replies first, and **My comments** (including replies to other
  users).
- Teacher highlighting and "Teacher replied" badges.
- Solutions forum tab with the same sorting and pagination.
- Comment and reply posting with Markdown formatting, toolbar buttons, and
  keyboard shortcuts.
- Comment voting with optimistic score updates.
- KaTeX MathML rendering for `$...$`, `$$...$$`, `\(...\)`, and `\[...\]`.
- Syntax highlighting for code in comments and solutions.
- HTML sanitization for comments and rendered Markdown.
- Full support for all graded Stepik problem types: choice, string, number,
  math, free-answer, sorting, matching, table, fill-blanks, SQL, HTML/CSS with
  checklist scoring, dataset, chemical, puzzle, and code.
- Per-attempt datasets for sorting, matching, table, and fill-blanks tasks, plus
  dataset input files loaded from the attempt endpoint.
- In-panel result messages for quiz submissions, including validation errors
  and the list of unfinished HTML checklist items.

### Fixed

- Inline math formulas no longer render one per line. The stylesheet no longer
  overrides the MathML `display` property, so Chromium keeps inline formulas
  inline and display formulas on their own centered line.
- Python problems now use `step-N.py` and Python language mode instead of
  `.txt` for `python3.12`.

### Changed

- Repository cleaned up for GitHub: removed local backups and scratch files,
  added `.vscodeignore`, repository metadata, and publishing notes.
- Version bumped to `0.1.0`.
