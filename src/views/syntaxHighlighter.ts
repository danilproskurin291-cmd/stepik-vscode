import hljs from 'highlight.js/lib/core';
import type { LanguageFn } from 'highlight.js';

import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import delphi from 'highlight.js/lib/languages/delphi';
import go from 'highlight.js/lib/languages/go';
import haskell from 'highlight.js/lib/languages/haskell';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import julia from 'highlight.js/lib/languages/julia';
import kotlin from 'highlight.js/lib/languages/kotlin';
import lua from 'highlight.js/lib/languages/lua';
import markdown from 'highlight.js/lib/languages/markdown';
import matlab from 'highlight.js/lib/languages/matlab';
import pascal from 'highlight.js/lib/languages/pascal';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES: Array<[string, LanguageFn]> = [
    ['bash', bash],
    ['c', c],
    ['cpp', cpp],
    ['csharp', csharp],
    ['css', css],
    ['dart', dart],
    ['delphi', delphi],
    ['go', go],
    ['haskell', haskell],
    ['java', java],
    ['javascript', javascript],
    ['json', json],
    ['julia', julia],
    ['kotlin', kotlin],
    ['lua', lua],
    ['markdown', markdown],
    ['matlab', matlab],
    ['perl', perl],
    ['php', php],
    ['plaintext', plaintext],
    ['powershell', powershell],
    ['python', python],
    ['r', r],
    ['ruby', ruby],
    ['rust', rust],
    ['scala', scala],
    ['sql', sql],
    ['swift', swift],
    ['typescript', typescript],
    ['xml', xml],
    ['yaml', yaml]
];

for (const [name, language] of LANGUAGES) {
    hljs.registerLanguage(name, language);
}

const LANGUAGE_LABELS: { [key: string]: string } = {
    bash: 'Bash',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    css: 'CSS',
    dart: 'Dart',
    delphi: 'Delphi/Pascal',
    go: 'Go',
    haskell: 'Haskell',
    java: 'Java',
    javascript: 'JavaScript',
    json: 'JSON',
    julia: 'Julia',
    kotlin: 'Kotlin',
    lua: 'Lua',
    markdown: 'Markdown',
    matlab: 'MATLAB/Octave',
    perl: 'Perl',
    php: 'PHP',
    plaintext: 'Текст',
    powershell: 'PowerShell',
    python: 'Python',
    r: 'R',
    ruby: 'Ruby',
    rust: 'Rust',
    scala: 'Scala',
    sql: 'SQL',
    swift: 'Swift',
    typescript: 'TypeScript',
    xml: 'HTML/XML',
    yaml: 'YAML'
};

/**
 * Languages offered by the rich comment editor. Stepik stores the selected
 * value in `<code class="language-...">`, which is exactly the shape used by
 * the comment renderer and by highlight.js.
 */
export function getCommentCodeLanguages(): Array<{ value: string; label: string }> {
    return LANGUAGES.map(([value]) => ({
        value,
        label: LANGUAGE_LABELS[value] || value
    }));
}

/**
 * Stepik stores language ids like "python3.6", "cpp17" or "java11".
 * Convert them to highlight.js names, including common aliases.
 */
const LANGUAGE_ALIASES: { [key: string]: string } = {
    py: 'python',
    python2: 'python',
    python3: 'python',
    js: 'javascript',
    jsx: 'javascript',
    node: 'javascript',
    nodejs: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    cxx: 'cpp',
    'c++': 'cpp',
    'c#': 'csharp',
    cs: 'csharp',
    dotnet: 'csharp',
    golang: 'go',
    rs: 'rust',
    kt: 'kotlin',
    kts: 'kotlin',
    sh: 'bash',
    shell: 'bash',
    zsh: 'bash',
    console: 'bash',
    html: 'xml',
    htm: 'xml',
    xhtml: 'xml',
    svg: 'xml',
    jsonc: 'json',
    yml: 'yaml',
    ps1: 'powershell',
    pwsh: 'powershell',
    md: 'markdown',
    octave: 'matlab',
    pascal: 'delphi',
    delphi: 'delphi',
    text: 'plaintext',
    txt: 'plaintext'
};

const AUTO_LANGUAGES = [
    'python',
    'javascript',
    'typescript',
    'java',
    'c',
    'cpp',
    'csharp',
    'go',
    'rust',
    'kotlin',
    'swift',
    'php',
    'ruby',
    'sql',
    'bash',
    'xml',
    'css',
    'json',
    'r',
    'scala',
    'haskell',
    'lua',
    'perl',
    'powershell',
    'yaml',
    'markdown'
];

