import { getCommentCodeLanguages } from './syntaxHighlighter';

/**
 * Rich comment editor used by the step page.
 *
 * The editor is a contenteditable surface whose HTML is sent to Stepik
 * directly. The Markdown mode is converted by the extension host so both
 * directions use the same sanitizer and math protection as the existing
 * Markdown composer.
 *
 * The script below is embedded in the webview. It is deliberately written in
 * plain ES2019 (no template literals) so it can be pasted into the generated
 * HTML without escaping issues.
 */
export function getRichCommentEditorScript(): string {
    const languages = JSON.stringify(getCommentCodeLanguages());
    return String.raw`
(function () {
    if (window.StepikRichEditor) {
        return;
    }

    var LANGUAGES = ${languages};
    var editors = new Map();
    var requestCounter = 0;
    var pendingRequests = new Map();

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function escapeAttribute(value) {
        return escapeHtml(value);
    }

    function buildLanguageOptions(selected) {
        return LANGUAGES.map(function (item) {
            return '<option value="' + escapeAttribute(item.value) + '"' +
                (item.value === selected ? ' selected' : '') + '>' +
                escapeHtml(item.label) + '</option>';
        }).join('');
    }

    function buildMarkup(options) {
        var placeholder = escapeAttribute(options.placeholder || 'Напишите комментарий…');
        return '' +
            '<div class="rich-editor-toolbar" role="toolbar" aria-label="Форматирование комментария">' +
                '<button type="button" class="rich-tool" data-command="bold" title="Жирный (Ctrl+B)"><strong>B</strong></button>' +
                '<button type="button" class="rich-tool" data-command="italic" title="Курсив (Ctrl+I)"><em>I</em></button>' +
                '<button type="button" class="rich-tool" data-command="underline" title="Подчёркнутый (Ctrl+U)"><u>U</u></button>' +
                '<button type="button" class="rich-tool" data-command="strikeThrough" title="Зачёркнутый"><s>S</s></button>' +
                '<button type="button" class="rich-tool" data-action="inline-code" title="Встроенный код">&lt;/&gt;</button>' +
                '<button type="button" class="rich-tool" data-command="superscript" title="Верхний индекс">x²</button>' +
                '<button type="button" class="rich-tool" data-command="subscript" title="Нижний индекс">x₂</button>' +
                '<span class="rich-toolbar-sep" aria-hidden="true"></span>' +
                '<button type="button" class="rich-tool" data-command="formatBlock:blockquote" title="Цитата">❝</button>' +
                '<button type="button" class="rich-tool" data-command="insertUnorderedList" title="Маркированный список">• Список</button>' +
                '<button type="button" class="rich-tool" data-command="insertOrderedList" title="Нумерованный список">1. Список</button>' +
                '<span class="rich-toolbar-sep" aria-hidden="true"></span>' +
                '<button type="button" class="rich-tool" data-action="codeblock" title="Блок кода с выбором языка">Код</button>' +
                '<button type="button" class="rich-tool" data-action="math" title="Формула LaTeX">Σ Формула</button>' +
                '<button type="button" class="rich-tool" data-action="image" title="Вставить изображение">🖼 Изображение</button>' +
                '<button type="button" class="rich-tool" data-action="link" title="Вставить ссылку (Ctrl+K)">🔗 Ссылка</button>' +
                '<span class="rich-editor-modes" role="group" aria-label="Режим редактирования">' +
                    '<button type="button" class="rich-mode active" data-mode="rich" title="Визуальный режим с форматированием">Предпросмотр</button>' +
                    '<button type="button" class="rich-mode" data-mode="markdown" title="Редактировать исходный Markdown">Markdown</button>' +
                '</span>' +
            '</div>' +
            '<div class="rich-editor-surface">' +
                '<div class="rich-editor-content" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="' + placeholder + '"></div>' +
                '<textarea class="rich-editor-markdown" spellcheck="true" placeholder="Markdown…" hidden></textarea>' +
                '<div class="rich-editor-drop-hint">Отпустите изображение, чтобы вставить его</div>' +
            '</div>' +
            '<input type="file" class="rich-editor-file" accept="image/*" hidden>' +
            '<div class="rich-editor-status" aria-live="polite"></div>';
    }

    function request(command, payload) {
        return new Promise(function (resolve, reject) {
            var requestId = 'editor-' + (++requestCounter) + '-' + Date.now();
            var timer = setTimeout(function () {
                pendingRequests.delete(requestId);
                reject(new Error('Истекло время ожидания ответа редактора.'));
            }, 25000);
            pendingRequests.set(requestId, {
                resolve: function (value) {
                    clearTimeout(timer);
                    pendingRequests.delete(requestId);
                    resolve(value);
                },
                reject: function (error) {
                    clearTimeout(timer);
                    pendingRequests.delete(requestId);
                    reject(error);
                }
            });
            vscode.postMessage(Object.assign({
                command: command,
                requestId: requestId
            }, payload || {}));
        });
    }

    window.addEventListener('message', function (event) {
        var message = event.data || {};
        if (message.command !== 'commentEditorResponse') {
            return;
        }
        var pending = pendingRequests.get(message.requestId);
        if (!pending) {
            return;
        }
        if (message.ok) {
            pending.resolve(message.data || {});
        } else {
            pending.reject(new Error(message.error || 'Ошибка редактора.'));
        }
    });

    function openDialog(title, bodyHtml, primaryLabel) {
        var backdrop = document.createElement('div');
        backdrop.className = 'rich-dialog-backdrop';
        var dialog = document.createElement('div');
        dialog.className = 'rich-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.innerHTML =
            '<div class="rich-dialog-head">' +
                '<span class="rich-dialog-title">' + escapeHtml(title) + '</span>' +
                '<button type="button" class="rich-dialog-close" aria-label="Закрыть">×</button>' +
            '</div>' +
            '<div class="rich-dialog-body">' + bodyHtml + '</div>' +
            '<div class="rich-dialog-error" aria-live="polite"></div>' +
            '<div class="rich-dialog-actions">' +
                '<button type="button" class="rich-dialog-cancel secondary">Отмена</button>' +
                '<button type="button" class="rich-dialog-primary">' + escapeHtml(primaryLabel) + '</button>' +
            '</div>';
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        function close() {
            document.removeEventListener('keydown', onKeyDown);
            backdrop.remove();
        }
        function onKeyDown(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                close();
            }
        }
        document.addEventListener('keydown', onKeyDown);
        backdrop.addEventListener('mousedown', function (event) {
            if (event.target === backdrop) {
                close();
            }
        });
        dialog.querySelector('.rich-dialog-close').addEventListener('click', close);
        dialog.querySelector('.rich-dialog-cancel').addEventListener('click', close);

        return {
            dialog: dialog,
            body: dialog.querySelector('.rich-dialog-body'),
            error: dialog.querySelector('.rich-dialog-error'),
            primary: dialog.querySelector('.rich-dialog-primary'),
            close: close,
            setError: function (text) {
                dialog.querySelector('.rich-dialog-error').textContent = text || '';
            }
        };
    }

    function normalizeUrl(value) {
        var url = String(value || '').trim();
        if (!url) {
            return '';
        }
        if (/^(https?:|mailto:)/i.test(url) || url.charAt(0) === '#') {
            return url;
        }
        if (url.indexOf('//') === 0) {
            return 'https:' + url;
        }
        return 'https://' + url.replace(/^\/+/, '');
    }

    function create(host, options) {
        options = options || {};
        var existing = editors.get(host.id);
        if (existing) {
            if (typeof options.onChange === 'function') {
                existing.setOnChange(options.onChange);
            }
            return existing;
        }

        host.classList.add('stepik-rich-editor');
        host.innerHTML = buildMarkup(options);

        var root = host;
        var toolbar = root.querySelector('.rich-editor-toolbar');
        var rich = root.querySelector('.rich-editor-content');
        var markdownInput = root.querySelector('.rich-editor-markdown');
        var fileInput = root.querySelector('.rich-editor-file');
        var statusEl = root.querySelector('.rich-editor-status');
        var dropHint = root.querySelector('.rich-editor-drop-hint');
        var mode = 'rich';
        var disabled = Boolean(options.disabled);
        var savedRange = null;
        var converting = false;
        var uploading = false;
        var onChange = typeof options.onChange === 'function' ? options.onChange : null;
        var compact = Boolean(options.compact);

        if (compact) {
            root.classList.add('compact');
        }

        function setStatus(text) {
            if (statusEl) {
                statusEl.textContent = text || '';
            }
        }

        function notify() {
            if (onChange) {
                onChange(api);
            }
        }

        function saveSelection() {
            var selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) {
                return;
            }
            var range = selection.getRangeAt(0);
            if (rich.contains(range.commonAncestorContainer)) {
                savedRange = range.cloneRange();
            }
        }

        function selectionInsideRich() {
            var selection = window.getSelection();
            return Boolean(
                selection &&
                selection.rangeCount > 0 &&
                rich.contains(selection.getRangeAt(0).commonAncestorContainer)
            );
        }

        function restoreSelection() {
            rich.focus();
            var selection = window.getSelection();
            if (!selection) {
                return;
            }
            selection.removeAllRanges();
            if (savedRange && rich.contains(savedRange.commonAncestorContainer)) {
                selection.addRange(savedRange);
                return;
            }
            var range = document.createRange();
            range.selectNodeContents(rich);
            range.collapse(false);
            selection.addRange(range);
        }

        function insertHtmlAtCursor(html) {
            restoreSelection();
            var inserted = false;
            try {
                inserted = document.execCommand('insertHTML', false, html);
            } catch (error) {
                inserted = false;
            }
            if (!inserted) {
                rich.insertAdjacentHTML('beforeend', html);
            }
            savedRange = null;
            notify();
        }

        function selectedText() {
            var selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || !selectionInsideRich()) {
                return '';
            }
            return selection.toString();
        }

        function insertInlineCode() {
            var text = selectedText() || 'код';
            var selection = window.getSelection();
            if (selection && selection.rangeCount > 0 && selectionInsideRich()) {
                var range = selection.getRangeAt(0);
                range.deleteContents();
                var code = document.createElement('code');
                code.textContent = text;
                range.insertNode(code);
                range.setStartAfter(code);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                notify();
                return;
            }
            insertHtmlAtCursor('<code>' + escapeHtml(text) + '</code>');
        }

        function runCommand(command) {
            if (disabled) {
                return;
            }
            rich.focus();
            var parts = command.split(':');
            var name = parts[0];
            var value = parts[1] || null;
            try {
                document.execCommand(name, false, value);
            } catch (error) {
                setStatus('Команда форматирования недоступна.');
                return;
            }
            saveSelection();
            notify();
        }

        function openLinkDialog() {
            saveSelection();
            var selected = selectedText();
            var dialog = openDialog(
                'Вставить ссылку',
                '<label class="rich-field">Адрес ссылки' +
                    '<input type="text" class="rich-dialog-url" placeholder="https://example.com" value="">' +
                '</label>' +
                '<label class="rich-field">Отображаемый текст' +
                    '<input type="text" class="rich-dialog-text" placeholder="Текст ссылки" value="' +
                        escapeAttribute(selected) + '">' +
                '</label>' +
                '<div class="rich-dialog-hint">Если оставить текст пустым, будет показан сам адрес.</div>',
                'Вставить'
            );
            var urlInput = dialog.body.querySelector('.rich-dialog-url');
            var textInput = dialog.body.querySelector('.rich-dialog-text');
            urlInput.focus();
            urlInput.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    dialog.primary.click();
                }
            });
            dialog.primary.addEventListener('click', function () {
                var url = normalizeUrl(urlInput.value);
                if (!url) {
                    dialog.setError('Введите адрес ссылки.');
                    urlInput.focus();
                    return;
                }
                if (!/^(https?:|mailto:|#)/i.test(url)) {
                    dialog.setError('Поддерживаются ссылки http(s), mailto и якоря.');
                    return;
                }
                var label = textInput.value.trim() || url;
                insertHtmlAtCursor(
                    '<a href="' + escapeAttribute(url) + '">' + escapeHtml(label) + '</a>'
                );
                dialog.close();
            });
        }

        function openCodeDialog() {
            saveSelection();
            var selected = selectedText();
            var dialog = openDialog(
                'Блок кода',
                '<label class="rich-field">Язык программирования' +
                    '<select class="rich-dialog-language">' +
                        buildLanguageOptions('plaintext') +
                    '</select>' +
                '</label>' +
                '<label class="rich-field">Код' +
                    '<textarea class="rich-dialog-code" rows="9" spellcheck="false" placeholder="Вставьте код…">' +
                        escapeHtml(selected) +
                    '</textarea>' +
                '</label>',
                'Вставить код'
            );
            var codeInput = dialog.body.querySelector('.rich-dialog-code');
            var languageInput = dialog.body.querySelector('.rich-dialog-language');
            codeInput.focus();
            dialog.primary.addEventListener('click', function () {
                var code = codeInput.value.replace(/\r\n/g, '\n');
                if (!code.trim()) {
                    dialog.setError('Введите код.');
                    codeInput.focus();
                    return;
                }
                var language = languageInput.value;
                var className = language && language !== 'plaintext'
                    ? ' class="language-' + escapeAttribute(language) + '"'
                    : '';
                insertHtmlAtCursor(
                    '<pre><code' + className + '>' + escapeHtml(code) + '</code></pre><p><br></p>'
                );
                dialog.close();
            });
        }

        function openMathDialog() {
            saveSelection();
            var selected = selectedText();
            var dialog = openDialog(
                'Формула LaTeX',
                '<label class="rich-field">Формула' +
                    '<textarea class="rich-dialog-math" rows="3" spellcheck="false" placeholder="x^2 + y^2 = z^2">' +
                        escapeHtml(selected) +
                    '</textarea>' +
                '</label>' +
                '<label class="rich-checkbox"><input type="checkbox" class="rich-dialog-display"> Отдельная строка</label>' +
                '<div class="rich-dialog-preview" aria-live="polite"></div>' +
                '<div class="rich-dialog-hint">Поддерживается синтаксис LaTeX. ' +
                    '<a href="http://en.wikibooks.org/wiki/LaTeX/Mathematics" data-external="true">Шпаргалка по математике</a>' +
                '</div>',
                'Вставить формулу'
            );
            var mathInput = dialog.body.querySelector('.rich-dialog-math');
            var displayInput = dialog.body.querySelector('.rich-dialog-display');
            var preview = dialog.body.querySelector('.rich-dialog-preview');
            var previewTimer = null;
            var previewRequest = 0;

            function updatePreview() {
                var formula = mathInput.value.trim();
                var current = ++previewRequest;
                if (!formula) {
                    preview.innerHTML = '';
                    return;
                }
                preview.textContent = 'Предпросмотр…';
                request('renderMathPreview', {
                    formula: formula,
                    display: displayInput.checked
                }).then(function (data) {
                    if (current !== previewRequest) {
                        return;
                    }
                    preview.innerHTML = data.html || '';
                }).catch(function (error) {
                    if (current !== previewRequest) {
                        return;
                    }
                    preview.textContent = error.message;
                });
            }

            mathInput.addEventListener('input', function () {
                clearTimeout(previewTimer);
                previewTimer = setTimeout(updatePreview, 250);
            });
            displayInput.addEventListener('change', updatePreview);
            mathInput.focus();
            updatePreview();

            dialog.primary.addEventListener('click', function () {
                var formula = mathInput.value.trim();
                if (!formula) {
                    dialog.setError('Введите формулу.');
                    mathInput.focus();
                    return;
                }
                var display = displayInput.checked;
                var delimiters = display
                    ? ['\\[', '\\]']
                    : ['\\(', '\\)'];
                insertHtmlAtCursor(
                    '<span class="math-tex">' + escapeHtml(delimiters[0] + formula + delimiters[1]) + '</span>'
                );
                dialog.close();
            });
        }

        function base64FromBytes(bytes) {
            var binary = '';
            var chunk = 0x8000;
            for (var index = 0; index < bytes.length; index += chunk) {
                binary += String.fromCharCode.apply(
                    null,
                    bytes.subarray(index, index + chunk)
                );
            }
            return btoa(binary);
        }

        function uploadFile(file) {
            if (!file || disabled || uploading) {
                return;
            }
            if (!/^image\//i.test(file.type || '')) {
                setStatus('Можно вставлять только изображения.');
                return;
            }
            if (file.size > 15 * 1024 * 1024) {
                setStatus('Изображение больше 15 МБ.');
                return;
            }

            uploading = true;
            setStatus('Загрузка изображения…');
            file.arrayBuffer().then(function (buffer) {
                return request('uploadCommentImage', {
                    name: file.name || 'image.png',
                    mimeType: file.type || 'image/png',
                    data: base64FromBytes(new Uint8Array(buffer))
                });
            }).then(function (data) {
                uploading = false;
                setStatus('');
                var dimensions = '';
                if (data.width && data.height) {
                    dimensions = ' width="' + Number(data.width) + '" height="' + Number(data.height) + '"';
                }
                insertHtmlAtCursor(
                    '<img src="' + escapeAttribute(data.url) + '" alt="' +
                    escapeAttribute(data.alt || file.name || '') + '"' + dimensions + '>'
                );
            }).catch(function (error) {
                uploading = false;
                setStatus(error.message || 'Не удалось загрузить изображение.');
            });
        }

        function updateToolbarState() {
            // Markdown mode exposes raw text; rich formatting tools would act
            // on the hidden surface. Only the mode switch stays usable there.
            toolbar.querySelectorAll('.rich-tool').forEach(function (button) {
                button.disabled = disabled || mode === 'markdown';
            });
            toolbar.querySelectorAll('.rich-mode').forEach(function (button) {
                button.disabled = disabled || converting;
            });
        }

        function switchMode(nextMode) {
            if (disabled || converting || nextMode === mode) {
                return;
            }
            var modeButtons = root.querySelectorAll('.rich-mode');
            converting = true;
            updateToolbarState();
            if (nextMode === 'markdown') {
                setStatus('Преобразование в Markdown…');
                request('commentEditorToMarkdown', { html: rich.innerHTML })
                    .then(function (data) {
                        converting = false;
                        setStatus('');
                        markdownInput.value = data.markdown || '';
                        rich.hidden = true;
                        markdownInput.hidden = false;
                        mode = 'markdown';
                        modeButtons.forEach(function (button) {
                            button.classList.toggle('active', button.getAttribute('data-mode') === 'markdown');
                        });
                        updateToolbarState();
                        markdownInput.focus();
                        notify();
                    })
                    .catch(function (error) {
                        converting = false;
                        setStatus(error.message || 'Не удалось переключить режим.');
                        updateToolbarState();
                    });
                return;
            }

            setStatus('Преобразование из Markdown…');
            request('commentEditorToHtml', { markdown: markdownInput.value })
                .then(function (data) {
                    converting = false;
                    setStatus('');
                    rich.innerHTML = data.html || '';
                    markdownInput.hidden = true;
                    rich.hidden = false;
                    mode = 'rich';
                    modeButtons.forEach(function (button) {
                        button.classList.toggle('active', button.getAttribute('data-mode') === 'rich');
                    });
                    updateToolbarState();
                    rich.focus();
                    notify();
                })
                .catch(function (error) {
                    converting = false;
                    setStatus(error.message || 'Не удалось переключить режим.');
                    updateToolbarState();
                });
        }

        var api = {
            host: root,
            getMode: function () {
                return mode;
            },
            getHtml: function () {
                return rich.innerHTML;
            },
            getMarkdown: function () {
                return markdownInput.value;
            },
            getPayload: function () {
                if (mode === 'markdown') {
                    return { text: markdownInput.value.trim(), format: 'markdown' };
                }
                return { text: rich.innerHTML.trim(), format: 'html' };
            },
            isEmpty: function () {
                if (mode === 'markdown') {
                    return !markdownInput.value.trim();
                }
                if (rich.textContent.trim()) {
                    return false;
                }
                return !rich.querySelector('img,pre,table,hr');
            },
            clear: function () {
                rich.innerHTML = '';
                markdownInput.value = '';
                savedRange = null;
                setStatus('');
                notify();
            },
            setHtml: function (html) {
                rich.innerHTML = html || '';
                markdownInput.value = '';
                if (mode !== 'rich') {
                    mode = 'rich';
                    rich.hidden = false;
                    markdownInput.hidden = true;
                    root.querySelectorAll('.rich-mode').forEach(function (button) {
                        button.classList.toggle('active', button.getAttribute('data-mode') === 'rich');
                    });
                }
                notify();
            },
            focus: function () {
                if (mode === 'markdown') {
                    markdownInput.focus();
                } else {
                    rich.focus();
                }
            },
            setDisabled: function (value) {
                disabled = Boolean(value);
                rich.setAttribute('contenteditable', disabled ? 'false' : 'true');
                markdownInput.disabled = disabled;
                root.classList.toggle('disabled', disabled);
                updateToolbarState();
            },
            setOnChange: function (handler) {
                onChange = typeof handler === 'function' ? handler : null;
            },
            destroy: function () {
                editors.delete(root.id);
                root.innerHTML = '';
                root.classList.remove('stepik-rich-editor');
            }
        };

        root.addEventListener('mousedown', function (event) {
            var target = event.target;
            if (target instanceof Element && target.closest('.rich-tool, .rich-mode')) {
                saveSelection();
                event.preventDefault();
            }
        });

        root.addEventListener('click', function (event) {
            var target = event.target;
            if (!(target instanceof Element)) {
                return;
            }
            var tool = target.closest('.rich-tool');
            if (tool) {
                event.preventDefault();
                if (tool.getAttribute('data-action') === 'inline-code') {
                    insertInlineCode();
                    return;
                }
                if (tool.getAttribute('data-action') === 'codeblock') {
                    openCodeDialog();
                    return;
                }
                if (tool.getAttribute('data-action') === 'math') {
                    openMathDialog();
                    return;
                }
                if (tool.getAttribute('data-action') === 'image') {
                    saveSelection();
                    fileInput.click();
                    return;
                }
                if (tool.getAttribute('data-action') === 'link') {
                    openLinkDialog();
                    return;
                }
                var command = tool.getAttribute('data-command');
                if (command) {
                    runCommand(command);
                }
                return;
            }
            var modeButton = target.closest('.rich-mode');
            if (modeButton) {
                event.preventDefault();
                switchMode(modeButton.getAttribute('data-mode'));
            }
        });

        rich.addEventListener('input', notify);
        markdownInput.addEventListener('input', notify);
        rich.addEventListener('keydown', function (event) {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                root.dispatchEvent(new CustomEvent('rich-editor-submit', { bubbles: true }));
                return;
            }
            if (event.key === 'Escape' && savedRange) {
                savedRange = null;
            }
        });
        document.addEventListener('selectionchange', function () {
            if (selectionInsideRich()) {
                saveSelection();
            }
        });
        rich.addEventListener('paste', function (event) {
            if (!event.clipboardData) {
                return;
            }
            event.preventDefault();
            var text = event.clipboardData.getData('text/plain');
            if (!text) {
                var html = event.clipboardData.getData('text/html');
                if (html) {
                    document.execCommand('insertHTML', false, escapeHtml(html));
                }
                return;
            }
            document.execCommand('insertHTML', false, escapeHtml(text).replace(/\n/g, '<br>'));
        });
        fileInput.addEventListener('change', function () {
            var file = fileInput.files && fileInput.files[0];
            fileInput.value = '';
            if (file) {
                uploadFile(file);
            }
        });

        rich.addEventListener('dragover', function (event) {
            if (event.dataTransfer && Array.from(event.dataTransfer.types || []).indexOf('Files') !== -1) {
                event.preventDefault();
                root.classList.add('dragging');
            }
        });
        rich.addEventListener('dragleave', function () {
            root.classList.remove('dragging');
        });
        rich.addEventListener('drop', function (event) {
            root.classList.remove('dragging');
            if (!event.dataTransfer || !event.dataTransfer.files || event.dataTransfer.files.length === 0) {
                return;
            }
            event.preventDefault();
            if (typeof document.caretRangeFromPoint === 'function') {
                var range = document.caretRangeFromPoint(event.clientX, event.clientY);
                var selection = window.getSelection();
                if (range && selection) {
                    selection.removeAllRanges();
                    selection.addRange(range);
                    savedRange = range.cloneRange();
                }
            }
            uploadFile(event.dataTransfer.files[0]);
        });

        document.addEventListener('click', function (event) {
            var target = event.target;
            if (!(target instanceof Element)) {
                return;
            }
            var link = target.closest('a[data-external]');
            if (link) {
                event.preventDefault();
                vscode.postMessage({ command: 'openExternalUrl', url: link.href });
            }
        });

        rich.hidden = false;
        markdownInput.hidden = true;
        if (disabled) {
            api.setDisabled(true);
        } else {
            updateToolbarState();
        }

        editors.set(root.id, api);
        return api;
    }

    function get(id) {
        return editors.get(id);
    }

    document.querySelectorAll('[data-stepik-rich-editor]').forEach(function (host) {
        create(host, {
            placeholder: host.getAttribute('data-placeholder') || undefined,
            compact: host.hasAttribute('data-compact'),
            disabled: host.hasAttribute('data-disabled')
        });
    });

    window.StepikRichEditor = {
        create: create,
        get: get,
        request: request,
        escapeHtml: escapeHtml
    };
})();
`;
}
