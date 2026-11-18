import {strict as assert} from "assert";
import {BN} from "@coral-xyz/anchor";
import {ComputeBudgetProgram,PublicKey,Transaction} from "@solana/web3.js";
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAccount,getAssociatedTokenAddress} from "@solana/spl-token";
import {readFileSync} from "fs";
import {context,save,POOL,CLMM,INPUT,OUTPUT,pdas,vaultProgram,quote} from "./common";
async function main(){
 const {connection,owner,raydium}=await context();
 const program=vaultProgram(connection,owner);const p=pdas(program.programId);
 const report=JSON.parse(readFileSync("evidence/devnet-tests.json","utf8"));
 const record=(name:string,detail?:unknown)=>{
  const index=report.results.findIndex((r:any)=>r.name===name);
  const result={name,status:"passed",detail};
  if(index<0)report.results.push(result);else report.results[index]=result;
  report.passed=report.results.filter((r:any)=>r.status==="passed").length;
  report.failed=report.results.filter((r:any)=>r.status==="failed").length;
  save("devnet-tests.json",report);console.log("PASS",name);
 };
 const snapshot=async()=>{
  const [a,b,v,raw]=await Promise.all([
   getAccount(connection,p.vaultTokenAccount),getAccount(connection,p.outputTokenAccount),
   (program.account as any).vaultState.fetch(p.vaultState),
   connection.getMultipleAccountsInfo([p.vaultState,POOL,p.outputTokenAccount,p.vaultTokenAccount])]);
  return {input:a.amount.toString(),output:b.amount.toString(),totalTokens:v.totalTokens.toString(),
   totalShares:v.totalShares.toString(),accounts:raw.map(x=>x?.data.toString("base64"))};
 };
 const q=await quote(raydium,new BN("100000000"));
 const accounts={
  vaultState:p.vaultState,swapConfig:p.swapConfig,poolState:POOL,
  inputTokenAccount:p.vaultTokenAccount,outputTokenAccount:p.outputTokenAccount,
  inputMint:INPUT,outputMint:OUTPUT,ammConfig:new PublicKey(q.poolInfo.config.id),
  observationState:q.computePoolInfo.observationId,
  inputVault:INPUT.toBase58()===q.poolInfo.mintA.address?q.computePoolInfo.vaultA:q.computePoolInfo.vaultB,
  outputVault:INPUT.toBase58()===q.poolInfo.mintA.address?q.computePoolInfo.vaultB:q.computePoolInfo.vaultA,
  admin:owner.publicKey,clmmProgram:CLMM,tokenProgram:TOKEN_PROGRAM_ID,
  tokenProgram2022:TOKEN_2022_PROGRAM_ID,
  memoProgram:new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
 };
 const remaining=q.quote.remainingAccounts.map(pubkey=>({pubkey,isWritable:true,isSigner:false}));
 const before=await snapshot();
 const minimum=new BN("18446744073709551615");
 const ix=await program.methods.swapViaRaydium(new BN("100000000"),minimum)
  .accounts(accounts as any).remainingAccounts(remaining).instruction();
 const latest=await connection.getLatestBlockhash("confirmed");
 const tx=new Transaction({feePayer:owner.publicKey,recentBlockhash:latest.blockhash})
  .add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),ix);
 tx.sign(owner);
 const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:true,maxRetries:3});
 save("latest-rejected-transaction.json",{signature,minimumOut:minimum.toString(),before});
 try {await connection.confirmTransaction({signature,...latest},"confirmed");}
 catch(e){console.log("Expected confirmation rejection:",JSON.stringify(e));}
 let confirmed:Awaited<ReturnType<typeof connection.getTransaction>>=null;
 for(let i=0;i<10&&!confirmed;i++){
  confirmed=await connection.getTransaction(signature,{commitment:"confirmed",maxSupportedTransactionVersion:0});
  if(!confirmed)await new Promise(r=>setTimeout(r,1000));
 }
 assert(confirmed?.meta?.err,"Failed transaction must exist on-chain");
 assert(confirmed.meta.logMessages?.some(l=>l.includes("TooLittleOutputReceived")),JSON.stringify(confirmed.meta));
 record("impossible minimum rejected by Raydium on-chain",{signature,error:confirmed.meta.err});
 const after=await snapshot();assert.deepEqual(after,before);
 record("failed swap atomically preserves Vault and pool accounts");
 save("rejected-swap.json",{cluster:"devnet",signature,minimumOut:minimum.toString(),error:confirmed.meta.err,
  before,after,logs:confirmed.meta.logMessages,slot:confirmed.slot});
 const userAccounts={vaultState:p.vaultState,userCard:p.userCard(owner.publicKey),
  vaultTokenAccount:p.vaultTokenAccount,shareMint:p.shareMint,
  userTokenAccount:await getAssociatedTokenAddress(INPUT,owner.publicKey),
  userShareAccount:await getAssociatedTokenAddress(p.shareMint,owner.publicKey),user:owner.publicKey,tokenProgram:TOKEN_PROGRAM_ID};
 for(const method of ["deposit","withdraw"]){
  const simTx=new Transaction({feePayer:owner.publicKey}).add(await program.methods[method](new BN(1)).accounts(userAccounts as any).instruction());
  const sim=await connection.simulateTransaction(simTx,[owner]);
  assert(sim.value.err&&sim.value.logs?.some(l=>l.includes("StrategyActive")),JSON.stringify(sim.value));
  record(method==="deposit"?"single-token deposit cannot dilute a two-asset vault":"single-token withdraw cannot strand the second asset",
   {error:sim.value.err,logs:sim.value.logs});
 }
 report.executionCompleted=true;save("devnet-tests.json",report);
 assert.equal(report.failed,0);console.log("Completed Devnet checks:",report.passed,"passed,",report.failed,"failed");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
