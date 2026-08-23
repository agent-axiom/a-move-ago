# A MOVE AGO — удаление Telegram-профиля

- Статус: утверждён пользователем; готов к реализации
- Дата: 2026-08-20
- Репозиторий: `agent-axiom/a-move-ago`
- Связанный release blocker: `PRIVACY.md`, раздел «Player controls and deletion requirement»

## 1. Резюме решения

До публичного запуска A MOVE AGO предоставляет игроку самостоятельный путь немедленного и
безвозвратного удаления Telegram-профиля и связанных с ним данных приложения.

Удаление выполняется через аутентифицированный `DELETE /v1/me`. В одной D1-транзакции текущая
Telegram-сессия превращается в отвязанную от Telegram псевдонимную гостевую сессию, после чего
строка игрока удаляется. Существующие внешние ключи каскадно удаляют остальные Telegram-сессии,
привязанные попытки, подсказки и Telegram auth-flow, уже связанные с player. Текущий opaque token
не меняется и после успешного удаления даёт доступ только к пустому гостевому состоянию.

Такой порядок делает операцию безопасной при повторе и при потере успешного HTTP-ответа: пока
сохранённая session активна и запрос допущен limiter, клиент может повторить его с тем же token и
получить то же гостевое состояние, не создавая новую учётную запись и не восстанавливая удалённые
данные.

## 2. Цели

- Снять явно зафиксированный в `PRIVACY.md` блокер публичного запуска.
- Удалить из online D1 Telegram identity и весь связанный с ним прогресс одним атомарным действием.
- Немедленно отозвать доступ к удалённому профилю со всех остальных устройств.
- Продолжить текущую сессию как гостевую без повторной выдачи или передачи token.
- Не сообщать об успехе до подтверждённого ответа Worker.
- Не записывать Telegram identity или удаляемые данные в application logs.

## 3. Не входит в scope

- Период восстановления, soft delete или отложенное удаление.
- Восстановление удалённого профиля и прогресса.
- Удаление Telegram-аккаунта или данных, которые хранит сам Telegram.
- Fresh re-authentication через Telegram непосредственно перед удалением. Активная Telegram-сессия
  A MOVE AGO является достаточной аутентификацией для MVP.
- Административная панель и ручная операторская очередь удаления.
- Немедленное физическое стирание из инфраструктурных backup и platform logs. Их фактическая
  retention должна быть настроена и раскрыта оператором до production launch; удалённые данные не
  должны восстанавливаться обратно в активную базу.
- Изменение или удаление шахматного контента, import history и агрегатов, не содержащих identity
  игрока.

## 4. API-контракт

### 4.1. Endpoint

```http
DELETE /v1/me
Authorization: Bearer <opaque-session-token>
Accept: application/json
```

Request body отсутствует. Endpoint использует существующие middleware и сервисы в следующей
границе ответственности:

1. `requireSession` проверяет bearer token, expiry и revocation;
2. `requireAllowedMutationOrigin` применяет точный browser-origin allowlist и сохраняет текущую
   поддержку native-клиентов без `Origin`;
3. `AUTH_RATE_LIMITER` ограничивает запросы по ключу `profile-delete:<sessionId>`;
4. deletion service выполняет идемпотентную операцию в D1.

Глобальный `exactCors` добавляет `DELETE` в `Access-Control-Allow-Methods` только для exact allowed
origin. Иначе browser-клиент не сможет пройти обязательный preflight.

Успешный ответ имеет статус `200`, заголовок `Cache-Control: no-store` и проверяется новым
guest-only `GuestMeResponseSchema`:

```json
{
  "kind": "guest",
  "profile": null
}
```

`GuestMeResponseSchema` экспортируется из `packages/api-contract`; `MeResponseSchema` переиспользует
его как guest-ветвь существующего union. Новый token не выдаётся. `createApiClient` расширяет
допустимые методы запроса значением `DELETE` и добавляет строго типизированный guest-only метод
`deleteProfile()`. Даже корректный Telegram-shaped `200` для этого endpoint считается contract
failure, а не успешным удалением.

### 4.2. Идемпотентность

- Допущенная middleware активная Telegram-сессия удаляет профиль и становится гостевой.
- Допущенная middleware активная гостевая сессия возвращает тот же `200` guest response без
  изменения данных.
