import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { createMint, getAccount, getMint, MINT_SIZE, ACCOUNT_SIZE } from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL, SystemProgram, Transaction, SendTransactionError } from "@solana/web3.js";
import { assert } from "chai";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { SimpleVault } from "../target/types/simple_vault";

const ROOT = path.resolve(__dirname, "..");
const PROGRAM_ID = "Ecas7acK9ayt8GEs7VozKdn77SmJGLsxHeE9T4zrDjiS";
const ADMIN = "3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const explorer = (kind: "address" | "tx", value: string) =>
  `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
const address = (key: PublicKey) => ({ address: key.toBase58(), explorer: explorer("address", key.toBase58()) });

// Only public addresses, RPC observations and transaction signatures enter this object.
const evidencePath = path.join(ROOT, "evidence/week8-devnet.json");
const previous = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : null;
const previousRuns = previous ? [...(previous.previousRuns || []), Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "previousRuns"))] : [];
const evidence: any = {
  schemaVersion: 1, cluster: "devnet", status: "incomplete",
  program: address(new PublicKey(PROGRAM_ID)), admin: address(new PublicKey(ADMIN)),
  accounts: {}, transactions: {}, tests: [], previousRuns,
};

function saveEvidence() {
  mkdirSync(path.join(ROOT, "evidence"), { recursive: true });
  writeFileSync(path.join(ROOT, "evidence/week8-devnet.json"), JSON.stringify(evidence, null, 2) + "\n");
}

async function fundFromAdmin(provider: anchor.AnchorProvider, recipient: PublicKey) {
  return provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: provider.wallet.publicKey, toPubkey: recipient, lamports: 0.05 * LAMPORTS_PER_SOL,
  })));
}

describe("simple_vault (real Devnet)", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<SimpleVault>;
  let admin: Keypair;
  const userA = Keypair.generate();
  const userB = Keypair.generate();
  let tokenMint: PublicKey;
  let vaultStatePDA: PublicKey;
  let vaultTokenAccountPDA: PublicKey;
  let shareMintPDA: PublicKey;
  let started = false;

  const cardPda = (user: PublicKey) => PublicKey.findProgramAddressSync(
    [Buffer.from("user_card"), vaultStatePDA.toBuffer(), user.toBuffer()], program.programId,
  )[0];

  async function recordTransaction(name: string, signature: string) {
    // Preserve the real returned signature even if subsequent RPC verification fails.
    evidence.transactions[name] = { signature, explorer: explorer("tx", signature), verified: false };
    saveEvidence();
    let tx = null;
    for (let attempt = 0; attempt < 10 && !tx; attempt++) {
      tx = await provider.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.isNotNull(tx, `RPC must return transaction ${signature}`);
    assert.isNotNull(tx!.meta, "Transaction metadata is required");
    assert.isNull(tx!.meta!.err, "Transaction must succeed on Devnet");
    const keys = tx!.transaction.message.getAccountKeys().staticAccountKeys;
    assert.isTrue(keys.some(key => key.equals(program.programId)), "Transaction must invoke this program");
    Object.assign(evidence.transactions[name], { verified: true, slot: tx!.slot, err: tx!.meta!.err });
    saveEvidence();
  }

  async function verifyAccounts() {
    const vault = await program.account.vaultState.fetch(vaultStatePDA, "confirmed");
    assert.equal(vault.admin.toBase58(), ADMIN);
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.vaultTokenAccount.toBase58(), vaultTokenAccountPDA.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPDA.toBase58());
    const tokenAccount = await getAccount(provider.connection, vaultTokenAccountPDA, "confirmed");
    assert.equal(tokenAccount.mint.toBase58(), tokenMint.toBase58());
    assert.equal(tokenAccount.owner.toBase58(), vaultStatePDA.toBase58());
    const mint = await getMint(provider.connection, tokenMint, "confirmed");
    assert.equal(mint.mintAuthority!.toBase58(), ADMIN);
    const shares = await getMint(provider.connection, shareMintPDA, "confirmed");
    assert.equal(shares.mintAuthority!.toBase58(), vaultStatePDA.toBase58());
    assert.equal(shares.decimals, 6);
    for (const [label, user] of [["A", userA], ["B", userB]] as const) {
      const card = await program.account.userCard.fetch(cardPda(user.publicKey), "confirmed");
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePDA.toBase58());
      evidence.accounts[`userCard${label}`].decoded = { owner: card.owner.toBase58(), vault: card.vault.toBase58() };
    }
    evidence.accounts.vaultState.decoded = {
      admin: vault.admin.toBase58(), tokenMint: vault.tokenMint.toBase58(),
      vaultTokenAccount: vault.vaultTokenAccount.toBase58(), shareMint: vault.shareMint.toBase58(),
    };
    evidence.rpcVerification = { checkedAt: new Date().toISOString(), commitment: "confirmed", vaultTokenAuthority: tokenAccount.owner.toBase58(), shareMintAuthority: shares.mintAuthority!.toBase58() };
  }

  before(async () => {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8" }).trim();
    assert.equal(branch, "week-8-submission", "Only the submission branch may run these transactions");
    const config = readFileSync(path.join(ROOT, "Anchor.toml"), "utf8");
    assert.include(config.match(/\[programs\.devnet\]([\s\S]*?)(?=\n\[|$)/)![1], PROGRAM_ID);
    assert.include(readFileSync(path.join(ROOT, "programs/simple_vault/src/lib.rs"), "utf8"), `declare_id!("${PROGRAM_ID}")`);
    const walletPath = process.env.ANCHOR_WALLET;
    assert.isOk(walletPath, "Set ANCHOR_WALLET to the existing Devnet admin wallet; never use the program keypair");
    assert.isTrue(existsSync(walletPath!), "Admin wallet file is missing");
    const resolvedWallet = realpathSync(walletPath!);
    const relativeWallet = path.relative(realpathSync(ROOT), resolvedWallet);
    if (!relativeWallet.startsWith("..") && !path.isAbsolute(relativeWallet)) {
      execFileSync("git", ["check-ignore", "--quiet", "--", relativeWallet], { cwd: ROOT });
      const tracked = execFileSync("git", ["ls-files", "--", relativeWallet], { cwd: ROOT, encoding: "utf8" });
      assert.equal(tracked.trim(), "", "Wallet must not be tracked by Git");
    }
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    program = anchor.workspace.SimpleVault as Program<SimpleVault>;
    admin = (provider.wallet as anchor.Wallet).payer;
    assert.equal(program.programId.toBase58(), PROGRAM_ID);
    assert.equal(admin.publicKey.toBase58(), ADMIN, "Wrong admin wallet");
    const genesisHash = await provider.connection.getGenesisHash();
    assert.equal(genesisHash, DEVNET_GENESIS, "RPC is not Solana Devnet; refusing transactions");
    const deployed = await provider.connection.getAccountInfo(program.programId, "confirmed");
    assert.isTrue(deployed?.executable, "Existing Devnet program must be executable");
    const rentSizes = [MINT_SIZE, 137, ACCOUNT_SIZE, MINT_SIZE];
    const rents = await Promise.all(rentSizes.map(size => provider.connection.getMinimumBalanceForRentExemption(size)));
    const requiredLamports = rents.reduce((sum, rent) => sum + rent, 0) + 0.1 * LAMPORTS_PER_SOL + 0.01 * LAMPORTS_PER_SOL;
    const balanceLamports = await provider.connection.getBalance(admin.publicKey, "confirmed");
    assert.isAtLeast(balanceLamports, requiredLamports, "Insufficient Devnet SOL for rent, user funding and fee reserve");
    evidence.preflight = { checkedAt: new Date().toISOString(), genesisHash, programExecutable: true, balanceLamports, requiredLamports };
    started = true;
    saveEvidence();
    for (const [label, user] of [["A", userA], ["B", userB]] as const) {
      evidence.accounts[`user${label}`] = address(user.publicKey);
      const signature = await fundFromAdmin(provider, user.publicKey);
      evidence.transactions[`fundUser${label}`] = { signature, explorer: explorer("tx", signature) };
      saveEvidence();
    }
    tokenMint = await createMint(provider.connection, admin, admin.publicKey, null, 6, undefined, { commitment: "confirmed", preflightCommitment: "confirmed" });
    [vaultStatePDA] = PublicKey.findProgramAddressSync([Buffer.from("vault"), tokenMint.toBuffer()], program.programId);
    [vaultTokenAccountPDA] = PublicKey.findProgramAddressSync([Buffer.from("vault_tokens"), tokenMint.toBuffer()], program.programId);
    [shareMintPDA] = PublicKey.findProgramAddressSync([Buffer.from("share_mint"), tokenMint.toBuffer()], program.programId);
    Object.assign(evidence.accounts, {
      tokenMint: address(tokenMint), vaultState: address(vaultStatePDA),
      vaultTokenAccount: address(vaultTokenAccountPDA), shareMint: address(shareMintPDA),
      userCardA: address(cardPda(userA.publicKey)), userCardB: address(cardPda(userB.publicKey)),
    });
    saveEvidence();
  });

  afterEach(function () {
    evidence.tests.push({ name: this.currentTest!.title, result: this.currentTest!.state, ...(this.currentTest!.err ? { error: this.currentTest!.err.message } : {}) });
    if (started) saveEvidence();
  });

  after(async () => {
    if (!started) return;
    if (evidence.tests.length === 3 && evidence.tests.every((test: any) => test.result === "passed")) {
      await verifyAccounts();
      evidence.status = "complete";
      evidence.completedAt = new Date().toISOString();
    }
    saveEvidence();
  });

  it("initialize_vault: creates the vault", async () => {
    const signature = await program.methods.initializeVault().accounts({
      vaultState: vaultStatePDA, vaultTokenAccount: vaultTokenAccountPDA,
      shareMint: shareMintPDA, tokenMint, admin: admin.publicKey,
    } as any).rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
    await recordTransaction("initializeVault", signature);
    const vault = await program.account.vaultState.fetch(vaultStatePDA, "confirmed");
    assert.equal(vault.admin.toBase58(), ADMIN);
    assert.equal(vault.tokenMint.toBase58(), tokenMint.toBase58());
    assert.equal(vault.shareMint.toBase58(), shareMintPDA.toBase58());
  });

  it("create_user_card: creates distinct cards for A and B", async () => {
    for (const [label, user] of [["A", userA], ["B", userB]] as const) {
      const userCard = cardPda(user.publicKey);
      const signature = await program.methods.createUserCard()
        .accounts({ vaultState: vaultStatePDA, userCard, user: user.publicKey } as any)
        .signers([user]).rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
      await recordTransaction(`createUserCard${label}`, signature);
      const card = await program.account.userCard.fetch(userCard, "confirmed");
      assert.equal(card.owner.toBase58(), user.publicKey.toBase58());
      assert.equal(card.vault.toBase58(), vaultStatePDA.toBase58());
    }
    assert.notEqual(cardPda(userA.publicKey).toBase58(), cardPda(userB.publicKey).toBase58());
  });

  it("create_user_card: rejects duplicate card A", async () => {
    const userCard = cardPda(userA.publicKey);
    const before = await provider.connection.getAccountInfo(userCard, "confirmed");
    let rejection: SendTransactionError | undefined;
    try {
      await program.methods.createUserCard()
        .accounts({ vaultState: vaultStatePDA, userCard, user: userA.publicKey } as any)
        .signers([userA]).rpc({ commitment: "confirmed", preflightCommitment: "confirmed", skipPreflight: false });
    } catch (error) {
      // Network failures and unrelated errors must fail this test.
      if (!(error instanceof SendTransactionError)) throw error;
      rejection = error;
    }
    assert.isDefined(rejection, "Duplicate creation must be rejected by simulation");
    const logs = rejection!.logs || [];
    const allocation = logs.find(line => /already in use/i.test(line));
    assert.isDefined(allocation, "Must reject because the account already exists");
    assert.include(allocation!, userCard.toBase58(), "Rejection must identify the existing UserCard PDA");
    const after = await provider.connection.getAccountInfo(userCard, "confirmed");
    assert.isTrue(before!.data.equals(after!.data), "Existing card data must stay unchanged");
    evidence.duplicateRejection = { userCard: userCard.toBase58(), stage: "preflight simulation", reason: allocation, logs, existingCardUnchanged: true };
  });
});
