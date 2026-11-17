# Simple Vault — Week 11

В этой неделе к учебному проекту добавлен отдельный TypeScript-скрипт. Он создаёт два SPL-токена и пул Raydium CLMM в Solana Devnet. Код контракта Simple Vault и его Program ID не менялись.

## AMM и CLMM

AMM — это обмен токенов через пул и формулу цены, без биржевого стакана. В CLMM поставщик ликвидности выбирает диапазон цены, в котором его средства участвуют в обменах. На этой неделе создаётся только сам пул: swap, позиции и добавление ликвидности не выполняются.

TOKEN_A и TOKEN_B — собственные тестовые SPL-токены для учебной пары. Скрипт создаёт для каждого mint с 6 decimals и выпускает по 1 000 000 токенов на настроенный кошелёк Devnet. Суммы считаются в целых базовых единицах: `1_000_000_000_000` на каждый токен.

## Запуск

Нужны Node.js 18+, npm, Solana CLI и кошелёк с SOL именно в Devnet. Секретный файл кошелька должен быть доступен через `ANCHOR_WALLET` или находиться по адресу `~/.config/solana/id.json`. Для RPC можно задать `DEVNET_RPC`; иначе используется публичный Devnet RPC.

```bash
npm install
npm run typecheck
npm run create-pool
```

`create-pool` запускает `scripts/create-clmm-pool.ts`. Скрипт проверяет mint authority, decimals, supply и баланс токен-аккаунта. Состояние выполнения хранится локально в игнорируемом `.devnet-pool-progress.json`, чтобы продолжить после частичного сбоя. При повторном запуске уже созданные mint’ы и пул переиспользуются.

Скрипт запрашивает комиссии из Raydium Devnet API и требует строгое совпадение `tickSpacing = 60` и `tradeFeeRate = 2500`, то есть 0,25%. Если такого конфига нет, скрипт прекращает работу. Для пары с одинаковыми decimals начальная цена задаётся как `1 TOKEN_A = 1 TOKEN_B`. При создании пула используется Raydium CLMM Program ID Devnet `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH`.

После подтверждения транзакции скрипт читает аккаунт пула напрямую через RPC и проверяет владельца, пару mint’ов, конфигурацию комиссии и начальную цену. Подтверждённые адреса записываются в локальный `devnet-pool.json`; оба JSON-файла исключены из Git.

## Результат Devnet

- Кошелёк: `3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7`
- TOKEN_A mint: `7bdCcN9agJ3TSSjTFctxM4TGFVecBRd6gLNYoWYyvawF` — 1 000 000 токенов, 6 decimals.
- TOKEN_B mint: `CwHVUNisByLqXM7mN47nhtcfG8AkYxeJ3tBdFB66yZAt` — 1 000 000 токенов, 6 decimals.
- TOKEN_A mint transaction: [Solana Explorer](https://explorer.solana.com/tx/4RRrfDqJ9pPNMTWMbUz1xPcob7Ty4zbdBSoaqjbBri7zge4NbgTFpQB8TgzatrSHQ2YsZ1HHod2tXiTHRpw5MsAF?cluster=devnet); выпуск токенов: [Explorer](https://explorer.solana.com/tx/4Xv9nurdDuyyKiaJxiPJfKG41c9Ui89pd4MsGpD8K3V4WKh5H3JtYpzodEGT8P4TpQ1vHCB6UJ2LUJmXe9EzzMAS?cluster=devnet).
- TOKEN_B mint transaction: [Solana Explorer](https://explorer.solana.com/tx/4WnHyyzrEFBoys2mtvHf2aBMY3HGdHXbbJRk964sCWf3r4b5zoXwxNFfh3aXUuyscCVkfyNz7664zUfFNBzFztVM?cluster=devnet); выпуск токенов: [Explorer](https://explorer.solana.com/tx/2Xs8CZwutqCaBKErSY4TZed6if64w7x2QTbKLLiCZ2y2WU1rj1vJBSUnnf19UqHmpxseKWsLSuk3tSgDhXoqrXgM?cluster=devnet).
- CLMM pool: `EKwcP1HdZsti8ALXNvAUAduWfYLXH76DeJkcH39auM1f` — [Solana Explorer](https://explorer.solana.com/address/EKwcP1HdZsti8ALXNvAUAduWfYLXH76DeJkcH39auM1f?cluster=devnet).
- Создание пула: [подтверждённая транзакция](https://explorer.solana.com/tx/3gbxWcfF3vEKsvYq3pd9pGgPxLVUM992shCRvQKBNiMdCsV9ms6BpwuMDzxHZPm3jBWCrqsHqyfRqrtXqbPYPtQ5?cluster=devnet). `solana confirm` вернул `Finalized`.
- Fee config: `CD4aJtX11cqTCAc83nxSPkkh5JW2yjD6uwHeovjqQ1qu`; tick spacing 60; комиссия 0,25%; начальная цена 1:1.
- Проверено через RPC: mint’ы имеют 6 decimals, supply и баланс кошелька равны `1_000_000_000_000` базовых единиц на токен; аккаунт пула существует и принадлежит указанной программе Raydium CLMM. SDK подтвердил mint’ы, fee config и цену пула.

## Проверки и файлы

- `npm run typecheck` — успешно для `scripts/create-clmm-pool.ts`.
- `npm run create-pool` — успешно; повторный запуск нашёл существующие mint’ы и пул, проверил их и не отправлял повторные транзакции.
- Anchor-контракт на этой неделе не собирался и не развёртывался: он не менялся, а для создания пула это не требуется.
- Адреса и подписи транзакций также сохранены локально в `devnet-pool.json`.

Основные файлы: `scripts/create-clmm-pool.ts` — создание и проверка токенов/пула; `package.json` — команды и зависимости; `tsconfig.json` — настройки TypeScript. `devnet-pool.json` и файл продолжения скрипта не коммитятся.

В Week 10 остались прежними инструкции `initialize_vault`, `create_user_card`, `deposit`, `withdraw`, структуры состояния и Program ID. История Week 8–10 не изменялась.
