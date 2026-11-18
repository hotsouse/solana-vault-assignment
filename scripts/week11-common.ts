import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount, getMint, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PoolInfoLayout, ClmmConfigLayout, PositionInfoLayout, TickArrayLayout, ObservationInfoLayout,
  SqrtPriceMath, LiquidityMath, TickUtils, getPdaPoolId, getPdaAmmConfigId, getPdaPoolVaultId,
  getPdaPersonalPositionAddress, getPdaProtocolPositionAddress, getPdaTickArrayAddress, getPdaObservationAccount } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import Decimal from "decimal.js";
import { utils } from "@coral-xyz/anchor";
const bs58 = utils.bytes.bs58;
import { createHash } from "crypto";
import * as path from "path";
export const WALLET = new PublicKey("3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7");
export const POOL = new PublicKey("EKwcP1HdZsti8ALXNvAUAduWfYLXH76DeJkcH39auM1f");
export const PROGRAM = new PublicKey("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
export const MINT_A = new PublicKey("7bdCcN9agJ3TSSjTFctxM4TGFVecBRd6gLNYoWYyvawF");
export const MINT_B = new PublicKey("CwHVUNisByLqXM7mN47nhtcfG8AkYxeJ3tBdFB66yZAt");
export const EVIDENCE = path.resolve(__dirname, "../evidence/week11-devnet.json");
export const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
export const connection = () => new Connection(RPC, "finalized");
export function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
export const discriminator = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);
export const u128 = (b: Buffer, offset: number) => new BN(b.subarray(offset, offset + 16), "le");
export async function programAccount(c: Connection, key: PublicKey, name: string) {
  const a = await c.getAccountInfo(key, "finalized");
  assert(a && a.owner.equals(PROGRAM) && !a.executable, name + ": missing or wrong program owner");
  return a;
}
export async function inspectPool(c: Connection) {
  assert(await c.getGenesisHash() === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "RPC is not Solana Devnet");
  const account = await programAccount(c, POOL, "pool");
  assert(account.data.subarray(0, 8).equals(discriminator("account:PoolState")), "Pool discriminator mismatch");
  const p = PoolInfoLayout.decode(account.data);
  assert(p.mintA.equals(MINT_A) && p.mintB.equals(MINT_B), "Wrong pool mint order");
  assert(Buffer.compare(p.mintA.toBuffer(), p.mintB.toBuffer()) < 0, "Unsorted token0/token1");
  const ca = await programAccount(c, p.ammConfig, "config");
  assert(ca.data.subarray(0, 8).equals(discriminator("account:AmmConfig")), "Config discriminator mismatch");
  const config = ClmmConfigLayout.decode(ca.data);
  assert(getPdaAmmConfigId(PROGRAM, config.index).publicKey.equals(p.ammConfig), "Config PDA mismatch");
  assert(config.tickSpacing === 60 && p.tickSpacing === 60 && config.tradeFeeRate === 2500, "Wrong fee/tick spacing");
  assert(getPdaPoolId(PROGRAM, p.ammConfig, MINT_A, MINT_B).publicKey.equals(POOL), "Pool PDA mismatch");
  const [a, b, va, vb] = await Promise.all([
    getMint(c, MINT_A, "finalized", TOKEN_PROGRAM_ID), getMint(c, MINT_B, "finalized", TOKEN_PROGRAM_ID),
    getAccount(c, p.vaultA, "finalized"), getAccount(c, p.vaultB, "finalized"),
  ]);
  assert(a.decimals === 6 && b.decimals === 6 && p.mintDecimalsA === 6 && p.mintDecimalsB === 6, "Decimals mismatch");
  for (const [mint, vault, info] of [[MINT_A, p.vaultA, va], [MINT_B, p.vaultB, vb]] as const) {
    assert(getPdaPoolVaultId(PROGRAM, POOL, mint).publicKey.equals(vault), "Vault PDA mismatch");
    assert(info.owner.equals(POOL) && info.mint.equals(mint), "Vault relationship mismatch");
  }
  assert(getPdaObservationAccount(PROGRAM, POOL).publicKey.equals(p.observationId), "Observation PDA mismatch");
  const observation = ObservationInfoLayout.decode((await programAccount(c, p.observationId, "observation")).data);
  assert(observation.poolId.equals(POOL), "Observation pool mismatch");
  return { p, config, mintA: a, mintB: b, vaultA: va, vaultB: vb,
    price: SqrtPriceMath.sqrtPriceX64ToPrice(p.sqrtPriceX64, 6, 6).toString() };
}
// Search both token programs. A failed RPC is fatal, never treated as "no position".
export async function discoverPositions(c: Connection) {
  const found: PublicKey[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const tokens = await c.getParsedTokenAccountsByOwner(WALLET, { programId }, "finalized");
    for (const token of tokens.value) {
      const i = token.account.data.parsed.info;
      if (i.tokenAmount.decimals !== 0 || i.tokenAmount.amount !== "1") continue;
      const position = getPdaPersonalPositionAddress(PROGRAM, new PublicKey(i.mint)).publicKey;
      const a = await c.getAccountInfo(position, "finalized");
      if (!a || !a.owner.equals(PROGRAM)) continue;
      assert(a.data.subarray(0, 8).equals(discriminator("account:PersonalPositionState")), "Position discriminator mismatch");
      if (PositionInfoLayout.decode(a.data).poolId.equals(POOL)) found.push(position);
    }
  }
  return found;
}
export async function verifyPosition(c: Connection, address: PublicKey, signature?: string) {
  const checks: Record<string, boolean> = {};
  const check = (name: string, ok: unknown) => { checks[name] = !!ok; assert(ok, name); };
  const { p, config, price } = await inspectPool(c);
  check("devnet_pool_owner_mints_decimals_config_vaults_observation_pdas", true);
  const posAccount = await programAccount(c, address, "position");
  check("position_discriminator", posAccount.data.subarray(0, 8).equals(discriminator("account:PersonalPositionState")));
  const pos = PositionInfoLayout.decode(posAccount.data);
  check("personal_position_pda", getPdaPersonalPositionAddress(PROGRAM, pos.nftMint).publicKey.equals(address));
  check("position_pool", pos.poolId.equals(POOL));
  check("nonzero_liquidity", pos.liquidity.gt(new BN(0)));
  check("aligned_ticks", pos.tickLower < pos.tickUpper && pos.tickLower % 60 === 0 && pos.tickUpper % 60 === 0);
  const mintAccount = await c.getAccountInfo(pos.nftMint, "finalized");
  check("nft_token_program", mintAccount && [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(x => x.equals(mintAccount.owner)));
  const mint = await getMint(c, pos.nftMint, "finalized", mintAccount!.owner);
  check("nft_supply_decimals_authority", mint.supply === 1n && mint.decimals === 0 && mint.mintAuthority === null);
  const nftATA = getAssociatedTokenAddressSync(pos.nftMint, WALLET, false, mintAccount!.owner);
  const nft = await getAccount(c, nftATA, "finalized", mintAccount!.owner);
  check("wallet_owns_nft_ata", nft.owner.equals(WALLET) && nft.mint.equals(pos.nftMint) && nft.amount === 1n);
  for (const tick of [pos.tickLower, pos.tickUpper]) {
    const start = TickUtils.getTickArrayStartIndexByTick(tick, p.tickSpacing);
    const key = getPdaTickArrayAddress(PROGRAM, POOL, start).publicKey;
    const taAccount = await programAccount(c, key, "tick array");
    check("tick_array_discriminator_" + tick, taAccount.data.subarray(0, 8).equals(discriminator("account:TickArrayState")));
    const ta = TickArrayLayout.decode(taAccount.data);
    const state = ta.ticks[(tick - start) / p.tickSpacing];
    check("tick_array_" + tick, ta.poolId.equals(POOL) && ta.startTickIndex === start &&
      state.tick === tick && state.liquidityGross.gte(pos.liquidity));
  }
  // Protocol position is deprecated on current Devnet: verify PDA in instruction,
  // but do not require an account at this unused compatibility address.
  const protocolPda = getPdaProtocolPositionAddress(PROGRAM, POOL, pos.tickLower, pos.tickUpper).publicKey;
  const sigs = await c.getSignaturesForAddress(address, { limit: 1000 }, "finalized");
  const candidates = signature ? [signature] : sigs.filter(x => x.err === null).map(x => x.signature).reverse();
  let tx: Awaited<ReturnType<Connection["getTransaction"]>> = null;
  let openIx: { accounts: number[]; data: string; programIdIndex: number } | undefined;
  let keys: PublicKey[] = [];
  let txSignature = "";
  for (const candidate of candidates) {
    const t = await c.getTransaction(candidate, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!t || t.meta?.err) continue;
    const message = t.transaction.message;
    const accountKeys = message.getAccountKeys({ accountKeysFromLookups: t.meta?.loadedAddresses });
    const k = Array.from({ length: accountKeys.length }, (_, i) => accountKeys.get(i)!);
    const ix = message.compiledInstructions.find(i => k[i.programIdIndex].equals(PROGRAM) &&
      Buffer.from(i.data).subarray(0, 8).equals(discriminator("global:open_position_with_token22_nft")) &&
      k[i.accountKeyIndexes[8]].equals(address));
    if (ix) { tx = t; keys = k; openIx = { accounts: Array.from(ix.accountKeyIndexes), data: bs58.encode(ix.data), programIdIndex: ix.programIdIndex }; txSignature = candidate; break; }
  }
  check("opening_transaction_found", tx && openIx);
  const status = (await c.getSignatureStatuses([txSignature], { searchTransactionHistory: true })).value[0];
  check("finalized_meta_err_null", status?.confirmationStatus === "finalized" && status.err === null && tx!.meta!.err === null);
  const ix = openIx!;
  check("opening_pool_wallet_nft_position_protocol_pda",
    keys[ix.accounts[0]].equals(WALLET) && keys[ix.accounts[1]].equals(WALLET) &&
    keys[ix.accounts[2]].equals(pos.nftMint) && keys[ix.accounts[3]].equals(nftATA) &&
    keys[ix.accounts[4]].equals(POOL) && keys[ix.accounts[5]].equals(protocolPda) &&
    keys[ix.accounts[8]].equals(address));
  check("opening_mints_vaults_token_programs", keys[ix.accounts[11]].equals(p.vaultA) &&
    keys[ix.accounts[12]].equals(p.vaultB) && keys[ix.accounts[18]].equals(MINT_A) &&
    keys[ix.accounts[19]].equals(MINT_B) && keys[ix.accounts[15]].equals(TOKEN_PROGRAM_ID) &&
    keys[ix.accounts[17]].equals(TOKEN_2022_PROGRAM_ID));
  const data = Buffer.from(bs58.decode(ix.data));
  for (const [tick, keyIndex, offset] of [[pos.tickLower, 6, 16], [pos.tickUpper, 7, 20]]) {
    const start = TickUtils.getTickArrayStartIndexByTick(tick, p.tickSpacing);
    check("opening_tick_array_pda_" + tick, data.readInt32LE(offset) === start &&
      keys[ix.accounts[keyIndex]].equals(getPdaTickArrayAddress(PROGRAM, POOL, start).publicKey));
  }
  check("opening_ticks", data.readInt32LE(8) === pos.tickLower && data.readInt32LE(12) === pos.tickUpper);
  const maxA = data.readBigUInt64LE(40), maxB = data.readBigUInt64LE(48);
  const events = tx!.meta!.logMessages!.filter(x => x.startsWith("Program data: ")).map(x => Buffer.from(x.slice(14), "base64"));
  const ev = events.find(x => x.subarray(0, 8).equals(discriminator("event:LiquidityCalculateEvent")));
  check("opening_price_event", ev && ev.length >= 60);
  const sqrt = u128(ev!, 24), tick = ev!.readInt32LE(40);
  const amountA = ev!.readBigUInt64LE(44), amountB = ev!.readBigUInt64LE(52);
  check("opening_tick_inside_range", pos.tickLower <= tick && tick < pos.tickUpper);
  check("opening_tick_matches_sqrt", SqrtPriceMath.getTickFromSqrtPriceX64(sqrt) === tick);
  const sqrtLower = SqrtPriceMath.getSqrtPriceX64FromTick(pos.tickLower);
  const sqrtUpper = SqrtPriceMath.getSqrtPriceX64FromTick(pos.tickUpper);
  const amounts = LiquidityMath.getAmountsFromLiquidity(sqrt, sqrtLower, sqrtUpper, pos.liquidity, true);
  check("clmm_math_matches_deposits", amounts.amountA.toString() === amountA.toString() && amounts.amountB.toString() === amountB.toString());
  check("max_amounts_bound_deposits", amountA > 0n && amountB > 0n && amountA <= maxA && amountB <= maxB);
  check("opening_transaction_contains_no_swap", tx!.transaction.message.compiledInstructions.every(i =>
    keys[i.programIdIndex].toBase58() === "ComputeBudget111111111111111111111111111111" ||
    (keys[i.programIdIndex].equals(PROGRAM) && Buffer.from(i.data).subarray(0, 8).equals(discriminator("global:open_position_with_token22_nft")))));
  const balanceChanges: object[] = [];
  for (const [mintKey, vault, amount, index] of [[MINT_A, p.vaultA, amountA, 9], [MINT_B, p.vaultB, amountB, 10]] as const) {
    const source = keys[ix.accounts[index]];
    for (const [account, expected] of [[source, -amount], [vault, amount]] as const) {
      const accountIndex = keys.findIndex(x => x.equals(account));
      const pre = tx!.meta!.preTokenBalances!.find(x => x.accountIndex === accountIndex && x.mint === mintKey.toBase58());
      const post = tx!.meta!.postTokenBalances!.find(x => x.accountIndex === accountIndex && x.mint === mintKey.toBase58());
      const delta = BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0");
      check("balance_delta_" + account.toBase58(), pre && post && delta === expected &&
        pre.owner === (expected < 0n ? WALLET : POOL).toBase58() && post.owner === pre.owner);
      if (expected < 0n) check("deposit_at_most_one_percent_" + mintKey.toBase58(), amount * 100n <= BigInt(pre!.uiTokenAmount.amount));
      balanceChanges.push({ account: account.toBase58(), mint: mintKey.toBase58(), pre: pre!.uiTokenAmount.amount, post: post!.uiTokenAmount.amount, delta: delta.toString() });
    }
  }
  const ownerA = await getAccount(c, getAssociatedTokenAddressSync(MINT_A, WALLET), "finalized");
  const ownerB = await getAccount(c, getAssociatedTokenAddressSync(MINT_B, WALLET), "finalized");
  check("wallet_token_accounts", ownerA.owner.equals(WALLET) && ownerB.owner.equals(WALLET) && ownerA.mint.equals(MINT_A) && ownerB.mint.equals(MINT_B));
  const openingPrice = SqrtPriceMath.sqrtPriceX64ToPrice(sqrt, 6, 6).toString();
  return {
    schemaVersion: 1, cluster: "devnet", rpcEndpoint: RPC, wallet: WALLET.toBase58(), owner: WALLET.toBase58(),
    tokenA: MINT_A.toBase58(), tokenB: MINT_B.toBase58(), decimalsA: 6, decimalsB: 6,
    pool: POOL.toBase58(), poolProgram: PROGRAM.toBase58(), feeConfig: p.ammConfig.toBase58(),
    tradeFeeRate: config.tradeFeeRate, tickSpacing: p.tickSpacing,
    position: address.toBase58(), positionNftMint: pos.nftMint.toBase58(), nftProgram: mintAccount!.owner.toBase58(),
    nftTokenAccount: nftATA.toBase58(), protocolPositionPda: protocolPda.toBase58(),
    protocolPositionNote: "Deprecated compatibility PDA; account existence is not required.",
    liquidity: pos.liquidity.toString(), tickLower: pos.tickLower, tickUpper: pos.tickUpper,
    priceLower: SqrtPriceMath.sqrtPriceX64ToPrice(sqrtLower, 6, 6).toString(),
    priceUpper: SqrtPriceMath.sqrtPriceX64ToPrice(sqrtUpper, 6, 6).toString(),
    opening: { slot: tx!.slot, blockTime: tx!.blockTime, currentTick: tick, sqrtPriceX64: sqrt.toString(), priceTokenBPerTokenA: openingPrice,
      amountA: amountA.toString(), amountB: amountB.toString(), uiAmountA: new Decimal(amountA.toString()).div(1000000).toString(),
      uiAmountB: new Decimal(amountB.toString()).div(1000000).toString(),
      maxAmountA: maxA.toString(), maxAmountB: maxB.toString(),
      slippageHeadroomBpsA: Number((maxA - amountA) * 10000n / amountA),
      slippageHeadroomBpsB: Number((maxB - amountB) * 10000n / amountB),
      instructionLiquidity: u128(data, 24).toString(), baseFlag: data.length >= 59 && data[57] === 1 ? !!data[58] : null,
      priceSource: "Finalized LiquidityCalculateEvent; not the current pool snapshot." },
    current: { slot: await c.getSlot("finalized"), currentTick: p.tickCurrent, sqrtPriceX64: p.sqrtPriceX64.toString(),
      priceTokenBPerTokenA: price, walletLamports: await c.getBalance(WALLET, "finalized"),
      walletAmountA: ownerA.amount.toString(), walletAmountB: ownerB.amount.toString() },
    transactionSignature: txSignature, explorerUrl: "https://explorer.solana.com/tx/" + txSignature + "?cluster=devnet",
    confirmationStatus: status!.confirmationStatus, metadata: { err: tx!.meta!.err, fee: tx!.meta!.fee,
      computeUnitsConsumed: tx!.meta!.computeUnitsConsumed, logs: tx!.meta!.logMessages,
      preTokenBalances: tx!.meta!.preTokenBalances, postTokenBalances: tx!.meta!.postTokenBalances, balanceChanges },
    historicalSimulation: { status: "unavailable", note: "Existing finalized position recovered through RPC. No original pre-send simulation receipt was found; it cannot be reconstructed by simulating an already executed opening." },
    verifiedAt: new Date().toISOString(), checks, passedChecks: Object.keys(checks).length
  };
}