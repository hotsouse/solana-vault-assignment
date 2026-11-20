import {strict as assert} from "assert";
import {BN,EventParser,Program,AnchorProvider,Wallet} from "@coral-xyz/anchor";
import {Connection,ComputeBudgetProgram,Keypair,PublicKey,SystemProgram,SYSVAR_RENT_PUBKEY,Transaction,TransactionInstruction} from "@solana/web3.js";
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,getAccount,getMint,createAssociatedTokenAccountIdempotentInstruction,createTransferInstruction,createBurnInstruction,unpackAccount,unpackMint} from "@solana/spl-token";
import {PoolInfoLayout,PositionInfoLayout,Raydium,DEV_API_URLS,LiquidityMath,SqrtPriceMath,PoolUtils,ClmmInstrument} from "@raydium-io/raydium-sdk-v2";
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync} from "fs";
import {context,pdas,vaultProgram,POOL,CLMM,INPUT,OUTPUT,quote} from "./common";
const PROGRAM="Cm1i9GJUXXvZPA1cDeZ62FjCsmz8w8LJXe91drJYWYx9";
const local=process.env.SETTLEMENT_LOCAL==="1";
const META=new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const MEMO=new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const localRoot=process.env.SETTLEMENT_LOCAL_DIR??".tools/settlement-local";
const file=local?localRoot+"/manifest.json":"evidence/week13/settlement/manifest.json";
const bn=(x:bigint|string|number)=>new BN(x.toString());
const json=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==="bigint"?v.toString():v,2)+"\n";
function normalize(v:any):any {if(BN.isBN(v))return v.toString();if(v instanceof PublicKey)return v.toBase58();if(Array.isArray(v))return v.map(normalize);if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,normalize(x)]));return v;}
async function localContext(){const url=process.env.ANCHOR_PROVIDER_URL??"";assert(url.startsWith("http://127.0.0.1:"));const connection=new Connection(url,"confirmed");const owner=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET??"/home/aigerim/.config/solana/id.json","utf8"))));const raydium=await Raydium.load({connection,owner,cluster:"devnet",disableFeatureCheck:true,disableLoadToken:true,urlConfigs:DEV_API_URLS});return {connection,owner,raydium};}
async function main(){
 const mode=process.argv[2];if(!["setup","normal","rebalance","cleanup","recover","settle","withdraw"].includes(mode))throw Error("Choose setup, normal, settle, withdraw, recover");
 const runtime=local?await localContext():await context();const {connection:c,owner,raydium}=runtime;
 const idl=JSON.parse(readFileSync("evidence/week13/settlement/program-idl.json","utf8"));assert.equal(idl.address,PROGRAM);
 const program=new Program(idl,new AnchorProvider(c,new Wallet(owner),{commitment:"confirmed"}));
 assert.equal(program.programId.toBase58(),PROGRAM,"Refusing any previous-week program");
 const info=await c.getAccountInfo(program.programId);assert(info?.executable,"Week 13 not deployed");
 const p=pdas(program.programId);mkdirSync(".tools",{recursive:true});
 mkdirSync(local?localRoot:"evidence/week13/settlement",{recursive:true});
 const userFile=".tools/settlement-user-keypair.json";let user:Keypair;
 if(existsSync(userFile))user=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(userFile,"utf8"))));else{user=Keypair.generate();writeFileSync(userFile,json([...user.secretKey]));}
 const m:any=existsSync(file)?JSON.parse(readFileSync(file,"utf8")):{schema:2,cluster:local?"local":"devnet",user:user.publicKey.toBase58(),program:PROGRAM,pool:POOL.toBase58(),vault:p.vaultState.toBase58(),admin:owner.publicKey.toBase58(),tokenA:INPUT.toBase58(),tokenB:OUTPUT.toBase58(),records:[],tests:[]};
 assert.equal(m.admin,owner.publicKey.toBase58());
 const save=()=>{writeFileSync(file+".tmp",json(m));renameSync(file+".tmp",file);};
 const pool=async()=>{const a=await c.getAccountInfo(POOL);assert(a?.owner.equals(CLMM));return PoolInfoLayout.decode(a.data);};
 const bal=async()=>{
  const userA=getAssociatedTokenAddressSync(INPUT,user.publicKey),userShares=getAssociatedTokenAddressSync(p.shareMint,user.publicKey);
  const keys=[p.vaultState,p.vaultTokenAccount,p.outputTokenAccount,p.shareMint,userA,userShares];const q=await c.getMultipleAccountsInfoAndContext(keys,"confirmed");
  const token=(i:number)=>q.value[i]?unpackAccount(keys[i],q.value[i]!).amount.toString():"0";
  const vault=q.value[0]?program.coder.accounts.decode("vaultState",q.value[0].data):null;
  return {a:token(1),b:token(2),shareSupply:q.value[3]?unpackMint(p.shareMint,q.value[3]).supply.toString():"0",userA:token(4),userShares:token(5),strategyActive:vault?.strategyActive,totalTokens:vault?.totalTokens.toString(),totalShares:vault?.totalShares.toString(),observationSlot:q.context.slot,existing:keys.map((_,i)=>!!q.value[i])};
 };
 async function finalize(sig:string){for(let i=0;i<90;i++){const t=await c.getTransaction(sig,{commitment:local?"confirmed":"finalized",maxSupportedTransactionVersion:0});if(t){assert.equal(t.meta?.err,null,JSON.stringify(t.meta));return t;}await new Promise(r=>setTimeout(r,1000));}throw Error("Finalization unavailable: "+sig);}
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
  const events=[...new EventParser(program.programId,program.coder).parseLogs(t.meta?.logMessages??[])].map(e=>({name:e.name,data:normalize(e.data)}));
  const record={label,signature:sig,explorer:local?null:"https://explorer.solana.com/tx/"+sig+"?cluster=devnet",slot:t.slot,before,after,events,detail};
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
 async function reject(label:string,builder:any,signers:Keypair[]=[],expected?:string,fundAdmin?:Keypair,prefix:TransactionInstruction[]=[]){
  const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}));
  // Fund only the simulated admin when Anchor init constraints run before authorization.
  if(fundAdmin)tx.add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:fundAdmin.publicKey,lamports:10000000}));
  const ix=await builder.instruction();for(const key of ix.keys)if(signers.some(s=>s.publicKey.equals(key.pubkey)))key.isSigner=true;
  tx.add(...prefix,ix);tx.feePayer=owner.publicKey;
  const sim=await c.simulateTransaction(tx,[owner,...signers]);assert(sim.value.err,label+" unexpectedly succeeded");
  const logs=sim.value.logs??[];if(expected)assert(logs.some(l=>l.includes(expected)),label+": "+logs.join("\n"));
  m.tests.push({label,kind:"RPC simulation",error:sim.value.err,expected,logs:logs.filter(l=>l.includes("Error")||l.includes("failed"))});save();console.log("PASS",label);
 }
 async function open(label:string,halfWidth:number){
  const q=await pool();const s=q.tickSpacing;const center=Math.floor(q.tickCurrent/s)*s;const lower=center-halfWidth*s,upper=center+halfWidth*s;
  const balances=await bal();const a0=q.mintA.equals(INPUT)?BigInt(balances.a):BigInt(balances.b);const a1=q.mintB.equals(OUTPUT)?BigInt(balances.b):BigInt(balances.a);
  const budget=20000000n;assert(a0>=budget&&a1>=budget,"Need at least 20 of each token in Vault");
  const liquidity=LiquidityMath.getLiquidityFromTokenAmounts(q.sqrtPriceX64,SqrtPriceMath.getSqrtPriceX64FromTick(lower),SqrtPriceMath.getSqrtPriceX64FromTick(upper),bn(budget),bn(budget));
  const nft=Keypair.generate();writeFileSync((local?localRoot+"/":".tools/settlement-")+label+"-keypair.json",json([...nft.secretKey]));
  const acc=await accounts(nft.publicKey,lower,upper);const method=(lo=lower,hi=upper,l=liquidity,max0=bn(budget),max1=bn(budget),over:any={})=>program.methods.openPosition(lo,hi,l,max0,max1).accountsStrict({...acc,...over}).remainingAccounts(remaining());
  const attacker=Keypair.generate();
  await reject(label+" non-admin",method(lower,upper,liquidity,bn(budget),bn(budget),{admin:attacker.publicKey}),[attacker],"Unauthorized",attacker);
  await reject(label+" invalid ticks",method(upper,lower),[nft],"InvalidTicks");
  await reject(label+" zero liquidity",method(lower,upper,bn(0)),[nft],"ZeroAmount");
  await reject(label+" maximum inputs",method(lower,upper,liquidity,bn(1),bn(1)),[nft],"PriceSlippageCheck");
  await reject(label+" wrong pool",method(lower,upper,liquidity,bn(budget),bn(budget),{poolState:CLMM}),[nft],"AccountOwnedByWrongProgram");
  await reject(label+" incorrect NFT destination",method(lower,upper,liquidity,bn(budget),bn(budget),{nftAccount:getAssociatedTokenAddressSync(nft.publicKey,owner.publicKey)}),[nft],"An account required by the instruction is missing");
  const openIx=await method().instruction();for(const k of openIx.keys)if(k.pubkey.equals(nft.publicKey))k.isSigner=true;
  const r=await send(label,[openIx],[nft],{nft:nft.publicKey.toBase58(),lower,upper,liquidity:liquidity.toString(),max0:budget.toString(),max1:budget.toString(),tickBefore:q.tickCurrent,sqrtBefore:q.sqrtPriceX64.toString()});
  const position=await c.getAccountInfo(acc.personalPosition);assert(position?.owner.equals(CLMM));const decoded=PositionInfoLayout.decode(position.data);
  assert(decoded.liquidity.eq(liquidity));const custody=await getAccount(c,acc.nftAccount);assert(custody.owner.equals(p.vaultState)&&custody.amount===1n);
  m.active={nft:nft.publicKey.toBase58(),lower,upper,liquidity:liquidity.toString()};save();
  const next=Keypair.generate();const nextAcc=await accounts(next.publicKey,lower,upper);
  await reject(label+" duplicate",program.methods.openPosition(lower,upper,liquidity,bn(budget),bn(budget)).accountsStrict(nextAcc).remainingAccounts(remaining()),[next],"PositionActive");
  const userCard=p.userCard(user.publicKey),userShareAccount=getAssociatedTokenAddressSync(p.shareMint,user.publicKey);
  const legacy={vaultState:p.vaultState,userCard,vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,userTokenAccount:getAssociatedTokenAddressSync(INPUT,user.publicKey),userShareAccount,user:user.publicKey,tokenProgram:TOKEN_PROGRAM_ID,strategyTokenAccount:p.outputTokenAccount};
  await reject(label+" deposits locked",program.methods.deposit(bn(1)).accounts(legacy),[user],"StrategyActive");
  await reject(label+" withdrawals locked",program.methods.withdraw(bn(1)).accounts(legacy),[user],"StrategyActive");
  await expectedReverseFailure(program.methods.withdraw(bn(1)).accounts(legacy),"withdraw-while-active","StrategyActive",[user]);
  await reject("settle active position",program.methods.settleStrategy().accountsStrict(settleAccounts(acc)),[],"PositionActive");
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
  assert.equal(await c.getAccountInfo(acc.personalPosition,local?"confirmed":"finalized"),null);assert.equal(await c.getAccountInfo(acc.nftAccount,local?"confirmed":"finalized"),null);assert.equal((await getMint(c,nft,local?"confirmed":"finalized")).supply,0n);
  delete m.active;save();await reject(label+" duplicate close",method(),[],"NoPosition");return r;
 }
 function settleAccounts(a:any){return {vaultState:a.vaultState,swapConfig:a.swapConfig,positionState:a.positionState,poolState:a.poolState,tokenA:a.tokenA,tokenB:a.tokenB,shareMint:p.shareMint,nftMint:a.nftMint,nftAccount:a.nftAccount,personalPosition:a.personalPosition,admin:owner.publicKey};}
 async function lastAccounts(){const rec=m.records.find((r:any)=>r.label==="normal-open");assert(rec);return accounts(new PublicKey(rec.detail.nft),rec.detail.lower,rec.detail.upper);}
 async function reverseBuilder(amount:BN,minimum:BN,over:any={}){
  const d=await raydium.clmm.getPoolInfoFromRpc(POOL.toBase58());const isA=d.poolInfo.mintA.address===INPUT.toBase58();
  const swapAccounts={vaultState:p.vaultState,swapConfig:p.swapConfig,poolState:POOL,inputTokenAccount:p.vaultTokenAccount,outputTokenAccount:p.outputTokenAccount,inputMint:INPUT,outputMint:OUTPUT,ammConfig:new PublicKey(d.poolInfo.config.id),observationState:d.computePoolInfo.observationId,inputVault:isA?d.computePoolInfo.vaultA:d.computePoolInfo.vaultB,outputVault:isA?d.computePoolInfo.vaultB:d.computePoolInfo.vaultA,admin:owner.publicKey,clmmProgram:CLMM,tokenProgram:TOKEN_PROGRAM_ID,tokenProgram2022:TOKEN_2022_PROGRAM_ID,memoProgram:MEMO,...over};
  const q=PoolUtils.computeAmountOut({poolInfo:d.computePoolInfo,tickArrayCache:d.tickData[POOL.toBase58()],baseMint:OUTPUT,epochInfo:await c.getEpochInfo(),amountIn:amount.lten(1)?bn(1000000):amount,slippage:0,catchLiquidityInsufficient:false});
  return {builder:program.methods.reverseSwapViaRaydium(amount,minimum).accountsStrict({swap:swapAccounts,positionState}).remainingAccounts(q.remainingAccounts.map(pubkey=>({pubkey,isWritable:true,isSigner:false}))),quote:q};
 }
 async function expectedReverseFailure(builder:any,label="reverse-slippage-failure",expected="TooLittleOutputReceived",extra:Keypair[]=[]){
  if((m.failures??[]).some((x:any)=>x.label===label))return;
  assert(!m.pending);const before=await bal(),tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),await builder.instruction());const block=await c.getLatestBlockhash();tx.feePayer=owner.publicKey;tx.recentBlockhash=block.blockhash;tx.sign(owner,...extra);const signature=require("bs58").encode(tx.signature);
  m.pending={label,signature,before,...block,expectedFailure:expected};save();await c.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});
  let t:any;for(let i=0;i<90;i++){t=await c.getTransaction(signature,{commitment:local?"confirmed":"finalized",maxSupportedTransactionVersion:0});if(t)break;await new Promise(r=>setTimeout(r,1000));}
  assert(t?.meta?.err);assert(t.meta.logMessages.some((l:string)=>l.includes(expected)));const after=await bal();
  for(const key of ["a","b","shareSupply","userShares","strategyActive","totalTokens","totalShares"])assert.equal(after[key as keyof typeof after],before[key as keyof typeof before]);
  m.failures??=[];m.failures.push({label,signature,slot:t.slot,explorer:local?null:"https://explorer.solana.com/tx/"+signature+"?cluster=devnet",expected,error:t.meta.err,before,after});delete m.pending;save();console.log(local?"PASS local expected failure":"PASS finalized expected failure",label,signature);
 }
 let trader:Keypair;const tf=".tools/settlement-trader-keypair.json";
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
  if(!done("fund-user"))await send("fund-user",[
   SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:user.publicKey,lamports:10000000}),
   createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,getAssociatedTokenAddressSync(INPUT,user.publicKey),user.publicKey,INPUT),
   createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,getAssociatedTokenAddressSync(p.shareMint,user.publicKey),user.publicKey,p.shareMint),
   createTransferInstruction(getAssociatedTokenAddressSync(INPUT,owner.publicKey),getAssociatedTokenAddressSync(INPUT,user.publicKey),owner.publicKey,200000000n)
  ]);
  const userCard=p.userCard(user.publicKey),userShareAccount=getAssociatedTokenAddressSync(p.shareMint,user.publicKey);
  if(!done("deposit"))await send("deposit",[
   await program.methods.createUserCard().accounts({vaultState:p.vaultState,userCard,user:user.publicKey,systemProgram:SystemProgram.programId}).instruction(),
   createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,userShareAccount,user.publicKey,p.shareMint),
   await program.methods.deposit(bn(200000000)).accounts({vaultState:p.vaultState,userCard,vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,userTokenAccount:getAssociatedTokenAddressSync(INPUT,user.publicKey),userShareAccount,user:user.publicKey,tokenProgram:TOKEN_PROGRAM_ID,strategyTokenAccount:p.outputTokenAccount}).instruction()
  ],[user]);
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
 } else if(mode==="settle"){
  const done=(label:string)=>m.records.some((r:any)=>r.label===label);const acc=await lastAccounts();const sa=settleAccounts(acc);const settle=(over:any={})=>program.methods.settleStrategy().accountsStrict({...sa,...over});
  if(!done("reverse-all-b")){
   const x=await bal();const amount=bn(x.b);assert(amount.gtn(1));
   await reject("settle non-admin",settle({admin:user.publicKey}),[user],"Unauthorized");
   await reject("settle residual B",settle(),[],"UnsettledTokenB");
   await reject("settle wrong pool",settle({poolState:CLMM}),[],"AccountOwnedByWrongProgram");
   await reject("settle wrong vault PDA",settle({vaultState:p.swapConfig}),[],"AccountDiscriminatorMismatch");
   await reject("reverse wrong mint",(await reverseBuilder(amount,bn(1),{inputMint:OUTPUT})).builder,[],"ConstraintTokenMint");
   await reject("reverse wrong token account",(await reverseBuilder(amount,bn(1),{inputTokenAccount:getAssociatedTokenAddressSync(INPUT,owner.publicKey)})).builder,[],"ConstraintSeeds");
   await reject("reverse zero amount",(await reverseBuilder(bn(0),bn(1))).builder,[],"ZeroAmount");
   await reject("reverse partial balance",(await reverseBuilder(amount.subn(1),bn(1))).builder,[],"IncompleteConversion");
   await reject("reverse zero minimum",(await reverseBuilder(amount,bn(0))).builder,[],"InvalidMinimum");
   const fail=(await reverseBuilder(amount,bn("18446744073709551615"))).builder;await reject("reverse slippage",fail,[],"TooLittleOutputReceived");await expectedReverseFailure(fail);
   const q=(await reverseBuilder(amount,bn(1))).quote;const minimum=q.amountOut.amount.muln(99).divn(100);const b=(await reverseBuilder(amount,minimum)).builder;
   await send("reverse-all-b",[await b.instruction()],[],{amount:amount.toString(),minimum:minimum.toString()});
  }
  if(!done("settle-strategy")){
   const userShares=getAssociatedTokenAddressSync(p.shareMint,user.publicKey);
   await reject("settle stale share accounting",settle(),[user],"ShareSupplyMismatch",undefined,[createBurnInstruction(userShares,p.shareMint,user.publicKey,1n)]);
   await send("settle-strategy",[await settle().instruction()]);
  }
  const x=await bal();assert.equal(x.b,"0");assert.equal(x.strategyActive,false);assert.equal(x.totalTokens,x.a);assert.equal(x.totalShares,x.shareSupply);
  await reject("repeated settlement",settle(),[],"AlreadySettled");
 } else if(mode==="withdraw"){
  const done=m.records.some((r:any)=>r.label==="user-withdraw");if(!done){
   const x=await bal();assert.equal(x.strategyActive,false);const amount=bn(x.userShares);assert(amount.gtn(0));
   const wa={vaultState:p.vaultState,userCard:p.userCard(user.publicKey),vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,userTokenAccount:getAssociatedTokenAddressSync(INPUT,user.publicKey),userShareAccount:getAssociatedTokenAddressSync(p.shareMint,user.publicKey),user:user.publicKey,tokenProgram:TOKEN_PROGRAM_ID,strategyTokenAccount:p.outputTokenAccount};
   const redeem=(n=amount,over:any={})=>program.methods.withdraw(n).accountsStrict({...wa,...over});
   await reject("withdraw exceeding shares",redeem(amount.addn(1)),[user],"InsufficientShares");
   await reject("withdraw invalid share account",redeem(amount,{userShareAccount:getAssociatedTokenAddressSync(INPUT,user.publicKey)}),[user],"ConstraintTokenMint");
   await reject("withdraw residual B after unlock",redeem(),[user],"UnsettledTokenB",undefined,[createTransferInstruction(getAssociatedTokenAddressSync(OUTPUT,owner.publicKey),p.outputTokenAccount,owner.publicKey,1n)]);
   await reject("withdraw stale asset accounting",redeem(),[user],"StaleAccounting",undefined,[createTransferInstruction(getAssociatedTokenAddressSync(INPUT,owner.publicKey),p.vaultTokenAccount,owner.publicKey,1n)]);
   if(BigInt(x.a)<BigInt(x.totalShares))await reject("withdraw rounds to zero",redeem(bn(1)),[user],"WithdrawTooSmall");
   const expected=BigInt(x.userShares)*BigInt(x.a)/BigInt(x.totalShares);await send("user-withdraw",[await redeem().instruction()],[user],{shares:x.userShares,expectedTokenA:expected.toString()});
   const after=await bal();assert.equal(BigInt(after.userA)-BigInt(x.userA),expected);assert.equal(after.a,"0");assert.equal(after.b,"0");assert.equal(after.shareSupply,"0");assert.equal(after.totalShares,"0");assert.equal(after.totalTokens,"0");assert.equal(after.userShares,"0");
  }
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
