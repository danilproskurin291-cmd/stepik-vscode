# Stepik VS Code Extension - План реализации

## Phase 1: Инициализация проекта
- [ ] Scaffold VS Code extension (TypeScript, esbuild)
- [ ] Настройка package.json (commands, views, activation events)
- [ ] Структура папок: `src/api`, `src/views`, `src/providers`, `src/utils`

## Phase 2: Аутентификация
- [ ] Команда `stepik.login` - окно ввода токена (client_id + client_secret)
- [ ] Сохранение в SecretStorage
- [ ] Команда `stepik.logout`
- [ ] Проверка авторизации при старте

## Phase 3: Stepik API Client
- [ ] Базовый HTTP клиент с авторизацией
- [ ] Endpoints:
  - `GET /api/user-courses` - курсы пользователя
  - `GET /api/courses/{id}` - детали курса
  - `GET /api/sections` - секции курса
  - `GET /api/lessons/{id}` - уроки
  - `GET /api/steps/{id}` - шаги (задания)
  - `POST /api/attempts` - создание попытки
  - `POST /api/submissions` - отправка решения
  - `GET /api/submissions/{id}` - статус проверки

## Phase 4: TreeView - Навигация
- [ ] TreeDataProvider для курсов/уроков/шагов
- [ ] Иконки статусов: ⭕ не пройдено, 🔵 начато, ✅ пройдено
- [ ] Автообновление при изменении статуса
- [ ] Команда refresh

## Phase 5: WebView - Отображение задания
- [ ] Рендер текста задания в Markdown
- [ ] Поддержка картинок, формул (KaTeX)
- [ ] Выбор языка (для code заданий)
- [ ] Quiz UI: чекбоксы/радиокнопки + Submit

## Phase 6: Работа с файлами
- [ ] Создание структуры `course-name/lesson-N/step-M.ext`
- [ ] Вставка template кода из API
- [ ] Сопоставление открытого файла с заданием

## Phase 7: Отправка решений
- [ ] Команда `stepik.submit` - отправка открытого файла
- [ ] Polling статуса проверки
- [ ] Уведомление результата (toast notification)
- [ ] Обновление иконки в tree

## Phase 8: Polish
- [ ] Обработка ошибок, retry логика
- [ ] Loading states
- [ ] Кэширование данных
- [ ] README, документация

---

## MVP Scope (Phases 1-4 + базовый 5-7):
1. Логин по токену
2. Tree с курсами/уроками/шагами
3. Просмотр code задания + выбор языка
4. Создание файла с template
5. Отправка и получение результата

Quiz/Choice - после MVP.
