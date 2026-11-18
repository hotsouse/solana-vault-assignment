import { strict as assert } from "assert";
import { BN, EventParser } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAccount,getMint,getAssociatedTokenAddress,getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import Decimal from "decimal.js";
import { context,save,POOL,CLMM,INPUT,OUTPUT,quote,pdas,vaultProgram } from "./common";
import { existsSync,readFileSync } from "fs";
const MEMO=new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
async function main(){
 const {connection,owner,raydium}=await context();
 async function confirmedTx(signature:string) {
  for(let i=0;i<10;i++) {
   const tx=await connection.getTransaction(signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});
   if(tx) return tx;
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new Error("Confirmed transaction is temporarily unavailable: "+signature);
 }
 const program=vaultProgram(connection,owner);
 const p=pdas(program.programId);const attacker=Keypair.generate();
 const results:{name:string,status:string,detail?:unknown}[]=[];
 const report=(name:string,detail?:unknown)=>{results.push({name,status:"passed",detail});console.log("PASS",name);save("devnet-tests.json",{passed:results.length,failed:0,results});};
 const check=async(name:string,fn:()=>Promise<unknown>)=>{
  try {report(name,await fn());} catch(e){results.push({name,status:"failed",detail:String(e)});save("devnet-tests.json",{passed:results.filter(r=>r.status==="passed").length,failed:1,results});throw e;}
 };
 const state=()=> (program.account as any).vaultState.fetch(p.vaultState);
 const accountBalances=async()=>{
  const [a,b]=await Promise.all([getAccount(connection,p.vaultTokenAccount),getAccount(connection,p.outputTokenAccount)]);
  const v=await state();
  const raw=await connection.getMultipleAccountsInfo([p.vaultState,POOL,p.outputTokenAccount,p.vaultTokenAccount]);
  return {input:a.amount.toString(),output:b.amount.toString(),totalTokens:v.totalTokens.toString(),
   totalShares:v.totalShares.toString(),accounts:raw.map(x=>x?.data.toString("base64"))};
 };
 const initAccounts={...p,tokenMint:INPUT,admin:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId};
 let initializeTx:string|undefined;
 await check("initialize vault",async()=>{
  if(!await connection.getAccountInfo(p.vaultState))
   initializeTx=await program.methods.initializeVault().accounts(initAccounts as any).rpc();
  const s=await state(); assert(s.admin.equals(owner.publicKey));assert(s.tokenMint.equals(INPUT));assert(s.shareMint.equals(p.shareMint));
  return {tx:initializeTx,vault:p.vaultState.toBase58()};
 });
 await check("first token account authority and mint",async()=>{
  const a=await getAccount(connection,p.vaultTokenAccount);assert(a.owner.equals(p.vaultState));assert(a.mint.equals(INPUT));
 });
 const initSwapAccounts={vaultState:p.vaultState,swapConfig:p.swapConfig,
  outputTokenAccount:p.outputTokenAccount,outputMint:OUTPUT,poolState:POOL,
  clmmProgram:CLMM,admin:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId};
 async function simulateReject(ix:any,errorName:string,extra:Keypair[]=[]){
  const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}));
  // Fund extra signers only inside simulation so init reaches the authorization constraint.
  for(const signer of extra) tx.add(SystemProgram.transfer({fromPubkey:owner.publicKey,toPubkey:signer.publicKey,lamports:10000000}));
  tx.add(await ix.instruction());
  tx.feePayer=owner.publicKey;
  const sim=await connection.simulateTransaction(tx,[owner,...extra]);
  assert(sim.value.err,"Transaction unexpectedly succeeded");
  assert((sim.value.logs??[]).some(l=>l.includes(errorName)),JSON.stringify(sim.value));
  return {error:sim.value.err,logs:sim.value.logs};
 }
 if(!await connection.getAccountInfo(p.swapConfig)){
  await check("only admin can initialize second storage",()=>simulateReject(
   program.methods.initializeSwap().accounts({...initSwapAccounts,admin:attacker.publicKey} as any),"Unauthorized",[attacker]));
  await check("second mint must match pool",()=>simulateReject(
   program.methods.initializeSwap().accounts({...initSwapAccounts,outputMint:INPUT} as any),"InvalidMint"));
 }
 await check("second token account controlled by Vault PDA",async()=>{
  let tx:string|undefined;
  if(!await connection.getAccountInfo(p.swapConfig)) tx=await program.methods.initializeSwap().accounts(initSwapAccounts as any).rpc();
  const a=await getAccount(connection,p.outputTokenAccount);assert(a.owner.equals(p.vaultState));assert(a.mint.equals(OUTPUT));
  const cfg=await (program.account as any).swapConfig.fetch(p.swapConfig);assert(cfg.pool.equals(POOL));
  return {tx,account:p.outputTokenAccount.toBase58()};
 });
 const beforeState=await state();
 if(!beforeState.strategyActive){
  const userCard=p.userCard(owner.publicKey);
  if(!await connection.getAccountInfo(userCard))
   await program.methods.createUserCard().accounts({vaultState:p.vaultState,userCard,user:owner.publicKey} as any).rpc();
  const userTokenAccount=await getAssociatedTokenAddress(INPUT,owner.publicKey);
  const userShareAccount=(await getOrCreateAssociatedTokenAccount(connection,owner,p.shareMint,owner.publicKey)).address;
  const accounts={vaultState:p.vaultState,userCard,vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,
   userTokenAccount,userShareAccount,user:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID};
  await check("deposit transfers A and mints PDA shares",async()=>{
   const a=(await getAccount(connection,p.vaultTokenAccount)).amount;
   const tx=await program.methods.deposit(new BN("1000000000")).accounts(accounts as any).rpc();
   assert.equal((await getAccount(connection,p.vaultTokenAccount)).amount-a,1000000000n);
   assert.equal((await getAccount(connection,userShareAccount)).amount.toString(),(await state()).totalShares.toString());
   return {tx};
  });
  await check("withdraw burns shares and transfers from PDA",async()=>{
   const a=(await getAccount(connection,p.vaultTokenAccount)).amount;
   const tx=await program.methods.withdraw(new BN("10000000")).accounts(accounts as any).rpc();
   assert.equal(a-(await getAccount(connection,p.vaultTokenAccount)).amount,10000000n);return {tx};
  });
 } else console.log("Existing rebalanced vault: deposit/withdraw setup is skipped; previous evidence is retained separately.");
 let q=await quote(raydium,new BN("100000000"));
 const baseAccounts=(data:typeof q)=>({
  vaultState:p.vaultState,swapConfig:p.swapConfig,poolState:POOL,
  inputTokenAccount:p.vaultTokenAccount,outputTokenAccount:p.outputTokenAccount,
  inputMint:INPUT,outputMint:OUTPUT,ammConfig:new PublicKey(data.poolInfo.config.id),
  observationState:data.computePoolInfo.observationId,
  inputVault:INPUT.toBase58()===data.poolInfo.mintA.address?data.computePoolInfo.vaultA:data.computePoolInfo.vaultB,
  outputVault:INPUT.toBase58()===data.poolInfo.mintA.address?data.computePoolInfo.vaultB:data.computePoolInfo.vaultA,
  admin:owner.publicKey,clmmProgram:CLMM,tokenProgram:TOKEN_PROGRAM_ID,
  tokenProgram2022:TOKEN_2022_PROGRAM_ID,memoProgram:MEMO,
 });
 const remaining=(data:typeof q)=>data.quote.remainingAccounts.map(pubkey=>({pubkey,isWritable:true,isSigner:false}));
 const swap=(amount:BN,min:BN,overrides:Record<string,PublicKey>={},data=q)=>
  program.methods.swapViaRaydium(amount,min).accounts({...baseAccounts(data),...overrides} as any).remainingAccounts(remaining(data));
 const amount=new BN("100000000"); const min=new BN(q.minimum.toString());
 await check("non-admin cannot swap even with minimum 1",()=>simulateReject(swap(amount,new BN(1),{admin:attacker.publicKey}),"Unauthorized",[attacker]));
 await check("zero amount is rejected",()=>simulateReject(swap(new BN(0),min),"ZeroAmount"));
 await check("zero minimum is rejected",()=>simulateReject(swap(amount,new BN(0)),"InvalidMinimum"));
 await check("insufficient input balance is rejected",()=>simulateReject(swap(new BN("18446744073709551615"),min),"InsufficientBalance"));
 await check("wrong input mint is rejected",()=>simulateReject(swap(amount,min,{inputMint:OUTPUT}),"ConstraintTokenMint"));
 await check("wrong output mint is rejected",()=>simulateReject(swap(amount,min,{outputMint:INPUT}),"ConstraintTokenMint"));
 await check("wrong Vault PDA is rejected",()=>simulateReject(swap(amount,min,{vaultState:p.swapConfig}),"AccountDiscriminatorMismatch"));
 await check("wrong token authority/account is rejected",async()=>simulateReject(swap(amount,min,{inputTokenAccount:await getAssociatedTokenAddress(INPUT,owner.publicKey)}),"ConstraintSeeds"));
 await check("wrong Raydium program is rejected",()=>simulateReject(swap(amount,min,{clmmProgram:SystemProgram.programId}),"InvalidProgramId"));
 await check("foreign pool is rejected",async()=>{
  const pools=await connection.getProgramAccounts(CLMM,{dataSlice:{offset:0,length:0},filters:[{dataSize:1544}]});
  const foreign=pools.find(a=>!a.pubkey.equals(POOL));assert(foreign,"Need an existing foreign Devnet pool");
  return simulateReject(swap(amount,min,{poolState:foreign.pubkey}),"InvalidPool");
 });
 await check("invalid tick array is rejected",()=>simulateReject(
  program.methods.swapViaRaydium(amount,min).accounts(baseAccounts(q) as any)
  .remainingAccounts([{pubkey:SystemProgram.programId,isWritable:true,isSigner:false}]),"InvalidTickArray"));
 // Refresh the RPC quote immediately before constructing the successful swap.
 q=await quote(raydium,amount);
 const before=await accountBalances();
 const priceBefore=new Decimal(q.computePoolInfo.sqrtPriceX64.toString()).div(new Decimal(2).pow(64)).pow(2)
  .mul(new Decimal(10).pow(q.poolInfo.mintA.decimals-q.poolInfo.mintB.decimals));
 const swapTx=await swap(amount,new BN(q.minimum.toString()),{},q)
  .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({units:600000})]).rpc();
 save("latest-swap-transaction.json",{signature:swapTx,program:program.programId.toBase58(),pool:POOL.toBase58()});
 const after=await accountBalances();
 const dataAfter=await raydium.clmm.getPoolInfoFromRpc(POOL.toBase58());
 const details=await confirmedTx(swapTx);
 assert(details?.meta && !details.meta.err,"Swap transaction not confirmed");
 const parser=new EventParser(program.programId,program.coder);
 const event=[...parser.parseLogs(details.meta.logMessages??[])].find(e=>e.name==="VaultSwap"||e.name==="vaultSwap");
 assert(event,"Vault swap event missing");
 const eventData=event.data as any;
 const logs=details.meta.logMessages??[];
 const priceAfter=new Decimal(dataAfter.computePoolInfo.sqrtPriceX64.toString()).div(new Decimal(2).pow(64)).pow(2)
  .mul(new Decimal(10).pow(q.poolInfo.mintA.decimals-q.poolInfo.mintB.decimals));
 await check("real Raydium CPI confirmed on Devnet",async()=>{
  assert(logs.some(l=>l.includes(CLMM.toBase58())&&l.includes("invoke [2]")));return {signature:swapTx};
 });
 await check("exact input A debited from Vault",async()=>assert.equal(BigInt(before.input)-BigInt(after.input),BigInt(amount.toString())));
 await check("output B credited above minimum",async()=>assert(BigInt(after.output)-BigInt(before.output)>=q.minimum));
 await check("PDA signer accepted by Raydium/SPL",async()=>{
  assert.equal(eventData.vault.toBase58(),p.vaultState.toBase58());
  assert.equal(eventData.amountIn.toString(),amount.toString());
 });
 await check("pool price changed inside this swap",async()=>{
  assert.notEqual(eventData.sqrtPriceBefore.toString(),eventData.sqrtPriceAfter.toString());
  assert.equal(eventData.sqrtPriceBefore.toString(),q.computePoolInfo.sqrtPriceX64.toString());
  assert.equal(eventData.sqrtPriceAfter.toString(),dataAfter.computePoolInfo.sqrtPriceX64.toString());
 });
 const success={cluster:"devnet",program:program.programId.toBase58(),vault:p.vaultState.toBase58(),
 pool:POOL.toBase58(),inputMint:INPUT.toBase58(),outputMint:OUTPUT.toBase58(),amountIn:amount.toString(),
 expectedOut:q.expected.toString(),minimumOut:q.minimum.toString(),amountOut:(BigInt(after.output)-BigInt(before.output)).toString(),
 slippageBps:100,signature:swapTx,slot:details.slot,before,after,
 sqrtBefore:eventData.sqrtPriceBefore.toString(),sqrtAfter:eventData.sqrtPriceAfter.toString(),
 priceDirection:"pool mint B per pool mint A",priceBefore:priceBefore.toString(),priceAfter:priceAfter.toString(),
 priceChange:priceAfter.minus(priceBefore).toString(),priceChangePercent:priceAfter.div(priceBefore).minus(1).mul(100).toString(),
 event:JSON.parse(JSON.stringify(eventData)),logs};
 save("successful-swap.json",success);
 // This failure is deliberately broadcast so the Explorer link refers to a real failed transaction.
 const failQuote=await quote(raydium,amount);
 const beforeFail=await accountBalances();
 const impossible=new BN("18446744073709551615");
 const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),
  await swap(amount,impossible,{},failQuote).instruction());
 const latest=await connection.getLatestBlockhash("confirmed");
 tx.feePayer=owner.publicKey;tx.recentBlockhash=latest.blockhash;tx.sign(owner);
 const failedSignature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});
 save("latest-rejected-transaction.json",{signature:failedSignature,minimumOut:impossible.toString(),before:beforeFail});
 try { await connection.confirmTransaction({signature:failedSignature,...latest},"confirmed"); }
 catch(e) { console.log("Expected rejection; verifying on-chain metadata:",JSON.stringify(e)); }
 const failedDetails=await confirmedTx(failedSignature);
 const failedResult={value:{err:failedDetails.meta?.err??null}};
 await check("impossible minimum rejected by Raydium on-chain",async()=>{
  assert(failedResult.value.err);assert(failedDetails?.meta?.logMessages?.some(l=>l.includes("TooLittleOutputReceived")));
  return {signature:failedSignature,error:failedResult.value.err};
 });
 const afterFail=await accountBalances();
 await check("failed swap atomically preserves Vault and pool accounts",async()=>assert.deepEqual(afterFail,beforeFail));
 save("rejected-swap.json",{cluster:"devnet",signature:failedSignature,minimumOut:impossible.toString(),
 error:failedResult.value.err,before:beforeFail,after:afterFail,logs:failedDetails?.meta?.logMessages,slot:failedDetails?.slot});
 const userCard=p.userCard(owner.publicKey);
 const accounts={vaultState:p.vaultState,userCard,vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,
  userTokenAccount:await getAssociatedTokenAddress(INPUT,owner.publicKey),
  userShareAccount:await getAssociatedTokenAddress(p.shareMint,owner.publicKey),user:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID};
 await check("single-token deposit cannot dilute a two-asset vault",()=>simulateReject(program.methods.deposit(new BN(1)).accounts(accounts as any),"StrategyActive"));
 await check("single-token withdraw cannot strand the second asset",()=>simulateReject(program.methods.withdraw(new BN(1)).accounts(accounts as any),"StrategyActive"));
 console.log("Devnet tests:",results.length,"passed, 0 failed");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