- Последовательный повтор после успешного удаления поэтому безопасен.
- Идемпотентность гарантирует сохранность state, но не обходит middleware: слишком частые повторы
  могут получить `429` вместо `200`.
- При конкурентных запросах один выполняет удаление, а остальные либо видят уже преобразованную
  guest session и возвращают success, либо получают `401`, если их Telegram-сессия была каскадно
  удалена. Ни один путь не восстанавливает профиль и не оставляет частичное удаление.

### 4.3. Ошибки

| Условие | Ответ | Изменение данных |
| --- | --- | --- |
| Bearer token отсутствует, истёк или отозван | `401 INVALID_SESSION` | Нет |
| Browser origin не входит в allowlist | `403 ORIGIN_NOT_ALLOWED` | Нет |
| Rate limit исчерпан | `429 RATE_LIMITED` | Нет |
| D1 statement или in-batch guard завершился ошибкой | Ответ после state re-read по разделу 6: `200`, `401` или generic `5xx` | Текущий batch rollback; конкурентный commit мог изменить state |
| Post-return sanity check не может подтвердить ожидаемый D1 result | Ответ после state re-read по разделу 6: `200`, `401` или generic `5xx` | Batch мог быть committed; повторное чтение классифицирует outcome |
| Соединение или acknowledgement потеряно после отправки batch | Client transport error | Outcome неизвестен клиенту; безопасный retry классифицирует state |

Ответы не раскрывают наличие другого профиля, Telegram ID, число устройств, количество попыток или
внутренние SQL-детали.

## 5. Модель данных и транзакция

Новая migration не требуется. Используются существующие связи:

- `sessions.player_id -> players.id ON DELETE CASCADE`;
- `attempts.player_id -> players.id ON DELETE CASCADE`;
- `hint_events.attempt_id -> attempts.id ON DELETE CASCADE`;
- `auth_flows.player_id -> players.id ON DELETE CASCADE`.

Для Telegram actor deletion service выполняет один `env.DB.batch` с transaction guard:

1. Обновляет только текущую активную сессию, если `id`, `kind`, `player_id` и `channel` совпадают с
   actor из middleware, а строка всё ещё удовлетворяет `revoked_at IS NULL AND expires_at > now`.
   `SessionActor` не расширяется expiry/revocation snapshot.
2. Устанавливает `kind = 'guest'`, `player_id = NULL`, `rotated_from_session_id = NULL` и обновляет
   `last_seen_at`. `token_hash`, `channel`, `created_at` и `expires_at` сохраняются.
3. Удаляет строку `players`, только если первый шаг успешно оставил ожидаемую guest session. На
   обычном пути удаляется ровно одна строка; уже завершённый конкурентный повтор может изменить
   ноль строк.
4. Последний prepared statement **внутри того же batch** условно нарушает существующий
   `sessions.kind` CHECK constraint, если текущая session не является ожидаемой guest session,
   player всё ещё существует или связанные каскады не завершены. Ошибка statement откатывает весь
   batch. Проверка `D1Result.meta.changes` после возврата служит только sanity check и не считается
   механизмом rollback.

После commit:

- текущий token обозначает новую пустую guest identity;
- все остальные Telegram-сессии удалённого player отсутствуют;
- все attempts с `player_id` удалены, включая прогресс, ранее перенесённый из guest session;
- соответствующие `hint_events` и `auth_flows` с удалённым `player_id` отсутствуют;
- `players.telegram_user_id`, OIDC claims, display name, username и avatar URL отсутствуют;
- `puzzles`, `daily_cases`, solutions, hints контента и `content_imports` не изменены.

Текущая unlinked pseudonymous guest session сохраняет `id`, `token_hash`, `kind = 'guest'`,
`channel`, `created_at`, `expires_at`, `revoked_at` и `last_seen_at`; её `player_id` и
`rotated_from_session_id` равны `NULL`. Отозванные pseudonymous guest predecessors могут сохранять
те же технические поля, `player_id = NULL` и собственный `rotated_from_session_id`, указывающий на
более раннюю pseudonymous guest session, до штатной scheduled cleanup. После удаления player и
связанных auth-flow эти session rows не содержат Telegram identity, текущая session на них больше
не ссылается, и они не связаны с попытками удалённого профиля. Эта retention раскрывается в
`PRIVACY.md`.

