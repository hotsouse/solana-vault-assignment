/** Reuse an existing wallet-owned position before considering any transaction. */
import { Keypair, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Raydium, DEV_API_URLS, TxVersion, SqrtPriceMath, LiquidityMath } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { utils } from "@coral-xyz/anchor";
const bs58 = utils.bytes.bs58;
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { connection, WALLET, MINT_A, MINT_B, POOL, EVIDENCE, assert, inspectPool, discoverPositions, verifyPosition } from "./week11-common";
const LOCK = path.resolve(__dirname, "../.week11-position-pending.json");
function save(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(file + ".tmp", file);
}
async function main() {
  const c = connection();
  await inspectPool(c);
  const existing = await discoverPositions(c);
  assert(existing.length <= 1, "Multiple existing positions: review manually; refusing another opening.");
  if (existing.length === 1) {
    const evidence = await verifyPosition(c, existing[0]);
    const previous = fs.existsSync(EVIDENCE) ? JSON.parse(fs.readFileSync(EVIDENCE, "utf8")) : null;
    assert(!previous || (previous.position === evidence.position && previous.transactionSignature === evidence.transactionSignature), "Existing evidence refers to another opening");
    save(EVIDENCE, { ...evidence, historicalSimulation: previous?.historicalSimulation ?? evidence.historicalSimulation });
    console.log("Existing position verified; no transaction sent. " + evidence.position);
    console.log("Checks passed: " + evidence.passedChecks);
    return;
  }
  assert(!fs.existsSync(EVIDENCE), "Evidence exists but its NFT was not found: refusing another opening.");
  assert(!fs.existsSync(LOCK), "Pending opening exists: recover its signature/position before any retry.");
  const keyPath = process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json");
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8"))));
  assert(owner.publicKey.equals(WALLET), "Wallet does not match Week 11 owner");
  // Persistent exclusive guard, including concurrent processes and uncertain send outcomes.
  fs.writeFileSync(LOCK, JSON.stringify({ pool: POOL.toBase58(), owner: WALLET.toBase58(), phase: "building" }), { flag: "wx" });
  const { p } = await inspectPool(c);
  assert(await c.getBalance(WALLET, "finalized") >= 200000000, "Need >=0.2 Devnet SOL for rent and fees");
  const a = await getAccount(c, getAssociatedTokenAddressSync(MINT_A, WALLET), "finalized");
  const b = await getAccount(c, getAssociatedTokenAddressSync(MINT_B, WALLET), "finalized");
  const tickLower = Math.floor(p.tickCurrent / 60) * 60 - 6000;
  const tickUpper = Math.ceil(p.tickCurrent / 60) * 60 + 6000;
  assert(tickLower >= -443636 && tickUpper <= 443636 && tickLower < p.tickCurrent && p.tickCurrent < tickUpper, "Invalid tick range");
  const budgetA = new BN((a.amount / 100n).toString());
  const budgetB = new BN((b.amount / 100n).toString());
  const lo = SqrtPriceMath.getSqrtPriceX64FromTick(tickLower), hi = SqrtPriceMath.getSqrtPriceX64FromTick(tickUpper);
  // Leave room for the 1% maximum-amount allowance within the 1% wallet budget.
  const liquidity = LiquidityMath.getLiquidityFromTokenAmounts(p.sqrtPriceX64, lo, hi,
    budgetA.muln(10000).divn(10100), budgetB.muln(10000).divn(10100));
  assert(liquidity.gt(new BN(0)), "Token budgets give zero liquidity");
  const amounts = LiquidityMath.getAmountsFromLiquidity(p.sqrtPriceX64, lo, hi, liquidity, true);
  const max = (x: BN) => x.muln(10100).addn(9999).divn(10000);
  const amountMaxA = max(amounts.amountA), amountMaxB = max(amounts.amountB);
  assert(amounts.amountA.gtn(0) && amounts.amountB.gtn(0) && amountMaxA.lte(budgetA) && amountMaxB.lte(budgetB), "Unsafe token limits");
  const raydium = await Raydium.load({ connection: c, owner, cluster: "devnet", disableFeatureCheck: true,
    disableLoadToken: true, blockhashCommitment: "finalized", urlConfigs: DEV_API_URLS });
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(POOL.toBase58());
  const built = await raydium.clmm.openPositionFromLiquidity({ poolInfo, poolKeys, ownerInfo: { useSOLBalance: false },
    tickLower, tickUpper, liquidity, amountMaxA, amountMaxB, nft2022: true, withMetadata: "no-create",
    txVersion: TxVersion.LEGACY, computeBudgetConfig: { units: 600000 } });
  const block = await c.getLatestBlockhash("finalized");
  const transaction = new VersionedTransaction(new TransactionMessage({ payerKey: WALLET, recentBlockhash: block.blockhash,
    instructions: built.transaction.instructions }).compileToV0Message());
  transaction.sign([owner, ...built.signers]);
  const sim = await c.simulateTransaction(transaction, { sigVerify: true, commitment: "finalized" });
  assert(sim.value.err === null, "Simulation failed: " + JSON.stringify(sim.value));
  const signature = bs58.encode(transaction.signatures[0]);
  save(LOCK, { phase: "simulated", position: built.extInfo.address.personalPosition.toBase58(),
    nftMint: built.extInfo.address.nftMint.toBase58(), signature, block, simulation: sim,
    planned: { tickLower, tickUpper, liquidity: liquidity.toString(), amountMaxA: amountMaxA.toString(), amountMaxB: amountMaxB.toString(), slippageBps: 100 } });
  // The identical signed bytes that passed simulation are submitted once.
  assert(await c.sendRawTransaction(transaction.serialize(), { skipPreflight: false, preflightCommitment: "finalized", maxRetries: 3 }) === signature, "Signature mismatch");
  const confirmation = await c.confirmTransaction({ ...block, signature }, "finalized");
  assert(confirmation.value.err === null, "Opening failed: " + JSON.stringify(confirmation.value.err));
  const evidence = await verifyPosition(c, built.extInfo.address.personalPosition, signature);
  save(EVIDENCE, { ...evidence, historicalSimulation: { status: "passed", result: sim } });
  console.log("Opened and verified: " + evidence.position);
}
main().catch(e => { console.error(e); process.exitCode = 1; });