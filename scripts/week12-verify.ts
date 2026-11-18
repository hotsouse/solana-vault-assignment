/** Read-only Devnet evidence verification: no wallet, signing, or transaction submission. */
import {Connection,PublicKey} from "@solana/web3.js";
import {readFileSync} from "fs";
import {createHash} from "crypto";
import {strict as assert} from "assert";
const bs58=require("bs58");
const read=(name:string)=>JSON.parse(readFileSync("evidence/"+name+".json","utf8"));
async function main(){
 const success=read("successful-swap"), rejected=read("rejected-swap"), deployment=read("deployment"), tests=read("devnet-tests");
 const c=new Connection(process.env.DEVNET_RPC??"https://api.devnet.solana.com","finalized");
 assert.equal(await c.getGenesisHash(),"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
 const program=new PublicKey(success.program),vault=new PublicKey(success.vault);
 const ray="DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH";
 const token="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
 const checks:string[]=[];
 const pass=(s:string)=>{checks.push(s);console.log("PASS",s);};
 async function tx(sig:string){
  const status=await c.getSignatureStatuses([sig],{searchTransactionHistory:true});
  assert.equal(status.value[0]?.confirmationStatus,"finalized");
  const t=await c.getParsedTransaction(sig,{commitment:"finalized",maxSupportedTransactionVersion:0});
  assert(t?.meta,"Historical transaction unavailable");return t!;
 }
 const deployed=await c.getAccountInfo(program);
 assert(deployed?.executable);assert.equal(deployed.owner.toBase58(),"BPFLoaderUpgradeab1e11111111111111111111111");
 assert.equal(deployment.program,success.program);assert.equal((await tx(deployment.signature)).meta!.err,null);
 pass("Deployed executable and finalized deployment");
 const ok=await tx(success.signature);assert.equal(ok.meta!.err,null);assert.equal(ok.slot,success.slot);
 const logs=ok.meta!.logMessages??[];
 const start=logs.indexOf("Program "+program+" invoke [1]");
 const mid=logs.indexOf("Program "+ray+" invoke [2]",start);
 assert(start>=0&&mid>start&&logs.slice(mid).some(l=>l==="Program "+token+" invoke [3]"));
 pass("Finalized successful Vault -> Raydium -> SPL CPI");
 const expectedVault=PublicKey.findProgramAddressSync([Buffer.from("vault"),new PublicKey(success.inputMint).toBuffer()],program)[0];
 assert(expectedVault.equals(vault));
 const input=PublicKey.findProgramAddressSync([Buffer.from("vault_tokens"),new PublicKey(success.inputMint).toBuffer()],program)[0];
 const output=PublicKey.findProgramAddressSync([Buffer.from("vault_output"),vault.toBuffer()],program)[0];
 const keys=ok.transaction.message.accountKeys.map(k=>k.pubkey.toBase58());
 function delta(address:PublicKey,mint:string){
  const i=keys.indexOf(address.toBase58());assert(i>=0);
  const pre=ok.meta!.preTokenBalances!.find(b=>b.accountIndex===i),post=ok.meta!.postTokenBalances!.find(b=>b.accountIndex===i);
  assert(pre&&post);assert.equal(pre.mint,mint);assert.equal(post.mint,mint);
  assert.equal(pre.owner,vault.toBase58());assert.equal(post.owner,vault.toBase58());
  return BigInt(post.uiTokenAmount.amount)-BigInt(pre.uiTokenAmount.amount);
 }
 assert.equal(delta(input,success.inputMint),-100000000n);assert.equal(delta(output,success.outputMint),99492788n);
 const inner=ok.meta!.innerInstructions!.reduce((all:any[],g)=>all.concat(g.instructions),[]) as any[];
 assert(inner.some(i=>i.programId.toBase58()===token&&i.parsed?.info?.authority===vault.toBase58()));
 pass("PDA authority and historical token deltas: -100 A, +99.492788 B");
 const ix=ok.transaction.message.instructions.find((i:any)=>i.programId.equals(program)) as any;
 const data=Buffer.from(bs58.decode(ix.data));
 assert(data.subarray(0,8).equals(createHash("sha256").update("global:swap_via_raydium").digest().subarray(0,8)));
 assert.equal(data.readBigUInt64LE(8),100000000n);assert.equal(data.readBigUInt64LE(16),98497860n);
 pass("Historical instruction amount and minimum 98497860");
 const eventTag=createHash("sha256").update("event:VaultSwap").digest().subarray(0,8);
 const event=logs.filter(l=>l.startsWith("Program data: ")).map(l=>Buffer.from(l.slice(14),"base64"))
 .find(b=>b.subarray(0,8).equals(eventTag));
 assert(event&&event.length===128);assert(new PublicKey(event.subarray(8,40)).equals(vault));
 assert.equal(new PublicKey(event.subarray(40,72)).toBase58(),success.pool);
 const u128=(offset:number)=>event.readBigUInt64LE(offset)+(event.readBigUInt64LE(offset+8)<<64n);
 assert.equal(u128(96).toString(),success.sqrtBefore);assert.equal(u128(112).toString(),success.sqrtAfter);
 assert.notEqual(u128(96),u128(112));assert.equal(event.readBigUInt64LE(88),98497860n);
 pass("Historical VaultSwap sqrt price change from transaction logs");
 const bad=await tx(rejected.signature);assert.deepEqual(bad.meta!.err,{InstructionError:[1,{Custom:6018}]});
 assert((bad.meta!.logMessages??[]).some(l=>l.includes("TooLittleOutputReceived")));
 assert((bad.meta!.logMessages??[]).includes("Program "+ray+" failed: custom program error: 0x1782"));
 assert.deepEqual(bad.meta!.preTokenBalances,bad.meta!.postTokenBalances);
 assert.deepEqual(rejected.before,rejected.after);
 pass("Finalized Raydium 6018 failure, unchanged historical token balances");
 const [state,a,b]=await c.getMultipleAccountsInfo([vault,input,output]);
 assert(state&&a&&b);assert(state.owner.equals(program));
 assert.equal(state.data.length,154);assert.equal(state.data.readBigUInt64LE(136),a.data.readBigUInt64LE(64));
 assert.equal(state.data[152],1);assert(new PublicKey(a.data.subarray(32,64)).equals(vault));
 assert(new PublicKey(b.data.subarray(32,64)).equals(vault));
 assert.equal(tests.failed,0);assert.equal(tests.executionCompleted,true);
 pass("Current PDA storage authorities, strategy lock and liquid A accounting");
 console.log(JSON.stringify({checks:checks.length,result:"verified",limitation:
 "Standard RPC has no historical arbitrary account bytes. Failed-transaction token balances are independently checked; Vault/pool byte rollback relies on Solana transaction atomicity, with saved before/after snapshots as supplementary evidence. Saved test count is not a fresh test execution."},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
