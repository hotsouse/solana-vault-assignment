/** Read-only: no wallet key, filesystem writes, signing or transaction submission. */
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { connection, EVIDENCE, assert, verifyPosition } from "./week11-common";
async function main() {
  const saved = JSON.parse(fs.readFileSync(EVIDENCE, "utf8"));
  const fresh = await verifyPosition(connection(), new PublicKey(saved.position), saved.transactionSignature);
  for (const field of ["cluster", "wallet", "owner", "tokenA", "tokenB", "pool", "poolProgram", "feeConfig",
    "position", "positionNftMint", "nftProgram", "nftTokenAccount", "liquidity", "tickLower", "tickUpper",
    "priceLower", "priceUpper", "tickSpacing", "tradeFeeRate", "transactionSignature", "confirmationStatus"] as const) {
    assert(saved[field] === fresh[field], "Evidence mismatch: " + field);
  }
  assert(JSON.stringify(saved.opening) === JSON.stringify(fresh.opening), "Opening evidence mismatch");
  assert(JSON.stringify(saved.metadata) === JSON.stringify(fresh.metadata), "Transaction evidence mismatch");
  console.log(JSON.stringify(fresh, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });