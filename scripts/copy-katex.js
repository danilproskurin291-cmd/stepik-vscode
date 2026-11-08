/*
 * KaTeX HTML output needs its stylesheet and web fonts. The extension ships
 * them under media/katex so the webview works offline and does not depend on
 * a CDN. This script keeps that folder in sync with the installed katex
 * package during the normal build.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'katex', 'dist');
const target = path.join(root, 'media', 'katex');
const targetFonts = path.join(target, 'fonts');

if (!fs.existsSync(source)) {
    console.error('KaTeX is not installed. Run npm install first.');
    process.exit(1);
}

fs.mkdirSync(targetFonts, { recursive: true });
fs.copyFileSync(
    path.join(source, 'katex.min.css'),
    path.join(target, 'katex.min.css')
);

for (const file of fs.readdirSync(path.join(source, 'fonts'))) {
    // Chromium in VS Code supports woff2; the woff/ttf fallbacks are not
    // shipped to keep the extension package small.
    if (!file.endsWith('.woff2')) {
        continue;
    }
    fs.copyFileSync(
        path.join(source, 'fonts', file),
        path.join(targetFonts, file)
    );
}

console.log('KaTeX assets copied to media/katex');
