# Vignet — план реализации

Статусы: `pending` — ещё не завершено; `done / verified` — реализовано и проверено автоматикой; `manual` — нужна ручная проверка Chromium/ChatGPT. Непроверенное не считается завершённым.

## Аудит и ограничения

- Существующий маршрут: Cloudflare Quick Tunnel → `bridge/http.mjs` (`127.0.0.1:8789/mcp`, JSON) → дочерний `bridge/server.mjs` (stdio) → WebSocket `127.0.0.1:8788/extension` → MV3 extension.
- Сохраняем оба транспорта, URL туннеля и legacy tools/результаты. Виньетка мигрирует из `vignetteSettings` без сброса.
- Baseline: `npm run check` PASS. `npm test` FAIL: рабочий Bridge уже занимает 8788; исправить тест на независимый порт, не останавливая рабочую инфраструктуру ради теста.
- Риски: существующая рассылка во все вкладки/первый socket; публичный HTTP без auth; MV3 userScripts availability; произвольный JS имеет доступ к DOM; квоты/ZIP bomb; отсутствие настоящего браузерного E2E. Репозиторий не содержит `.git`.
- Авторизация: внешний HTTP требует bearer token из окружения, устройство — отдельный credential; секреты за пределами исходников. Локальный режим явно single-user.

## Этапы и зависимости

0. Audit — done / verified: прочитаны ТЗ, все существующие исходники, README, transport, manifest и тесты. Baseline зафиксирован выше.
1. Core Model + Spec — done / verified. CSP-safe schema validation/defaults, builtin.vignette, migrations. `node --test tests/model.test.mjs`: PASS 3; legacy smoke на независимом порту PASS. Зависит от 0.
2. Media + Installer — done / verified (автоматика). IndexedDB content-addressed store, atomic install/update/restore, ZIP bounds/signatures/integrity, consent, export/pack. `node --test tests/model.test.mjs tests/storage.test.mjs`: PASS 14, включая квоты, rollback, traversal/bomb/CRC/SVG/hash/dedup. Настоящий браузерный IDB пока manual. Зависит от 1.
3. Runtime — done / verified. CSS parser, USER_SCRIPT lifecycle, independent Rain/theme с оригинальными MP3/WebP. Focused runtime/context PASS 13, включая зависшие Promise, immediate managed cleanup, поздние вызовы API и сброс world configuration. Настоящий Chromium USER_SCRIPT Rain/update/stop/media URL PASS. Синхронные бесконечные циклы и произвольные DOM patches требуют доверия/перезагрузки, это не sandbox. Зависит от 1–2.
4. Context Manager — done / verified. global/chat/temporary, event navigation, session storage для сна MV3, A/B restore и precedence. Controller suite PASS 11: worker recreation, миграция при пробуждении после присвоения ID, wrong-target refusal, failed cleanup retry, реальный remount при rollback update и rollback активной версии. Chromium A/B/reload/global style PASS. Зависит от 3.
5. Universal MCP — done / verified (автоматика). 8 universal + 2 legacy tools; explicit device/tab target, received/applied, bounded receipts/payload/auth. `node --test tests/bridge.test.mjs`: PASS 9 (живые HTTP/WS с mock extension), auth/malformed/offline/ambiguous/timeout/dynamic catalog; legacy smoke PASS. Зависит от 1 и 4.
6. UI + release — done / verified (локальная автоматика). Vanilla options UI, review/consent/import/export/settings/instances/media/diagnostics, build archives, ASSET_SPEC/SECURITY/SETUP, форматирование. UI/build unit PASS 7. `npm run test:browser` PASS: настоящий Chromium, собранное расширение, синтетический HTML ChatGPT без аккаунта, пользовательский JS через chrome.userScripts (не mock). Ручной сценарий настоящего MCP-плагина и autoplay в SETUP. Финальный clean install/check/test/build записывается ниже. Зависит от 2–5.

## Правила проверки

После каждого завершённого этапа записать конкретные команды и результаты, исправить регрессии до следующего checkpoint. Параллельно можно разрабатывать независимые модули с явно согласованными контрактами. Запуск эффекта подтверждается только `applied`, import не запускает JS. Ручные проверки реального ChatGPT, Allow User Scripts и autoplay отмечаются отдельно.

## Журнал

- Stage 0: аудит выполнен; syntax PASS; baseline smoke выявил конфликт с живым портом, а не доказанную регрессию.
- Stage 1–2: выделенные schema/storage тесты PASS; consent не запускает код, обе версии media сохраняются для rollback. Используется безопасное подмножество JSON Schema без runtime eval.
- Stage 3–4: раздельные проверки runtime/context PASS; независимый review выявил и исправлены потеря temporary при MV3 wake, ложный applied при чужом instanceId, engine mismatch обновления и повтор cleanup после ошибки. Для каждой интеграционной регрессии добавлен тест.
- Stage 5: HTTP `/mcp` сохранён; bearer обязателен для внешнего Host/forwarded запросов. Отдельный device credential, single-owner deployment. Уже запущенный старый процесс ещё не перезапускался; новая версия проверяется изолированно.
- Stage 6 in progress: UI/build PASS 7; отдельные `rain.vignet` и `example-theme.vignet` собраны; добавлены ASSET_SPEC/SECURITY/SETUP. Планируется настоящий Chromium smoke на синтетической странице ChatGPT, не аккаунтный E2E.
- Stage 6 complete: найденный настоящим Chromium баг sender.tab в options UI исправлен проверкой доверенного sender.id+URL. `npm run test:browser` повторно PASS после интеграционных исправлений. Проверены file picker+consent, отсутствие autorun, настоящий USER_SCRIPT, 112→84 капель при update, Blob fetch/revoke, дедуп MP3/WebP, A→B→A, global CSS, reload, WS disconnect и удаление одного владельца общих media.
- Финальный review: исправлены stale-mounted cache при ошибке update (с реальным повторным mount), wake-migration temporary и ложный applied при частичном global failure; добавлены регрессии. Статусы возвращают per-tab executions вместо устаревшего общего running.
- Финальная проверка после `npm ci`: PASS (48 пакетов audit, 0 vulnerabilities). `npm run check`: PASS, 30 JS-файлов. `npm test`: PASS, legacy stdio MCP smoke + 55 unit/integration checks, 0 failed/skipped. Проверен также private launcher: генерирует ключи вне проекта, требует bearer, не выводит секреты, завершает дочерние процессы.
- `npm run test:browser`: PASS после интеграционных исправлений; `npm run build`: PASS, `dist/extension`, `dist/packages/rain.vignet`, `dist/packages/example-theme.vignet`. Повторный независимый review исправлений: все три подтверждённых замечания закрыты, новых в проверенном объёме нет.

## Ручные проверки и границы

- Настоящий аккаунт ChatGPT и установленный MCP-плагин: manual / NOT RUN. Автоматика отдельно проверяет настоящий Bridge/HTTP/WS с mock extension и настоящее расширение/Chromium с локальным mock transport.
- Autoplay со звуком и поведение текущего production DOM ChatGPT: manual / NOT RUN. Беззвучный Rain проверен настоящим браузером.
- Развёртывание поддерживает одного владельца с отдельными credentials, не многопользовательский SaaS. Для разных владельцев нужны изолированные deployment/DB/token.
- Quick Tunnel URL не вписан в код. Ранее запущенный процесс Cloudflare уже завершён (внешняя среда, log: graceful shutdown); повторный запуск Quick Tunnel назначит новый URL. Реальный браузер пользователя не перезагружался и расширение в его профиль не устанавливалось автоматически: загрузить `dist/extension` по SETUP.