Без tombstone deletion не может отменить два уже начатых, но ещё не связанных с player пути входа:

- OIDC auth-flow с `player_id IS NULL` ещё не содержит связи с удаляемым Telegram ID и поэтому не
  удаляется каскадом;
- уже выполняющийся Mini App login может держать проверенную Telegram identity только в текущем
  запросе и работать от другой guest session.

Если любой из этих явно начатых до deletion login завершится после commit, он может создать новый
player. Это считается новым account creation event: удалённые profile attempts/hints не
восстанавливаются, но независимо накопленный progress исходной guest session может быть привязан
обычным account-link механизмом. Если linking успевает завершиться до deletion, созданная связь
попадает под обычное удаление player. Отказ от tombstone — осознанный MVP trade-off.

## 6. Классификация повторов и гонок

Deletion service следует существующему в session/account-link services fail-closed паттерну. После
любого rejected batch/guard и после post-return sanity failure он повторно читает состояние:

- до batch он принимает только проверенный `SessionActor`;
- активная session с тем же ID, уже имеющая `kind = 'guest'` и `player_id = NULL`, при отсутствии
  прежнего player и его связанных rows означает завершённый идемпотентный delete;
- отсутствующая, revoked или expired session означает `401 INVALID_SESSION`;
- любое иное состояние или ошибка самого re-read считается internal invariant failure и даёт
  generic `5xx`, не маскируясь под success.

Этот механизм не создаёт tombstone и не сохраняет Telegram ID ради дедупликации. Потеря успешного
HTTP acknowledgement поэтому обрабатывается повтором: active guest означает committed delete,
исходная active Telegram session запускает delete повторно, а отсутствующая session даёт `401`.

## 7. Client UX

### 7.1. Видимость

На экране `Progress` destructive control и confirmation отображаются только при
`state.tag === 'ready'` и `me.kind === 'telegram'`. Profile-deletion component остаётся смонтированным
на экране, чтобы после собственного успешного action показать одноразовый guest success status.
Обычный guest, booting, authenticating и fatal states не показывают destructive control.

### 7.2. Два явных шага

Первый control называется `Delete Telegram profile`. После нажатия прямо на странице раскрывается
inline confirmation region с текстом:

> This permanently deletes your A MOVE AGO Telegram profile and all saved attempts, hints, and
> statistics on every device. It does not delete your Telegram account. This cannot be undone.

Доступные действия:

- `Cancel` — закрывает confirmation без network request;
- `Delete permanently` — запускает единственный deletion action.

Inline region предпочтительнее modal для MVP: он не требует отдельного focus trap, остаётся в
естественном порядке клавиатурной навигации и использует heading/description для доступного имени.
Destructive action визуально отделён от обычной статистики и Telegram consent.

Disclosure opener имеет `aria-expanded` и `aria-controls`. Confirmation region имеет стабильный
`id`, доступное имя через heading и описание через warning text. После раскрытия focus переходит на
heading с `tabIndex = -1`; `Cancel` закрывает region и возвращает focus opener. Все действия доступны
с клавиатуры без специального pointer interaction.

### 7.3. Pending, success и failure

- Пока запрос выполняется, обе кнопки disabled, destructive label меняется на `Deleting…`, а
  повторный вызов блокируется существующим single-action механизмом `SessionProvider`. Pending
  state объявляется через `role="status"`/polite live region.
- При `200` provider устанавливает `{ tag: 'ready', me: { kind: 'guest', profile: null } }`.
- Смена session identity меняет key ежедневного flow и `StatsPanel.refreshKey`: daily state
  remount'ится, статистика перечитывается, удалённая Telegram profile больше не отображается и
  появляется `Save progress with Telegram`.
- Profile-deletion component остаётся смонтированным на `Progress` screen, показывает surviving
  success status `Telegram profile deleted. You are now playing as a guest.` и переводит на него
  focus. Status использует polite live announcement и `tabIndex = -1` только для programmatic focus.
