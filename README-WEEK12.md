# Liquidity Vault — Week 12

На этой неделе Vault обменивает TOKEN_A на TOKEN_B через Raydium CLMM в Solana Devnet. Обмен проходит внутри Anchor-программы через CPI. TypeScript получает quote и собирает вызов Vault; он не выполняет обмен от имени пользовательского кошелька.

## Что добавлено

- `initialize_swap` привязывает существующий пул к Vault и создаёт второе токеновое хранилище.
- `swap_via_raydium(amount_in, minimum_amount_out)` вызывает официальный Raydium `swap_v2` с точной входной суммой.
- Обе инструкции требуют подпись администратора, записанного в VaultState.
- Проверяются PDA, mint’ы, owner токен-аккаунтов, выбранный пул, программа Raydium, конфигурация, oracle, pool vaults, tick arrays и bitmap.
- Vault PDA подписывает CPI seeds `["vault", token_mint, bump]`. Администратор разрешает операцию своей подписью, а право списать токены хранилища принадлежит PDA.
- Нулевая сумма, нулевой минимум, нехватка баланса и неполное исполнение отклоняются. Полученный баланс дополнительно проверяется после CPI.
- Событие `VaultSwap` сохраняет суммы и sqrt price непосредственно внутри той же транзакции.

Второе хранилище нужно, потому что результат обмена должен оставаться под управлением Vault. Его seeds — `["vault_output", vault_state]`. Настройка `SwapConfig` имеет seeds `["swap_config", vault_state]`; после создания она не перенастраивается.

## Состояние и ограничения

Week 12 использует отдельный Program ID: `HudBjTFM6HRinqoiQN6DZPDNkUK9K9qES9QdeGDKPBNF`. Программы предыдущих недель не обновляются.

В новом VaultState добавлен флаг `strategy_active`; размер с discriminator — 154 байта. Аккаунты старых программ не мигрируются и не используются новым развёртыванием.

До первого обмена работают прежние `initialize_vault`, `create_user_card`, `deposit` и `withdraw`. После обмена Vault хранит два актива. Старые формулы долей учитывают только TOKEN_A, поэтому однотокеновые deposit/withdraw в таком Vault отклоняются с `StrategyActive`. Это предотвращает неверный выпуск долей и неполный вывод. Полноценный вывод двух активов и оценка портфеля в этой учебной неделе не реализованы. На других Vault без обменов deposit/withdraw продолжают работать.

Инструкции открытия позиции Vault, сбора комиссий и закрытия позиции не добавлены. Позиция, необходимая для тестирования пула, принадлежит обычному кошельку.

## Slippage

Slippage — возможное изменение результата между получением quote и исполнением транзакции. Перед отправкой скрипт заново читает состояние пула и tick arrays через RPC, затем вызывает `PoolUtils.computeAmountOut` из Raydium SDK.

Для демонстрации используется 1%:

```text
minimum_amount_out = floor(expected_amount_out * 9900 / 10000)
```

Расчёт сумм выполняется через BigInt и BN без перевода в Number. Raydium получает минимум как `other_amount_threshold`; при недостаточном результате вся транзакция откатывается. Обычный пользователь не может уменьшить минимум и обойти администратора.

## Проверка Week 11

Методичка: страница 6, раздел «12 Swap через Raydium». Извлечённый текст сохранён в `evidence/requirements-page-6.txt`.

Исходная проверка Devnet сохранена в `evidence/week11-preflight.json`. TOKEN_A и TOKEN_B существуют, имеют 6 decimals и supply по 1 000 000 токенов. В существующем пуле ликвидность была равна нулю, позиций кошелька не было. SDK не мог получить quote: отсутствовали initialized tick arrays.

Поэтому из Week 12 добавлена ликвидность с обычного кошелька в прежний пул, без создания нового пула. Диапазон — от tick -6000 до 6000; активная ликвидность после добавления — `38584613330`.

