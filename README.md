# Week 8 — Solana Vault и пользовательские карточки

## 1. Описание проекта

Учебный проект на Solana с использованием Anchor Framework.

Цель Week 8 — реализовать основу токенового хранилища (Vault) и систему индивидуальных пользовательских карточек (UserCard).

В рамках этой недели реализовано создание аккаунтов и проверка уникальности карточек. Депозиты, вывод средств и операции обмена относятся к последующим заданиям и не входят в текущую реализацию.

## 2. Реализованная функциональность

### initialize_vault

Инструкция инициализирует Vault для работы с выбранным токеном.

Vault использует Program Derived Address (PDA), что позволяет программе управлять состоянием хранилища.

### create_user_card

Инструкция создаёт индивидуальную карточку пользователя, связанную с Vault.

Карточка используется для хранения информации о пользователе и его участии в хранилище.

### Защита от дублирования

Для одного пользователя и одного Vault повторное создание карточки отклоняется.

Это поведение проверяется автоматическим тестом.

## 3. Используемые технологии

- Rust — разработка смарт-контракта.
- Solana — блокчейн-платформа.
- Anchor Framework 0.31.1 — разработка и тестирование программы.
- TypeScript — автоматизированные тесты.
- Mocha — выполнение тестов.
- Solana Devnet — тестовая сеть.

## 4. Структура проекта

- `programs/simple_vault/src/lib.rs` — основная логика смарт-контракта.
- `tests/vault.ts` — автоматические тесты.
- `Anchor.toml` — конфигурация Anchor.
- `Cargo.toml` — конфигурация Rust workspace.
- `package.json` — зависимости JavaScript/TypeScript.

## 5. Подготовка окружения

Для запуска необходимы:

- Rust и Cargo;
- Solana CLI;
- Anchor CLI версии 0.31.1;
- Node.js и npm;
- настроенный кошелёк Solana Devnet.

Установить JavaScript-зависимости:

```bash
npm install
```

Проверить версии:

```bash
solana --version
anchor --version
node --version
```

Если Anchor установлен через AVM, можно использовать соответствующую версию напрямую:

```bash
~/.avm/bin/anchor-0.31.1 --version
```

## 6. Сборка программы

В корневой папке проекта выполнить:

```bash
~/.avm/bin/anchor-0.31.1 build
```

Перед развёртыванием необходимо проверить согласованность Program ID в `Anchor.toml`, исходном коде и ключе программы.

## 7. Настройка Devnet

```bash
solana config set --url devnet

export ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
```

Для развёртывания программы необходим кошелёк с достаточным количеством Devnet SOL и соответствующий локальный ключ программы.

При необходимости развернуть программу:

```bash
~/.avm/bin/anchor-0.31.1 deploy
```

## 8. Запуск автоматических тестов

После сборки и развёртывания соответствующей версии программы выполнить:

```bash
./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 tests/vault.ts
```

Тесты взаимодействуют с программой через Solana Devnet.

## Результаты Week 8 в Devnet

Фактический повторный запуск в Ubuntu WSL завершился успешно: **3 passing (13s), 0 failing**. Использована существующая программа без повторного deploy.