- Если игрок позднее снова явно выбирает `Save progress with Telegram`, создаётся новый профиль
  для той же Telegram identity; удалённый прогресс не восстанавливается, а накопленный после
  удаления guest progress может быть привязан обычным способом.
- Token в runtime и platform token store не заменяется и не очищается.
- При API, contract или transport error provider сохраняет Telegram `me` в ready state и
  отклоняет action; profile-deletion component показывает сообщение с `requestId`, если он
  доступен. Error использует `role="alert"`.
- Transport error никогда не трактуется как success. Confirmation остаётся доступным для повтора.
- После `401` клиент не утверждает, что профиль удалён. Обычный session bootstrap при следующем
  запуске восстановит доступную session либо создаст guest, но UI предлагает снова войти через
  Telegram, если пользователь хочет проверить состояние профиля.

## 8. Security и privacy boundaries

- Авторизация основана только на opaque bearer token, hash которого хранится в D1 с server-side
  pepper; token не передаётся в URL или response body удаления.
- Client-side confirmation защищает от случайного действия, но не считается дополнительным
  authentication factor.
- Exact-origin middleware защищает browser mutation. Native Telegram/Android сохраняют текущую
  модель запросов без `Origin` и полагаются на bearer token.
- Endpoint не принимает player ID, Telegram ID или произвольный target; удалить можно только
  профиль текущего actor.
- Structured logs содержат request ID, method, path, status и session kind, но не raw URL,
  authorization header, request body, Telegram fields или удаляемые значения.
- Success/error payload не содержит counts удалённых строк и не позволяет исследовать чужие
  аккаунты.
- `PRIVACY.md` после реализации описывает online deletion, все retained поля unlinked pseudonymous
  guest sessions, возможность завершения ранее явно начатого OIDC или Mini App login и отдельно
  раскрывает platform backup/log retention production-оператора.

## 9. Component boundaries

### `packages/api-contract`

- Разрешает HTTP method `DELETE` во внутреннем transport.
- Добавляет exported guest-only `GuestMeResponseSchema` и typed `deleteProfile()` с этим schema.
- Проверяет точный method/path, auth header, success contract и error envelope.

### `apps/api`

- `routes/me.ts` объявляет endpoint и middleware chain.
- `middleware/cors.ts` разрешает `DELETE` в preflight только для configured exact origins.
- Отдельный profile-deletion service владеет D1 batch, transaction guard и race classification.
- Route не содержит SQL и возвращает только schema-validated response.

### `apps/client`

- `SessionProvider` владеет единственным in-flight deletion action и глобальным переходом
  Telegram -> guest.
- Небольшой profile-deletion component владеет раскрытием confirmation и локальным pending/error
  UI; он не меняет глобальную session identity напрямую.
- `App.tsx` компонует control внутри существующего экрана `Progress`, не переносит API-логику в UI.

## 10. Test design

### Contract tests

- `deleteProfile()` отправляет exact `DELETE /v1/me` с bearer token и без body.
- Валидный guest response принимается; malformed success вызывает `ApiContractError`.
- Валидный для общего `MeResponseSchema`, но Telegram-shaped success также вызывает
  `ApiContractError`; client сохраняет прежний Telegram state.
- Error envelope, abort и transport failure сохраняют существующую семантику клиента.
- Allowed-origin preflight рекламирует `GET,POST,DELETE,OPTIONS`; denied origin не получает CORS
  grant. Protected endpoint не выполняется во время preflight.

### API/service integration tests

- Профиль с несколькими Telegram-сессиями, attempts, hint events и auth-flow полностью удаляется.
- Текущая session остаётся с тем же ID/token hash/channel/expiry, но становится guest и теряет
  rotation link.
- Retained revoked guest predecessor может сохранить pseudonymous `rotated_from_session_id` chain,
  но не `player_id`, Telegram identity или attempts удалённого profile; privacy inventory перечисляет
  это поле, а scheduled cleanup по-прежнему удаляет chain по retention policy.
