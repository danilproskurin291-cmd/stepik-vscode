# Stepik для VS Code
[[EN]](README_en.md)

Решайте задачи [Stepik](https://stepik.org) прямо в VS Code.


## Сборка
```
npm install -g vsce
vsce package
code --install-extension stepik-vscode-*.vsix
```


## Настройка OAuth

1. Перейдите на https://stepik.org/oauth2/applications/ и создайте новое приложение с настройками `client type = confidential` и `authorization grant type = client-credentials`.
2. Скопируйте `client id` и `client secret` созданного приложения.
3. Введите эти данные в расширении при авторизации.


## Рабочая папка

Решения сохраняются в `~/.stepik` по умолчанию, организованы по курсам и урокам.

## Лицензия

GPL v3
