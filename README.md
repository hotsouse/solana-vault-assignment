# Simple Vault — Week 10

Учебный проект на Solana и Anchor. Vault принимает SPL-токены и выдаёт shares, которые отражают долю пользователя. В Week 10 добавлен обратный обмен shares на токены.

## Что реализовано

- `initialize_vault` создаёт состояние Vault, токен-аккаунт и mint для shares.
- `create_user_card` создаёт PDA-карточку пользователя.
- `deposit(amount)` переводит токены в Vault через Token Program CPI, выпускает shares и обновляет состояние.
- `withdraw(shares_amount)` сжигает shares пользователя через CPI и переводит ему токены из Vault через CPI с подписью Vault PDA.

Обмены, Raydium и CLMM в проект не входят.

## Расчёт и проверки вывода

Количество выдаваемых токенов рассчитывается так:

```text
tokens_out = shares_amount × total_tokens / total_shares
```

Произведение вычисляется в `u128`, деление целочисленное, остаток отбрасывается. Нулевые shares, пустой Vault, нулевой результат и арифметическая ошибка отклоняются. Anchor проверяет PDA Vault, UserCard, token account и share mint, а Token Program проверяет владельцев аккаунтов и достаточность shares.

Транзакция атомарна: если сжигание shares или перевод токенов завершается ошибкой, изменения балансов и состояния откатываются. При переводе из Vault программа подписывает CPI за PDA с seeds `[b"vault", token_mint, bump]`. Этот же PDA является authority токен-аккаунта Vault и mint для shares.

## Структура проекта

- `programs/simple_vault/src/lib.rs` — инструкции, аккаунты и ошибки.
- `tests/vault.ts` — Anchor integration tests с проверкой SPL- и program-account балансов.
- `Anchor.toml` — настройки Anchor и Program ID.
- `Cargo.toml` — Rust workspace.
- `package.json` — команды и зависимости TypeScript.

## Окружение и запуск

Проект проверялся в Ubuntu WSL с Anchor 0.31.1, Solana CLI 2.3.0, Rust/Cargo и Node.js 18.19.1. При `npm ci` npm предупредил, что несколько транзитивных пакетов предпочитают Node 20; установка завершилась, TypeScript и integration tests прошли на Node 18.

Установка JavaScript-зависимостей:

```bash
npm ci
```

Проверка форматирования и сборка:

```bash
cargo fmt --check
cargo check --workspace
/home/aigerim/.avm/bin/anchor-0.31.1 build
```

Запуск тестов на Windows-mounted WSL каталоге:

```bash
solana-test-validator \
  --ledger .anchor/week-10-test-ledger \
  --mint "$(solana address)" \
  --bpf-program EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu \
  target/deploy/simple_vault.so
```

В другом терминале WSL:

```bash
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"
./node_modules/.bin/ts-mocha -p ./tsconfig.json -t 1000000 tests/vault.ts
```

Локальный валидатор не требует Devnet SOL. Тесты проверяют создание Vault и карточек, депозиты, частичный и полный вывод, фактическое сжигание shares и перевод SPL-токенов, обновление VaultState/UserCard, неверные аккаунты и откат транзакции при нехватке shares.

На WSL, если проект находится под `/mnt/c`, `anchor test` может завершить тесты успешно, но вернуть ошибку `No such file or directory` при очистке validator admin socket: этот Unix socket не создаётся на Windows-mounted файловой системе. Поэтому выше валидатор запускается отдельно, а integration suite вызывается через `ts-mocha`.

TypeScript можно проверить отдельно:

```bash
npx tsc --noEmit
```

## Результаты проверки

Результаты запуска в WSL:

- `cargo fmt --check` — успешно.
- `cargo check --workspace` — успешно; остались предупреждения от Anchor macro о `cfg` и deprecated `realloc`.
- Anchor/SBF build — успешно; те же предупреждения макросов, ошибок сборки нет.
- `cargo test --workspace` — 4 passed, 0 failed.
- TypeScript: `npx tsc --noEmit` — успешно.
- Integration tests: 17 passed, 0 failed на локальном Solana validator.
- `git diff --check` — успешно.

Devnet-развёртывание не выполнялось. Локальные проверки не подтверждают наличие программы в Devnet.

## Program ID

```text
EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu
```

В Week 10 используется тот же Program ID, что и в исходной Week 9. В этой работе проверяется локальная сборка и локальный валидатор; подтверждённого развёртывания Week 10 в Devnet нет.