[Транзакция добавления ликвидности](https://explorer.solana.com/tx/3HDBYwjDxHqXAaEDtvmSXi3SFSsRSe2MqdkAsCosR3XUbmz8JeWTFx9P4bJFg3pj7H1pk8LM67tR2E2YXjBKKZbf?cluster=devnet). Адрес позиции и NFT записаны в `evidence/liquidity.json`.

Адреса:

- Кошелёк: `3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7`.
- TOKEN_A: `7bdCcN9agJ3TSSjTFctxM4TGFVecBRd6gLNYoWYyvawF`.
- TOKEN_B: `CwHVUNisByLqXM7mN47nhtcfG8AkYxeJ3tBdFB66yZAt`.
- Pool ID: `EKwcP1HdZsti8ALXNvAUAduWfYLXH76DeJkcH39auM1f`.
- Raydium CLMM Devnet: `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH`.

## Запуск в Ubuntu WSL

Нужны Node.js 22, Anchor CLI 0.31.1, Solana CLI 2.3.0, Rust и кошелёк с тестовыми SOL. Используется только Devnet. Скрипты проверяют полный genesis hash сети. Секретный ключ кошелька берётся из `ANCHOR_WALLET` или `~/.config/solana/id.json`.

```bash
npm ci
cargo fmt --check
cargo check --workspace
anchor build
npm run typecheck
cargo test --workspace
npm run test:unit
npm run preflight
```

Если установлен другой Anchor CLI, можно вызвать бинарник 0.31.1 явно, например `/home/aigerim/.avm/bin/anchor-0.31.1 build`.

Для собственного повторного развёртывания нужно создать локальный program keypair и синхронизировать новый Program ID в `Anchor.toml` и `declare_id!`. Program keypair из этого запуска не публикуется.

```bash
solana-keygen new --no-bip39-passphrase --outfile target/deploy/simple_vault-keypair.json
anchor keys sync
anchor build
anchor deploy --provider.cluster devnet
npm run prepare-liquidity
npm run test:devnet
```

`prepare-liquidity` сначала проверяет позиции кошелька и текущую ликвидность. При наличии активной ликвидности новую позицию не открывает. Если существуют позиции с ненулевой ликвидностью вне диапазона, скрипт требует разобраться с ними до добавления ещё одной.

`test:devnet` создаёт Vault, проверяет deposit/withdraw до обмена, выполняет проверки отказа через RPC simulation, отправляет настоящий успешный CPI swap и отдельно отправляет транзакцию с недостижимым минимумом через `skipPreflight`. Последняя должна попасть в блокчейн с ошибкой. Комиссия сети за неуспешную транзакцию при этом списывается; балансы токенов и данные Vault/пула должны остаться прежними.

## Локальные интеграционные тесты

На файловой системе Windows в WSL валидатор запускается отдельно, чтобы избежать проблемы с Unix admin socket:

```bash
solana-test-validator --ledger .anchor/week-12-test-ledger \
  --mint "$(solana address)" \
  --bpf-program HudBjTFM6HRinqoiQN6DZPDNkUK9K9qES9QdeGDKPBNF target/deploy/simple_vault.so
```

В другом терминале:

```bash
export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$HOME/.config/solana/id.json
npm run test:local
```

Локальная suite проверяет прежние deposit/withdraw через настоящий SPL Token Program. Она не заменяет отдельные Devnet-тесты Raydium.

## Источники

- [Репозиторий преподавателя](https://github.com/0xnurda/vault-dev/tree/students-vault-card).
- [Официальный пример Raydium CPI](https://github.com/raydium-io/raydium-cpi-example/blob/master/clmm-cpi/programs/clmm-cpi/src/instructions/proxy_swap.rs).
- [Закреплённая ревизия Raydium CLMM](https://github.com/raydium-io/raydium-clmm/tree/d4ec101534724a20e1eb38a9b997f8b391c5100f). Она использует Anchor 0.31.1; новая основная ветка Raydium уже перешла на Anchor 1.x.
- [Официальные SDK-примеры](https://github.com/raydium-io/raydium-sdk-V2-demo).
- SDK в этом проекте: `@raydium-io/raydium-sdk-v2@0.2.41-alpha`; версии зафиксированы lock-файлами.

## Подтверждённые результаты

Полный `anchor build` через Anchor 0.31.1 успешно собрал SBF и IDL. После переноса крупных аккаунтов в `Box` сообщений о превышении стека нет. `cargo fmt --check`, `cargo check --workspace` и проверка TypeScript выполнены отдельно.

[Деплой Week 12 в Devnet](https://explorer.solana.com/tx/41DaQAy1thdDRQa8eWc8tvfdyeat9GAoiscabpDiU42PrhV5M5JBS4jN6vdYuGgdT9wKnDtuJGiAUkWmh139qygQ?cluster=devnet). Vault PDA: `Dvu4UMUWYfLVbtkvHxhQLbXk6jPL8Mc4vh5ej2J95eCw`.

[Успешный CPI swap](https://explorer.solana.com/tx/5NmUQaxbpKULNNADsfpFGDqDqNyvttw4ZMMz5DP7gX5PhKbGb3yJYzE3xa5i7KDh3SqpNkihYfzKc4FEuTGXmbox?cluster=devnet), slot `523547788`:

- Вход: 100 TOKEN_A (`100000000` базовых единиц).
- SDK quote: 99,492788 TOKEN_B; минимум с допуском 1%: 98,497860 TOKEN_B.
- Получено: 99,492788 TOKEN_B (`99492788` базовых единиц).
- Баланс TOKEN_A Vault: 990 → 890.
- Баланс TOKEN_B Vault: 0 → 99,492788.

В логах транзакции есть вызов Raydium `invoke [2]` и вложенные SPL Token CPI. Проверены authority обоих хранилищ, списание средств PDA и получение второго токена.

Цена TOKEN_B за TOKEN_A изменилась с `1` до `0.9948495264917161464`. Изменение: `-0.0051504735082838536`, его величина — `0.0051504735082838536`; в процентах — `-0.51504735082838536%`.

Точные sqrt price: `18446744073709551616` → `18399178014378143518`. Они записаны событием Vault внутри swap и совпали с RPC-снимками до и после. Это подтверждает изменение состояния пула нашей транзакцией. Внешнего изменения между этими снимками тест не обнаружил.

[Отклонённый обмен из-за slippage](https://explorer.solana.com/tx/55yX7vGsc5Uros4qkS9WZjaGsyRK6XNHrXSLYMiLKtuy4Vrvq8cHjZ3EMmp8JEVXStjeZyQ4cns5FDQdAmFjNCiE?cluster=devnet), slot `523548681`: минимум `18446744073709551615` недостижим, Raydium вернул `TooLittleOutputReceived`, код `6018`. Транзакция действительно находится в блокчейне с ошибкой. Данные VaultState, обоих token accounts и пула побайтово совпали со снимком до отправки. Комиссия за попытку списалась в SOL.

Подписи, суммы, слоты, снимки аккаунтов и настоящие program logs сохранены в `evidence/successful-swap.json` и `evidence/rejected-swap.json`.

## Выполненные проверки

- Rust unit tests: 4 passed, 0 failed.
- Целочисленный расчёт slippage: 6 passed, 0 failed.
- Локальные integration tests Vault/SPL: 17 passed, 0 failed.
- Devnet: 27 проверок passed, 0 failed.

Первые 23 Devnet-проверки выполнены через `devnet-demo.ts`. При подтверждении отрицательной транзакции RPC-клиент выбросил ожидаемую on-chain ошибку как исключение. Обработка исправлена. Оставшиеся четыре проверки завершены через `verify-rejection.ts` без нового успешного обмена: подтверждённый отказ Raydium, атомарный откат и запрет однотокеновых deposit/withdraw после ребалансировки.

```bash
npm run verify-rejection
```

Эта команда повторяет только отрицательную транзакцию и проверяет on-chain metadata. Все 27 результатов находятся в `evidence/devnet-tests.json`. Проверки доступа и неверных аккаунтов выполнялись через настоящую RPC simulation программы Devnet; они не выдаются за отдельные подтверждённые транзакции. Deposit, withdraw, успешный swap и отказ по slippage проверены реальными транзакциями.

Предупреждения Anchor macro о `cfg` и deprecated `realloc` остаются; ошибок сборки нет. Исходные HEAD, Git status и SHA256 отслеживаемых файлов Week 8–11 сравниваются с сохранёнными значениями; результат находится в `evidence/previous-weeks-verification.json`. Работа подготовлена в отдельной ветке `week-12-submission`.
