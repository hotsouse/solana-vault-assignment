import {strict as assert} from "assert";
import {BN,EventParser} from "@coral-xyz/anchor";
import {ComputeBudgetProgram,Keypair,PublicKey,SystemProgram,SYSVAR_RENT_PUBKEY,Transaction,TransactionInstruction} from "@solana/web3.js";
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,getAccount,getMint,createAssociatedTokenAccountIdempotentInstruction,createTransferInstruction} from "@solana/spl-token";
import {PoolInfoLayout,PositionInfoLayout,LiquidityMath,SqrtPriceMath,PoolUtils,ClmmInstrument} from "@raydium-io/raydium-sdk-v2";
import {readFileSync,writeFileSync,existsSync,mkdirSync} from "fs";
import {context,pdas,vaultProgram,POOL,CLMM,INPUT,OUTPUT,quote} from "./common";
const PROGRAM="8Fwjh2gQ9qAQFZ4jVPKPe8G6xEq2dQJatFDv4A6iw2Qa";
const META=new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const MEMO=new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const file="evidence/week13/manifest.json";
const bn=(x:bigint|string|number)=>new BN(x.toString());
const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==="bigint"?v.toString():v,2)+"\n";
async function main(){
 const mode=process.argv[2];if(!["setup","normal","rebalance","cleanup","recover"].includes(mode))throw Error("Choose setup, normal, rebalance, cleanup, recover");
 const {connection:c,owner,raydium}=await context();const program=vaultProgram(c,owner);
 assert.equal(program.programId.toBase58(),PROGRAM,"Refusing any previous-week program");
 const info=await c.getAccountInfo(program.programId);assert(info?.executable,"Week 13 not deployed");
 const p=pdas(program.programId);mkdirSync(".tools",{recursive:true});
 const m:any=existsSync(file)?JSON.parse(readFileSync(file,"utf8")):{schema:1,cluster:"devnet",program:PROGRAM,pool:POOL.toBase58(),vault:p.vaultState.toBase58(),admin:owner.publicKey.toBase58(),tokenA:INPUT.toBase58(),tokenB:OUTPUT.toBase58(),records:[],tests:[]};
 assert.equal(m.admin,owner.publicKey.toBase58());
 const save=()=>writeFileSync(file,json(m));
 const pool=async()=>{const a=await c.getAccountInfo(POOL);assert(a?.owner.equals(CLMM));return PoolInfoLayout.decode(a.data);};
 const bal=async()=>({a:(await getAccount(c,p.vaultTokenAccount)).amount.toString(),b:(await getAccount(c,p.outputTokenAccount)).amount.toString()});
 async function finalize(sig:string){for(let i=0;i<90;i++){const t=await c.getTransaction(sig,{commitment:"finalized",maxSupportedTransactionVersion:0});if(t){assert.equal(t.meta?.err,null,JSON.stringify(t.meta));return t;}await new Promise(r=>setTimeout(r,1000));}throw Error("Finalization unavailable: "+sig);}
 async function send(label:string,ixs:TransactionInstruction[],extra:Keypair[]=[],detail:any={}){
  assert(!m.records.some((r:any)=>r.label===label),"Already executed: "+label);
  assert(!m.pending,"Resolve pending transaction before retrying");
  const before=(await c.getAccountInfo(p.swapConfig))?await bal():null;
  for(const ix of ixs)for(const key of ix.keys)if(extra.some(s=>s.publicKey.equals(key.pubkey)))key.isSigner=true;
  const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),...ixs);
  const block=await c.getLatestBlockhash("confirmed");tx.feePayer=owner.publicKey;tx.recentBlockhash=block.blockhash;tx.sign(owner,...extra);
  const sig=require("bs58").encode(tx.signature);
  // Persist the signed signature before broadcasting: an RPC timeout must never cause a blind replay.
  m.pending={label,signature:sig,before,detail,...block};save();
  await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,maxRetries:3});
  const t=await finalize(sig);const after=(await c.getAccountInfo(p.swapConfig))?await bal():null;
  const events=[...new EventParser(program.programId,program.coder).parseLogs(t.meta?.logMessages??[])].filter(e=>e.name==="vaultPositionEvent").map(e=>{const d:any=e.data;return {...d,vault:d.vault.toBase58(),nft:d.nft.toBase58(),liquidity:d.liquidity.toString(),amount0:d.amount0.toString(),amount1:d.amount1.toString()};});
  const record={label,signature:sig,explorer:"https://explorer.solana.com/tx/"+sig+"?cluster=devnet",slot:t.slot,before,after,events,detail};
  m.records.push(record);delete m.pending;save();console.log(label,sig);return record;
 }
 const positionState=PublicKey.findProgramAddressSync([Buffer.from("position"),p.vaultState.toBuffer()],program.programId)[0];
 const bitmap=PublicKey.findProgramAddressSync([Buffer.from("pool_tick_array_bitmap_extension"),POOL.toBuffer()],CLMM)[0];
 const remaining=()=>[{pubkey:bitmap,isWritable:true,isSigner:false}];
 const live=await (program.account as any).positionState.fetchNullable(positionState);
 if(live?.active)m.active={nft:live.nftMint.toBase58(),lower:live.lower,upper:live.upper,liquidity:live.liquidity.toString()};else delete m.active;
 save();
 if(mode==="recover"){
  assert(m.pending,"No pending submission to recover");const x=m.pending;
  const status=(await c.getSignatureStatuses([x.signature],{searchTransactionHistory:true})).value[0];
  if(status?.confirmationStatus==="finalized"){
   if(status.err){m.failures??=[];m.failures.push({...x,error:status.err,slot:status.slot});delete m.pending;save();console.log("Finalized failure recorded; inspect before retry",x.signature);return;}
   const t=await finalize(x.signature);m.records.push({label:x.label,signature:x.signature,explorer:"https://explorer.solana.com/tx/"+x.signature+"?cluster=devnet",slot:t.slot,before:x.before,after:(await c.getAccountInfo(p.swapConfig))?await bal():null,events:[],detail:x.detail,recovered:true});
   delete m.pending;save();console.log("Recovered finalized submission",x.signature);return;
  }
  if(!status&&await c.getBlockHeight("finalized")>x.lastValidBlockHeight){m.expired??=[];m.expired.push(x);delete m.pending;save();console.log("Expired unlanded submission cleared",x.signature);return;}
  throw Error("Submission still pending; do not replay "+x.signature);
 }
 async function accounts(nft:PublicKey,lower:number,upper:number){
  const q=await pool();const tick=(n:number)=>{const b=Buffer.alloc(4);b.writeInt32BE(Math.floor(n/(q.tickSpacing*60))*q.tickSpacing*60);return PublicKey.findProgramAddressSync([Buffer.from("tick_array"),POOL.toBuffer(),b],CLMM)[0];};
  return {vaultState:p.vaultState,swapConfig:p.swapConfig,positionState,poolState:POOL,admin:owner.publicKey,tokenA:p.vaultTokenAccount,tokenB:p.outputTokenAccount,
   tokenVault0:q.vaultA,tokenVault1:q.vaultB,mint0:q.mintA,mint1:q.mintB,nftMint:nft,nftAccount:getAssociatedTokenAddressSync(nft,p.vaultState,true),
   personalPosition:PublicKey.findProgramAddressSync([Buffer.from("position"),nft.toBuffer()],CLMM)[0],protocolPosition:CLMM,
   tickArrayLower:tick(lower),tickArrayUpper:tick(upper),metadataAccount:PublicKey.findProgramAddressSync([Buffer.from("metadata"),META.toBuffer(),nft.toBuffer()],META)[0],
   clmmProgram:CLMM,tokenProgram:TOKEN_PROGRAM_ID,tokenProgram2022:TOKEN_2022_PROGRAM_ID,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,metadataProgram:META,memoProgram:MEMO,systemProgram:SystemProgram.programId,rent:SYSVAR_RENT_PUBKEY};
 }
 async function reject(label:string,builder:any,signers:Keypair[]=[],expected?:string,fundAdmin?:Keypair){
  const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}));
  // Fund only the simulated admin when Anchor init constraints run before authorization.
  if(fundAdmin)tx.add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:fundAdmin.publicKey,lamports:10000000}));
  const ix=await builder.instruction();for(const key of ix.keys)if(signers.some(s=>s.publicKey.equals(key.pubkey)))key.isSigner=true;
  tx.add(ix);tx.feePayer=owner.publicKey;
  const sim=await c.simulateTransaction(tx,[owner,...signers]);assert(sim.value.err,label+" unexpectedly succeeded");
  const logs=sim.value.logs??[];if(expected)assert(logs.some(l=>l.includes(expected)),label+": "+logs.join("\n"));
  m.tests.push({label,kind:"RPC simulation",error:sim.value.err,expected,logs:logs.filter(l=>l.includes("Error")||l.includes("failed"))});save();console.log("PASS",label);
 }
 async function open(label:string,halfWidth:number){
  const q=await pool();const s=q.tickSpacing;const center=Math.floor(q.tickCurrent/s)*s;const lower=center-halfWidth*s,upper=center+halfWidth*s;
  const balances=await bal();const a0=q.mintA.equals(INPUT)?BigInt(balances.a):BigInt(balances.b);const a1=q.mintB.equals(OUTPUT)?BigInt(balances.b):BigInt(balances.a);
  const budget=20000000n;assert(a0>=budget&&a1>=budget,"Need at least 20 of each token in Vault");
  const liquidity=LiquidityMath.getLiquidityFromTokenAmounts(q.sqrtPriceX64,SqrtPriceMath.getSqrtPriceX64FromTick(lower),SqrtPriceMath.getSqrtPriceX64FromTick(upper),bn(budget),bn(budget));
  const nft=Keypair.generate();writeFileSync(".tools/"+label+"-keypair.json",json([...nft.secretKey]));
  const acc=await accounts(nft.publicKey,lower,upper);const method=(lo=lower,hi=upper,l=liquidity,max0=bn(budget),max1=bn(budget),over:any={})=>program.methods.openPosition(lo,hi,l,max0,max1).accountsStrict({...acc,...over}).remainingAccounts(remaining());
  const attacker=Keypair.generate();
  await reject(label+" non-admin",method(lower,upper,liquidity,bn(budget),bn(budget),{admin:attacker.publicKey}),[attacker],"Unauthorized",attacker);
  await reject(label+" invalid ticks",method(upper,lower),[nft],"InvalidTicks");
  await reject(label+" zero liquidity",method(lower,upper,bn(0)),[nft],"ZeroAmount");
  await reject(label+" maximum inputs",method(lower,upper,liquidity,bn(1),bn(1)),[nft],"PriceSlippageCheck");
  await reject(label+" wrong pool",method(lower,upper,liquidity,bn(budget),bn(budget),{poolState:CLMM}),[nft]);
  await reject(label+" incorrect NFT destination",method(lower,upper,liquidity,bn(budget),bn(budget),{nftAccount:getAssociatedTokenAddressSync(nft.publicKey,owner.publicKey)}),[nft]);
  const openIx=await method().instruction();for(const k of openIx.keys)if(k.pubkey.equals(nft.publicKey))k.isSigner=true;
  const r=await send(label,[openIx],[nft],{nft:nft.publicKey.toBase58(),lower,upper,liquidity:liquidity.toString(),max0:budget.toString(),max1:budget.toString(),tickBefore:q.tickCurrent,sqrtBefore:q.sqrtPriceX64.toString()});
  const position=await c.getAccountInfo(acc.personalPosition);assert(position?.owner.equals(CLMM));const decoded=PositionInfoLayout.decode(position.data);
  assert(decoded.liquidity.eq(liquidity));const custody=await getAccount(c,acc.nftAccount);assert(custody.owner.equals(p.vaultState)&&custody.amount===1n);
  m.active={nft:nft.publicKey.toBase58(),lower,upper,liquidity:liquidity.toString()};save();
  const next=Keypair.generate();const nextAcc=await accounts(next.publicKey,lower,upper);
  await reject(label+" duplicate",program.methods.openPosition(lower,upper,liquidity,bn(budget),bn(budget)).accountsStrict(nextAcc).remainingAccounts(remaining()),[next],"PositionActive");
  const userCard=p.userCard(owner.publicKey),userShareAccount=getAssociatedTokenAddressSync(p.shareMint,owner.publicKey);
  const legacy={vaultState:p.vaultState,userCard,vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,userTokenAccount:getAssociatedTokenAddressSync(INPUT,owner.publicKey),userShareAccount,user:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID};
  await reject(label+" deposits locked",program.methods.deposit(bn(1)).accounts(legacy),[],"StrategyActive");
  await reject(label+" withdrawals locked",program.methods.withdraw(bn(1)).accounts(legacy),[],"StrategyActive");
  return r;
 }
 async function collect(label:string){assert(m.active);const x=m.active;const acc=await accounts(new PublicKey(x.nft),x.lower,x.upper);
  const attacker=Keypair.generate();await reject(label+" non-admin",program.methods.collectPositionFees().accountsStrict({...acc,admin:attacker.publicKey}).remainingAccounts(remaining()),[attacker],"Unauthorized",attacker);
  await reject(label+" foreign NFT custody",program.methods.collectPositionFees().accountsStrict({...acc,nftAccount:getAssociatedTokenAddressSync(INPUT,owner.publicKey)}).remainingAccounts(remaining()),[],"InvalidPosition");
  const r=await send(label,[await program.methods.collectPositionFees().accountsStrict(acc).remainingAccounts(remaining()).instruction()]);
  assert(r.before&&r.after);const feesA=BigInt(r.after.a)-BigInt(r.before.a),feesB=BigInt(r.after.b)-BigInt(r.before.b);assert(feesA+feesB>0n,"No trading fees collected");return r;
 }
 async function close(label:string){assert(m.active);const x=m.active;const nft=new PublicKey(x.nft);const acc=await accounts(nft,x.lower,x.upper);const q=await pool();
  const amounts=LiquidityMath.getAmountsFromLiquidity(q.sqrtPriceX64,SqrtPriceMath.getSqrtPriceX64FromTick(x.lower),SqrtPriceMath.getSqrtPriceX64FromTick(x.upper),bn(x.liquidity),false);
  const min0=amounts.amountA.muln(99).divn(100),min1=amounts.amountB.muln(99).divn(100);assert(!min0.isZero()||!min1.isZero());
  const method=(a=min0,b=min1,over:any={})=>program.methods.closePosition(a,b).accountsStrict({...acc,...over}).remainingAccounts(remaining());
  const attacker=Keypair.generate();await reject(label+" non-admin",method(min0,min1,{admin:attacker.publicKey}),[attacker],"Unauthorized",attacker);
  await reject(label+" zero minima",method(bn(0),bn(0)),[],"InvalidMinimum");
  await reject(label+" excessive minima",method(bn("18446744073709551615"),bn("18446744073709551615")),[],"PriceSlippageCheck");
  await reject(label+" foreign position",method(min0,min1,{nftMint:INPUT,nftAccount:getAssociatedTokenAddressSync(INPUT,owner.publicKey),personalPosition:PublicKey.findProgramAddressSync([Buffer.from("position"),INPUT.toBuffer()],CLMM)[0]}),[],"InvalidPosition");
  const r=await send(label,[await method().instruction()],[],{...x,min0:min0.toString(),min1:min1.toString(),tick:q.tickCurrent,sqrt:q.sqrtPriceX64.toString()});
  assert.equal(await c.getAccountInfo(acc.personalPosition,"finalized"),null);assert.equal(await c.getAccountInfo(acc.nftAccount,"finalized"),null);assert.equal((await getMint(c,nft,"finalized")).supply,0n);
  delete m.active;save();await reject(label+" duplicate close",method(),[],"NoPosition");return r;
 }
 let trader:Keypair;const tf=".tools/trader-keypair.json";
 if(existsSync(tf))trader=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(tf,"utf8"))));else{trader=Keypair.generate();writeFileSync(tf,json([...trader.secretKey]));}
 m.trader=trader.publicKey.toBase58();save();
 async function swap(label:string,amount=1000000n,input=INPUT){
  const data=await raydium.clmm.getPoolInfoFromRpc(POOL.toBase58());const q=PoolUtils.computeAmountOut({poolInfo:data.computePoolInfo,tickArrayCache:data.tickData[POOL.toBase58()],baseMint:input,epochInfo:await c.getEpochInfo(),amountIn:bn(amount),slippage:0,catchLiquidityInsufficient:false});assert(q.allTrade);
  const zero=data.poolInfo.mintA.address===input.toBase58();const output=zero?new PublicKey(data.poolInfo.mintB.address):new PublicKey(data.poolInfo.mintA.address);
  const ix=ClmmInstrument.swapInstruction(CLMM,trader.publicKey,POOL,new PublicKey(data.poolInfo.config.id),getAssociatedTokenAddressSync(input,trader.publicKey),getAssociatedTokenAddressSync(output,trader.publicKey),zero?data.computePoolInfo.vaultA:data.computePoolInfo.vaultB,zero?data.computePoolInfo.vaultB:data.computePoolInfo.vaultA,input,output,q.remainingAccounts,data.computePoolInfo.observationId,bn(amount),q.amountOut.amount.muln(99).divn(100),bn(0),true,bitmap);
  return send(label,[ix],[trader],{trader:trader.publicKey.toBase58(),amount:amount.toString(),input:input.toBase58(),tickBefore:data.computePoolInfo.tickCurrent});
 }
 if(mode==="setup"){
  const done=(label:string)=>m.records.some((r:any)=>r.label===label);
  if(!done("initialize-vault"))await send("initialize-vault",[await program.methods.initializeVault().accounts({vaultState:p.vaultState,vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,tokenMint:INPUT,admin:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction()]);
  if(!done("initialize-swap"))await send("initialize-swap",[await program.methods.initializeSwap().accounts({vaultState:p.vaultState,swapConfig:p.swapConfig,outputTokenAccount:p.outputTokenAccount,outputMint:OUTPUT,poolState:POOL,clmmProgram:CLMM,admin:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction()]);
  // Fund the separate trader, then deposit A and acquire B through the Vault CPI.
  const ixs:TransactionInstruction[]=[SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:trader.publicKey,lamports:10000000})];
  for(const mint of [INPUT,OUTPUT]){
   const source=getAssociatedTokenAddressSync(mint,owner.publicKey),dest=getAssociatedTokenAddressSync(mint,trader.publicKey);
   ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,dest,trader.publicKey,mint),createTransferInstruction(source,dest,owner.publicKey,1000000000n));
  }
  if(!done("fund-trader"))await send("fund-trader",ixs);
  const userCard=p.userCard(owner.publicKey),userShareAccount=getAssociatedTokenAddressSync(p.shareMint,owner.publicKey);
  if(!done("deposit"))await send("deposit",[
   await program.methods.createUserCard().accounts({vaultState:p.vaultState,userCard,user:owner.publicKey,systemProgram:SystemProgram.programId}).instruction(),
   createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,userShareAccount,owner.publicKey,p.shareMint),
   await program.methods.deposit(bn(200000000)).accounts({vaultState:p.vaultState,userCard,vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,userTokenAccount:getAssociatedTokenAddressSync(INPUT,owner.publicKey),userShareAccount,user:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID}).instruction()
  ]);
  const q=await quote(raydium,bn(100000000));
  const aFirst=q.poolInfo.mintA.address===INPUT.toBase58();
  if(!done("prepare-vault-token-b"))await send("prepare-vault-token-b",[await program.methods.swapViaRaydium(bn(100000000),bn(q.minimum)).accountsStrict({
   vaultState:p.vaultState,swapConfig:p.swapConfig,poolState:POOL,inputTokenAccount:p.vaultTokenAccount,outputTokenAccount:p.outputTokenAccount,
   inputMint:INPUT,outputMint:OUTPUT,ammConfig:new PublicKey(q.poolInfo.config.id),observationState:q.computePoolInfo.observationId,
   inputVault:aFirst?q.computePoolInfo.vaultA:q.computePoolInfo.vaultB,outputVault:aFirst?q.computePoolInfo.vaultB:q.computePoolInfo.vaultA,
   admin:owner.publicKey,clmmProgram:CLMM,tokenProgram:TOKEN_PROGRAM_ID,tokenProgram2022:TOKEN_2022_PROGRAM_ID,memoProgram:MEMO
  }).remainingAccounts(q.quote.remainingAccounts.map(pubkey=>({pubkey,isWritable:true,isSigner:false}))).instruction()]);
 } else if(mode==="normal"){
  const done=(label:string)=>m.records.some((r:any)=>r.label===label);
  if(!done("normal-open"))await open("normal-open",10);
  if(!done("normal-swap-1"))await swap("normal-swap-1");
  if(!done("normal-swap-2"))await swap("normal-swap-2",1000000n,OUTPUT);
  if(!done("normal-swap-3"))await swap("normal-swap-3");
  if(!done("normal-collect"))await collect("normal-collect");
  if(!done("normal-close"))await close("normal-close");
 } else if(mode==="rebalance"){
  const done=(label:string)=>m.records.some((r:any)=>r.label===label);
  if(!done("rebalance-old-open"))await open("rebalance-old-open",1);
  if(!done("rebalance-old-close")){
  let outside=false;
  for(let i=0;i<12;i++){const q=await pool();const x=m.active;if(q.tickCurrent<x.lower||q.tickCurrent>=x.upper){m.outside={tick:q.tickCurrent,sqrt:q.sqrtPriceX64.toString(),lower:x.lower,upper:x.upper,observedAt:new Date().toISOString()};save();outside=true;break;}if(!done("rebalance-move-"+i))await swap("rebalance-move-"+i,20000000n);}
  assert(outside,"Price did not leave range within spending cap; inspect before more swaps");await close("rebalance-old-close");}
  if(!done("rebalance-new-open"))await open("rebalance-new-open",10);
 } else if(!m.records.some((r:any)=>r.label==="rebalance-new-close")){await close("rebalance-new-close");}
 console.log("Completed phase",mode);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
