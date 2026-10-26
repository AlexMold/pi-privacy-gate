# TODO

## Goal
Локально работающий v1 пакета **pi-privacy**: PII-гейт в Pi (детектор PII Tracer GGUF через llama-server, withhold/redact tool results, `privacy_analyze` на локальной модели, fail-closed), верифицированный canary-сьютом, PII-TRACE-сабсетом и dogfooding-прогоном.

## Tasks

### 0. Repo & skeleton
- [x] `git init` в ~/workplace/pi-privacy-router, `.gitignore` (node_modules, веса моделей, артефакты)
- [x] SPEC.md: Claim Register по A.6.B — ID норм гейта (L-1 категории PII, A-1 withhold-предикат, A-2 allowlist-предикат, D-1 fail-closed, D-2 блок без валидной локальной модели) + зафиксированные решения design tree
- [x] package.json: name `pi-privacy`, license MIT, peerDependencies на host-пакеты Pi, `pi`-манифест (extensions)

### 1. M0 — Spike детектора (SYSE.24 bounded probe, go/no-go перед M1)
- [x] Скачать perplexity-ai/PII-Tracer-GGUF (~1.2GB), проверить состав: backbone f16, fp32 heads, decoding client
- [x] Определить язык decoding client и его самостоятельность → выбор: TS-порт Viterbi или микро-sidecar (в spike-отчёт)
- [x] Запустить llama-server с моделью, прогнать канонический пример из HF README, сверить спаны (private_person/email/phone)
- [x] Замерить латентность на чанке 4096 токенов на Mac (CPU и GPU)
- [x] Проверить self-managed путь: скачивание бинарника llama-server (macOS + Linux), spawn, health-check
- [x] Spike-отчёт: сравнение GGUF+llama-server vs Python-sidecar по 8 вопросам SYSE.24:4.3 + go/no-go. M1 стартует только после go

### 2. M1 — Детектор-сервис
- [x] Команда `/privacy-setup`: переиспользовать веса и llama-server из M0, если они уже скачаны/работают; иначе скачать. Идемпотентно (повторный запуск ничего не перекачивает). Развернуть, health-check, сохранить конфиг
- [x] Супервизор llama-server: запуск при session_start, рестарт при падении, остановка при session_shutdown
- [x] Scan API в TS: text → spans (9 категорий) + sensitivity score, чанкинг по 4096 токенов, Viterbi-декодер (порт или вызов sidecar — по решению M0)
- [x] Unit-тесты scan API на канонических примерах (email, phone, account_number, private_person)

### 3. M2 — Механика гейта
- [x] Хук `tool_result`: сканировать все tool results; спаны withhold-категорий (A-1) → контент в side-store, в контекст плейсхолдер; остальные спаны → `[REDACTED_category]`
- [x] Хук `before_provider_request`: сканировать payload, redact спанов в user-сообщениях и остаточном контенте; инжектированные секции (system/memory/скиллы) не трогать
- [x] Уведомления через ui.notify (TUI/RPC-safe, без диалогов): «N spans redacted», «file withheld»
- [x] Unit-тесты: withhold, redact, плейсхолдер, освобождение инжектированного контекста

### 4. M3 — privacy_analyze
- [ ] Инструмент `privacy_analyze(question, fileRef)`: чтение side-store, вызов локальной модели из конфига (provider/model через ctx.modelRegistry), возврат ответа
- [ ] Ответ инструмента проходит через детектор до попадания в контекст (redact спанов)
- [ ] Unit-тесты: вызов на каноничном чувствительном файле, redaction ответа с PII

### 5. M4 — Fail-closed, конфиг, allowlist
- [ ] privacy-router.json: localModel{provider, model}, withholdCategories, redactCategories, retryTimeout, пороги калибровки (span confidence, sensitivity), allowlist
- [ ] Fail-closed (D-1, D-2): retry N сек → блок с ошибкой; невалидная/отсутствующая localModel → блок всех чувствительных запросов с инструктивной ошибкой
- [ ] Команда `/privacy-allow file|session` → allowlist (работает в TUI и headless)
- [ ] Unit-тесты: retry-then-block, невалидный конфиг, allowlist-bypass

### 6. M5 — Виртуальная модель и пакет
- [ ] `registerVirtualModel` `privacy/auto`: гейт активен только в ней, дефолт-роутинг в облачную модель
- [ ] Команда `/privacy on|off|status`: включает/выключает гейт в текущей сессии (переключение модели на `privacy/auto` и обратно) и показывает состояние гейта
- [ ] Сборка пакета (pi-манифест, peerDependencies), локальная установка `pi install ./` — проверка загрузки
- [ ] README (EN): установка, /privacy-setup, конфиг, ограничения — инжектированный контекст освобождён, защищается egress в облако, не локальный диск

### 7. M6 — Верификация и dogfooding
- [ ] Canary suite: синтетические файлы с подсаженным PII всех 9 категорий (выписки, договор, медзапись, штраф) + бенигн-корпус для замера FP-rate
- [ ] PII-TRACE сабсет: замер F1 детектора, пороги зафиксировать в отчёте
- [ ] Dogfooding: включить `privacy/auto` на своих сессиях, проверить логи провайдеров на egress, журнал находок
- [ ] B.3 assurance card в SPEC.md: target claim, assurance use, disposition, limitations, reopen conditions (4: egress-инцидент, апдейт PII Tracer, изменение семантики хуков Pi, превышение бюджета латентности)
- [ ] Линт привязки: каждый тест ссылается на Claim Register ID (G/A/D-нормы)

## Notes
- **Язык:** документация EN (комьюнити), TODO/SPEC можно RU.
- **Платформы:** macOS (твоя машина) + Linux в логике скачивания; Windows вне v1.
- **Решения design tree (из гриллинга):** two-tier через privacy_analyze; PII Tracer GGUF; self-managed /privacy-setup; fail-closed retry→block; конфиг-файл без wizard; withhold по конфиг-категориям; сканирование всех tool results; /privacy-allow как escape hatch; верификация canary + PII-TRACE + dogfooding + unit.
- **Открытые риски:** язык decoding client (решает M0); латентность детектора (меряет M0); качество локальной модели юзера влияет на privacy_analyze — в README минимальная рекомендация.
- **FPF-дисциплина:** design tree = описание, не система; go по M0 ≠ release (release-решение — отдельно, после M6, по SYSE.14).
