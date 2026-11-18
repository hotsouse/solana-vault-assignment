/// <reference lib="es2019" />
/** Week 10: Devnet only. --simulate | --run | --verify (read-only, no wallet). */
import * as anchor from '@coral-xyz/anchor';
import * as spl from '@solana/spl-token';
import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, SystemProgram, ComputeBudgetProgram, TransactionInstruction } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { strict as assert } from 'assert';
const ROOT = path.resolve(__dirname, '..');
assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(ROOT), 'Run from project root');
const RPC = 'https://api.devnet.solana.com';
const PROGRAM = new PublicKey('EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu');
const WALLET = '3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7';
const AUTHORITY = '38afxYQhjGKgyoWEsKhAZ85xkdCj3z6bj3YU5RY74mR1';
const FILE = path.join(ROOT, 'evidence/week10-devnet.json');
const c = new Connection(RPC, { commitment: 'finalized', confirmTransactionInitialTimeout: 120000 });
const mode = process.argv[2];
assert(['--simulate', '--run', '--verify'].includes(mode), 'Choose --simulate, --run or --verify');
const idl = JSON.parse(fs.readFileSync(path.join(ROOT, mode === '--verify' ? 'evidence/week10-idl.json' : 'target/idl/simple_vault.json'), 'utf8'));
assert.equal(idl.address, PROGRAM.toBase58());
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pda = (seed: string, ...keys: PublicKey[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map(k => k.toBuffer())], PROGRAM)[0];
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const save = (e: any) => fs.writeFileSync(FILE, JSON.stringify(e, null, 2) + '\n', 'utf8');
const pk = (x: string) => new PublicKey(x);
let checks = 0;
function check(ok: boolean, label: string) { assert(ok, label); checks++; }
async function metadata() {
  assert.equal(await c.getGenesisHash(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  const info = await c.getParsedAccountInfo(PROGRAM);
  assert(info.value?.executable);
  const dataAddress = (info.value!.data as any).parsed.info.programData;
  const raw = (await c.getAccountInfo(pk(dataAddress)))!.data;
  const authority = raw[12] === 1 ? new PublicKey(raw.subarray(13,45)).toBase58() : null;
  assert.equal(authority, AUTHORITY);
  return { rpc: RPC, genesis: await c.getGenesisHash(), program: PROGRAM.toBase58(), programData: dataAddress,
    deploymentSlot: raw.readBigUInt64LE(4).toString(), upgradeAuthority: authority,
    deployedPayloadSha256: hash(raw.subarray(45)), idlSha256: hash(Buffer.from(JSON.stringify(idl))) };
}
function addresses(mint: PublicKey, user: PublicKey) {
  const vaultState = pda('vault', mint), shareMint = pda('share_mint', mint);
  return { vaultState, vaultTokenAccount: pda('vault_tokens', mint), shareMint,
    userCard: pda('user_card', vaultState, user), userTokenAccount: spl.getAssociatedTokenAddressSync(mint, user),
    userShareAccount: spl.getAssociatedTokenAddressSync(shareMint, user), user, tokenProgram: spl.TOKEN_PROGRAM_ID };
}
async function simulate(ixs: TransactionInstruction[], signers: Keypair[], feePayer: PublicKey, returnAccounts: PublicKey[] = []) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }), ...ixs);
  tx.feePayer = feePayer; tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  const v = new VersionedTransaction(tx.compileMessage()); v.sign(signers);
  return { kind: 'RPC simulation; never submitted', serializedBytes: v.serialize().length,
    response: await c.simulateTransaction(v, { commitment: 'finalized', sigVerify: true, innerInstructions: true,
      ...(returnAccounts.length ? { accounts: { encoding: 'base64' as const, addresses: returnAccounts.map(x=>x.toBase58()) } } : {}) }) };
}
function tokenCpi(tx: any) {
  return (tx.meta.innerInstructions || []).flatMap((g: any) => g.instructions.filter((i: any) =>
    i.programId.toBase58() === spl.TOKEN_PROGRAM_ID.toBase58() && i.parsed).map((i: any) => ({ outerIndex: g.index, stackHeight: i.stackHeight, ...i.parsed })));
}
async function finalized(sig: string) {
  for (let i=0;i<60;i++) {
    const status = (await c.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (status?.err) throw Error(JSON.stringify(status.err));
    if (status?.confirmationStatus === 'finalized') {
      const tx = await c.getParsedTransaction(sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
      if (tx) { assert.equal(tx.meta!.err, null); return { status, tx }; }
    }
    await new Promise(r => setTimeout(r,2000));
  }
  throw Error(`Finalization not confirmed: ${sig}`);
}
async function snapshot(p: any, accounts: any, label: string) {
  const names = ['vaultState','vaultTokenAccount','shareMint','A.token','A.share','A.card','B.token','B.share','B.card'];
  const keys = [accounts.vaultState,accounts.vaultTokenAccount,accounts.shareMint,
    accounts.A.userTokenAccount,accounts.A.userShareAccount,accounts.A.userCard,
    accounts.B.userTokenAccount,accounts.B.userShareAccount,accounts.B.userCard].map(pk);
  const result = await c.getMultipleAccountsInfoAndContext(keys, {commitment:'finalized'});
  const raw: any = Object.fromEntries(names.map((n,i)=>{assert(result.value[i],n);return [n,result.value[i]!.data.toString('base64')];}));
  const vault: any = p.coder.accounts.decode('vaultState', Buffer.from(raw.vaultState,'base64'));
  const card = (u: string) => { const x: any=p.coder.accounts.decode('userCard',Buffer.from(raw[u+'.card'],'base64')); return {deposited:x.deposited.toString(), shares:x.shares.toString(),owner:x.owner.toBase58(),vault:x.vault.toBase58()}; };
  const amount = (n: string) => spl.AccountLayout.decode(Buffer.from(raw[n],'base64')).amount.toString();
  return { label, slot:result.context.slot, commitment:'finalized', rawAccounts:raw,
    A:{tokens:amount('A.token'),shares:amount('A.share'),card:card('A')},B:{tokens:amount('B.token'),shares:amount('B.share'),card:card('B')},
    vaultTokens:amount('vaultTokenAccount'),shareSupply:spl.MintLayout.decode(Buffer.from(raw.shareMint,'base64')).supply.toString(),totalTokens:vault.totalTokens.toString(),totalShares:vault.totalShares.toString() };
}
function expectSnapshot(s: any, at: number, ash: number, bt: number, bsh: number, vault: number) {
  const unit = (n:number)=>String(n*1000000);
  for (const [got,want] of [[s.A.tokens,unit(at)],[s.A.shares,unit(ash)],[s.B.tokens,unit(bt)],[s.B.shares,unit(bsh)],
    [s.vaultTokens,unit(vault)],[s.shareSupply,unit(vault)],[s.totalTokens,unit(vault)],[s.totalShares,unit(vault)],
    [s.A.card.deposited,unit(ash)],[s.A.card.shares,unit(ash)],[s.B.card.deposited,unit(bsh)],[s.B.card.shares,unit(bsh)]]) check(got===want,`${s.label}: ${got} != ${want}`);
}
function proveWithdraw(tx: any, a: any) {
  const cpi = tokenCpi(tx), burn=cpi.find((i:any)=>i.type==='burn'),transfer=cpi.find((i:any)=>i.type==='transfer');
  check(cpi.length===2 && !!burn && !!transfer,'exact Burn + Transfer CPI');
  check(burn.outerIndex===transfer.outerIndex && burn.stackHeight===2 && transfer.stackHeight===2,'same outer instruction, stack 2');
  check(burn.info.authority===a.user && burn.info.account===a.userShareAccount && burn.info.mint===a.shareMint && burn.info.amount==='50000000','Burn accounts and amount');
  check(tx.transaction.message.accountKeys.some((k:any)=>k.pubkey.toBase58()===a.user && k.signer),'Burn authority is transaction signer');
  check(transfer.info.authority===a.vaultState && transfer.info.source===a.vaultTokenAccount && transfer.info.destination===a.userTokenAccount && transfer.info.amount==='50000000','Transfer PDA authority and amount');
  check(!tx.transaction.message.accountKeys.find((k:any)=>k.pubkey.toBase58()===a.vaultState).signer,'PDA is not a transaction signer; successful CPI implies invoke_signed');
  return cpi;
}
async function main() {
  const meta = await metadata();
  if (mode==='--verify') {
    const e=JSON.parse(fs.readFileSync(FILE,'utf8'));
    check(e.complete===true,'run complete'); check(meta.deployedPayloadSha256===e.metadata.deployedPayloadSha256,'deployed payload unchanged');
    check(meta.idlSha256===e.metadata.idlSha256,'IDL unchanged');
    const p=new anchor.Program(idl,{connection:c} as any);
    for(const u of ['A','B']) for(const [k,v] of Object.entries(addresses(pk(e.accounts.mint),pk(e.accounts[u].user)))) check((v as PublicKey).toBase58()===e.accounts[u][k],`PDA/account ${u}.${k}`);
    check(e.transactions.length===7 && e.snapshots.length===6 && e.negativeTests.length===7,'evidence counts');
    const expected=[[100,0,50,0,0],[0,100,50,0,100],[0,100,0,50,150],[50,50,0,50,100],[50,50,50,0,50],[100,0,50,0,0]];
    for(let i=0;i<e.snapshots.length;i++) {
      const s=e.snapshots[i];expectSnapshot(s,...expected[i] as [number,number,number,number,number]);
      const v:any=p.coder.accounts.decode('vaultState',Buffer.from(s.rawAccounts.vaultState,'base64'));
      check(v.totalTokens.toString()===s.totalTokens && v.totalShares.toString()===s.totalShares,'raw VaultState agrees');
      for(const u of ['A','B']) {
        const card:any=p.coder.accounts.decode('userCard',Buffer.from(s.rawAccounts[u+'.card'],'base64'));
        check(card.deposited.toString()===s[u].card.deposited && card.shares.toString()===s[u].card.shares && card.owner.toBase58()===e.accounts[u].user && card.vault.toBase58()===e.accounts.vaultState,'raw UserCard agrees');
      }
    }
    for(const item of e.transactions) {
      const {tx,status}=await finalized(item.signature); check(status.confirmationStatus==='finalized' && tx.meta!.err===null,item.label+' finalized');
      if(item.label.startsWith('withdraw')) {const proof=proveWithdraw(tx,e.accounts[item.user]);check(JSON.stringify(proof)===JSON.stringify(item.cpi),'CPI matches evidence');}
      check(JSON.stringify(tx.meta!.postTokenBalances)===JSON.stringify(item.transaction.meta.postTokenBalances),'historical token balances match RPC');
      check(JSON.stringify(tx.meta!.logMessages)===JSON.stringify(item.transaction.meta.logMessages),'historical logs match RPC');
      const snap=e.snapshots.find((s:any)=>s.label===item.label);
      if(snap) {
        for(const u of ['A','B']) for(const kind of ['tokens','shares']) {
          const address=e.accounts[u][kind==='tokens'?'userTokenAccount':'userShareAccount'];
          const balance=tx.meta!.postTokenBalances!.find((b:any)=>tx.transaction.message.accountKeys[b.accountIndex].pubkey.toBase58()===address);
          if(balance) check(balance.uiTokenAmount.amount===snap[u][kind],'historical balance agrees with snapshot');
        }
        check(tx.meta!.logMessages!.some((l:string)=>l.includes(`total_tokens=${snap.totalTokens}, total_shares=${snap.totalShares}`)),'historical VaultState totals agree');
      }
    }
    const live=await snapshot(p,e.accounts,'verify-current'); expectSnapshot(live,100,0,50,0,0);
    for(const n of e.negativeTests) check(n.response.value.err!==null && n.matchedExpectedError===true && n.stateUnchanged===true && new RegExp(n.expectedLogPattern).test(n.response.value.logs.join('\n')),n.label);
    check(e.compatibility.response.value.err===null,'compatibility simulation success');
    console.log(JSON.stringify({mode,checks,transactions:e.transactions.length,withdrawals:3,negativeSimulations:e.negativeTests.length,currentSlot:live.slot},null,2));return;
  }
  const payer=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.ANCHOR_WALLET || '/home/aigerim/.config/solana/id.json','utf8'))));
  assert.equal(payer.publicKey.toBase58(),WALLET);
  const p:any=new anchor.Program(idl,new anchor.AnchorProvider(c,new anchor.Wallet(payer),{commitment:'finalized'}));
  const mint=Keypair.generate(), sim=addresses(mint.publicKey,payer.publicKey);
  const init=(m:PublicKey,a:any)=>p.methods.initializeVault().accountsPartial({...a,tokenMint:m,admin:payer.publicKey,systemProgram:SystemProgram.programId}).instruction();
  const card=(a:any)=>p.methods.createUserCard().accountsPartial({...a,systemProgram:SystemProgram.programId}).instruction();
  const op=(name:string,n:number,a:any)=>p.methods[name](new anchor.BN(n)).accountsPartial(a).instruction();
  const mintSetup=[SystemProgram.createAccount({fromPubkey:payer.publicKey,newAccountPubkey:mint.publicKey,space:spl.MINT_SIZE,lamports:await c.getMinimumBalanceForRentExemption(spl.MINT_SIZE),programId:spl.TOKEN_PROGRAM_ID}),spl.createInitializeMintInstruction(mint.publicKey,6,payer.publicKey,null)];
  const atas=(a:any)=>[spl.createAssociatedTokenAccountInstruction(payer.publicKey,a.userTokenAccount,a.user,mint.publicKey),spl.createAssociatedTokenAccountInstruction(payer.publicKey,a.userShareAccount,a.user,a.shareMint)];
  const compatibility=await simulate([...mintSetup,await init(mint.publicKey,sim),await card(sim),...atas(sim),spl.createMintToInstruction(mint.publicKey,sim.userTokenAccount,payer.publicKey,100000000),await op('deposit',100000000,sim),await op('withdraw',50000000,sim)],[payer,mint],payer.publicKey,[sim.vaultState,sim.userCard,sim.shareMint,sim.vaultTokenAccount,sim.userTokenAccount,sim.userShareAccount]);
  fs.mkdirSync(path.join(ROOT,'evidence'),{recursive:true});
  if(fs.existsSync(FILE))throw Error('Evidence already exists; refusing overwrite or new spending');
  fs.writeFileSync(path.join(ROOT,'evidence/week10-idl.json'),JSON.stringify(idl,null,2)+'\n','utf8');
  const e:any={schemaVersion:1,createdAt:new Date().toISOString(),metadata:{...meta,localBinarySha256:hash(fs.readFileSync(path.join(ROOT,'target/deploy/simple_vault.so'))),binaryIdentityProven:false},compatibility,transactions:[],snapshots:[],negativeTests:[],complete:false};save(e);
  check(compatibility.response.value.err===null,'compatibility failed: stop before real transactions');
  const simCpi=compatibility.response.value.innerInstructions!.flatMap((x:any)=>x.instructions).filter((x:any)=>x.parsed?.type==='burn');check(simCpi.length===1,'compatibility Burn');
  console.log('Compatibility passed',compatibility.response.context.slot);
  if(mode==='--simulate')return;
  const A=Keypair.generate(),B=Keypair.generate(),C=Keypair.generate();
  const aa=addresses(mint.publicKey,A.publicKey),bb=addresses(mint.publicKey,B.publicKey),cc=addresses(mint.publicKey,C.publicKey);
  const strings=(a:any)=>Object.fromEntries(Object.entries(a).map(([k,v])=>[k,(v as PublicKey).toBase58()]));
  e.accounts={mint:mint.publicKey.toBase58(),vaultState:aa.vaultState.toBase58(),vaultTokenAccount:aa.vaultTokenAccount.toBase58(),shareMint:aa.shareMint.toBase58(),A:strings(aa),B:strings(bb),C:strings(cc)};save(e);
  async function send(label:string,ixs:TransactionInstruction[],signers:Keypair[]=[],user?:string) {
    const latest=await c.getLatestBlockhash();const tx=new Transaction({feePayer:payer.publicKey,...latest}).add(ComputeBudgetProgram.setComputeUnitLimit({units:600000}),...ixs);tx.sign(payer,...signers);
    const signature=await c.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:5});
    const item:any={label,user,signature,explorer:explorer(signature),submittedAt:new Date().toISOString()};e.transactions.push(item);save(e);
    const result=await finalized(signature);item.status=result.status;item.transaction=result.tx;
    if(label.startsWith('withdraw'))item.cpi=proveWithdraw(result.tx,e.accounts[user!]);save(e);console.log(label,signature,'finalized');
  }
  await send('setup-mint-vault',[...mintSetup,await init(mint.publicKey,aa)],[mint]);
  await send('setup-users',[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:A.publicKey,lamports:3000000}),SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:B.publicKey,lamports:3000000}),await card(aa),await card(bb),...atas(aa),...atas(bb),...atas(cc),spl.createMintToInstruction(mint.publicKey,aa.userTokenAccount,payer.publicKey,100000000),spl.createMintToInstruction(mint.publicKey,bb.userTokenAccount,payer.publicKey,50000000)],[A,B]);
  async function snap(label:string,nums:[number,number,number,number,number]){const s=await snapshot(p,e.accounts,label);e.snapshots.push(s);save(e);expectSnapshot(s,...nums);console.log('Balances verified',label);}
  await snap('initial',[100,0,50,0,0]);
  async function negative(label:string,n:number,a:any,signer:Keypair,pattern:RegExp){
    const before=await snapshot(p,e.accounts,'before-negative');
    const r:any=await simulate([await op('withdraw',n,a)],[payer,signer],payer.publicKey);
    const logs=(r.response.value.logs||[]).join('\n');r.label=label;r.expectedLogPattern=pattern.source;r.matchedExpectedError=r.response.value.err!==null&&pattern.test(logs);
    const after=await snapshot(p,e.accounts,'after-negative');r.stateUnchanged=JSON.stringify(before.rawAccounts)===JSON.stringify(after.rawAccounts);e.negativeTests.push(r);save(e);
    check(r.matchedExpectedError,label+' expected rejection');check(r.stateUnchanged,label+' unchanged RPC state');console.log('Negative simulation passed',label,JSON.stringify(r.response.value.err));
  }
  await negative('empty-vault',1000000,aa,A,/VaultEmpty|Vault has no outstanding shares/);
  await send('deposit-A',[await op('deposit',100000000,aa)],[A],'A');await snap('deposit-A',[0,100,50,0,100]);
  await send('deposit-B',[await op('deposit',50000000,bb)],[B],'B');await snap('deposit-B',[0,100,0,50,150]);
  await negative('withdraw-zero',0,aa,A,/ZeroAmount|Amount must be greater than zero/);
  await negative('insufficient-shares',100000001,aa,A,/insufficient funds|custom program error: 0x1/);
  await negative('missing-user-card',1000000,cc,C,/AccountNotInitialized|not initialized/);
  await negative('substituted-user-card',1000000,{...aa,userCard:bb.userCard},A,/ConstraintSeeds/);
  await negative('wrong-share-mint',1000000,{...aa,shareMint:mint.publicKey},A,/ConstraintSeeds/);
  await negative('wrong-token-account',1000000,{...aa,userTokenAccount:aa.userShareAccount},A,/ConstraintTokenMint/);
  await send('withdraw-A-half',[await op('withdraw',50000000,aa)],[A],'A');await snap('withdraw-A-half',[50,50,0,50,100]);
  await send('withdraw-B-all',[await op('withdraw',50000000,bb)],[B],'B');await snap('withdraw-B-all',[50,50,50,0,50]);
  await send('withdraw-A-final',[await op('withdraw',50000000,aa)],[A],'A');await snap('withdraw-A-final',[100,0,50,0,0]);
  e.complete=true;e.runChecks=checks;e.finishedAt=new Date().toISOString();e.walletFinalLamports=await c.getBalance(payer.publicKey);save(e);
  console.log(JSON.stringify({checks,transactions:e.transactions.length,negativeSimulations:e.negativeTests.length,complete:e.complete}));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});