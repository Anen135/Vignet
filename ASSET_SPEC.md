# Спецификация пакетов Vignet

## Формат `.vignet`

Пакет — ZIP-архив с UTF-8 `asset.json` и только объявленными в манифесте файлами. Пути относительные, разделитель `/`; абсолютные пути, `.`/`..`, обратная косая черта, повторяющиеся пути без учёта регистра и неиспользуемые файлы запрещены. ID должен быть namespaced, например `community.rain`; идентификаторы с префиксом `builtin.` зарезервированы.

Пример CSS-пакета:

```json
{
  "schemaVersion": 1,
  "id": "community.example-theme",
  "name": "Example Theme",
  "version": "1.0.0",
  "description": "Небольшая тема для ChatGPT",
  "scripts": [],
  "styles": ["styles/theme.css"],
  "media": [],
  "actions": {
    "start": {
      "description": "Применить тему",
      "parameters": {"type":"object","additionalProperties":false}
    },
    "stop": {
      "description": "Снять тему",
      "parameters": {"type":"object","additionalProperties":false}
    }
  },
  "settingsSchema": {"type":"object","additionalProperties":false,"properties":{}},
  "permissions": ["dom_overlay"],
  "execution": {
    "world":"USER_SCRIPT",
    "multipleInstances":false,
    "cleanupGuarantee":"managed",
    "requiresReloadOnStop":false
  },
  "defaultScope":"chat",
  "compatibility":{"minimumChromeVersion":135}
}
```

Обязательные поля: `schemaVersion`, `id`, `name`, `version` (SemVer), `description`, `scripts` (может быть пустым), `styles`, `media`, `actions`, `settingsSchema`, `permissions`, `execution`, `defaultScope`, `compatibility`. Вместо `scripts` можно указать корневое поле `entry` — одиночный JS entry point. `author`, `license`, `integrity` необязательны. Для JavaScript обязательны `user_scripts` и `dom_access`: такой код имеет доступ к DOM беседы. Для воспроизведения аудио объявляйте `audio`.

JSON Schema намеренно ограничена безопасным подмножеством: `type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `default`, `description`, `title`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`. Разрешённый `pattern` сейчас только `^#[a-fA-F0-9]{6}$`. Другие ключевые слова отклоняются. У схемы параметров действия должен быть тип `object`; defaults применяются перед проверкой.

При сборке `entry` преобразуется в самостоятельный IIFE bundle `VignetAssetLifecycle`; импорты из файлов за корнем пакета отклоняются. Экспорт включит этот скомпилированный bundle и заявленные ресурсы. CSS разбирается css-tree; локальные `url(...)` разрешаются относительно файла стилей и превращаются в Blob URL в странице-потребителе. Внешние URL и CSS `@import` запрещены. Медиа читается через `context.resource("media/file.webp")` / `context.playAudio("media/loop.mp3")` в SDK lifecycle-контексте.

Пределы ZIP: архив до 16 MiB, распакованный объём до 32 MiB, до 256 файлов, степень сжатия до 100:1. Проверяются CRC, пути, MIME-сигнатуры и SHA-256 (`integrity`). Активные или внешне ссылающиеся SVG запрещены. Поддерживаемые типы: JS, CSS, JSON/TXT, PNG, JPEG, WebP, ICO, MP3, WAV, OGG и ограниченный SVG. Установка требует явного подтверждения; установленный пакет не запускается автоматически. Обновление требует новой SemVer-версии и отдельного подтверждения.

## Runtime lifecycle

JS entry point экспортирует:

```js
export async function mount(context, options) {}
export async function update(context, options) {}
export async function unmount(context) {}
export const actions = { /* дополнительные объявленные действия */ };
```

`context` предоставляет `root` (ShadowRoot), `signal`, `instanceId`, `resource(path)`, `playAudio(path)`, `onCleanup(fn)`, `interval`, `timeout`, `listen` и `observe`. Верните disposer из `mount` либо освободите ресурсы в `unmount`. `update` обновляет работающий экземпляр. Асинхронный lifecycle ограничен четырьмя секундами; управляемые ресурсы очищаются сразу при остановке, до ожидания пользовательского teardown. Синхронный бесконечный цикл или произвольные изменения DOM могут требовать перезагрузки вкладки. Встроенный `builtin.vignette` совместим с прежними `enabled`, `color`, `opacity`, `innerRadius`; сохранённая `vignetteSettings` мигрирует при запуске.

Команды разработчика: `npm run pack:asset -- <директория> [выходной-файл]`; без аргументов команда собирает примеры. Полная сборка — `npm run build`; результат: `dist/extension`, `dist/packages/rain.vignet`, `dist/packages/example-theme.vignet`.
