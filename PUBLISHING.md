# Публикация

## 1. Проверьте метаданные

Ссылки в `package.json` указывают на
`danilproskurin291-cmd/stepik-vscode`:

```json
"repository": {
  "type": "git",
  "url": "https://github.com/danilproskurin291-cmd/stepik-vscode.git"
},
"homepage": "https://github.com/danilproskurin291-cmd/stepik-vscode#readme",
"bugs": {
  "url": "https://github.com/danilproskurin291-cmd/stepik-vscode/issues"
}
```

Поле `publisher` (`FYddddss`) — идентификатор издателя. Для публикации в
VS Code Marketplace он должен совпадать с созданным publisher-аккаунтом.
Для распространения только через GitHub менять его не обязательно.

## 2. Соберите VSIX

```bash
npm ci
npm run build
npx @vscode/vsce package
```

В корне появится `stepik-vscode-fork-0.4.7.vsix`.

`vsce` может предупредить об отсутствии `LICENSE` в формате Markdown или о
поле `publisher`. Лицензия уже включена как `LICENSE.txt`.

## 3. Подготовьте репозиторий

В репозиторий входят исходники, `dist/extension.js`,
`dist/audioWorker.js`, `package-lock.json`, документация и ресурсы.
`node_modules`, `recordings`, старые `.vsix` и локальные файлы исключены
через `.gitignore` и `.vscodeignore`.

```bash
git add .
git commit -m "Stepik for VS Code 0.4.7"
git push origin main
```

## 4. Оформите релиз на GitHub

1. Откройте **Releases → Draft a new release**.
2. Укажите тег `v0.4.7`.
3. Прикрепите `stepik-vscode-fork-0.4.7.vsix`.
4. При необходимости приложите ZIP с исходниками.
5. Опубликуйте релиз.

Пользователи смогут установить расширение командой:

```bash
code --install-extension stepik-vscode-fork-0.4.7.vsix
```

## 5. Публикация в VS Code Marketplace (необязательно)

1. Создайте publisher на <https://marketplace.visualstudio.com/manage>.
2. Укажите его в поле `publisher` в `package.json`.
3. Создайте Azure DevOps Personal Access Token с правом **Marketplace
   (Manage)**.
4. Выполните:

   ```bash
   npx @vscode/vsce login <publisher>
   npx @vscode/vsce publish
   ```

## Лицензия и авторство

Проект распространяется по GPL-3.0. При публикации сохраните `LICENSE.txt` и
ссылку на оригинальный проект <https://github.com/su-mt/stepik-vscode>.
