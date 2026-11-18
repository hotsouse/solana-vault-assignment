# Simple Vault — Week 10: вывод токенов из Vault на Devnet

## 1. Описание проекта и результат Week 10

Simple Vault — учебный проект на Solana и Anchor. Пользователи вносят базовые SPL-токены в общий Vault и получают share-токены, отражающие их долю. Week 10 добавляет обратный обмен: инструкция `withdraw(shares_amount: u64)` сжигает shares и возвращает соответствующее количество базовых токенов.

По сохранённым доказательствам от 19 ноября 2026 года (Asia/Qyzylorda), полный цикл с пользователями A и B выполнен в настоящем Devnet: подтверждены **7 реальных транзакций**, включая **3 успешных Withdraw**. Дополнительно выполнены **7 негативных RPC-симуляций** с ожидаемыми отказами. Localnet не использовался вместо Devnet; deploy и upgrade в этом прогоне не выполнялись.

Источники результатов: [публичные RPC-доказательства](evidence/week10-devnet.json), [публичный IDL](evidence/week10-idl.json), [сценарий проверки](scripts/week10-devnet.ts) и [локальный Rust-контракт](programs/simple_vault/src/lib.rs). Эта правка восстанавливает документацию; новых Devnet-транзакций она не создаёт.

## 2. Принцип работы Withdraw и формула

Количество возвращаемых токенов определяется долей пользователя в Vault перед выводом:

```text
tokens_out = floor(shares_amount * VaultState.total_tokens / VaultState.total_shares)
```

В локальном контракте произведение вычисляется в `u128`, деление целочисленное, дробная часть отбрасывается, результат преобразуется в `u64`. Контракт отклоняет нулевую сумму, пустой Vault, результат округления до нуля и арифметические ошибки. Anchor проверяет PDA и ограничения токен-аккаунтов; SPL Token Program проверяет полномочия и доступный баланс shares.

Вывод последовательно выполняет SPL Token CPI `Burn`, затем CPI `Transfer`. После успеха `VaultState.total_tokens` уменьшается на `tokens_out`, а `VaultState.total_shares` — на `shares_amount`. Локальная реализация уменьшает `UserCard.deposited` и `UserCard.shares` через `saturating_sub`. Транзакция атомарна: ошибка сжигания, перевода или обновления состояния отменяет все её изменения.

При первом депозите shares выпускаются в соотношении 1:1. Для последующих депозитов используется `shares = floor(amount * total_shares / total_tokens)`. В проверенном сценарии цена shares всё время оставалась 1:1.

## 3. Публичные адреса Devnet и PDA

