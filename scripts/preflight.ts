import { context,save,POOL,CLMM,INPUT,OUTPUT,quote } from "./common";
import { getMint,getAccount,getAssociatedTokenAddress } from "@solana/spl-token";
import { BN } from "@coral-xyz/anchor";
async function main() {
 const {connection,owner,raydium}=await context();
 const account=await connection.getAccountInfo(POOL);
 if(!account?.owner.equals(CLMM)) throw new Error("Wrong/missing CLMM pool owner");
 const tokens=[];
 for(const mint of [INPUT,OUTPUT]) {
  const info=await getMint(connection,mint);
  const wallet=await getAccount(connection,await getAssociatedTokenAddress(mint,owner.publicKey));
  tokens.push({mint:mint.toBase58(),decimals:info.decimals,supply:info.supply,balance:wallet.amount,authority:info.mintAuthority?.toBase58()});
 }
 const data=await raydium.clmm.getPoolInfoFromRpc(POOL.toBase58());
 const mints=[data.poolInfo.mintA.address,data.poolInfo.mintB.address].sort();
 if(mints.join()!==[INPUT.toBase58(),OUTPUT.toBase58()].sort().join()) throw new Error("Pool mint mismatch");
 const positions=(await raydium.clmm.getOwnerPositionInfo({programId:CLMM})).filter(p=>p.poolId.equals(POOL));
 let quoteResult:unknown;
 try { const q=await quote(raydium,new BN(1000000)); quoteResult={expected:q.expected,minimum:q.minimum,remaining:q.quote.remainingAccounts.map(p=>p.toBase58())}; }
 catch(e) { quoteResult={error:String(e)}; }
 const result={cluster:"devnet",wallet:owner.publicKey.toBase58(),sol:await connection.getBalance(owner.publicKey)/1e9,
 clmm:CLMM.toBase58(),pool:POOL.toBase58(),tokens,liquidity:data.computePoolInfo.liquidity.toString(),
 tick:data.computePoolInfo.tickCurrent,sqrtPriceX64:data.computePoolInfo.sqrtPriceX64.toString(),
 price:data.poolInfo.price,config:data.poolInfo.config,
 positions:positions.map(p=>({nft:p.nftMint.toBase58(),liquidity:p.liquidity.toString(),lower:p.tickLower,upper:p.tickUpper})),quote:quoteResult};
 save("week11-preflight.json",result);console.log(JSON.stringify(result,(_,v)=>typeof v==="bigint"?v.toString():v,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
