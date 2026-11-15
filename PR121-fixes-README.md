# ZeroScript PR #121 — заплатки по итогам ревью (v1.5.6.4)

**Патч:** `pr121-followup-fixes.patch` (5 файлов, собран по head-коммиту PR `60eece1ad19f3b6349fea15426f630d09bedc5dd`)
**Вердикт ревью:** Request Changes — 2 blocker, 1 major, 2 minor. Всё, что чинится кодом, залатано в этом патче; остальное — ручные действия на GitHub (см. раздел 3).

---

## 1. Что залатано

| # | Серьёзность | Проблема | Фикс | Файл |
|---|---|---|---|---|
| A | 🔴 blocker | Автогендшейк (issue #61) отдавал токен **любому** расширению: проверка Origin была префиксной (`chrome-extension://*`), и welcome-кадр вручал per-install токен каждому, кто прошёл её. Любое второе расширение в браузере получало полный контроль над мостом. | Whitelist по **ID расширения** (браузер сам ставит Origin, подделать нельзя). TOFU: первый подключившийся ID пиннится в `bridge_extension_ids.txt`; неизвестный ID → close **4402**; веб-страница/null-origin → **4401**. Токен в welcome-кадре отдаётся только ID, запиненному **до** текущего соединения — даже если rogue-расширение выиграет гонку первого подключения, токен оно не получит. Сброс пина: удалить `bridge_extension_ids.txt`, перезапустить мост. | `Client/bridge.py` |
| B | 🔴 blocker | `Client/bridge_token.txt` закоммичен в историю PR **дважды** (токен `988c175e…6614`, а вторым коммитом — файл с текстом «Someone, help setting with .gitignore to ignore MY TOKEN»). Последующий «Delete … Again.» историю **не чистит** — значение остаётся в коммитах навсегда. | Guardrail в мосте: если `bridge_token.txt` лежит внутри git-репозитория (есть `.git`), при каждом старте печатается красный баннер **ACTION NEEDED** с шагами ротации. Ротация = удалить файл, мост сгенерит новый токен. | `Client/bridge.py` |
| C | 🟠 major | `start.bat` ставил websockets **без пина** (`pip install websockets`). Факт (живой probe рукопожатием): в websockets ≤13.x `ws.request_headers` есть (legacy API), в **14.0+ `websockets.serve` — уже новый asyncio-API, и `request_headers` удалён** — Origin достаётся только через фолбэк `ws.request.headers`. Сегодня это работает, но future major может снести и его → fail-closed (мост отклонит всех). | Пин `websockets>=12,<18` + авто-даунгрейд, если старый start.bat уже поставил непиненную latest; в bridge.py — жёлтое предупреждение при major ≥ 18. Диапазон 12/14/17 проверен реальным рукопожатием. | `Client/start.bat`, `Client/bridge.py` |
| D | 🟠 major | Rate-limit: кулдаун 2 мин, а watchdog-автовозобновление смотрит в окно «свежести» 3 мин. Оба автосендера гейтятся только `rateLimitActive()` — как только кулдаун истёк, они снова стреляли в ещё горячий лимит: send → refuse → 2 мин → send → refuse (drip-цикл), хотя баннер обещает «отправьте сообщение вручную». | Латч `A.rateLimitHold`: ставится в `tripRateLimit()`, снимается **только** реальным сообщением пользователя (`onUserMessage`). Плюс `A.lastGenAt = 0` — отказавший ход навсегда «протухает» для watchdog'а. Автоповторов больше нет в принципе; резюм — только вручную, как и написано в баннере. | `Extension/core/main.js` |
| E | 🟡 minor | Синхронизация версий bridge ↔ manifest. | `1.5.6.3 → 1.5.6.4` в обоих местах. | `Extension/manifest.json`, `Client/bridge.py` |
| F | 🟡 minor | Новый локальный файл с пинами не должен попасть в git. | `.gitignore`: + `bridge_extension_ids.txt`, `Client/bridge_extension_ids.txt`. | `.gitignore` |

**Осознанно не тронуто:** human-paced sends (3.4–16.8 с/сообщение) — это анти-rate-limit фича, резать её без согласия автора нельзя, а фикс D уже убирает главный вред от повторных долблений; ERR_LEAD-камуфляж (`failure_leads.json`) — имиджевый, не security-риск.

## 2. Как применить патч

Патч накладывается **из корня репозитория** на ветку PR (или на master — контексты общие, при конфликте используйте `--3way`):

```bash
# Вариант 1: поверх ветки PR #121 (если можете в неё пушить)
git fetch origin pull/121/head && git checkout -b pr121-security-fixes FETCH_HEAD
git apply --check pr121-followup-fixes.patch   # сухой прогон
git apply pr121-followup-fixes.patch
git add -A && git commit -m "Security follow-up (1.5.6.4): pin extension IDs, token-in-repo guardrail, websockets pin, rate-limit hold"
git push -u origin pr121-security-fixes        # отдельным PR к PR #121 или в ту же ветку

# Вариант 2: на master / свою ветку
git checkout main
git apply --3way pr121-followup-fixes.patch
```

Патч проверен `git apply --check` на чистой копии head-коммита PR; состав:
`Client/bridge.py`, `Client/start.bat`, `Extension/core/main.js`, `Extension/manifest.json`, `.gitignore`.

## 3. GitHub-сторона (то, что кодом не чинится)

Это единственная часть, которую придётся сделать руками (или отдать любому агенту с GitHub-коннектором — команды атомарные):

1. **Ротация токена — сделать первым.** Токен `988c…c6614` публичен в истории PR. Он защищает только localhost-мост, но это не повод оставлять его в истории: удалить `Client/bridge_token.txt` локально → при следующем старте мост сгенерирует новый → вставить его в попап расширения один раз. Патч B с этого момента будет напоминать баннером, если файл снова окажется в репо.

2. **Чистка истории — одно из двух:**
   - **Простой путь (рекомендую):** закрыть PR #121 и вмержить версию из патча **squash-коммитом** со своей ветки. Squash схлопывает всю историю PR в один чистый коммит — токен в merged-истории не появится.
   - **Сложный путь (если PR нужен именно как PR):** автор переписывает ветку через
     `git filter-repo --path Client/bridge_token.txt --invert-paths` (или BFG) и делает force-push. После этого попросить GitHub Support прогнать GC, чтобы старые коммиты пропали из кэша и форков: https://docs.github.com/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository

3. **Если PR чужой:** оставить Request Changes со ссылкой на этот файл, приложить патч и пункты 1–2 — автору.

## 4. Как проверялся патч

- `python -m py_compile` (bridge.py) и `node --check` (main.js) — чисто.
- **Интеграционный тест реального `handler()`** (боевой websocket-сервер + клиент): первое подключение → пин без токена; второе → автогендшейк с токеном; сообщение без токена → `auth_error`; чужой extension ID → close 4402; страница/null-origin → close 4401; пин персистится в файл. **PASS на websockets 12.0, 14.2 и 17.4.**
- Тесты парсера расширения (`test-parser.js`) — PASS.
- `git apply --check` на чистом head `60eece1` — OK; результат применения байт-в-байт совпадает с исправленным деревом.

---

## 5. ZIP «весь ZeroScript с фиксами» — что обезврежено дополнительно

В дереве PR #121, кроме папки `Client/`, обнаружился **легаси-дубликат в корне репо**: `bridge.py` v1.5.5 (2041 строка) **вообще без Origin-проверки и токена** — любой таб в браузере мог открыть `ws://127.0.0.1:17613` и рулить Studio. Корневой README при этом отправлял запускать именно корневой `start.bat`. В ZIP это обезврежено (только в ZIP — upstream-патч оставлен хирургическим, см. раздел 2):

| Файл | Что сделано в ZIP |
|---|---|
| `bridge.py` (корень, 1.5.5) | Бэкпорт Origin-гейта: тот же TOFU allow-list по ID расширения (`bridge_extension_ids.txt`), unknown ID → close **4402**, страница/null → **4401**. Токен-аутентификации тут нет by design (легаси-копия) — гейт по ID единственный. |
| `start.bat` (корень) | Редирект на `Client\start.bat` (запускается только поддерживаемый мост 1.5.6.4). |
| `MacOS_Start.command` (корень) | Редирект на `Client/MacOS_Start.command`. |
| `README.md` (корень) | Пункт запуска исправлен на `Client\start.bat` / `Client/MacOS_Start.command`. |

**Каноничный запуск из ZIP — только `Client/start.bat` (Windows) или `Client/MacOS_Start.command` (macOS).** Все остальные пути ведут на редирект или гейт.

В ZIP не попали (проверено): `bridge_token.txt`, утёкший токен `988c175e…` (в дереве отсутствует), `.git` (история с утечкой), `logs/`, `__pycache__`.

Бонус-проверка бэкпорта: живой handshake-тест корневого `handler()` — first-connect без токен-поля, страница → 4401, чужой ID → 4402, пин пишется в файл. PASS на websockets 16.x.