- Другие Telegram-сессии того же player становятся invalid.
- attempts/hints/auth-flow удаляются; unrelated player и весь chess content остаются неизменными.
- Ранее перенесённые guest attempts с `player_id` также удаляются.
- Повтор тем же token возвращает `200` guest без дополнительных mutations.
- Конкурентный повтор не оставляет частичное состояние и не восстанавливает player.
- Если session становится revoked, expired или missing между `requireSession` и batch, guard
  откатывает текущий batch, state re-read возвращает `401`, а не generic `5xx`. Если конкурентный
  delete уже оставил проверенное guest-состояние, тот же путь возвращает `200`.
- Новый явный Telegram sign-in после удаления создаёт новый player без прежних profile
  attempts/hints; attempts используемой guest session могут быть привязаны обычным способом.
- OIDC auth-flow с `player_id IS NULL`, начатый до delete и завершившийся после commit, может создать
  только новый player: независимо накопленные attempts его guest session переносятся, а attempts
  удалённого player отсутствуют.
- Уже выполняющийся Mini App login, чей account-link commit происходит после delete, имеет тот же
  результат: новый player может получить progress исходной guest session, но не progress удалённого
  player. Обратный порядок commit удаляет уже связанную запись вместе со старым player.
- Guest request является успешным no-op.
- Invalid/expired/revoked token, forbidden origin и exhausted limiter возвращают `401`, `403` и
  `429` до mutation.
- Constraint-failing guard внутри batch доказывает полный rollback; post-return sanity validation
  отдельно не заявляется как rollback mechanism.
- Lost-success-response test выполняет реальный commit, отбрасывает первый response, повторяет
  DELETE с тем же token и подтверждает guest response и отсутствие восстановленных rows.
- Responses и structured logs не содержат Telegram ID, token, profile fields или row counts.

### Client tests

- Control отсутствует у guest и присутствует у ready Telegram profile.
- Первый клик только раскрывает warning; `Cancel` не вызывает API.
- `Delete permanently` вызывает API ровно один раз; double-click заблокирован.
- Pending labels и disabled state доступны пользователю.
- Disclosure, keyboard navigation, focus return, success focus и live announcements соответствуют
  accessibility-контракту раздела 7.
- Success переключает общий session state в guest и скрывает destructive control.
- API/transport failure сохраняет Telegram profile, показывает ошибку и позволяет retry.
- Unmount или replacement самого `SessionProvider` abort'ит незавершённый action; уход с profile
  screen не применяет устаревшее component-local состояние, но не отменяет уже подтверждённое
  server deletion.

### End-to-end regression

Production-like client fixture начинает с Telegram profile, подтверждает удаление, получает guest
state, заново загружает empty guest stats и продолжает обычный daily flow. Отдельный сценарий
коммитит первый DELETE, имитирует потерянный response и подтверждает успешный retry с тем же token.
Реальный Telegram proof для этих E2E не требуется.

## 11. Документация и release gate

После реализации:

- `PRIVACY.md` больше не утверждает, что deletion path отсутствует; он описывает точный UI и scope
  удаления;
- `README.md` документирует `DELETE /v1/me` на уровне пользовательского поведения, без публикации
  внутренних SQL-деталей;
- release checklist требует smoke-test удаления на deployed service до открытия публичной Pages
  версии;
- private vulnerability reporting и фактические production log/backup retention остаются отдельными
  operational gates.

## 12. Acceptance criteria

Функция считается готовой, когда одновременно выполнены следующие условия:

1. Telegram player может через два явных UI-действия немедленно удалить профиль.
2. После success тот же client продолжает как guest с тем же opaque token и без старой статистики.
3. Все online Telegram identity/profile rows и связанный прогресс удалены атомарно на сервере;
   остальные устройства теряют доступ при следующем API request, а retained pseudonymous session
   fields раскрыты в privacy notice.
4. Повтор, lost response и конкурентный вызов не создают partial state или восстановление данных.
5. Guest gameplay, logout, Telegram linking, OIDC handoff и scheduled cleanup не регрессируют.
6. Contract, API, client и E2E tests проходят вместе с repository check, typecheck и production-like
   builds.
7. `PRIVACY.md` и README соответствуют фактическому поведению.
8. В публичные client artifacts, logs и error responses не попадают secrets, bearer token или
   удалённые Telegram fields.

После выполнения этих критериев profile-deletion release blocker считается закрытым; production
deployment всё ещё требует Cloudflare/Telegram configuration, актуального daily content и smoke
verification.
