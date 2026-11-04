/**
 * Shared Stepik look for every webview panel.
 *
 * Stepik uses a white canvas, Roboto, #54ad54 green accents and soft grey
 * borders. In VS Code the same palette is mapped to light, dark and high
 * contrast variants so the panel never relies on a single hard-coded theme.
 */

const STEPIK_MARK_PATH =
    'M122.343 159.179c-6.777 6.558-16.178 10.712-26.234 10.712-10.493 ' +
    '0-19.893-4.154-26.889-11.15l17.708-17.707c2.404 2.405 5.465 3.716 ' +
    '9.181 3.716 3.498 0 6.777-1.53 9.182-3.716l35.852-35.852c2.405-2.405 ' +
    '3.717-5.466 3.717-9.182 0-3.498-1.53-6.777-3.717-9.182-2.404-2.404-' +
    '5.465-3.716-9.181-3.716-3.717 0-6.777 1.53-9.182 3.716L86.928 122.89c-' +
    '6.777 6.777-16.396 11.15-26.89 11.15-10.493 0-19.893-4.373-26.889-' +
    '11.15C26.372 116.112 22 106.493 22 96c0-10.493 4.155-19.894 11.15-' +
    '26.89l35.852-35.852c6.777-6.777 16.396-11.149 26.89-11.149 10.493 0 ' +
    '19.893 4.154 26.889 11.15l-17.708 17.707c-2.404-2.405-5.465-3.716-' +
    '9.181-3.716-3.717 0-6.777 1.53-9.182 3.716L50.857 86.818C48.452 89.223 ' +
    '47.14 92.284 47.14 96c0 3.498 1.53 6.777 3.717 9.182 2.404 2.404 5.465 ' +
    '3.716 9.181 3.716 3.498 0 6.777-1.53 9.182-3.716l35.852-35.853c6.777-' +
    '6.777 16.396-11.149 26.89-11.149 10.493 0 19.893 4.154 26.889 11.15C' +
    '165.628 76.105 170 85.724 170 96.218c0 10.493-4.155 19.893-11.15 ' +
    '26.889z';

/** Stepik-style top bar with the brand mark, wordmark and a VS Code tag. */
export function stepikBrandHtml(): string {
    return `<div class="stepik-topbar">
        <div class="stepik-topbar-inner">
            <span class="stepik-brand">
                <span class="stepik-brand-mark" aria-hidden="true">
                    <svg viewBox="0 0 192 192"><path d="${STEPIK_MARK_PATH}" fill="currentColor"></path></svg>
                </span>
                <span class="stepik-brand-name">stepik</span>
                <span class="stepik-brand-tag">VS Code</span>
            </span>
        </div>
    </div>`;
}