Program ID: [`Ecas7acK9ayt8GEs7VozKdn77SmJGLsxHeE9T4zrDjiS`](https://explorer.solana.com/address/Ecas7acK9ayt8GEs7VozKdn77SmJGLsxHeE9T4zrDjiS?cluster=devnet).

Admin: [`3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7`](https://explorer.solana.com/address/3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7?cluster=devnet).

Публичные доказательства, подписи и слоты транзакций, декодированные поля аккаунтов и логи отказа сохранены в [evidence/week8-devnet.json](evidence/week8-devnet.json).

Проверка RPC завершена: `2026-11-18T21:40:06.739Z` (UTC, commitment `confirmed`). Genesis hash Devnet: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. До выполнения транзакций проверены принадлежность RPC к Devnet, наличие исполняемой программы (executable) и баланс администратора: 3.489315415 SOL при расчётном резерве 0.114968240 SOL на аренду аккаунтов (rent), пополнение пользователей A/B и комиссии.

### Созданные и проверенные аккаунты

| Аккаунт | Адрес в Solana Explorer (Devnet) |
|---|---|
| Token mint | [`9JumWPvwcmgWcsvaFUbkoEbMiMygfMfCzs1BEMf6yhc`](https://explorer.solana.com/address/9JumWPvwcmgWcsvaFUbkoEbMiMygfMfCzs1BEMf6yhc?cluster=devnet) |
| VaultState PDA | [`EcD24AmtSfBnRrxngCKASh3g78shZtbsWh7Ua27pxxSf`](https://explorer.solana.com/address/EcD24AmtSfBnRrxngCKASh3g78shZtbsWh7Ua27pxxSf?cluster=devnet) |
| Vault Token Account PDA | [`2fkqekwhrBeREa4tYEBBv2QF64KHZtgw2CjePZLdJQvR`](https://explorer.solana.com/address/2fkqekwhrBeREa4tYEBBv2QF64KHZtgw2CjePZLdJQvR?cluster=devnet) |
| Share Mint PDA | [`EUhuheCuRpaX1ugBHmLqhWCs7JNzs6PN5RJPVCaw9yxa`](https://explorer.solana.com/address/EUhuheCuRpaX1ugBHmLqhWCs7JNzs6PN5RJPVCaw9yxa?cluster=devnet) |
| Пользователь A (пополнен SOL) | [`7TvMCVdy5F67wskvYkwTQbFzE7Upb4ypm47c3z1Vgx5E`](https://explorer.solana.com/address/7TvMCVdy5F67wskvYkwTQbFzE7Upb4ypm47c3z1Vgx5E?cluster=devnet) |
| Пользователь B (пополнен SOL) | [`8fFok11jiD8ng39Lt9q2NsA7147RYmtT7cQKZRQAt23B`](https://explorer.solana.com/address/8fFok11jiD8ng39Lt9q2NsA7147RYmtT7cQKZRQAt23B?cluster=devnet) |
| UserCard A PDA | [`E7yX8fZsKYctHXdAnPSKTawjZmgeJ1cTHHW6spmjTxhJ`](https://explorer.solana.com/address/E7yX8fZsKYctHXdAnPSKTawjZmgeJ1cTHHW6spmjTxhJ?cluster=devnet) |
| UserCard B PDA | [`BdAhCtm1vhWS1Ej88XRHh1HwX5n25vNMvZUGBw7YUB3A`](https://explorer.solana.com/address/BdAhCtm1vhWS1Ej88XRHh1HwX5n25vNMvZUGBw7YUB3A?cluster=devnet) |

### Связи аккаунтов

```text
VaultState --admin--> Admin
VaultState --token_mint--> Token mint
VaultState --vault_token_account--> Vault Token Account
VaultState --share_mint--> Share Mint
Vault Token Account --mint--> Token mint
Vault Token Account --authority--> VaultState
Share Mint --mint_authority--> VaultState
UserCard A --owner--> User A
UserCard A --vault--> VaultState
UserCard B --owner--> User B
UserCard B --vault--> VaultState
```

PDA seeds сохранены: `["vault", token_mint]`, `["vault_tokens", token_mint]`, `["share_mint", token_mint]`, `["user_card", vault_state, user]`.

После создания через RPC прочитаны VaultState и обе UserCard. Проверены admin, token mint, share mint, vault token account, владельцы карточек и их связь с Vault. SPL Token Account и оба mint также прочитаны через RPC: полномочия Token Account и Share Mint принадлежат VaultState, а полномочия исходного token mint принадлежат admin.

### Успешные вызовы программы

| Вызов | Реальная транзакция | Слот | Результат RPC |
|---|---|---|---|
| initialize_vault | [`TxijGZGjKrDkwmyNzrtYRQuDenyVeTmzR15JzMUrGd6jCLUaiv6tFPwrQ3TJ6iuX6mWCq2qEMQVp9hV3N9Bj9Zs`](https://explorer.solana.com/tx/TxijGZGjKrDkwmyNzrtYRQuDenyVeTmzR15JzMUrGd6jCLUaiv6tFPwrQ3TJ6iuX6mWCq2qEMQVp9hV3N9Bj9Zs?cluster=devnet) | 523768395 | meta.err = null |
| create_user_card A | [`5t7yemE6c2cjCEg1T9c4DYierCLDM8qbUJngdSbMciminPYmkaynVkWM9AuYaQDMiV6CiXmTTpCh44wP4xp9tETz`](https://explorer.solana.com/tx/5t7yemE6c2cjCEg1T9c4DYierCLDM8qbUJngdSbMciminPYmkaynVkWM9AuYaQDMiV6CiXmTTpCh44wP4xp9tETz?cluster=devnet) | 523768400 | meta.err = null |
| create_user_card B | [`2jYWqcJSutgE1dPvZVbD51Ru57X2LRr38N6SDrZXZXTWQLvVFKoyDSLs7t6gWmDN6X747CSo7T4CmCQVponF2Crz`](https://explorer.solana.com/tx/2jYWqcJSutgE1dPvZVbD51Ru57X2LRr38N6SDrZXZXTWQLvVFKoyDSLs7t6gWmDN6X747CSo7T4CmCQVponF2Crz?cluster=devnet) | 523768405 | meta.err = null |

Подготовительные переводы тестовых SOL:

- [Пополнение пользователя A](https://explorer.solana.com/tx/3YHsft7FLMMs11BZX1FR7RyhfTNBn9dDf1TUPyUaH47VRUCsvFX22o51J272AK5mEYAqHU6sHyk8B28WRw9V3BEQ?cluster=devnet); signature: `3YHsft7FLMMs11BZX1FR7RyhfTNBn9dDf1TUPyUaH47VRUCsvFX22o51J272AK5mEYAqHU6sHyk8B28WRw9V3BEQ`.
- [Пополнение пользователя B](https://explorer.solana.com/tx/6EF3MCwa22m3iS8KeZ5ua8FFHwHQhC7xkrPhsmcsph8eLiSdAsbXeySE6NXK7LawvmhYMdBGY4mVASWLwGnt2Wb?cluster=devnet); signature: `6EF3MCwa22m3iS8KeZ5ua8FFHwHQhC7xkrPhsmcsph8eLiSdAsbXeySE6NXK7LawvmhYMdBGY4mVASWLwGnt2Wb`.

### Фактические результаты тестов

| Тест | Результат |
|---|---|
| initialize_vault: creates the vault | PASS |
| create_user_card: creates distinct cards for A and B | PASS |
| create_user_card: rejects duplicate card A | PASS |

```text
3 passing (13s)
0 failing
```

Повторное создание UserCard A отклонено **на этапе preflight-симуляции** с сообщением `already in use` и адресом существующей карточки. Данные карточки после отказа не изменились. Эта попытка не была отправлена в блокчейн, поэтому у неё нет подтверждённой подписи транзакции.

Первый запуск завершился с результатом **0 passing, 3 failing**: вызовы программы получили `Blockhash not found`, а тест дублирования не принял эту постороннюю ошибку за корректный отказ. Подготовительные переводы SOL и создание token mint успели пройти; Vault и UserCard в том запуске не созданы. Первый запуск сохранён в `previousRuns` JSON; указанные там адреса Vault и UserCard являются рассчитанными PDA, а не созданными аккаунтами.

Для успешного повторного запуска согласованы `commitment` и `preflightCommitment`: оба установлены в `confirmed`. Во время финального чтения RPC возникали ответы 429; встроенные повторные запросы завершились успешно.

### Повторный запуск в Ubuntu WSL

Команды для запуска из корня проекта:

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=/home/aigerim/.config/solana/id.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/ts-mocha/bin/ts-mocha -p tsconfig.json -t 180000 tests/vault.ts
```

Каждый запуск создаёт новый mint и новые аккаунты, расходует тестовые SOL и сохраняет предыдущий результат в `previousRuns`. Секретные ключи пользователей A/B существуют только в памяти процесса; JSON содержит только публичные данные. Существующий кошелёк администратора читается из `ANCHOR_WALLET`, не копируется в проект и не включается в Git.


