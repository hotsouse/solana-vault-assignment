/**
 * Тесты для Simple Vault на devnet
 *
 * Сценарий:
 *   1. Admin создаёт vault (initialize_vault)
 *   2. Пользователи A и B создают свои карточки (create_user_card)
 *   3. Повторное создание карточки A падает
 *   4. A вносит 100 токенов → 100 shares, B вносит 50 → 50 shares
 *   5. Ошибки депозита и вывода не меняют балансы частично
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { assert } from "chai";
import { SimpleVault } from "../target/types/simple_vault";

// Переводим SOL от admin → pubkey (обходит rate limit devnet airdrop)
async function fundFromAdmin(
  provider: anchor.AnchorProvider,
  admin: Keypair,
  pubkey: PublicKey,
  lamports = 0.05 * LAMPORTS_PER_SOL
) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: pubkey, lamports })
  );
  await provider.sendAndConfirm(tx, [admin]);
}

describe("simple_vault", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SimpleVault as Program<SimpleVault>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const userA = Keypair.generate();
  const userB = Keypair.generate();

  let tokenMint: PublicKey;
  let vaultStatePDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let shareMintPDA: PublicKey;

  // Токен-аккаунты (токен vault) и share-аккаунты пользователей
  const userC = Keypair.generate(); // без карточки
  const tokenAcc: Record<string, PublicKey> = {};
  const shareAcc: Record<string, PublicKey> = {};
  const UNIT = 1_000_000; // decimals = 6

  const deposit = (user: Keypair, amount: number) =>
    program.methods
      .deposit(new anchor.BN(amount))
      .accounts({
        vaultState: vaultStatePDA,
        userCard: cardPda(user.publicKey),
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        userTokenAccount: tokenAcc[user.publicKey.toBase58()],
        userShareAccount: shareAcc[user.publicKey.toBase58()],
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();

  const withdraw = (user: Keypair, sharesAmount: number) =>
    program.methods
      .withdraw(new anchor.BN(sharesAmount))
      .accounts({
        vaultState: vaultStatePDA,
        userCard: cardPda(user.publicKey),
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        userTokenAccount: tokenAcc[user.publicKey.toBase58()],
        userShareAccount: shareAcc[user.publicKey.toBase58()],
        user: user.publicKey,
      } as any)
      .signers([user])
      .rpc();

  const cardPda = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user_card"), vaultStatePDA.toBuffer(), user.toBuffer()],
      program.programId
    )[0];

  before(async () => {
    await fundFromAdmin(provider, admin, userA.publicKey);
    await fundFromAdmin(provider, admin, userB.publicKey);
    await fundFromAdmin(provider, admin, userC.publicKey);

    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    [vaultStatePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), tokenMint.toBuffer()],
      program.programId
    );
    [vaultTokenAccountPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), tokenMint.toBuffer()],
      program.programId
    );
    [shareMintPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), tokenMint.toBuffer()],
      program.programId
    );
  });

  it("initialize_vault: vault создан", async () => {
    await program.methods
      .initializeVault()
      .accounts({
        vaultState: vaultStatePDA,
        vaultTokenAccount: vaultTokenAccountPDA,
        shareMint: shareMintPDA,
        tokenMint,
        admin: admin.publicKey,
      } as any)
      .rpc();

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPDA.toBase58());
    assert.equal(vault.totalTokens.toNumber(), 0);
    assert.equal(vault.totalShares.toNumber(), 0);
  });

  it("create_user_card: у каждого пользователя своя карточка", async () => {
    for (const user of [userA, userB]) {
      const userCard = cardPda(user.publicKey);
      await program.methods
        .createUserCard()
        .accounts({ vaultState: vaultStatePDA, userCard, user: user.publicKey } as any)
        .signers([user])
        .rpc();

      const card = await program.account.userCard.fetch(userCard);
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePDA.toBase58());
    }
    assert.notEqual(cardPda(userA.publicKey).toBase58(), cardPda(userB.publicKey).toBase58());
  });

  it("create_user_card: вторая карточка для того же пользователя — ошибка", async () => {
    let failed = false;
    try {
      await program.methods
        .createUserCard()
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "повторная карточка должна быть отклонена");
  });

  it("подготовка: создаются пользовательские SPL-аккаунты", async () => {
    for (const user of [userA, userB, userC]) {
      const key = user.publicKey.toBase58();
      tokenAcc[key] = await createAccount(provider.connection, admin, tokenMint, user.publicKey);
      shareAcc[key] = await createAccount(provider.connection, admin, shareMintPDA, user.publicKey);
      await mintTo(provider.connection, admin, tokenMint, tokenAcc[key], admin, 1000 * UNIT);
    }
  });

  it("withdraw: пустой vault отклоняет вывод", async () => {
    let failed = false;
    try {
      await withdraw(userA, UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "из пустого vault нельзя вывести токены");
  });

  it("deposit: A вносит 100 токенов → получает 100 shares", async () => {
    await deposit(userA, 100 * UNIT);

    const shares = await getAccount(provider.connection, shareAcc[userA.publicKey.toBase58()]);
    assert.equal(shares.amount, BigInt(100 * UNIT));

    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));
    assert.equal(card.deposited.toNumber(), 100 * UNIT);
    assert.equal(card.shares.toNumber(), 100 * UNIT);
    const userTokens = await getAccount(provider.connection, tokenAcc[userA.publicKey.toBase58()]);
    assert.equal(userTokens.amount, BigInt(900 * UNIT));
    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.totalTokens.toNumber(), 100 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 100 * UNIT);
  });

  it("deposit: B вносит 50 токенов → получает 50 shares", async () => {
    await deposit(userB, 50 * UNIT);

    const shares = await getAccount(provider.connection, shareAcc[userB.publicKey.toBase58()]);
    assert.equal(shares.amount, BigInt(50 * UNIT));

    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    assert.equal(vault.totalTokens.toNumber(), 150 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 150 * UNIT);

    const card = await program.account.userCard.fetch(cardPda(userB.publicKey));
    assert.equal(card.deposited.toNumber(), 50 * UNIT);
    assert.equal(card.shares.toNumber(), 50 * UNIT);
    const userTokens = await getAccount(provider.connection, tokenAcc[userB.publicKey.toBase58()]);
    assert.equal(userTokens.amount, BigInt(950 * UNIT));

    const vaultTokens = await getAccount(provider.connection, vaultTokenAccountPDA);
    assert.equal(vaultTokens.amount, BigInt(150 * UNIT));
  });

  it("deposit: без карточки — ошибка", async () => {
    let failed = false;
    try {
      await deposit(userC, 10 * UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "депозит без карточки должен быть отклонён");
  });

  it("deposit: чужая UserCard отклоняется", async () => {
    let failed = false;
    try {
      await program.methods
        .deposit(new anchor.BN(UNIT))
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userB.publicKey),
          vaultTokenAccount: vaultTokenAccountPDA,
          shareMint: shareMintPDA,
          userTokenAccount: tokenAcc[userA.publicKey.toBase58()],
          userShareAccount: shareAcc[userA.publicKey.toBase58()],
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "чужая карточка должна быть отклонена");
  });

  it("deposit: share-аккаунт с неправильным mint отклоняется", async () => {
    let failed = false;
    try {
      await program.methods
        .deposit(new anchor.BN(UNIT))
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          vaultTokenAccount: vaultTokenAccountPDA,
          shareMint: shareMintPDA,
          userTokenAccount: tokenAcc[userA.publicKey.toBase58()],
          userShareAccount: tokenAcc[userA.publicKey.toBase58()],
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "неправильный mint должен быть отклонён");
  });
  it("deposit: сумма 0 — ошибка", async () => {
    let failed = false;
    try {
      await deposit(userA, 0);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "нулевой депозит должен быть отклонён");
  });

  it("withdraw: A возвращает половину shares и получает токены", async () => {
    await withdraw(userA, 50 * UNIT);

    const shares = await getAccount(provider.connection, shareAcc[userA.publicKey.toBase58()]);
    const userTokens = await getAccount(provider.connection, tokenAcc[userA.publicKey.toBase58()]);
    const vaultTokens = await getAccount(provider.connection, vaultTokenAccountPDA);
    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    const card = await program.account.userCard.fetch(cardPda(userA.publicKey));

    assert.equal(shares.amount, BigInt(50 * UNIT));
    assert.equal(userTokens.amount, BigInt(950 * UNIT));
    assert.equal(vaultTokens.amount, BigInt(100 * UNIT));
    assert.equal(vault.totalTokens.toNumber(), 100 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 100 * UNIT);
    assert.equal(card.deposited.toNumber(), 50 * UNIT);
    assert.equal(card.shares.toNumber(), 50 * UNIT);
  });

  it("withdraw: B возвращает все shares", async () => {
    await withdraw(userB, 50 * UNIT);

    const shares = await getAccount(provider.connection, shareAcc[userB.publicKey.toBase58()]);
    const userTokens = await getAccount(provider.connection, tokenAcc[userB.publicKey.toBase58()]);
    const vaultTokens = await getAccount(provider.connection, vaultTokenAccountPDA);
    const vault = await program.account.vaultState.fetch(vaultStatePDA);
    const card = await program.account.userCard.fetch(cardPda(userB.publicKey));

    assert.equal(shares.amount, BigInt(0));
    assert.equal(userTokens.amount, BigInt(1000 * UNIT));
    assert.equal(vaultTokens.amount, BigInt(50 * UNIT));
    assert.equal(vault.totalTokens.toNumber(), 50 * UNIT);
    assert.equal(vault.totalShares.toNumber(), 50 * UNIT);
    assert.equal(card.deposited.toNumber(), 0);
    assert.equal(card.shares.toNumber(), 0);
  });

  it("withdraw: нулевое количество shares отклоняется", async () => {
    let failed = false;
    try {
      await withdraw(userA, 0);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "нулевой вывод должен быть отклонён");
  });

  it("withdraw: нехватка shares отклоняется без частичных изменений", async () => {
    const vaultBefore = await program.account.vaultState.fetch(vaultStatePDA);
    const cardBefore = await program.account.userCard.fetch(cardPda(userA.publicKey));
    const sharesBefore = await getAccount(
      provider.connection,
      shareAcc[userA.publicKey.toBase58()]
    );
    const userTokensBefore = await getAccount(
      provider.connection,
      tokenAcc[userA.publicKey.toBase58()]
    );
    const vaultTokensBefore = await getAccount(provider.connection, vaultTokenAccountPDA);

    let failed = false;
    try {
      await withdraw(userA, 50 * UNIT + 1);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "нельзя сжечь больше shares, чем есть на аккаунте");

    const vaultAfter = await program.account.vaultState.fetch(vaultStatePDA);
    const cardAfter = await program.account.userCard.fetch(cardPda(userA.publicKey));
    const sharesAfter = await getAccount(provider.connection, shareAcc[userA.publicKey.toBase58()]);
    const userTokensAfter = await getAccount(
      provider.connection,
      tokenAcc[userA.publicKey.toBase58()]
    );
    const vaultTokensAfter = await getAccount(provider.connection, vaultTokenAccountPDA);

    assert.equal(vaultAfter.totalTokens.toNumber(), vaultBefore.totalTokens.toNumber());
    assert.equal(vaultAfter.totalShares.toNumber(), vaultBefore.totalShares.toNumber());
    assert.equal(cardAfter.deposited.toNumber(), cardBefore.deposited.toNumber());
    assert.equal(cardAfter.shares.toNumber(), cardBefore.shares.toNumber());
    assert.equal(sharesAfter.amount, sharesBefore.amount);
    assert.equal(userTokensAfter.amount, userTokensBefore.amount);
    assert.equal(vaultTokensAfter.amount, vaultTokensBefore.amount);
  });

  it("withdraw: без UserCard операция отклоняется", async () => {
    let failed = false;
    try {
      await withdraw(userC, UNIT);
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "вывод без карточки должен быть отклонён");
  });

  it("withdraw: подмена UserCard или share mint отклоняется", async () => {
    let wrongCardFailed = false;
    try {
      await program.methods
        .withdraw(new anchor.BN(UNIT))
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userB.publicKey),
          vaultTokenAccount: vaultTokenAccountPDA,
          shareMint: shareMintPDA,
          userTokenAccount: tokenAcc[userA.publicKey.toBase58()],
          userShareAccount: shareAcc[userA.publicKey.toBase58()],
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      wrongCardFailed = true;
    }
    assert.isTrue(wrongCardFailed, "чужая UserCard должна быть отклонена");

    let wrongMintFailed = false;
    try {
      await program.methods
        .withdraw(new anchor.BN(UNIT))
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          vaultTokenAccount: vaultTokenAccountPDA,
          shareMint: tokenMint,
          userTokenAccount: tokenAcc[userA.publicKey.toBase58()],
          userShareAccount: shareAcc[userA.publicKey.toBase58()],
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      wrongMintFailed = true;
    }
    assert.isTrue(wrongMintFailed, "неверный share mint должен быть отклонён");

    let wrongVaultFailed = false;
    try {
      await program.methods
        .withdraw(new anchor.BN(UNIT))
        .accounts({
          vaultState: cardPda(userA.publicKey),
          userCard: cardPda(userA.publicKey),
          vaultTokenAccount: vaultTokenAccountPDA,
          shareMint: shareMintPDA,
          userTokenAccount: tokenAcc[userA.publicKey.toBase58()],
          userShareAccount: shareAcc[userA.publicKey.toBase58()],
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      wrongVaultFailed = true;
    }
    assert.isTrue(wrongVaultFailed, "неверный Vault PDA должен быть отклонён");

    let wrongVaultTokenAccountFailed = false;
    try {
      await program.methods
        .withdraw(new anchor.BN(UNIT))
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          vaultTokenAccount: tokenAcc[userA.publicKey.toBase58()],
          shareMint: shareMintPDA,
          userTokenAccount: tokenAcc[userA.publicKey.toBase58()],
          userShareAccount: shareAcc[userA.publicKey.toBase58()],
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      wrongVaultTokenAccountFailed = true;
    }
    assert.isTrue(wrongVaultTokenAccountFailed, "неверный token account Vault должен быть отклонён");

    let wrongUserTokenAccountFailed = false;
    try {
      await program.methods
        .withdraw(new anchor.BN(UNIT))
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          vaultTokenAccount: vaultTokenAccountPDA,
          shareMint: shareMintPDA,
          userTokenAccount: shareAcc[userA.publicKey.toBase58()],
          userShareAccount: shareAcc[userA.publicKey.toBase58()],
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      wrongUserTokenAccountFailed = true;
    }
    assert.isTrue(wrongUserTokenAccountFailed, "неверный mint пользовательского token account должен быть отклонён");

    let wrongShareTokenAccountFailed = false;
    try {
      await program.methods
        .withdraw(new anchor.BN(UNIT))
        .accounts({
          vaultState: vaultStatePDA,
          userCard: cardPda(userA.publicKey),
          vaultTokenAccount: vaultTokenAccountPDA,
          shareMint: shareMintPDA,
          userTokenAccount: tokenAcc[userA.publicKey.toBase58()],
          userShareAccount: tokenAcc[userA.publicKey.toBase58()],
          user: userA.publicKey,
        } as any)
        .signers([userA])
        .rpc();
    } catch {
      wrongShareTokenAccountFailed = true;
    }
    assert.isTrue(wrongShareTokenAccountFailed, "неверный mint share account должен быть отклонён");
  });
});