/** Theme tokens and component overrides appended after each view's styles. */
export const stepikThemeCss = `
        :root {
            color-scheme: light;
            --sk-bg: #ffffff;
            --sk-bg-soft: #f7f9f6;
            --sk-surface: #ffffff;
            --sk-surface-2: #f6f8f5;
            --sk-fg: #1f2320;
            --sk-muted: #6f7a6d;
            --sk-border: #e3e8e1;
            --sk-border-strong: #cfd7cc;
            --sk-accent: #54ad54;
            --sk-accent-strong: #2f8f2f;
            --sk-accent-hover: #288b28;
            --sk-accent-soft: #eaf7ea;
            --sk-link: #288b28;
            --sk-link-hover: #1f741f;
            --sk-on-accent: #ffffff;
            --sk-danger: #c72e2e;
            --sk-warning: #9a6b00;
            --sk-avatar: #607d5e;
            --sk-heat-0: #ededed;
            --sk-heat-1: #468c46;
            --sk-heat-2: #264c26;
            --sk-shadow: 0 6px 18px rgba(31, 35, 32, 0.08);
            --sk-shell: 1000px;
        }
        body.vscode-dark {
            color-scheme: dark;
            --sk-bg: #171a16;
            --sk-bg-soft: #1b1f1a;
            --sk-surface: #20251e;
            --sk-surface-2: #252b23;
            --sk-fg: #e8eee5;
            --sk-muted: #a3ada0;
            --sk-border: #323a2e;
            --sk-border-strong: #414b3d;
            --sk-accent: #66cc66;
            --sk-accent-strong: #3f9f3f;
            --sk-accent-hover: #4bb34b;
            --sk-accent-soft: rgba(102, 204, 102, 0.13);
            --sk-link: #7ed77e;
            --sk-link-hover: #9ae69a;
            --sk-on-accent: #ffffff;
            --sk-danger: #f48771;
            --sk-warning: #e2c15c;
            --sk-avatar: #3f5d3f;
            --sk-heat-0: #2a2f28;
            --sk-heat-1: #468c46;
            --sk-heat-2: #66cc66;
            --sk-shadow: 0 10px 26px rgba(0, 0, 0, 0.24);
            --sk-shell: 1000px;
        }
        body.vscode-high-contrast,
        body.vscode-high-contrast-light {
            --sk-bg: var(--vscode-editor-background);
            --sk-bg-soft: var(--vscode-editor-background);
            --sk-surface: var(--vscode-editor-background);
            --sk-surface-2: var(--vscode-editor-background);
            --sk-fg: var(--vscode-foreground);
            --sk-muted: var(--vscode-descriptionForeground);
            --sk-border: var(--vscode-contrastBorder, var(--vscode-panel-border, #6fc3df));
            --sk-border-strong: var(--vscode-contrastBorder, var(--vscode-panel-border, #6fc3df));
            --sk-accent: var(--vscode-button-background);
            --sk-accent-strong: var(--vscode-button-background);
            --sk-accent-hover: var(--vscode-button-hoverBackground);
            --sk-accent-soft: transparent;
            --sk-link: var(--vscode-textLink-foreground);
            --sk-link-hover: var(--vscode-textLink-activeForeground);
            --sk-on-accent: var(--vscode-button-foreground);
            --sk-danger: var(--vscode-errorForeground);
            --sk-warning: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow));
            --sk-avatar: var(--vscode-button-background);
            --sk-heat-0: transparent;
            --sk-heat-1: var(--vscode-charts-green, #89d185);
            --sk-heat-2: var(--vscode-charts-green, #89d185);
            --sk-shadow: none;
            --sk-shell: 1000px;
        }

        body {
            color: var(--sk-fg);
            background: var(--sk-bg);
            font-family: "Roboto", "Segoe UI", -apple-system, BlinkMacSystemFont, Arial, sans-serif;
        }
        body[data-view="catalog"] { --sk-shell: 1240px; }
        ::selection { color: var(--sk-fg); background: var(--sk-accent-soft); }
        h1, h2, h3, .profile-name { color: var(--sk-fg); }
        a { color: var(--sk-link); }

        .stepik-topbar {
            border-bottom: 1px solid var(--sk-border);
            background: var(--sk-bg);
        }
        .stepik-topbar-inner {
            display: flex;
            align-items: center;
            max-width: var(--sk-shell);
            margin: 0 auto;
            padding: 10px 24px;
        }
        .stepik-brand {
            display: inline-flex;
            align-items: center;
            gap: 9px;
            min-width: 0;
        }
        .stepik-brand-mark {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 27px;
            height: 27px;
            border-radius: 7px;
            color: #ffffff;
            background: linear-gradient(135deg, #6bcf6f 0%, #54ad54 48%, #3f9f3f 100%);
            box-shadow: 0 1px 2px rgba(20, 60, 20, 0.24);
        }
        .stepik-brand-mark svg { width: 17px; height: 17px; }
        .stepik-brand-name {
            color: var(--sk-fg);
            font-size: 19px;
            font-weight: 700;
            line-height: 1;
            letter-spacing: -0.6px;
        }
        .stepik-brand-tag {
            padding: 2px 6px;
            border: 1px solid var(--sk-border-strong);
            border-radius: 999px;
            color: var(--sk-muted);
            font-size: 9.5px;
            font-weight: 600;
            line-height: 1.4;
            letter-spacing: 0.65px;
            text-transform: uppercase;
        }
        @media (max-width: 760px) {
            .stepik-topbar-inner { padding: 9px 14px; }
        }

        /* Buttons: Stepik green primary action, quiet bordered secondary. */
        .primary-button,
        .load-more {
            color: var(--sk-on-accent);
            background: var(--sk-accent-strong);
            border: 1px solid var(--sk-accent-strong);
        }
        .primary-button:hover,
        .load-more:hover {
            color: var(--sk-on-accent);
            background: var(--sk-accent-hover);
            border-color: var(--sk-accent-hover);
        }
        .secondary-button,
        .icon-button,
        .preview-exit {
            color: var(--sk-fg);
            background: var(--sk-surface);
            border: 1px solid var(--sk-border-strong);
        }
        .secondary-button:hover,
        .icon-button:hover,
        .preview-exit:hover {
            color: var(--sk-fg);
            background: var(--sk-accent-soft);
            border-color: var(--sk-accent);
        }
        .link-button,
        .main-action,
        .sidebar-nav a,
        .sidebar-nav button,
        .sidebar-link,
        .certificate-open {
            color: var(--sk-link);
        }
        .link-button:hover,
        .main-action:hover,
        .sidebar-nav a:hover,
        .sidebar-nav button:hover,
        .sidebar-link:hover,
        .certificate-open:hover {
            color: var(--sk-link-hover);
        }
        .primary-button:focus-visible,
        .secondary-button:focus-visible,
        .icon-button:focus-visible,
        .load-more:focus-visible,
        .flag-tab:focus-visible,
        .tab:focus-visible,
        .icon-action:focus-visible {
            outline: 1px solid var(--sk-accent);
            outline-offset: 1px;
        }

        /* Tabs and filters. */
        .flag-tabs,
        .tabs { border-bottom-color: var(--sk-border); }
        .flag-tab,
        .tab { color: var(--sk-muted); }
        .flag-tab:hover,
        .tab:hover {
            color: var(--sk-fg);
            background: var(--sk-accent-soft);
        }
        .flag-tab.active,
        .tab.active { color: var(--sk-fg); }
        .flag-tab.active::after,
        .tab.active::after { background: var(--sk-accent); }
        .filters select,
        .search-field input {
            color: var(--sk-fg);
            background: var(--sk-surface);
            border: 1px solid var(--sk-border-strong);
        }
        .filters select:focus,
        .search-field input:focus { border-color: var(--sk-accent); }
        .checkbox { border-color: var(--sk-border-strong); }
        .checkbox:hover { border-color: var(--sk-accent); }
        .checkbox input { accent-color: var(--sk-accent); }

        /* Cards and surfaces. */
        .notification-card,
        .course-card,
        .activity-card,
        .details-box {
            background: var(--sk-surface);
            border-color: var(--sk-border);
        }
        .notification-card:hover,
        .course-card:hover {
            border-color: var(--sk-accent);
            box-shadow: var(--sk-shadow);
        }
        .notification-card.unread { border-left-color: var(--sk-accent); }
        .unread-dot { background: var(--sk-accent); }
        .icon-wrap,
        .card-title .actor { color: var(--sk-link); }
        .card-title .actor:hover { color: var(--sk-link-hover); }
        .quote { border-left-color: var(--sk-accent); }
        .submission-line {
            color: var(--sk-muted);
            background: var(--sk-surface-2);
        }
        .aside-cover,
        .course-media { background: var(--sk-surface-2); }
        .aside-course:hover .aside-title { color: var(--sk-link); }
        .course-cover-placeholder {
            background:
                radial-gradient(circle at 20% 20%, var(--sk-accent-soft), transparent 58%),
                radial-gradient(circle at 80% 80%, rgba(84, 173, 84, 0.18), transparent 52%);
        }
        .course-card:hover { transform: translateY(-1px); }
        .empty-state { border-color: var(--sk-border-strong); }
        .loading::before,
        .loading-more::before {
            border-color: var(--sk-accent);
            border-right-color: transparent;
        }
        .status-line.loading,
        .status.loading { color: var(--sk-link); }
        .status-line.error,
        .status.error,
        .error-state strong { color: var(--sk-danger); }
        .status-line.info { color: var(--sk-muted); }

        /* Badges and counters. */
        .unread-badge {
            color: var(--sk-on-accent);
            background: var(--sk-accent-strong);
        }
        .badge {
            color: var(--sk-muted);
            background: var(--sk-surface-2);
            border: 1px solid var(--sk-border);
            box-shadow: none;
        }
        .badge.enrolled {
            color: var(--sk-on-accent);
            background: var(--sk-accent-strong);
            border-color: var(--sk-accent-strong);
        }
        .badge.paid {
            color: var(--sk-warning);
            background: var(--sk-surface-2);
            border-color: var(--sk-warning);
        }
        .price { color: var(--sk-accent-strong); }
        .price.paid { color: var(--sk-warning); }
        .rating-star { color: #d9a800; }
        .icon-action.active { color: #d9a800; }

        /* Profile. */
        .avatar {
            border-radius: 10px;
            color: #ffffff;
            background: var(--sk-avatar);
        }
        .profile-name { letter-spacing: -0.6px; }
        .profile-head h1 { letter-spacing: -0.3px; }
        .sidebar-nav .active { color: var(--sk-fg); }
        .preview-banner {
            color: var(--sk-fg);
            background: var(--sk-accent-soft);
            border: 1px solid var(--sk-accent);
        }
        .heat-cell { background: var(--sk-heat-0); }
        .heat-cell.level-1 { background: var(--sk-heat-1); }
        .heat-cell.level-2 { background: var(--sk-heat-2); }
        .heat-cell.pad { background: transparent; }
        .heat-tooltip {
            color: var(--sk-fg);
            background: var(--sk-surface);
            border: 1px solid var(--sk-border-strong);
            box-shadow: var(--sk-shadow);
        }
        .social-link { color: var(--sk-link); border-color: var(--sk-border-strong); }
        .social-link:hover { border-color: var(--sk-accent); }
        .certificate-icon { color: #d9a800; }

        body.vscode-high-contrast .heat-cell,
        body.vscode-high-contrast-light .heat-cell {
            border: 1px solid var(--sk-border);
        }
        body.vscode-high-contrast .stepik-brand-mark,
        body.vscode-high-contrast-light .stepik-brand-mark {
            background: var(--vscode-button-background);
            box-shadow: none;
        }

        @media (prefers-reduced-motion: reduce) {
            .course-card:hover { transform: none; }
        }
`;
