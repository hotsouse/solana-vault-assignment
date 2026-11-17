# Simple Vault — Week 9

В этом задании пользователь вносит SPL-токены в vault и получает share-токены, которые показывают его долю в общем количестве вкладов. Проект основан на учебной реализации Week 9 и собран на основе Week 8.

## Что реализовано

- `initialize_vault` создаёт состояние vault, токен-аккаунт хранилища и mint для shares.
- `create_user_card` создаёт одну PDA-карточку пользователя для выбранного vault.
- `deposit(amount)` переводит токены пользователя в vault через SPL Token CPI, выпускает shares и обновляет состояние vault и UserCard.
- Проверяются PDA и владельцы токен-аккаунтов. Внести депозит без созданной UserCard нельзя.
- Нулевая сумма, депозит с нулевым результатом shares и арифметическое переполнение отклоняются.

Вывод средств, обмены, Raydium и CLMM в проект не входят.

## Как работает депозит

Первый депозит выпускает такое же количество shares, сколько токенов внесено: `shares = amount`. Для последующих депозитов используется доля от текущих сумм:

```text
shares = amount × total_shares / total_tokens
```

Расчёт выполняется целочисленно с промежуточным значением `u128`; остаток от деления отбрасывается. Если результат равен нулю, транзакция завершается ошибкой. Перевод токенов, выпуск shares и обновление аккаунтов происходят в одной транзакции Solana, поэтому при ошибке изменения откатываются.

`total_tokens` и `total_shares` хранят суммы успешных депозитов и выпущенных shares. `UserCard.deposited` и `UserCard.shares` хранят соответствующие накопительные суммы конкретного пользователя.

## Структура

```text
programs/simple_vault/src/lib.rs  контракт и аккаунты
programs/simple_vault/Cargo.toml  зависимости программы
tests/vault.ts                   автоматические тесты
Anchor.toml                       настройки Anchor и Program ID
Cargo.toml                        Rust workspace
package.json                      команды и JS-зависимости
```

## Требования и установка

Нужны Rust stable, Solana CLI с поддержкой локального валидатора, Anchor CLI 0.31.1, Node.js 18 или новее и npm. Команды ниже рассчитаны на установленную совместимую toolchain.

```bash
npm install
```

Rust-зависимости устанавливаются Cargo при сборке. Anchor CLI можно установить через AVM:

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install 0.31.1
avm use 0.31.1
```

## Сборка и тесты

```bash
anchor build
npm test
```

`npm test` запускает `anchor test` на локальном валидаторе: отдельная публикация программы в Devnet для этих тестов не нужна. Тесты создают mint и аккаунты в тестовой среде.

В tests/vault.ts описано 9 интеграционных тестов. Фактический запуск в Ubuntu 24.04 WSL: anchor build завершился успешно с Solana CLI 2.3.0 и platform-tools v1.48; anchor test завершился результатом 9 passing (8s). Сборка вывела 13 предупреждений от Anchor macro (cfg и deprecated realloc), ошибок компиляции не было. В тестах проверены создание Vault и UserCard, повторное создание карточки, первый и повторный депозиты с балансами пользователя и Vault, shares, депозит без карточки, чужая карточка, неправильный mint и нулевая сумма. Для сборки пришлось восстановить отсутствовавший кэш platform-tools v1.48; для локального валидатора задан startup_wait = 30000.

## Devnet

В `Anchor.toml` задан тот же Program ID, что и в `declare_id!` программы. Для настройки собственного кошелька и публикации можно выполнить:

```bash
solana config set --url devnet
solana address
solana balance
anchor deploy --provider.cluster devnet
```



## Program ID

```text
EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu
```