- RPC: `https://api.devnet.solana.com`.
- Genesis hash: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- Program: [EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu](https://explorer.solana.com/address/EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu?cluster=devnet).
- Отдельный тестовый SPL mint, 6 decimals: [9aKN68o6YQ4jQBsUUogLcp7mPHHkm3bsJTCDKswY77xE](https://explorer.solana.com/address/9aKN68o6YQ4jQBsUUogLcp7mPHHkm3bsJTCDKswY77xE?cluster=devnet).
- VaultState PDA: [EVTx4YJQK8UE2Fpdzv8oAhfgzKwWMUz8rcDsWL5rA8yJ](https://explorer.solana.com/address/EVTx4YJQK8UE2Fpdzv8oAhfgzKwWMUz8rcDsWL5rA8yJ?cluster=devnet).
- Токен-аккаунт Vault: `3yz8prqzMb5x4vZHLbhzD5hPLb1jsauc1pWFEnwqKktw`.
- Share mint, 6 decimals: `B2NDFLzw8r5BGVFi1tyChPuyiVHY2VdJJiZznnXjVj2B`.
- Основной кошелёк и плательщик комиссий: `3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7`.
- ProgramData: `DsJEjWhUVM6urN6Yor9ZnnBNv2coQopDLWpJqr9gAFNa`.
- Upgrade authority: `38afxYQhjGKgyoWEsKhAZ85xkdCj3z6bj3YU5RY74mR1`.
- Слот развёртывания из ProgramData: `518592305`.
- SPL Token Program: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.

| Пользователь | Адрес пользователя | UserCard PDA | ATA базового токена | ATA shares |
|---|---|---|---|---|
| A | 12U5yEUuWby79mEV9JK4uRrPUGCKuJRm4QUcW4UsBN9e | gjxkFBh6H2cepTR1kowTXdTHQMVzkeFMbcoP51vZpoz | BfVeFeuzw9nwePE4d8bpZ4CQoxDtqmvreftdMJBWsAjS | CdQUxpGHKzVjEu8N4pFjt5myRMAFGcLzU1g7dzdNfjq7 |
| B | BTCzvy1drTqb3tHYh1dLEE4G2pHUK79GviUwFGAovhEh | 874JEXEBE7XDFGh91fHfzfs6L8ARYWfwapwaU8bd73gU | HJSt6zx2sqejANimVKuSevwWbo962Anbeh8kEt4s42z3 | DkbiamtedYDxoqpZrDq6DWqCANymWsmEy7F5toZcVm5S |
| C | ErH3mikZ9uosKimdakRCqJZiqFovbmNG9YF3nVggdu2S | 3JikGnmYUneTUps1cWwJEUi37jiNMKgw9VUehqrPUkYv | 749Wz28RTjH3yVTusDsVp19PmK4RsHsCEXA7Bosnro5W | 9n9k3pC9eGp1t1xbxHdH2ndSNbyKNm7JmHjvULsQ2z4d |

Для C созданы ATA, но UserCard отсутствует: её адрес в таблице вычислен для негативной симуляции. C не участвует в реальных депозитах и выводах.

Seeds остаются неизменными:

| Аккаунт | Seeds без bump |
|---|---|
| VaultState | `["vault", token_mint]` |
| Токен-аккаунт Vault | `["vault_tokens", token_mint]` |
| Share mint | `["share_mint", token_mint]` |
| UserCard | `["user_card", vault_state, user]` |

Все публичные аккаунты, включая временные аккаунты начальной симуляции, сохранены в evidence. Приватные ключи A/B/C существовали только в памяти процесса и не сохранялись; основной кошелёк загружался из внешнего файла Solana CLI. Повторно подписать транзакции от имени этих тестовых пользователей без их ключей невозможно.

## 4. Балансы до и после операций

В таблице указаны токены и shares с учётом 6 decimals. В JSON точные целые значения в минимальных единицах (`base units`) записаны строками. Каждый снимок получен одним `getMultipleAccountsInfo` с уровнем подтверждения `finalized` и содержит слот и исходные base64-данные аккаунтов.

| Шаг | A tokens | A shares | B tokens | B shares | Vault tokens | Share supply | State tokens / shares | Card A deposited / shares | Card B deposited / shares |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| initial | 100 | 0 | 50 | 0 | 0 | 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| deposit-A | 0 | 100 | 50 | 0 | 100 | 100 | 100 / 100 | 100 / 100 | 0 / 0 |
| deposit-B | 0 | 100 | 0 | 50 | 150 | 150 | 150 / 150 | 100 / 100 | 50 / 50 |
| withdraw-A-half | 50 | 50 | 0 | 50 | 100 | 100 | 100 / 100 | 50 / 50 | 50 / 50 |
| withdraw-B-all | 50 | 50 | 50 | 0 | 50 | 50 | 50 / 50 | 50 / 50 | 0 / 0 |
| withdraw-A-final | 100 | 0 | 50 | 0 | 0 | 0 | 0 / 0 | 0 / 0 | 0 / 0 |

A внёс 100 токенов и получил 100 shares, B внёс 50 токенов и получил 50 shares. Затем A вывел 50 shares, B вывел все 50 shares, A вывел оставшиеся 50 shares. В результате Vault полностью опустошён, supply shares и оба счётчика VaultState равны нулю. Все счётчики UserCard A/B также обнулились.

## 5. Все 7 реальных транзакций

| Действие | Ссылка | Слот | Подтверждённый результат RPC |
|---|---|---:|---|
| setup-mint-vault | [Explorer](https://explorer.solana.com/tx/15iTYiUgp4bxfU3NHjiHjWkcPD1sQ8EBDoGawe1GaYoeCRJ5VqLTxFvd33psTymLXEoLzCJKSPMKJRzxRF3PMie?cluster=devnet) | 523780485 | finalized; meta.err = null |
| setup-users | [Explorer](https://explorer.solana.com/tx/WfXJZ21aMdxhqUbinFyQWJ5JxNxzwobLRKaw9vjWsbhY8eS7mUiVgKmR7Y6NAeLdVBRC5swjXziQ8ELEU3WpqCV?cluster=devnet) | 523780496 | finalized; meta.err = null |
| deposit-A | [Explorer](https://explorer.solana.com/tx/5RQr6bvLmrA2o2nfV7GFvu8vErTu9Dkdk19DVfdwtW9UQWjY43SLeDT4pdNvykA4XJddvUKFLQ45wUzhzzkdc5zu?cluster=devnet) | 523780512 | finalized; meta.err = null |
| deposit-B | [Explorer](https://explorer.solana.com/tx/39y9qpUpmnoVpFkJq9E1UTMcFGAxhYoFLGjPTNbcN3SG5nGF8vhv8p5SXSAnQ1BqRirKcnxjiigzhQg5H7iRQuRE?cluster=devnet) | 523780524 | finalized; meta.err = null |
| withdraw-A-half | [Explorer](https://explorer.solana.com/tx/2XkH8PjJZCCtY6Hbt1VvmkaCMKSX7pjz8bC9zB7YaEDhSGQSj8niazZ29ZgjBdZq5e47kkyrH62aMrRnYEHup79C?cluster=devnet) | 523780554 | finalized; meta.err = null |
| withdraw-B-all | [Explorer](https://explorer.solana.com/tx/3LiJorCWziTs6iYSe6Jcevhu4WNrJEzmZiA5iafKbix9mAcXUcHwB3gQB99LjQd8XhRDiYW7BqmFW18g6VYSMhSi?cluster=devnet) | 523780566 | finalized; meta.err = null |
| withdraw-A-final | [Explorer](https://explorer.solana.com/tx/5Buja7wQh4JdgcJponp6iUSavbGaJTJJtXCbsa1MnifnbU5genPqPSNqAfKREdH4JdUskcYLBa61B9knjaciRJhd?cluster=devnet) | 523780578 | finalized; meta.err = null |

`setup-mint-vault` создаёт mint и Vault. В `setup-users` созданы две UserCard и ATA для A/B/C, пользователям A/B перечислены средства на создание карточек и выпущены 100 и 50 тестовых токенов соответственно. Депозиты и каждый из трёх успешных Withdraw выполнены отдельными транзакциями.

Для всех семи подписей сохранены ответы `getSignatureStatuses(searchTransactionHistory=true)` и `getTransaction`: статус `finalized`, `meta.err = null`. Это реальные транзакции; симуляции из следующего раздела не включены в их число.

## 6. Доказательства SPL Token CPI Burn и Transfer

Для каждого из трёх Withdraw проверены `meta.innerInstructions`, `meta.preTokenBalances` и `meta.postTokenBalances` ответа `getTransaction` с кодировкой `jsonParsed`. Каждый Withdraw содержит ровно два SPL Token CPI с `stackHeight = 2` под одной внешней инструкцией Vault:

1. **Burn:** `amount = 50000000`, mint — `B2NDFLzw8r5BGVFi1tyChPuyiVHY2VdJJiZznnXjVj2B`, источник — `userShareAccount`, authority — соответствующий пользователь A или B. Этот пользователь присутствует среди подписантов транзакции. Сжигание уменьшает его баланс shares и supply share mint на 50 shares.
2. **Transfer:** `amount = 50000000`, источник — `3yz8prqzMb5x4vZHLbhzD5hPLb1jsauc1pWFEnwqKktw`, получатель — `userTokenAccount`, authority — VaultState PDA `EVTx4YJQK8UE2Fpdzv8oAhfgzKwWMUz8rcDsWL5rA8yJ`. Пользователь получает 50 базовых токенов.

Vault PDA не является подписантом верхнего уровня транзакции. В локальном контракте программа предоставляет подпись PDA через `CpiContext::new_with_signer` / `invoke_signed`, используя seeds `[b"vault", token_mint, bump]`. Успешный исходящий SPL-перевод с этим authority подтверждает авторизацию PDA во время выполнения программы. Пользователь подписывает Burn; подпись Vault PDA авторизует Transfer.

Полные ответы RPC сохранены в `transactions[].transaction`, выделенные CPI — в `transactions[].cpi`, подтверждения финальности — в `transactions[].status`. Для всех трёх Withdraw `meta.err = null`. Изменения балансов, supply и состояния Vault дополнительно проверены снимками аккаунтов.

## 7. Все 7 негативных RPC-симуляций

Все проверки ниже выполнены через `simulateTransaction` с `sigVerify = true`. Ошибочные транзакции не отправлялись в сеть и не имеют Explorer-ссылок на подтверждённую транзакцию. До и после каждой симуляции скрипт сравнивал реальные RPC-снимки аккаунтов; состояние не изменилось (`stateUnchanged = true`).

| Проверка | Custom code | Фактический лог RPC |
|---|---:|---|
| empty-vault | 6002 | AnchorError thrown in programs/simple_vault/src/lib.rs:118. Error Code: VaultEmpty. Error Number: 6002. Error Message: Vault is empty. |
| withdraw-zero | 6000 | AnchorError thrown in programs/simple_vault/src/lib.rs:115. Error Code: ZeroAmount. Error Number: 6000. Error Message: Amount must be greater than zero. |
| insufficient-shares | 1 | Error: insufficient funds |
| missing-user-card | 3012 | AnchorError caused by account: user_card. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized. |
| substituted-user-card | 2006 | AnchorError caused by account: user_card. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated. |
| wrong-share-mint | 2006 | AnchorError caused by account: share_mint. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated. |
| wrong-token-account | 2014 | AnchorError occurred. Error Code: ConstraintTokenMint. Error Number: 2014. Error Message: A token mint constraint was violated. |

Проверка `withdraw-zero` вызывает `withdraw(0)`. В `insufficient-shares` запрошено `100000001` минимальных единиц при балансе A в `100000000` и непустом Vault. `empty-vault` выполняется до депозитов с положительным запросом `1000000`. Остальные симуляции проверяют отсутствие UserCard у C, подмену UserCard карточкой B для пользователя A, подмену share mint базовым mint и подмену базового токен-аккаунта аккаунтом shares.

Логи, слоты, ошибки, ожидаемые шаблоны и результат сравнения состояния сохранены в `negativeTests[]`. Отказ `insufficient-shares` исходит от SPL Token Program, остальные перечисленные ошибки — от программы Vault или ограничений Anchor.

Перед первой реальной транзакцией выполнена полная совместимостная симуляция: `initialize_vault → create_user_card → deposit → withdraw`. Её ответ сохранён в `compatibility`: слот `523780479`, `err = null`. Эта симуляция подтвердила вызов Withdraw с локальным IDL и ожидаемыми PDA, но сама реальной транзакцией не является.

## 8. Совместимость и ограничения бинарников

Публичный IDL находится в [evidence/week10-idl.json](evidence/week10-idl.json). Инструкция `withdraw` принимает `shares_amount: u64`; discriminator — `[183, 18, 70, 156, 148, 109, 161, 34]`. Совместимость Program ID, IDL и PDA подтверждена для выполненного сценария Devnet.

Локальный и развёрнутый бинарники **не идентичны**:

| Артефакт | Размер | SHA-256 |
|---|---:|---|
| Локальный `target/deploy/simple_vault.so` | 341296 байт | `831ecbee7ad3e50f1a465a6f508586f618cbb54957644fc9b2e3ca6dbe10eb13` |
| Развёрнутый ProgramData payload без 45-байтового заголовка | 445624 байта | `70b47924839245da06b69eb97e16e82104708137d0193bdf885896d535ecf4a0` |

Развёрнутая область содержит нулевой хвост, однако локальный ELF отличается и от её префикса: `localEqualsDeployedPrefix = false`. Различие не объясняется только padding. Проверка подтверждает поведение исследованных инструкций, а не соответствие всех локальных исходников развёрнутому бинарнику. Например, Devnet сообщает `VaultEmpty: "Vault is empty"`, локальный исходник — `"Vault has no outstanding shares"`.

Передача shares другому владельцу, доходность, внешние переводы в Vault и округление при иной цене shares в этом Devnet-прогоне не проверялись. UserCard хранит историю участия; локальный контракт использует насыщающее вычитание её счётчиков при выводе. Тестовые аккаунты и средства на rent остались в Devnet, очистка не выполнялась.

Во время прогона один RPC-запрос получил HTTP 429; встроенный повтор завершился успешно. Исторические снимки program accounts сохранены в момент операций. Обычный RPC не позволяет заново получить произвольный прошлый VaultState; режим проверки сопоставляет сохранённые снимки с логами и токен-балансами транзакций.

## 9. Инструкции запуска и независимой проверки

Рабочий каталог WSL: `/mnt/c/Users/uldan/Downloads/week-10`, ветка `week-10-submission`. С установленными зависимостями из `package-lock.json`:

```bash
cd /mnt/c/Users/uldan/Downloads/week-10
git branch --show-current
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/ts-node scripts/week10-devnet.ts --verify
```

`--verify` работает без отправки транзакций: не читает кошелёк и не изменяет evidence. Он повторно запрашивает Devnet, проверяет хеш развёрнутого payload и сохранённого IDL, финальность всех семи транзакций, исторические токен-балансы и логи, CPI Burn/Transfer и их authority, адреса PDA, текущие остатки Vault, supply shares и UserCard. Сохранённые ошибки негативных симуляций проверяются по их ответам; эти симуляции заново не запускаются. Метаданные ProgramData, включая deployment slot и upgrade authority, запрашиваются снова; скрипт проверяет ожидаемую upgrade authority.

Режим `--run` предназначен для нового полного прогона: сначала симулирует полный сценарий и останавливается при несовместимости, затем отправляет реальные транзакции с основного кошелька. `--simulate` выполняет только предварительную симуляцию. Оба режима сохраняют evidence и отказываются перезаписывать существующий `week10-devnet.json`. Для проверки этой сдачи повторный `--run` не требуется. Ни один режим не вызывает deploy или upgrade.

## 10. Сохранённые результаты проверок и состояние Git

В исходном прогоне выполнено **106 проверяемых утверждений**, подтверждено **7 реальных транзакций**, получено **7 ожидаемых отказов в симуляциях**. Последующая усиленная проверка `--verify` прошла **187 утверждений**, повторный RPC-слот — `523781383`. Эти числа взяты из сохранённого evidence и не означают повторный запуск Devnet-сценария при восстановлении README.

Перед исходным коммитом прошли `tsc --noEmit`, разбор JSON, проверка семи Explorer-ссылок и `git diff --cached --check`. Первоначальная ошибка TypeScript из-за объявления библиотеки ES2015 исправлена ссылкой `es2019` в скрипте. Предыдущая проверка UTF-8 не выявила потерю русских букв: последовательности `?` сами по себе допустимы в UTF-8. При восстановлении README дополнительно проверяются наличие кириллицы и отсутствие последовательностей из четырёх и более вопросительных знаков и символа замены U+FFFD.

Общий `git diff --check` в WSL указывал на CRLF в десяти исходных файлах. Эти незакоммиченные форматные изменения сохраняются вне коммита исправления. Восстановление документации меняет исключительно `README.md`; Rust-контракт, TypeScript-скрипт, JSON evidence, Program ID и PDA seeds остаются без изменений.