const NAMED_ENTITIES: { [key: string]: string } = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0'
};

export interface HighlightedCode {
    html: string;
    language: string;
}

export function normalizeHighlightLanguage(language?: string | null): string | undefined {
    if (!language) {
        return undefined;
    }

    let value = language.trim().toLowerCase();
    if (!value) {
        return undefined;
    }

    // Accept MIME types such as text/x-python and CSS-style "language-python".
    value = value
        .replace(/^text\/x-/, '')
        .replace(/^application\//, '')
        .replace(/^language-/, '')
        .replace(/^lang-/, '');

    // Stepik appends the runtime version to the language id: python3.10,
    // cpp17, java11, php8. Keep c++ and c# intact because they end in symbols.
    value = value.replace(/[.\d]+$/, '');
    value = LANGUAGE_ALIASES[value] || value;

    if (hljs.getLanguage(value)) {
        return value;
    }

    // Python 3.x is reported as python3 by some API endpoints.
    const withoutVersion = value.replace(/\d+$/, '');
    if (withoutVersion !== value && hljs.getLanguage(withoutVersion)) {
        return withoutVersion;
    }

    return undefined;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function decodeCodePoint(value: number): string {
    if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
        return '\ufffd';
    }
    try {
        return String.fromCodePoint(value);
    } catch {
        return '\ufffd';
    }
}

function decodeHtmlEntities(text: string): string {
    return text.replace(
        /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi,
        (match, entity: string) => {
            if (entity[0] === '#') {
                const hex = entity[1].toLowerCase() === 'x';
                const value = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
                return decodeCodePoint(value);
            }
            return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
        }
    );
}

/**
 * Highlight a piece of code. The returned HTML is safe to insert: highlight.js
 * escapes all text and only emits span elements with token classes.
 */
export function highlightCode(code: string, language?: string | null): HighlightedCode {
    const normalized = normalizeHighlightLanguage(language);

    if (normalized) {
        try {
            const result = hljs.highlight(code, {
                language: normalized,
                ignoreIllegals: true
            });
            return { html: result.value, language: normalized };
        } catch {
            // Fall through to auto-detection.
        }
    }

    try {
        const auto = hljs.highlightAuto(code, AUTO_LANGUAGES);
        if (auto.language && auto.relevance >= 2) {
            return { html: auto.value, language: auto.language };
        }
    } catch {
        // Fall through to plain text.
    }

    return { html: escapeHtml(code), language: 'plaintext' };
}

function getAttribute(attrs: string, name: string): string | undefined {
    const match = attrs.match(
        new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
    );
    if (!match) {
        return undefined;
    }
    return match[1] ?? match[2] ?? match[3];
}

function getLanguageFromAttributes(attrs: string): string | undefined {
    const dataLanguage = getAttribute(attrs, 'data-language');
    if (dataLanguage) {
        return dataLanguage;
    }

    const className = getAttribute(attrs, 'class');
    if (!className) {
        return undefined;
    }

    const classes = className.split(/\s+/).filter(Boolean);
    for (const cls of classes) {
        const language = normalizeHighlightLanguage(cls);
        if (language) {
            return language;
        }
    }

    return undefined;
}

/**
 * Highlight fenced code blocks inside Stepik comment HTML. Inline <code> is
 * left alone, exactly like Markdown preview: only <pre> blocks are colored.
 */
export function highlightCodeBlocks(html: string, defaultLanguage?: string | null): string {
    if (!html || !/<pre\b/i.test(html)) {
        return html;
    }

    return html.replace(
        /<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi,
        (match, preAttrs: string, inner: string) => {
            const codeMatch = inner.match(
                /^\s*<code\b([^>]*)>([\s\S]*?)<\/code>\s*$/i
            );
            if (!codeMatch && !inner.trim()) {
                return match;
            }

            const codeAttrs = codeMatch ? codeMatch[1] : '';
            const codeHtml = codeMatch ? codeMatch[2] : inner;
            if (!codeHtml.trim()) {
                return match;
            }

            const code = decodeHtmlEntities(codeHtml);
            const language = getLanguageFromAttributes(codeAttrs)
                || getLanguageFromAttributes(preAttrs)
                || defaultLanguage;
            const highlighted = highlightCode(code, language);
            const languageClass = highlighted.language === 'plaintext'
                ? ''
                : ` language-${highlighted.language}`;

            return `<pre class="hljs"><code class="hljs${languageClass}">${highlighted.html}</code></pre>`;
        }
    );
}
