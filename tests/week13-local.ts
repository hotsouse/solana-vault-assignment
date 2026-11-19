// Local-validator integration using public Devnet clones. These signatures are NOT Devnet evidence.
import {strict as assert} from "assert";
import {AnchorProvider,BN,Program,Idl} from "@coral-xyz/anchor";
import {PublicKey,Keypair,SystemProgram,SYSVAR_RENT_PUBKEY,Transaction,TransactionInstruction,ComputeBudgetProgram,sendAndConfirmTransaction} from "@solana/web3.js";
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createTransferInstruction,getAccount,getMint} from "@solana/spl-token";
import {Raydium,DEV_API_URLS,PoolInfoLayout,PositionInfoLayout,LiquidityMath,SqrtPriceMath,PoolUtils,ClmmInstrument} from "@raydium-io/raydium-sdk-v2";
import {readFileSync} from "fs";
import {pdas,POOL,CLMM,INPUT,OUTPUT} from "../scripts/common";
const suite=process.env.WEEK13_CLMM_LOCAL==="1"?describe:describe.skip;
suite("Week 13 actual Raydium CPI on local Devnet clones",function(){
 this.timeout(180000);
 let provider:AnchorProvider,program:Program,owner:Keypair,raydium:Raydium,p:ReturnType<typeof pdas>;
 let acc:any,nft:Keypair,lower:number,upper:number,liquidity:BN;
 const attacker=Keypair.generate(),trader=Keypair.generate();
 const META=new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),MEMO=new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
 const bitmap=PublicKey.findProgramAddressSync([Buffer.from("pool_tick_array_bitmap_extension"),POOL.toBuffer()],CLMM)[0];
 const remaining=[{pubkey:bitmap,isWritable:true,isSigner:false}];
 const bn=(x:string|number)=>new BN(x.toString());
 const pool=async()=>PoolInfoLayout.decode((await provider.connection.getAccountInfo(POOL))!.data);
 async function send(ixs:TransactionInstruction[],extra:Keypair[]=[]){for(const ix of ixs)for(const k of ix.keys)if(extra.some(s=>s.publicKey.equals(k.pubkey)))k.isSigner=true;return sendAndConfirmTransaction(provider.connection,new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),...ixs),[owner,...extra],{commitment:"confirmed"});}
 async function reject(builder:any,expected:string,extra:Keypair[]=[]){const ix=await builder.instruction();for(const k of ix.keys)if(extra.some(s=>s.publicKey.equals(k.pubkey)))k.isSigner=true;const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),ix);tx.feePayer=owner.publicKey;const r=await provider.connection.simulateTransaction(tx,[owner,...extra]);assert(r.value.err,"Unexpected success");assert((r.value.logs??[]).some(l=>l.includes(expected)),(r.value.logs??[]).join("\n"));}
 const open=(over:any={},lo=lower,hi=upper,l=liquidity,max0=bn(20000000),max1=bn(20000000))=>program.methods.openPosition(lo,hi,l,max0,max1).accountsStrict({...acc,...over}).remainingAccounts(remaining);
 const collect=(over:any={})=>program.methods.collectPositionFees().accountsStrict({...acc,...over}).remainingAccounts(remaining);
 const close=(a=bn(1),b=bn(1),over:any={})=>program.methods.closePosition(a,b).accountsStrict({...acc,...over}).remainingAccounts(remaining);
 before(async()=>{
  provider=AnchorProvider.env();assert(provider.connection.rpcEndpoint.startsWith("http://127.0.0.1:"),"Local fixture only");owner=(provider.wallet as any).payer;
  program=new Program(JSON.parse(readFileSync("target/idl/simple_vault.json","utf8")) as Idl,provider);assert.equal(program.programId.toBase58(),"8Fwjh2gQ9qAQFZ4jVPKPe8G6xEq2dQJatFDv4A6iw2Qa");p=pdas(program.programId);
  await send([await program.methods.initializeVault().accounts({vaultState:p.vaultState,vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,tokenMint:INPUT,admin:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction()]);
  await send([await program.methods.initializeSwap().accounts({vaultState:p.vaultState,swapConfig:p.swapConfig,outputTokenAccount:p.outputTokenAccount,outputMint:OUTPUT,poolState:POOL,clmmProgram:CLMM,admin:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId}).instruction()]);
  const ixs:TransactionInstruction[]=[SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:attacker.publicKey,lamports:100000000})];
  for(const mint of [INPUT,OUTPUT]){const src=getAssociatedTokenAddressSync(mint,owner.publicKey),dst=getAssociatedTokenAddressSync(mint,trader.publicKey);ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner.publicKey,dst,trader.publicKey,mint),createTransferInstruction(src,dst,owner.publicKey,1000000000n),createTransferInstruction(src,mint.equals(INPUT)?p.vaultTokenAccount:p.outputTokenAccount,owner.publicKey,100000000n));}
  await send(ixs);
  raydium=await Raydium.load({connection:provider.connection,owner,cluster:"devnet",disableFeatureCheck:true,disableLoadToken:true,urlConfigs:DEV_API_URLS});
  const q=await pool();lower=Math.floor(q.tickCurrent/q.tickSpacing)*q.tickSpacing-600;upper=lower+1200;
  liquidity=LiquidityMath.getLiquidityFromTokenAmounts(q.sqrtPriceX64,SqrtPriceMath.getSqrtPriceX64FromTick(lower),SqrtPriceMath.getSqrtPriceX64FromTick(upper),bn(20000000),bn(20000000));nft=Keypair.generate();
  const tick=(n:number)=>{const b=Buffer.alloc(4);b.writeInt32BE(Math.floor(n/(q.tickSpacing*60))*q.tickSpacing*60);return PublicKey.findProgramAddressSync([Buffer.from("tick_array"),POOL.toBuffer(),b],CLMM)[0];};
  acc={vaultState:p.vaultState,swapConfig:p.swapConfig,positionState:PublicKey.findProgramAddressSync([Buffer.from("position"),p.vaultState.toBuffer()],program.programId)[0],poolState:POOL,admin:owner.publicKey,tokenA:p.vaultTokenAccount,tokenB:p.outputTokenAccount,tokenVault0:q.vaultA,tokenVault1:q.vaultB,mint0:q.mintA,mint1:q.mintB,nftMint:nft.publicKey,nftAccount:getAssociatedTokenAddressSync(nft.publicKey,p.vaultState,true),personalPosition:PublicKey.findProgramAddressSync([Buffer.from("position"),nft.publicKey.toBuffer()],CLMM)[0],protocolPosition:CLMM,tickArrayLower:tick(lower),tickArrayUpper:tick(upper),metadataAccount:PublicKey.findProgramAddressSync([Buffer.from("metadata"),META.toBuffer(),nft.publicKey.toBuffer()],META)[0],clmmProgram:CLMM,tokenProgram:TOKEN_PROGRAM_ID,tokenProgram2022:TOKEN_2022_PROGRAM_ID,associatedTokenProgram:ASSOCIATED_TOKEN_PROGRAM_ID,metadataProgram:META,memoProgram:MEMO,systemProgram:SystemProgram.programId,rent:SYSVAR_RENT_PUBKEY};
 });
 it("rejects non-admin open",()=>reject(open({admin:attacker.publicKey}),"Unauthorized",[attacker]));
 it("rejects reversed and unaligned ticks",async()=>{await reject(open({},upper,lower),"InvalidTicks",[nft]);await reject(open({},lower+1,upper),"InvalidTicks",[nft]);});
 it("rejects zero liquidity",()=>reject(open({},lower,upper,bn(0)),"ZeroAmount",[nft]));
 it("enforces token maxima with genuine Raydium CPI",()=>reject(open({},lower,upper,liquidity,bn(1),bn(1)),"PriceSlippageCheck",[nft]));
 it("opens and funds atomically with Vault-owned NFT",async()=>{await send([await open().instruction()],[nft]);const n=await getAccount(provider.connection,acc.nftAccount);assert(n.owner.equals(p.vaultState)&&n.amount===1n);const pos=PositionInfoLayout.decode((await provider.connection.getAccountInfo(acc.personalPosition))!.data);assert(pos.liquidity.eq(liquidity));assert(pos.nftMint.equals(nft.publicKey));const state=await (program.account as any).vaultState.fetch(p.vaultState);assert(state.strategyActive);});
 it("rejects duplicate opening",()=>reject(open(),"PositionActive",[nft]));
 it("rejects non-admin collection and foreign NFT custody",async()=>{await reject(collect({admin:attacker.publicKey}),"Unauthorized",[attacker]);await reject(collect({nftAccount:getAssociatedTokenAddressSync(INPUT,owner.publicKey)}),"InvalidPosition");});
 it("accrues and collects actual trading fees without reducing liquidity",async()=>{
  for(const input of [INPUT,OUTPUT,INPUT]){
   const d=await raydium.clmm.getPoolInfoFromRpc(POOL.toBase58());const q=PoolUtils.computeAmountOut({poolInfo:d.computePoolInfo,tickArrayCache:d.tickData[POOL.toBase58()],baseMint:input,epochInfo:await provider.connection.getEpochInfo(),amountIn:bn(1000000),slippage:0,catchLiquidityInsufficient:false});const z=input.equals(INPUT),output=z?OUTPUT:INPUT;
   const ix=ClmmInstrument.swapInstruction(CLMM,trader.publicKey,POOL,new PublicKey(d.poolInfo.config.id),getAssociatedTokenAddressSync(input,trader.publicKey),getAssociatedTokenAddressSync(output,trader.publicKey),z?d.computePoolInfo.vaultA:d.computePoolInfo.vaultB,z?d.computePoolInfo.vaultB:d.computePoolInfo.vaultA,input,output,q.remainingAccounts,d.computePoolInfo.observationId,bn(1000000),q.amountOut.amount.muln(99).divn(100),bn(0),true,bitmap);await send([ix],[trader]);
  }
  const before=(await getAccount(provider.connection,p.vaultTokenAccount)).amount+(await getAccount(provider.connection,p.outputTokenAccount)).amount;
  await send([await collect().instruction()]);const after=(await getAccount(provider.connection,p.vaultTokenAccount)).amount+(await getAccount(provider.connection,p.outputTokenAccount)).amount;assert(after>before);
  const pos=PositionInfoLayout.decode((await provider.connection.getAccountInfo(acc.personalPosition))!.data);assert(pos.liquidity.eq(liquidity));
 });
 it("rejects non-admin close and invalid withdrawal minima",async()=>{await reject(close(bn(1),bn(1),{admin:attacker.publicKey}),"Unauthorized",[attacker]);await reject(close(bn(0),bn(0)),"InvalidMinimum");await reject(close(bn("18446744073709551615"),bn("18446744073709551615")),"PriceSlippageCheck");});
 it("withdraws all liquidity and burns/closes the actual position NFT",async()=>{const q=await pool();const amounts=LiquidityMath.getAmountsFromLiquidity(q.sqrtPriceX64,SqrtPriceMath.getSqrtPriceX64FromTick(lower),SqrtPriceMath.getSqrtPriceX64FromTick(upper),liquidity,false);await send([await close(amounts.amountA.muln(99).divn(100),amounts.amountB.muln(99).divn(100)).instruction()]);assert.equal(await provider.connection.getAccountInfo(acc.personalPosition),null);assert.equal(await provider.connection.getAccountInfo(acc.nftAccount),null);assert.equal((await getMint(provider.connection,nft.publicKey)).supply,0n);assert.equal((await (program.account as any).positionState.fetch(acc.positionState)).active,false);assert.equal((await (program.account as any).vaultState.fetch(p.vaultState)).strategyActive,true);});
 it("rejects repeated closure and collection",async()=>{await reject(close(),"NoPosition");await reject(collect(),"NoPosition");});
});
