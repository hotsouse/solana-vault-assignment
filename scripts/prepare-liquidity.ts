import {context,save,POOL,CLMM,quote} from "./common";
import {BN} from "@coral-xyz/anchor";
import {TxVersion} from "@raydium-io/raydium-sdk-v2";
async function main(){
 const {raydium}=await context();
 const positions=(await raydium.clmm.getOwnerPositionInfo({programId:CLMM})).filter(p=>p.poolId.equals(POOL));
 const data=await raydium.clmm.getPoolInfoFromRpc(POOL.toBase58());
 console.log("Existing positions:",positions.length,"active liquidity:",data.computePoolInfo.liquidity.toString());
 if(data.computePoolInfo.liquidity.isZero()){
  if(positions.some(p=>!p.liquidity.isZero())) throw new Error("Existing out-of-range liquidity; review before adding");
  const built=await raydium.clmm.openPositionFromBase({
   poolInfo:data.poolInfo,poolKeys:data.poolKeys,ownerInfo:{useSOLBalance:false},
   tickLower:-6000,tickUpper:6000,base:"MintA",baseAmount:new BN("10000000000"),
   otherAmountMax:new BN("10100000000"),withMetadata:"no-create",nft2022:true,
   txVersion:TxVersion.LEGACY,computeBudgetConfig:{units:600000},
  });
  const {txId}=await built.execute({sendAndConfirm:true});
  save("liquidity.json",{cluster:"devnet",pool:POOL.toBase58(),tx:txId,
   nft:built.extInfo.nftMint.toBase58(),personalPosition:built.extInfo.personalPosition.toBase58(),
   owner:raydium.ownerPubKey.toBase58(),tickLower:-6000,tickUpper:6000,
   note:"Wallet-owned prerequisite liquidity; no Vault position instruction."});
  console.log("Wallet liquidity confirmed:",txId);
 }
 const q=await quote(raydium,new BN("100000000"));
 const result={expected:q.expected,minimum:q.minimum,price:q.poolInfo.price,
  sqrtPriceX64:q.computePoolInfo.sqrtPriceX64.toString(),liquidity:q.computePoolInfo.liquidity.toString(),
  remaining:q.quote.remainingAccounts.map(p=>p.toBase58())};
 save("liquid-pool-quote.json",result);console.log(result);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
