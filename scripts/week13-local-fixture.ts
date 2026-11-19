// Builds a public account-address list for local testing. Never sends a Devnet transaction.
import {Connection,PublicKey} from "@solana/web3.js";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {PoolInfoLayout,TickArrayLayout} from "@raydium-io/raydium-sdk-v2";
import {writeFileSync} from "fs";
import {GENESIS,POOL,CLMM,INPUT,OUTPUT} from "./common";
async function main(){
 const c=new Connection("https://api.devnet.solana.com","finalized");if(await c.getGenesisHash()!==GENESIS)throw Error("Wrong genesis");
 const owner=new PublicKey(process.env.WEEK13_ADMIN??"3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7");
 const a=await c.getAccountInfo(POOL);if(!a?.owner.equals(CLMM))throw Error("Wrong pool owner");const p=PoolInfoLayout.decode(a.data);
 const bitmap=PublicKey.findProgramAddressSync([Buffer.from("pool_tick_array_bitmap_extension"),POOL.toBuffer()],CLMM)[0];
 const arrays=await c.getProgramAccounts(CLMM,{filters:[{dataSize:TickArrayLayout.span},{memcmp:{offset:8,bytes:POOL.toBase58()}}],dataSlice:{offset:0,length:0}});
 const accounts=[POOL,p.ammConfig,p.observationId,p.vaultA,p.vaultB,INPUT,OUTPUT,bitmap,getAssociatedTokenAddressSync(INPUT,owner),getAssociatedTokenAddressSync(OUTPUT,owner),...arrays.map(x=>x.pubkey)];
 const result={kind:"LOCAL validator fixture cloned from public Devnet",observedAt:new Date().toISOString(),sourceGenesis:GENESIS,sourceAdmin:owner.toBase58(),accounts:accounts.map(x=>x.toBase58()),programs:[CLMM.toBase58(),"metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"],limitations:["All transactions executed against this fixture are local, never Devnet evidence."]};
 writeFileSync("evidence/week13/local-fixture.json",JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
