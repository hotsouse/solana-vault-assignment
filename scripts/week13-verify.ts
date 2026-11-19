// Independent verifier: public RPC only; no wallet, signing, simulation or sends.
import {strict as assert} from "assert";
import {createHash} from "crypto";
import {Connection,PublicKey} from "@solana/web3.js";
import {getAccount,getMint,getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID} from "@solana/spl-token";
import {PositionInfoLayout,PoolInfoLayout} from "@raydium-io/raydium-sdk-v2";
import {readFileSync} from "fs";
import {GENESIS,CLMM,POOL,INPUT,OUTPUT,pdas} from "./common";
const bs58=require("bs58");
const PROGRAM=new PublicKey("8Fwjh2gQ9qAQFZ4jVPKPe8G6xEq2dQJatFDv4A6iw2Qa");
const disc=(s:string)=>createHash("sha256").update(s).digest().subarray(0,8);
const eq=(a:Buffer,b:Buffer)=>a.subarray(0,8).equals(b);
const u128=(b:Buffer,o:number)=>b.readBigUInt64LE(o)+(b.readBigUInt64LE(o+8)<<64n);
export function positionEvents(logs:string[]){
 const stack:string[]=[];const events:any[]=[];
 for(const l of logs){
  const invoke=l.match(/^Program (\w+) invoke \[\d+\]$/);if(invoke){stack.push(invoke[1]);continue;}
  if(/^Program \w+ (success|failed:)/.test(l)){stack.pop();continue;}
  if(l.startsWith("Program data: ")&&stack[stack.length-1]===PROGRAM.toBase58()){
   const b=Buffer.from(l.slice(14),"base64");if(!eq(b,disc("event:VaultPositionEvent")))continue;
   assert.equal(b.length,117,"Event length");events.push({vault:new PublicKey(b.subarray(8,40)).toBase58(),nft:new PublicKey(b.subarray(40,72)).toBase58(),action:b[72],lower:b.readInt32LE(73),upper:b.readInt32LE(77),liquidity:u128(b,81),amount0:b.readBigUInt64LE(97),amount1:b.readBigUInt64LE(105),tick:b.readInt32LE(113)});
  }
 }
 return events;
}
export function raydiumLiquidityEvents(logs:string[]){
 const stack:string[]=[];const result:any[]=[];
 for(const line of logs){
  const invoke=line.match(/^Program (\w+) invoke \[\d+\]$/);if(invoke){stack.push(invoke[1]);continue;}
  if(/^Program \w+ (success|failed:)/.test(line)){stack.pop();continue;}
  if(!line.startsWith("Program data: ")||stack[stack.length-1]!==CLMM.toBase58())continue;
  const b=Buffer.from(line.slice(14),"base64");if(!eq(b,disc("event:LiquidityCalculateEvent")))continue;
  assert.equal(b.length,92);result.push({poolLiquidity:u128(b,8),sqrtPriceX64:u128(b,24),tick:b.readInt32LE(40),principal0:b.readBigUInt64LE(44),principal1:b.readBigUInt64LE(52),fee0:b.readBigUInt64LE(60),fee1:b.readBigUInt64LE(68),transferFee0:b.readBigUInt64LE(76),transferFee1:b.readBigUInt64LE(84)});
 }
 return result;
}
export function tokenDelta(meta:any,index:number,owner:string,mint:string){
 const find=(list:any[])=>{const b=list.find(x=>x.accountIndex===index);assert(b,"Missing token balance metadata");assert.equal(b.owner,owner);assert.equal(b.mint,mint);assert.equal(b.uiTokenAmount.decimals,6);return BigInt(b.uiTokenAmount.amount);};
 return find(meta.postTokenBalances)-find(meta.preTokenBalances);
}
async function main(){
 const m=JSON.parse(readFileSync("evidence/week13/manifest.json","utf8"));assert.equal(m.program,PROGRAM.toBase58());assert.equal(m.pool,POOL.toBase58());assert(!m.pending,"Unresolved pending transaction");
 const c=new Connection(process.env.DEVNET_RPC??"https://api.devnet.solana.com","finalized");assert.equal(await c.getGenesisHash(),GENESIS);
 const p=pdas(PROGRAM);assert.equal(m.vault,p.vaultState.toBase58());assert.notEqual(m.trader,m.admin);assert.notEqual(m.trader,m.vault);
 const deployment=JSON.parse(readFileSync("evidence/week13/deployment.json","utf8"));assert.equal(deployment.program,m.program);
 const dt=await c.getTransaction(deployment.signature,{commitment:"finalized",maxSupportedTransactionVersion:0});assert(dt&&dt.meta?.err===null,"Missing/failed deployment transaction");
 const prog=await c.getAccountInfo(PROGRAM);assert(prog?.executable,"Week 13 program missing");
 const loader=new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");assert(prog.owner.equals(loader));assert.equal(prog.data.readUInt32LE(0),2);
 const programDataAddress=new PublicKey(prog.data.subarray(4,36));const programData=await c.getAccountInfo(programDataAddress);assert(programData?.owner.equals(loader));assert.equal(programData.data.readUInt32LE(0),3);
 assert.equal(programData.data[12],1);assert.equal(new PublicKey(programData.data.subarray(13,45)).toBase58(),m.admin,"Unexpected upgrade authority");
 const artifact=JSON.parse(readFileSync("evidence/week13/build-artifact.json","utf8"));assert.equal(artifact.program,m.program);
 assert.equal(createHash("sha256").update(programData.data.subarray(45,45+artifact.bytes)).digest("hex"),artifact.sha256,"Deployed ELF does not match verified artifact");
 const poolAccount=await c.getAccountInfo(POOL);assert(poolAccount?.owner.equals(CLMM));const currentPool=PoolInfoLayout.decode(poolAccount.data);
 assert(currentPool.mintA.equals(INPUT)&&currentPool.mintB.equals(OUTPUT),"Token orientation changed");
 for(const [address,mint] of [[p.vaultTokenAccount,INPUT],[p.outputTokenAccount,OUTPUT]]){const a=await getAccount(c,address);assert(a.owner.equals(p.vaultState)&&a.mint.equals(mint));}
 const deployMessage:any=dt.transaction.message;const deployKeys=deployMessage.getAccountKeys({accountKeysFromLookups:dt.meta?.loadedAddresses});assert(Array.from({length:deployKeys.length},(_,i)=>deployKeys.get(i)?.toBase58()).includes(m.program),"Deployment tx does not reference Week 13 program");
 const deployInstructions=deployMessage.compiledInstructions??deployMessage.instructions;
 assert(deployInstructions.some((ix:any)=>{
  if(!deployKeys.get(ix.programIdIndex)?.equals(loader))return false;
  const bytes=Buffer.from(typeof ix.data==="string"?bs58.decode(ix.data):ix.data);const accounts=ix.accountKeyIndexes??ix.accounts;
  return bytes.length>=4&&bytes.readUInt32LE(0)===2&&deployKeys.get(accounts[2])?.equals(PROGRAM)&&deployKeys.get(accounts[1])?.equals(programDataAddress);
 }),"Missing actual upgradeable-loader deployment instruction");
 assert.equal(programData.data.readBigUInt64LE(4),BigInt(dt.slot),"Program was upgraded after the recorded deployment");
 const checks:any[]=[];const fetched=new Map<string,any>();const signatures=new Set<string>();
 const opLabels=["normal-open","normal-collect","normal-close","rebalance-old-open","rebalance-old-close","rebalance-new-open"];
 for(const label of [...opLabels,"normal-swap-1","normal-swap-2","normal-swap-3"]){assert.equal(m.records.filter((r:any)=>r.label===label).length,1,"Missing/duplicate "+label);}
 assert(m.records.some((r:any)=>r.label.startsWith("rebalance-move-")),"Missing genuine rebalancing swaps");
 for(const r of m.records){
  assert(!signatures.has(r.signature),"Reused signature");signatures.add(r.signature);
  const t=await c.getTransaction(r.signature,{commitment:"finalized",maxSupportedTransactionVersion:0});assert(t?.meta&&t.meta.err===null,"Missing/failed finalized tx: "+r.label);assert.equal(t.slot,r.slot);
  const msg:any=t.transaction.message;const keys=msg.getAccountKeys({accountKeysFromLookups:t.meta.loadedAddresses});
  const list=msg.compiledInstructions??msg.instructions;
  const key=(i:number)=>keys.get(i)!.toBase58();
  const root=list.map((ix:any,index:number)=>({ix,index,program:key(ix.programIdIndex)}));
  const ops=root.filter((x:any)=>x.program===m.program);
  const swaps=root.filter((x:any)=>x.program===CLMM.toBase58());
  const events=positionEvents(t.meta.logMessages??[]);let e=events[0];
  if(opLabels.includes(r.label)||r.label==="rebalance-new-close"){
   assert.equal(ops.length,1);assert.equal(events.length,1);assert.equal(e.vault,m.vault);assert(e.lower<e.upper);
   const outerData=typeof ops[0].ix.data==="string"?bs58.decode(ops[0].ix.data):Buffer.from(ops[0].ix.data);
   const isOpen=r.label.endsWith("open"),isClose=r.label.endsWith("close");
   assert.equal(e.action,isOpen?0:isClose?2:1);
   const math=raydiumLiquidityEvents(t.meta.logMessages??[]);assert.equal(math.length,1,"Missing Raydium liquidity calculation event");
   assert.equal(math[0].tick,e.tick);assert.equal(math[0].transferFee0,0n);assert.equal(math[0].transferFee1,0n);
   assert.equal(e.amount0,math[0].principal0+math[0].fee0);assert.equal(e.amount1,math[0].principal1+math[0].fee1);
   if(!isOpen&&!isClose){assert.equal(math[0].principal0,0n);assert.equal(math[0].principal1,0n);}
   e={...e,sqrtPriceX64:math[0].sqrtPriceX64,principal0:math[0].principal0,principal1:math[0].principal1,fee0:math[0].fee0,fee1:math[0].fee1};
   assert(eq(Buffer.from(outerData),disc("global:"+(isOpen?"open_position":isClose?"close_position":"collect_position_fees"))),"Wrong outer instruction");
   const inn=t.meta.innerInstructions?.find(x=>x.index===ops[0].index)?.instructions??[];
   const cpis=inn.filter(x=>key(x.programIdIndex)===CLMM.toBase58()).map(x=>({ix:x,data:Buffer.from(bs58.decode(x.data))}));
   const expected=isOpen?["open_position_v2","increase_liquidity_v2"]:isClose?["decrease_liquidity_v2","close_position"]:["decrease_liquidity_v2"];
   assert.equal(cpis.length,expected.length);expected.forEach((name,i)=>assert(eq(cpis[i].data,disc("global:"+name)),"Wrong Raydium CPI sequence"));
   assert((t.meta.logMessages??[]).some(l=>l===`Program ${CLMM} invoke [2]`),"Missing nested Raydium execution");
   const iA=Array.from({length:keys.length},(_,i)=>i).find(i=>key(i)===p.vaultTokenAccount.toBase58());
   const iB=Array.from({length:keys.length},(_,i)=>i).find(i=>key(i)===p.outputTokenAccount.toBase58());assert(iA!==undefined&&iB!==undefined);
   const da=tokenDelta(t.meta,iA,m.vault,INPUT.toBase58()),db=tokenDelta(t.meta,iB,m.vault,OUTPUT.toBase58());
   // This pool has TOKEN_A as token_0, independently verified in preflight and current pool.
   assert.equal(da,isOpen?-e.amount0:e.amount0);assert.equal(db,isOpen?-e.amount1:e.amount1);
   const nft=new PublicKey(e.nft),nftAccount=getAssociatedTokenAddressSync(nft,p.vaultState,true);
   const personal=PublicKey.findProgramAddressSync([Buffer.from("position"),nft.toBuffer()],CLMM)[0];
   const bound=(cpi:number,index:number,expected:PublicKey)=>assert.equal(key(cpis[cpi].ix.accounts[index]),expected.toBase58(),"CPI account binding mismatch");
   if(isOpen){
    bound(0,1,p.vaultState);bound(0,2,nft);bound(0,3,nftAccount);bound(0,5,POOL);bound(0,9,personal);bound(0,10,p.vaultTokenAccount);bound(0,11,p.outputTokenAccount);
    bound(1,1,nftAccount);bound(1,2,POOL);bound(1,4,personal);bound(1,7,p.vaultTokenAccount);bound(1,8,p.outputTokenAccount);
   } else {
    bound(0,1,nftAccount);bound(0,2,personal);bound(0,3,POOL);bound(0,9,p.vaultTokenAccount);bound(0,10,p.outputTokenAccount);
    if(isClose){bound(1,0,p.vaultState);bound(1,1,nft);bound(1,2,nftAccount);bound(1,3,personal);}
   }
   const parsed=await c.getParsedTransaction(r.signature,{commitment:"finalized",maxSupportedTransactionVersion:0});assert(parsed?.meta);
   const parsedInner=(parsed.meta.innerInstructions??[]).flatMap(x=>x.instructions).filter((x:any)=>x.programId.equals(TOKEN_PROGRAM_ID)&&x.parsed).map((x:any)=>x.parsed);
   if(isOpen){
    assert(e.liquidity>0n&&e.amount0>0n&&e.amount1>0n);assert(e.tick>=e.lower&&e.tick<e.upper);
    const b=Buffer.from(outerData);assert.equal(b.readInt32LE(8),e.lower);assert.equal(b.readInt32LE(12),e.upper);assert.equal(u128(b,16),e.liquidity);
    assert(e.amount0<=b.readBigUInt64LE(32)&&e.amount1<=b.readBigUInt64LE(40));
    assert.equal(u128(cpis[0].data,24),0n);assert.equal(u128(cpis[1].data,8),e.liquidity);
    assert.equal(key(cpis[1].ix.accounts[0]),m.vault,"Vault must authorize liquidity funding");
    assert(parsedInner.some(x=>["initializeAccount","initializeAccount2","initializeAccount3"].includes(x.type)&&x.info.account===nftAccount.toBase58()&&x.info.owner===m.vault&&x.info.mint===e.nft),"Historical NFT custody not proven");
    assert(parsedInner.some(x=>x.type==="mintTo"&&x.info.mint===e.nft&&x.info.account===nftAccount.toBase58()&&x.info.amount==="1"),"NFT mint missing");
   } else {
    assert.equal(key(cpis[0].ix.accounts[0]),m.vault,"Vault must authorize withdrawal/collection");
    assert.equal(u128(cpis[0].data,8),isClose?e.liquidity:0n);
    if(isClose){
     const b=Buffer.from(outerData);assert(b.readBigUInt64LE(8)>0n||b.readBigUInt64LE(16)>0n);assert(e.amount0>=b.readBigUInt64LE(8)&&e.amount1>=b.readBigUInt64LE(16));
     assert(parsedInner.some(x=>x.type==="burn"&&x.info.mint===e.nft&&x.info.amount==="1"&&x.info.authority===m.vault),"NFT burn missing");
     assert(parsedInner.some(x=>x.type==="closeAccount"&&x.info.account===nftAccount.toBase58()&&x.info.destination===m.vault),"NFT account closure missing");
     assert.equal((await getMint(c,nft,"finalized")).supply,0n);
     assert.equal(await c.getAccountInfo(nftAccount),null);
     const position=PublicKey.findProgramAddressSync([Buffer.from("position"),nft.toBuffer()],CLMM)[0];assert.equal(await c.getAccountInfo(position),null);
    } else assert(e.amount0+e.amount1>0n,"No fees earned");
   }
   checks.push({label:r.label,slot:t.slot,signature:r.signature,event:e,deltaA:da,deltaB:db});
  } else if(r.label.includes("swap-")||r.label.startsWith("rebalance-move-")){
   assert.equal(swaps.length,1);assert.equal(ops.length,0);const ix=swaps[0].ix;
   const accounts=ix.accountKeyIndexes??ix.accounts;
   assert.equal(key(accounts[0]),m.trader,"Swap trader mismatch");assert.equal(key(accounts[2]),POOL.toBase58(),"Swap pool mismatch");
   assert(Array.from({length:msg.header.numRequiredSignatures},(_,i)=>key(i)).includes(m.trader),"Trader did not sign");
   const input=key(accounts[11]),output=key(accounts[12]);assert.deepEqual([input,output].sort(),[INPUT.toBase58(),OUTPUT.toBase58()].sort());
   assert.equal(key(accounts[3]),getAssociatedTokenAddressSync(new PublicKey(input),new PublicKey(m.trader)).toBase58());
   assert.equal(key(accounts[4]),getAssociatedTokenAddressSync(new PublicKey(output),new PublicKey(m.trader)).toBase58());
   const swapData=Buffer.from(typeof ix.data==="string"?bs58.decode(ix.data):ix.data);assert(eq(swapData,disc("global:swap_v2")));assert.equal(swapData[40],1);
   assert.equal(-tokenDelta(t.meta,accounts[3],m.trader,input),swapData.readBigUInt64LE(8));assert(tokenDelta(t.meta,accounts[4],m.trader,output)>=swapData.readBigUInt64LE(16));
   assert((t.meta.logMessages??[]).some(l=>l===`Program ${CLMM} success`));
  }
  fetched.set(r.label,{record:r,event:e,slot:t.slot});
  console.log("PASS finalized",r.label,r.signature);
 }
 const event=(label:string)=>{const x=fetched.get(label);assert(x?.event);return x;};
 const normalOpen=event("normal-open"),fees=event("normal-collect"),normalClose=event("normal-close");
 assert(normalOpen.slot<fees.slot&&fees.slot<normalClose.slot);assert.equal(normalOpen.event.nft,normalClose.event.nft);assert.equal(fees.event.nft,normalOpen.event.nft);assert.equal(normalOpen.event.liquidity,normalClose.event.liquidity);
 for(const label of ["normal-swap-1","normal-swap-2","normal-swap-3"]){const s=fetched.get(label);assert(s.slot>normalOpen.slot&&s.slot<fees.slot);}
 const old=event("rebalance-old-open"),closed=event("rebalance-old-close"),next=event("rebalance-new-open");
 assert(old.slot<closed.slot&&closed.slot<next.slot);assert.equal(old.event.nft,closed.event.nft);assert.notEqual(old.event.nft,next.event.nft);assert.equal(old.event.liquidity,closed.event.liquidity);
 assert(closed.event.tick<old.event.lower||closed.event.tick>=old.event.upper,"Price was not out of old range at close");
 assert(next.event.tick>=next.event.lower&&next.event.tick<next.event.upper);assert(old.event.lower!==next.event.lower||old.event.upper!==next.event.upper);
 if(m.active){
  assert.equal(m.active.nft,next.event.nft);const nft=new PublicKey(m.active.nft);const n=await getAccount(c,getAssociatedTokenAddressSync(nft,p.vaultState,true));assert(n.owner.equals(p.vaultState)&&n.amount===1n);
  const pos=await c.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("position"),nft.toBuffer()],CLMM)[0]);assert(pos?.owner.equals(CLMM));assert.equal(PositionInfoLayout.decode(pos.data).liquidity.toString(),next.event.liquidity.toString());
 }
 const positionState=await c.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("position"),p.vaultState.toBuffer()],PROGRAM)[0]);assert(positionState?.owner.equals(PROGRAM));assert.equal(positionState.data[160],m.active?1:0,"Current lifecycle checkpoint mismatch");
 const v=await c.getAccountInfo(p.vaultState);assert(v?.owner.equals(PROGRAM));assert.equal(v.data[152],1,"Withdrawal lock must remain set");
 console.log(JSON.stringify({status:"passed",verifiedAt:new Date().toISOString(),deployment:deployment.signature,checks,limitations:["RPC provides transaction token balances and instruction logs; arbitrary historical account bytes cannot be retrieved.","Historical NFT custody is proven by token initialization, minting and Vault-authorized CPI; current accounts are labeled separately.","Stored preflight balances are observations, not archival account proofs."]},(_,v)=>typeof v==="bigint"?v.toString():v,2));
}
if(require.main===module)main().catch(e=>{console.error("FAIL",e);process.exitCode=1;});
