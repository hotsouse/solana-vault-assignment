/** Week 11: create two SPL mints and a Raydium CLMM pool on Devnet. */
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  getMint,
  mintTo,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DEV_API_URLS,
  DEVNET_PROGRAM_ID,
  Raydium,
  TxVersion,
} from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RPC_URL = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const DECIMALS = 6;
const TOKEN_AMOUNT = 1_000_000n;
const BASE_UNITS = TOKEN_AMOUNT * 10n ** BigInt(DECIMALS);
const INITIAL_PRICE = new Decimal(1);
const TICK_SPACING = 60;
const TRADE_FEE_RATE = 2_500; // 2,500 / 1,000,000 = 0.25%
const PROGRAM_ID = new PublicKey("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
const OUTPUT_PATH = path.resolve(__dirname, "..", "devnet-pool.json");
const PROGRESS_PATH = path.resolve(__dirname, "..", ".devnet-pool-progress.json");

type Progress = {
  cluster: "devnet";
  owner: string;
  tokenA?: string;
  tokenACreateTx?: string;
  tokenAMintTx?: string;
  tokenB?: string;
  tokenBCreateTx?: string;
  tokenBMintTx?: string;
  poolId?: string;
  poolTx?: string;
  ammConfig?: string;
};

function saveJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function readProgress(owner: PublicKey): Progress {
  if (!fs.existsSync(PROGRESS_PATH)) return { cluster: "devnet", owner: owner.toBase58() };
  const progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8")) as Progress;
  if (progress.cluster !== "devnet" || progress.owner !== owner.toBase58()) {
    throw new Error(`Progress file belongs to another cluster or wallet: ${PROGRESS_PATH}`);
  }
  return progress;
}

function loadWallet(): Keypair {
  const keyPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config", "solana", "id.json");
  const secret = JSON.parse(fs.readFileSync(keyPath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function ensureToken(
  connection: Connection,
  owner: Keypair,
  progress: Progress,
  field: "tokenA" | "tokenB",
): Promise<{ mint: PublicKey; mintTx: string }> {
  const savedMint = progress[field];
  let mintAddress: PublicKey;
  let createTx = field === "tokenA" ? progress.tokenACreateTx : progress.tokenBCreateTx;

  if (savedMint) {
    mintAddress = new PublicKey(savedMint);
  } else {
    mintAddress = await createMint(connection, owner, owner.publicKey, null, DECIMALS);
    progress[field] = mintAddress.toBase58();
    saveJson(PROGRESS_PATH, progress);
  }

  if (!createTx) {
    const creationSignatures = await connection.getSignaturesForAddress(mintAddress, { limit: 1 }, "confirmed");
    if (!creationSignatures[0]) throw new Error(`Could not find the confirmed creation signature for ${field}`);
    createTx = creationSignatures[0].signature;
    progress[field] = mintAddress.toBase58();
    if (field === "tokenA") progress.tokenACreateTx = createTx;
    else progress.tokenBCreateTx = createTx;
    saveJson(PROGRESS_PATH, progress);
  }

  const mintInfo = await getMint(connection, mintAddress, "confirmed", TOKEN_PROGRAM_ID);
  if (mintInfo.decimals !== DECIMALS) throw new Error(`${field} decimals are ${mintInfo.decimals}; expected ${DECIMALS}`);
  if (!mintInfo.mintAuthority?.equals(owner.publicKey)) throw new Error(`${field} mint authority is not the configured wallet`);

  const ownerTokenAccount = await getAssociatedTokenAddress(mintAddress, owner.publicKey);
  let tokenAccount;
  try {
    tokenAccount = await getAccount(connection, ownerTokenAccount, "confirmed", TOKEN_PROGRAM_ID);
  } catch {
    // mintTo creates the associated account only when callers ask for it; create it here.
    const { getOrCreateAssociatedTokenAccount } = await import("@solana/spl-token");
    tokenAccount = await getOrCreateAssociatedTokenAccount(connection, owner, mintAddress, owner.publicKey);
  }

  if (mintInfo.supply > BASE_UNITS || tokenAccount.amount > BASE_UNITS || mintInfo.supply !== tokenAccount.amount) {
    throw new Error(`${field} supply/account balance is inconsistent with a safe ${TOKEN_AMOUNT.toString()} token mint`);
  }
  if (mintInfo.supply < BASE_UNITS) {
    const remaining = BASE_UNITS - mintInfo.supply;
    const signature = await mintTo(connection, owner, mintAddress, ownerTokenAccount, owner, remaining);
    if (field === "tokenA") progress.tokenAMintTx = signature;
    else progress.tokenBMintTx = signature;
    saveJson(PROGRESS_PATH, progress);
  }

  const finalMintInfo = await getMint(connection, mintAddress, "confirmed", TOKEN_PROGRAM_ID);
  const finalAccount = await getAccount(connection, ownerTokenAccount, "confirmed", TOKEN_PROGRAM_ID);
  if (finalMintInfo.supply !== BASE_UNITS || finalAccount.amount !== BASE_UNITS) {
    throw new Error(`${field} mint or wallet balance did not reach the expected base-unit amount`);
  }
  return { mint: mintAddress, mintTx: field === "tokenA" ? progress.tokenAMintTx! : progress.tokenBMintTx! };
}

async function verifyPool(
  connection: Connection,
  raydium: Raydium,
  poolId: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
  configId: PublicKey,
): Promise<void> {
  const account = await connection.getAccountInfo(poolId, "confirmed");
  if (!account) throw new Error(`Pool ${poolId.toBase58()} was not found on Devnet`);
  if (!account.owner.equals(PROGRAM_ID)) throw new Error(`Pool owner is ${account.owner.toBase58()}, not Raydium CLMM`);

  const rpcPool = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58());
  const state = rpcPool.poolInfo;
  const actualMints = [state.mintA.address, state.mintB.address].sort();
  const expectedMints = [mintA.toBase58(), mintB.toBase58()].sort();
  if (actualMints[0] !== expectedMints[0] || actualMints[1] !== expectedMints[1]) {
    throw new Error("On-chain pool mints do not match TOKEN_A and TOKEN_B");
  }
  if (state.config.id !== configId.toBase58()) throw new Error("On-chain pool references a different fee configuration");
  if (state.config.tickSpacing !== TICK_SPACING || state.config.tradeFeeRate !== TRADE_FEE_RATE) {
    throw new Error("On-chain pool fee configuration does not match tick spacing 60 and 0.25%");
  }
  if (!new Decimal(state.price.toString()).eq(INITIAL_PRICE)) {
    throw new Error(`On-chain pool price is ${state.price}; expected 1:1`);
  }
  const configAccount = await connection.getAccountInfo(configId, "confirmed");
  if (!configAccount || !configAccount.owner.equals(PROGRAM_ID)) {
    throw new Error("The referenced CLMM AmmConfig account is missing or has the wrong owner");
  }
}

async function main(): Promise<void> {
  if (!PROGRAM_ID.equals(DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID)) {
    throw new Error("Configured Raydium CLMM Program ID does not match the SDK Devnet constant");
  }
  const owner = loadWallet();
  const connection = new Connection(RPC_URL, "confirmed");
  const walletBalance = await connection.getBalance(owner.publicKey, "confirmed");
  console.log(`Devnet wallet: ${owner.publicKey.toBase58()}`);
  console.log(`SOL balance: ${(walletBalance / 1e9).toFixed(6)}`);
  if (walletBalance === 0) throw new Error("Wallet has no Devnet SOL for account rent and transaction fees");

  const progress = readProgress(owner.publicKey);
  const tokenA = await ensureToken(connection, owner, progress, "tokenA");
  const tokenB = await ensureToken(connection, owner, progress, "tokenB");
  console.log(`TOKEN_A: ${tokenA.mint.toBase58()} (${TOKEN_AMOUNT} tokens, ${DECIMALS} decimals)`);
  console.log(`TOKEN_B: ${tokenB.mint.toBase58()} (${TOKEN_AMOUNT} tokens, ${DECIMALS} decimals)`);

  const raydium = await Raydium.load({
    owner,
    connection,
    cluster: "devnet",
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: "confirmed",
    urlConfigs: DEV_API_URLS,
  });
  const configs = await raydium.api.getClmmConfigs();
  const config = configs.find((item) => item.tickSpacing === TICK_SPACING && item.tradeFeeRate === TRADE_FEE_RATE);
  if (!config) {
    throw new Error(`Raydium Devnet API has no config for tickSpacing=${TICK_SPACING}, tradeFeeRate=${TRADE_FEE_RATE}`);
  }
  const configId = new PublicKey(config.id);
  if (progress.ammConfig && progress.ammConfig !== configId.toBase58()) {
    throw new Error("The saved pool configuration differs from the current matching Raydium API config");
  }
  progress.ammConfig = configId.toBase58();
  saveJson(PROGRESS_PATH, progress);
  console.log(`Fee config: ${config.id} (tick spacing ${config.tickSpacing}, 0.25%)`);

  const tokenInfo = (mint: PublicKey) => ({
    address: mint.toBase58(),
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: DECIMALS,
  } as any);
  const pool = await raydium.clmm.createPool({
    programId: PROGRAM_ID,
    mint1: tokenInfo(tokenA.mint),
    mint2: tokenInfo(tokenB.mint),
    ammConfig: { ...config, id: configId, fundOwner: "", description: "" } as any,
    initialPrice: INITIAL_PRICE,
    txVersion: TxVersion.V0,
  });
  const poolId = new PublicKey((pool.extInfo as any).address.id);

  if (progress.poolId && progress.poolId !== poolId.toBase58()) {
    throw new Error("Derived pool address differs from the saved address; refusing to create another pool");
  }
  const existing = await connection.getAccountInfo(poolId, "confirmed");
  if (existing) {
    if (!existing.owner.equals(PROGRAM_ID)) throw new Error("The derived pool address is occupied by a non-CLMM account");
    console.log(`Pool already exists: ${poolId.toBase58()}; checking its on-chain state.`);
  } else {
    const { txId } = await pool.execute({ sendAndConfirm: true });
    progress.poolTx = txId;
    progress.poolId = poolId.toBase58();
    saveJson(PROGRESS_PATH, progress);
    console.log(`Pool transaction confirmed: ${txId}`);
  }

  await verifyPool(connection, raydium, poolId, tokenA.mint, tokenB.mint, configId);
  const result = {
    cluster: "devnet",
    tokenA: tokenA.mint.toBase58(),
    tokenB: tokenB.mint.toBase58(),
    tokenAmountEach: TOKEN_AMOUNT.toString(),
    baseUnitsEach: BASE_UNITS.toString(),
    decimals: DECIMALS,
    poolId: poolId.toBase58(),
    poolTx: progress.poolTx ?? null,
    tokenATx: tokenA.mintTx,
    tokenBTx: tokenB.mintTx,
    clmmProgram: PROGRAM_ID.toBase58(),
    ammConfig: configId.toBase58(),
    tickSpacing: config.tickSpacing,
    tradeFeeRate: config.tradeFeeRate,
    initialPriceTokenBPerTokenA: "1",
    explorer: `https://explorer.solana.com/address/${poolId.toBase58()}?cluster=devnet`,
    tokenACreateTx: progress.tokenACreateTx,
    tokenBCreateTx: progress.tokenBCreateTx,
    verifiedOnChain: true,
  };
  saveJson(OUTPUT_PATH, result);
  console.log(`Verified pool: ${poolId.toBase58()}`);
  console.log(`Explorer: ${result.explorer}`);
  console.log(`Saved: ${OUTPUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
