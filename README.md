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

Реальное развёртывание и депозиты проверены через Devnet RPC. Адреса, подписи и результаты приведены в разделе «Результаты Week 9 в Devnet» ниже.

## Program ID

```text
EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu
```

## Результаты Week 9 в Devnet

Проверка выполнена 19 ноября 2026 года (Asia/Qyzylorda, UTC+5).
Результат: **57 именованных проверок пройдено, 9 реальных транзакций finalized**, включая два депозита.
Каждая подпись проверена через RPC методами getSignatureStatuses и getTransaction:
confirmationStatus = finalized, status.err = null, meta.err = null.

Полные доказательства: [evidence/week9-devnet.json](evidence/week9-devnet.json).
Отдельный сценарий: [scripts/week9-devnet.ts](scripts/week9-devnet.ts).
Публичный локальный IDL, использованный для запросов: [evidence/week9-idl.json](evidence/week9-idl.json).

### Совместимость программы

Program ID: [EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu](https://explorer.solana.com/address/EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu?cluster=devnet).
Upgrade authority: 38afxYQhjGKgyoWEsKhAZ85xkdCj3z6bj3YU5RY74mR1.
Плательщик: 3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7.

Опубликованный on-chain IDL отсутствует. Развёрнутый бинарник отличается от локального;
в Devnet также обнаружена инструкция Withdraw. Поэтому идентичность бинарников
не заявляется. Совместимость нужного интерфейса Week 9 проверена полной RPC-симуляцией
initialize_vault + create_user_card + deposit с локальным IDL до отправки транзакций,
затем реальными вызовами. Симуляция также подтвердила ошибку ZeroAmount (6000).
VaultState декодирован локальной схемой размером 153 байта, UserCard — 89 байт;
проверены PDA, связи аккаунтов, владельцы, decimals и mint authority.
SHA-256 бинарника Devnet проверялся перед каждой отправкой и после завершения;
изменений за время прогона не было. Хеши бинарников и IDL и полные логи сохранены в JSON.
Контракт, Program ID, PDA seeds и развёрнутая программа не изменялись.

### Созданные аккаунты

Все адреса ниже относятся к реальным аккаунтам Devnet. Временные адреса из предварительных
симуляций в JSON не создавались в сети; их следует отличать от этого списка.

| Аккаунт | Адрес и Explorer |
| --- | --- |
| tokenMint | [8qq1v3aLFXv1JjEMmnPyZKbm8ohGvUJMs7LcpQatNXBT](https://explorer.solana.com/address/8qq1v3aLFXv1JjEMmnPyZKbm8ohGvUJMs7LcpQatNXBT?cluster=devnet) |
| vaultState | [HjFxF67AAe4j76Vsj2CyGQM9TxqZtkVLRK3ojYEzcWtK](https://explorer.solana.com/address/HjFxF67AAe4j76Vsj2CyGQM9TxqZtkVLRK3ojYEzcWtK?cluster=devnet) |
| vaultTokenAccount | [GVBy2a8ft7WDKUWxVvtUstp15efuq52SvNE9M77KMaxP](https://explorer.solana.com/address/GVBy2a8ft7WDKUWxVvtUstp15efuq52SvNE9M77KMaxP?cluster=devnet) |
| shareMint | [HUgizXzrmCiCXpbE4QajXRV2JawBmxeCMZnGzGqd4iGi](https://explorer.solana.com/address/HUgizXzrmCiCXpbE4QajXRV2JawBmxeCMZnGzGqd4iGi?cluster=devnet) |
| userA | [5k4HRdtwxNyvvtFM2AZToRMWa2MDnm3862kwkXJVLttR](https://explorer.solana.com/address/5k4HRdtwxNyvvtFM2AZToRMWa2MDnm3862kwkXJVLttR?cluster=devnet) |
| userB | [23sVgqJHXo2Hw6DBgNz7hPKeBEYNtUZKenR3hJTyqZoz](https://explorer.solana.com/address/23sVgqJHXo2Hw6DBgNz7hPKeBEYNtUZKenR3hJTyqZoz?cluster=devnet) |
| userCardA | [2FBfQSpxcNN8jXLrGuSyAycntwPAsfRuySDSw9wC5W6E](https://explorer.solana.com/address/2FBfQSpxcNN8jXLrGuSyAycntwPAsfRuySDSw9wC5W6E?cluster=devnet) |
| userCardB | [GjyMFwka581zH5gxX7229BkCycv9UCdn1K3DJgDp3TgL](https://explorer.solana.com/address/GjyMFwka581zH5gxX7229BkCycv9UCdn1K3DJgDp3TgL?cluster=devnet) |
| tokenAccountA | [Hto5T3YiHf48Vex5BLUXdfzDT9pxnfAZNDW3EnLkw8XP](https://explorer.solana.com/address/Hto5T3YiHf48Vex5BLUXdfzDT9pxnfAZNDW3EnLkw8XP?cluster=devnet) |
| tokenAccountB | [2XeCXb6DhbEYtqKLe2C2aCggF4MrZbCZLDtmyLB1CzyC](https://explorer.solana.com/address/2XeCXb6DhbEYtqKLe2C2aCggF4MrZbCZLDtmyLB1CzyC?cluster=devnet) |
| shareAccountA | [2HVX46exUiZrSNHFbmPgnYrkeHCUt2V6rzm8AuDpDEWY](https://explorer.solana.com/address/2HVX46exUiZrSNHFbmPgnYrkeHCUt2V6rzm8AuDpDEWY?cluster=devnet) |
| shareAccountB | [BQCm1XZKnpsZeofkS7hbMUag2kWS6jgicwGAfh2b87SW](https://explorer.solana.com/address/BQCm1XZKnpsZeofkS7hbMUag2kWS6jgicwGAfh2b87SW?cluster=devnet) |

A и B — два отдельных тестовых подписанта. Их ключи существовали только в памяти процесса.
Существующий WSL-кошелёк использован как admin, mint authority и плательщик комиссий;
его приватный ключ не копировался в проект. Каждому пользователю переведено 0,003 Devnet SOL
для оплаты UserCard. Начальный выпуск — по 1000 тестовых токенов каждому.

### Транзакции

| Операция | Подпись и Explorer | Slot | Проверка RPC |
| --- | --- | --- | --- |
| create_mint | [2dyrWVj8qG9qkUJtfFbMwhkWvfv39Sbu4ahy7fzLaa4nAiXpQ544syRTBxGr2xeSwz1c97kjUdqKEHps29X6SZ5o](https://explorer.solana.com/tx/2dyrWVj8qG9qkUJtfFbMwhkWvfv39Sbu4ahy7fzLaa4nAiXpQ544syRTBxGr2xeSwz1c97kjUdqKEHps29X6SZ5o?cluster=devnet) | 523775888 | finalized; err = null |
| initialize_vault | [4e2XPhVCcbGSpwHdKxZQhg6tYGiif12y9dnSkvQPiFomwfcDVmGAe5BKH165mAXmePuYHNsVLcRD59LfHXKNMnsq](https://explorer.solana.com/tx/4e2XPhVCcbGSpwHdKxZQhg6tYGiif12y9dnSkvQPiFomwfcDVmGAe5BKH165mAXmePuYHNsVLcRD59LfHXKNMnsq?cluster=devnet) | 523775895 | finalized; err = null |
| fund_users | [52mXx1QGsX3gEo9uxPrRfxBAzQvntrkRuJwviiie9rLJ3EjK9uqPSUSedLu9fCvEocmn3ai9pn3SpKD9V4PTPip9](https://explorer.solana.com/tx/52mXx1QGsX3gEo9uxPrRfxBAzQvntrkRuJwviiie9rLJ3EjK9uqPSUSedLu9fCvEocmn3ai9pn3SpKD9V4PTPip9?cluster=devnet) | 523775903 | finalized; err = null |
| create_card_A | [3WTQn9gntdpstT5KWSFe11n3ddUsRJ4vWMUAUzA8XcD6Jfw4dvmABjdhtxTs68F4Q6Z8BTAS5RuanxwC3KAJTL1P](https://explorer.solana.com/tx/3WTQn9gntdpstT5KWSFe11n3ddUsRJ4vWMUAUzA8XcD6Jfw4dvmABjdhtxTs68F4Q6Z8BTAS5RuanxwC3KAJTL1P?cluster=devnet) | 523775929 | finalized; err = null |
| prepare_tokens_A | [3kFGsRpPcmCbfRqMhQUPi4WzmVdJ82U42RV5fNX8xmMXqADty4wgcPVghNBwq2GD2B14E4CJxBZ1uxF9UiXZCztx](https://explorer.solana.com/tx/3kFGsRpPcmCbfRqMhQUPi4WzmVdJ82U42RV5fNX8xmMXqADty4wgcPVghNBwq2GD2B14E4CJxBZ1uxF9UiXZCztx?cluster=devnet) | 523775938 | finalized; err = null |
| create_card_B | [64K27awDzhHFXTMTUGKm9EVkVV8HjXhEQAxXv9LoCnDRrqsYMFjs3RhP7124xumoCLsgh7YuF9LykPvWB71oPEnp](https://explorer.solana.com/tx/64K27awDzhHFXTMTUGKm9EVkVV8HjXhEQAxXv9LoCnDRrqsYMFjs3RhP7124xumoCLsgh7YuF9LykPvWB71oPEnp?cluster=devnet) | 523775944 | finalized; err = null |
| prepare_tokens_B | [3hcTq39J6s4DSZqSKPJubTsk4UQERW5r3NVmC2Y3NobTH5WQKFn6xCREe1kkzWwzUE3JkB7V1D44BBCRFwy8dDSc](https://explorer.solana.com/tx/3hcTq39J6s4DSZqSKPJubTsk4UQERW5r3NVmC2Y3NobTH5WQKFn6xCREe1kkzWwzUE3JkB7V1D44BBCRFwy8dDSc?cluster=devnet) | 523775951 | finalized; err = null |
| deposit_A_100 | [3557xgkaNcQfKPMNpZfVxWSC4z3gydVjbao7coXbFXwrAzgS3CHvHLQXBXqWRCsZLADaHPbBBbtGNWfqNUHacrdx](https://explorer.solana.com/tx/3557xgkaNcQfKPMNpZfVxWSC4z3gydVjbao7coXbFXwrAzgS3CHvHLQXBXqWRCsZLADaHPbBBbtGNWfqNUHacrdx?cluster=devnet) | 523775962 | finalized; err = null |
| deposit_B_50 | [cT67q4XcdUUuGvWjUDzYBxZ7PV4bmUBPSRhY9zfc3iuCxN9M9j1hpE9J7xcPmR3JxTbSRePXVhEkkD7Y28hcLhq](https://explorer.solana.com/tx/cT67q4XcdUUuGvWjUDzYBxZ7PV4bmUBPSRhY9zfc3iuCxN9M9j1hpE9J7xcPmR3JxTbSRePXVhEkkD7Y28hcLhq?cluster=devnet) | 523775975 | finalized; err = null |

### Балансы до и после

Mint токена и share mint имеют **6 decimals**. В таблице показаны целые токены/shares;
в JSON записаны точные целые базовые единицы строками: 1 токен = 1000000 единиц.
Снимок после A одновременно является снимком перед B.
Значения взяты через getMultipleAccountsInfoAndContext с commitment finalized;
preTokenBalances/postTokenBalances самих транзакций также сохранены в JSON.

| Значение | До A, slot 523775952 | После A / до B, slot 523775963 | После B, slot 523775977 |
| --- | ---: | ---: | ---: |
| Токены A | 1000 | 900 | 900 |
| Токены B | 1000 | 1000 | 950 |
| Токены Vault | 0 | 100 | 150 |
| Shares A | 0 | 100 | 100 |
| Shares B | 0 | 0 | 50 |
| Share mint supply | 0 | 100 | 150 |
| VaultState.total_tokens | 0 | 100 | 150 |
| VaultState.total_shares | 0 | 100 | 150 |
| UserCard A.deposited | 0 | 100 | 100 |
| UserCard A.shares | 0 | 100 | 100 |
| UserCard B.deposited | 0 | 0 | 50 |
| UserCard B.shares | 0 | 0 | 50 |

Первый депозит: shares = amount = 100000000 базовых единиц = **100 shares**.
Второй: shares = amount × total_shares / total_tokens =
50000000 × 100000000 / 100000000 = 50000000 базовых единиц = **50 shares**.
Таким образом, текущее соотношение составляет 1:1. В общем случае контракт выполняет
целочисленное деление с отбрасыванием остатка.

Баланс плательщика: 3,384302175 → 3,367228895 Devnet SOL.
Разница 0,017073280 SOL включает rent, переводы пользователям и комиссии;
она не является суммой комиссий.

### Нулевая сумма и повторная проверка

deposit(0) отклонён **только RPC-симуляцией**, без отправки транзакции:
InstructionError[0].Custom = 6000 (ZeroAmount). Подписи этой операции нет.
Симуляция выполнялась также после реальных депозитов; повторный снимок подтвердил
неизменность всех балансов, total_tokens, total_shares и обеих UserCard.
Это не подтверждённая неуспешная транзакция.

Проверить все 9 подписей и 9 сохранённых итоговых аккаунтов через Devnet RPC без записи:

~~~bash
cd /mnt/c/Users/uldan/Downloads/week-9
node -r ts-node/register/transpile-only scripts/week9-devnet.ts --verify
~~~

Сценарий сверяет genesis hash Devnet и ветку week-9-submission. Режим --verify не читает
приватный ключ. Новый прогон без --verify использует существующий WSL-кошелёк
и отказывается перезаписывать уже существующий evidence/week9-devnet.json.
Для нового прогона нужен локальный target/idl/simple_vault.json и target/deploy/simple_vault.so;
IDL должен совпасть с сохранённым публичным IDL.
Ни deploy/upgrade, ни anchor test этот сценарий не запускает.

Проверка TypeScript: node node_modules/typescript/bin/tsc --noEmit.
JSON проверен разбором; русский текст проверен как UTF-8. Проверка diff выполнена командой
git -c core.whitespace=cr-at-eol diff --check: CRLF учитывается как окончание строки.
Обычный WSL git diff --check отмечает CRLF в семи исходных форматных изменениях;
эти файлы сохранены без изменений и исключены из коммита.
Число 57 обозначает именованные проверки сценария, а не 57 отдельных интеграционных тестов.
