// Public reads only. No wallet file is opened and no transaction is constructed.
import {Connection,PublicKey} from "@solana/web3.js";
import {getAccount,getMint,TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {PoolInfoLayout,TickArrayLayout} from "@raydium-io/raydium-sdk-v2";
import {writeFileSync} from "fs";
import {CLMM,POOL,INPUT,OUTPUT,GENESIS,pdas} from "./common";
const PROGRAM=new PublicKey("8Fwjh2gQ9qAQFZ4jVPKPe8G6xEq2dQJatFDv4A6iw2Qa");
async function main(){
 const c=new Connection(process.env.DEVNET_RPC??"https://api.devnet.solana.com","finalized");
 const genesis=await c.getGenesisHash();if(genesis!==GENESIS)throw Error("Devnet genesis mismatch");
 const owner=new PublicKey(process.env.WEEK13_ADMIN??"3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7");
 const ray=await c.getAccountInfo(CLMM);if(!ray?.executable)throw Error("CLMM program not executable");
 const account=await c.getAccountInfo(POOL);if(!account?.owner.equals(CLMM))throw Error("Wrong pool owner");
 const p=PoolInfoLayout.decode(account.data);
 if([p.mintA,p.mintB].map(x=>x.toBase58()).sort().join()!==[INPUT,OUTPUT].map(x=>x.toBase58()).sort().join())throw Error("Wrong mints");
 if(p.rewardInfos.some(r=>!r.tokenMint.equals(PublicKey.default)))throw Error("Reward-bearing pools unsupported");
 const tokens=[];
 for(const mint of [INPUT,OUTPUT]){
  const m=await getMint(c,mint,"finalized",TOKEN_PROGRAM_ID);
  const accounts=await c.getTokenAccountsByOwner(owner,{mint},"finalized");
  let balance=0n;for(const a of accounts.value)balance+=(await getAccount(c,a.pubkey)).amount;
  tokens.push({mint:mint.toBase58(),decimals:m.decimals,supply:m.supply.toString(),walletBalance:balance.toString(),mintAuthority:m.mintAuthority?.toBase58()});
 }
 const vaults=[];
 for(const [address,mint] of [[p.vaultA,p.mintA],[p.vaultB,p.mintB]]){
  const v=await getAccount(c,address);if(!v.owner.equals(POOL)||!v.mint.equals(mint))throw Error("Pool vault mismatch");
  vaults.push({address:address.toBase58(),mint:mint.toBase58(),authority:v.owner.toBase58(),amount:v.amount.toString()});
 }
 const arrays=await c.getProgramAccounts(CLMM,{filters:[{dataSize:TickArrayLayout.span},{memcmp:{offset:8,bytes:POOL.toBase58()}}]});
 const ticks=arrays.map(a=>{const t=TickArrayLayout.decode(a.account.data);return{address:a.pubkey.toBase58(),start:t.startTickIndex,initialized:t.initializedTickCount};});
 const v=pdas(PROGRAM);const vaultState=await c.getAccountInfo(v.vaultState);
 const deployed=await c.getAccountInfo(PROGRAM);
 const result={observedAt:new Date().toISOString(),commitment:"finalized",genesis,program:PROGRAM.toBase58(),programDeployed:!!deployed?.executable,
  admin:owner.toBase58(),lamports:(await c.getBalance(owner)).toString(),pool:POOL.toBase58(),clmm:CLMM.toBase58(),
  mint0:p.mintA.toBase58(),mint1:p.mintB.toBase58(),tick:p.tickCurrent,tickSpacing:p.tickSpacing,liquidity:p.liquidity.toString(),sqrtPriceX64:p.sqrtPriceX64.toString(),
  status:p.status,tokens,vaults,tickArrays:ticks,vault:v.vaultState.toBase58(),vaultInitialized:!!vaultState,
  limitations:["This is a current-state observation, not a historical snapshot.","Funding sufficiency is assessed against the actual deployment rent estimate before deployment."]};
 writeFileSync("evidence/week13/preflight.json",JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result,null,2));
 if(p.liquidity.isZero()||ticks.length===0)throw Error("Pool lacks liquidity/tick arrays");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
