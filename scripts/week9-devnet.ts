/**
 * Week 9 Devnet only. No deploy, upgrade, local validator or persisted private keys.
 * Run from repository root in WSL: node -r ts-node/register scripts/week9-devnet.ts
 * Existing successful evidence is never overwritten. Use --verify for read-only RPC verification.
 */
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFileSync } from "child_process";
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, Transaction, TransactionMessage,
  VersionedTransaction, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import { strict as assert } from "assert";

const RPC = "https://api.devnet.solana.com";
const PROGRAM = new PublicKey("EbojNUfh9Jk6dyZaaQAJWofbdnkvdxfQbeAPq6iWoHAu");
const WALLET = "3jiQ6pVz6xZ4VqmDho41aPUgXFQns5KeorWyEgb3Qdq7";
const AUTHORITY = "38afxYQhjGKgyoWEsKhAZ85xkdCj3z6bj3YU5RY74mR1";
const OUT = path.resolve("evidence/week9-devnet.json");
const idlPath = path.resolve("evidence/week9-idl.json");
const hash = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const link = (sig: string) => "https://explorer.solana.com/tx/" + sig + "?cluster=devnet";
const conn = new Connection(RPC, "finalized");
const checks: {name: string; passed: boolean}[] = [];
const evidence: any = { schemaVersion: 1, status: "in_progress", cluster: "devnet", rpc: RPC,
  startedAt: new Date().toISOString(), programId: PROGRAM.toBase58(), payer: WALLET,
  decimals: 6, amountsAre: "Raw integer base units; divide by 1000000 for tokens/shares",
  transactions: [], checks };
function fromEntries(entries: [string, any][]): any { const result: any = {}; for (const [key, value] of entries) result[key] = value; return result; }
function check(name: string, condition: boolean) {
  assert.ok(condition, name); checks.push({name, passed: true}); console.log("PASS " + name);
}
function save() {
  evidence.passedChecks = checks.length;
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n", "utf8");
}
async function txRecord(signature: string) {
  const status = (await conn.getSignatureStatuses([signature], {searchTransactionHistory: true})).value[0];
  assert.ok(status && status.confirmationStatus === "finalized" && status.err === null, "RPC finalized status");
  const tx = await conn.getTransaction(signature, {commitment: "finalized", maxSupportedTransactionVersion: 0});
  assert.ok(tx && tx.meta && tx.meta.err === null, "RPC transaction meta.err");
  return {signature, explorer: link(signature), slot: tx.slot, blockTime: tx.blockTime,
    confirmationStatus: status.confirmationStatus, err: tx.meta.err, feeLamports: tx.meta.fee,
    logs: tx.meta.logMessages, preTokenBalances: tx.meta.preTokenBalances, postTokenBalances: tx.meta.postTokenBalances};
}
async function programInfo() {
  const account = await conn.getAccountInfo(PROGRAM);
  assert.ok(account && account.executable && account.owner.toBase58() === "BPFLoaderUpgradeab1e11111111111111111111111");
  const address = new PublicKey(account.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(address);
  assert.ok(pd && pd.data.readUInt32LE(0) === 3 && pd.data[12] === 1);
  return {programData: address.toBase58(), upgradeAuthority: new PublicKey(pd.data.subarray(13,45)).toBase58(),
    deployedSlot: pd.data.readBigUInt64LE(4).toString(), executableBytes: pd.data.length - 45,
    executableSha256: hash(pd.data.subarray(45))};
}
async function main() {
  assert.equal(execFileSync("git", ["branch", "--show-current"], {encoding:"utf8"}).trim(), "week-9-submission");
  assert.equal(await conn.getGenesisHash(), "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
  if (process.argv.includes("--verify")) {
    const e = JSON.parse(fs.readFileSync(OUT, "utf8"));
    assert.equal(e.status, "completed");
    assert.equal((await programInfo()).executableSha256, e.compatibility.deployed.executableSha256);
    for (const tx of e.transactions) await txRecord(tx.signature);
    const names = ["vaultState", "vaultTokenAccount", "shareMint", "userCardA", "userCardB", "tokenAccountA", "tokenAccountB", "shareAccountA", "shareAccountB"];
    const accounts = await conn.getMultipleAccountsInfo(names.map(n => new PublicKey(e.addresses[n])));
    for (let i=0;i<names.length;i++) {
      assert.ok(accounts[i], names[i]);
      assert.equal(accounts[i]!.data.toString("base64"), e.finalAccountData[names[i]], names[i] + " unchanged");
    }
    console.log("Verified " + e.transactions.length + " finalized transactions and 9 final account states via Devnet RPC");
    return;
  }
  assert.ok(!fs.existsSync(OUT), "Evidence exists; use --verify instead of overwriting");
  // The authorized existing key is read only in WSL and is never printed or copied.
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/home/aigerim/.config/solana/id.json", "utf8"))));
  assert.equal(admin.publicKey.toBase58(), WALLET);
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  assert.equal(idl.address, PROGRAM.toBase58());
  const localIdl = JSON.parse(fs.readFileSync("target/idl/simple_vault.json", "utf8"));
  assert.deepEqual(idl, localIdl);
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(admin), {commitment: "finalized", preflightCommitment: "confirmed"});
  const program: any = new anchor.Program(idl, provider);
  const deployed = await programInfo();
  check("Expected upgrade authority", deployed.upgradeAuthority === AUTHORITY);
  evidence.compatibility = {deployed, idlSha256: hash(fs.readFileSync(idlPath)),
    localBinarySha256: hash(fs.readFileSync("target/deploy/simple_vault.so")),
    scope: "Behavioral compatibility of Week 9 instructions, PDA seeds and decoded account layouts; binary identity is NOT claimed. Devnet also contains Withdraw. Published IDL account is absent."};
  const mint = Keypair.generate(), userA = Keypair.generate(), userB = Keypair.generate();
  const pda = (seed: string, ...keys: PublicKey[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys.map(k=>k.toBuffer())],PROGRAM)[0];
  const vault = pda("vault",mint.publicKey), vt = pda("vault_tokens",mint.publicKey), sm = pda("share_mint",mint.publicKey);
  const card = (u: PublicKey) => pda("user_card",vault,u);
  const token = (u: PublicKey) => spl.getAssociatedTokenAddressSync(mint.publicKey,u);
  const shares = (u: PublicKey) => spl.getAssociatedTokenAddressSync(sm,u);
  const initialize = () => program.methods.initializeVault().accountsStrict({vaultState:vault,vaultTokenAccount:vt,shareMint:sm,tokenMint:mint.publicKey,admin:admin.publicKey,tokenProgram:spl.TOKEN_PROGRAM_ID,systemProgram:SystemProgram.programId,rent:SYSVAR_RENT_PUBKEY}).instruction();
  const createCard = (u: PublicKey) => program.methods.createUserCard().accountsStrict({vaultState:vault,userCard:card(u),user:u,systemProgram:SystemProgram.programId}).instruction();
  const deposit = (u: PublicKey, amount: number) => program.methods.deposit(new anchor.BN(amount)).accountsStrict({vaultState:vault,userCard:card(u),vaultTokenAccount:vt,shareMint:sm,userTokenAccount:token(u),userShareAccount:shares(u),user:u,tokenProgram:spl.TOKEN_PROGRAM_ID}).instruction();
  const createMint = SystemProgram.createAccount({fromPubkey:admin.publicKey,newAccountPubkey:mint.publicKey,lamports:await conn.getMinimumBalanceForRentExemption(spl.MINT_SIZE),space:spl.MINT_SIZE,programId:spl.TOKEN_PROGRAM_ID});
  const initMint = spl.createInitializeMint2Instruction(mint.publicKey,6,admin.publicKey,null);
  const atas = (u: PublicKey) => [spl.createAssociatedTokenAccountInstruction(admin.publicKey,token(u),u,mint.publicKey),spl.createAssociatedTokenAccountInstruction(admin.publicKey,shares(u),u,sm)];
  const simulate = async (instructions: any[], addresses: PublicKey[] = []) => {
    const latest = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({payerKey:admin.publicKey,recentBlockhash:latest.blockhash,instructions}).compileToV0Message());
    return (await conn.simulateTransaction(tx,{sigVerify:false,accounts:{encoding:"base64",addresses:addresses.map(k=>k.toBase58())}})).value;
  };
  // Entire setup + deposit is simulated without broadcasting, before any state changes.
  const probeSetup = [ComputeBudgetProgram.setComputeUnitLimit({units:1000000}),createMint,initMint,
    await initialize(),await createCard(admin.publicKey),...atas(admin.publicKey),
    spl.createMintToInstruction(mint.publicKey,token(admin.publicKey),admin.publicKey,100000000)];
  const probe = await simulate([...probeSetup,await deposit(admin.publicKey,100000000)],[vault,card(admin.publicKey)]);
  evidence.compatibility.positiveSimulation = probe;
  check("Full IDL setup and positive deposit simulation", probe.err === null);
  const vd = Buffer.from(probe.accounts![0]!.data[0],"base64"), cd = Buffer.from(probe.accounts![1]!.data[0],"base64");
  const dv: any = program.coder.accounts.decode("vaultState",vd), dc: any = program.coder.accounts.decode("userCard",cd);
  check("VaultState layout and simulated totals", vd.length === 153 && dv.totalTokens.toString() === "100000000" && dv.totalShares.toString() === "100000000" && dv.tokenMint.equals(mint.publicKey));
  check("UserCard layout and simulated totals", cd.length === 89 && dc.deposited.toString() === "100000000" && dc.shares.toString() === "100000000" && dc.owner.equals(admin.publicKey));
  const zeroProbe = await simulate([...probeSetup,await deposit(admin.publicKey,0)]);
  evidence.compatibility.zeroSimulation = zeroProbe;
  check("IDL ZeroAmount error 6000 in preflight simulation", JSON.stringify(zeroProbe.err) === JSON.stringify({InstructionError:[probeSetup.length,{Custom:6000}]}));
  check("Payer has sufficient Devnet SOL", await conn.getBalance(admin.publicKey) > 100000000);
  evidence.addresses = fromEntries(Object.entries({tokenMint:mint.publicKey,vaultState:vault,vaultTokenAccount:vt,shareMint:sm,userA:userA.publicKey,userB:userB.publicKey,userCardA:card(userA.publicKey),userCardB:card(userB.publicKey),tokenAccountA:token(userA.publicKey),tokenAccountB:token(userB.publicKey),shareAccountA:shares(userA.publicKey),shareAccountB:shares(userB.publicKey)}).map(([k,v])=>[k,v.toBase58()]));
  evidence.payerLamportsBefore = await conn.getBalance(admin.publicKey);
  save();
  async function send(label: string, instructions: any[], extra: Keypair[] = []) {
    assert.equal((await programInfo()).executableSha256,deployed.executableSha256,"Program changed; STOP");
    const latest = await conn.getLatestBlockhash();
    const tx = new Transaction({feePayer:admin.publicKey,...latest}).add(...instructions);
    tx.sign(admin,...extra);
    const signature = await conn.sendRawTransaction(tx.serialize(),{skipPreflight:false,preflightCommitment:"confirmed"});
    evidence.pendingTransaction = {label,signature,explorer:link(signature)}; save();
    const confirmed = await conn.confirmTransaction({...latest,signature},"finalized");
    assert.equal(confirmed.value.err,null);
    const record = await txRecord(signature);
    evidence.transactions.push({label,...record}); delete evidence.pendingTransaction;
    check(label + " finalized, RPC status and meta.err null", true); save();
    return record;
  }
  await send("create_mint",[createMint,initMint],[mint]);
  await send("initialize_vault",[await initialize()]);
  // Admin pays transaction fee; each new user pays only UserCard rent from a small transfer.
  await send("fund_users",[SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:userA.publicKey,lamports:3000000}),SystemProgram.transfer({fromPubkey:admin.publicKey,toPubkey:userB.publicKey,lamports:3000000})]);
  for (const [label,u] of [["A",userA],["B",userB]] as [string,Keypair][]) {
    await send("create_card_" + label,[await createCard(u.publicKey)],[u]);
    await send("prepare_tokens_" + label,[...atas(u.publicKey),spl.createMintToInstruction(mint.publicKey,token(u.publicKey),admin.publicKey,1000000000)]);
  }
  async function snapshot() {
    const addresses = [vault,vt,sm,card(userA.publicKey),card(userB.publicKey),token(userA.publicKey),token(userB.publicKey),shares(userA.publicKey),shares(userB.publicKey)];
    const r = await conn.getMultipleAccountsInfoAndContext(addresses,"finalized");
    const data = r.value.map(x=>{assert.ok(x);return x!;});
    const v: any = program.coder.accounts.decode("vaultState",data[0].data);
    const ca: any = program.coder.accounts.decode("userCard",data[3].data);
    const cb: any = program.coder.accounts.decode("userCard",data[4].data);
    check("Snapshot slot " + r.context.slot + ": account owners, layout and links",
      data[0].owner.equals(PROGRAM) && data[3].owner.equals(PROGRAM) && data[4].owner.equals(PROGRAM) &&
      data[0].data.length===153 && data[3].data.length===89 && data[4].data.length===89 &&
      v.admin.equals(admin.publicKey) && v.tokenMint.equals(mint.publicKey) && v.vaultTokenAccount.equals(vt) && v.shareMint.equals(sm) &&
      ca.owner.equals(userA.publicKey) && cb.owner.equals(userB.publicKey) && ca.vault.equals(vault) && cb.vault.equals(vault));
    const amounts = [1,5,6,7,8].map(i=>spl.unpackAccount(addresses[i],data[i]).amount.toString());
    const shareMint = spl.unpackMint(sm,data[2]);
    const tokenMint = await spl.getMint(conn,mint.publicKey,"finalized");
    check("Snapshot slot " + r.context.slot + ": mint decimals and authority",shareMint.decimals===6 && tokenMint.decimals===6 && shareMint.mintAuthority!.equals(vault));
    return {slot:r.context.slot,userTokensA:amounts[1],userTokensB:amounts[2],vaultTokens:amounts[0],
      userSharesA:amounts[3],userSharesB:amounts[4],shareSupply:shareMint.supply.toString(),
      totalTokens:v.totalTokens.toString(),totalShares:v.totalShares.toString(),
      cardA:{deposited:ca.deposited.toString(),shares:ca.shares.toString()},
      cardB:{deposited:cb.deposited.toString(),shares:cb.shares.toString()}};
  }
  function expected(s: any, a: number, b: number, phase: string) {
    const units = (n: number) => String(n*1000000);
    const values: any = {userTokensA:units(1000-a),userTokensB:units(1000-b),vaultTokens:units(a+b),
      userSharesA:units(a),userSharesB:units(b),shareSupply:units(a+b),totalTokens:units(a+b),totalShares:units(a+b)};
    for (const [k,v] of Object.entries(values)) check(phase + ": " + k,s[k] === v);
    check(phase + ": UserCard A",s.cardA.deposited===units(a) && s.cardA.shares===units(a));
    check(phase + ": UserCard B",s.cardB.deposited===units(b) && s.cardB.shares===units(b));
  }
  evidence.before = await snapshot(); expected(evidence.before,0,0,"Before A"); save();
  await send("deposit_A_100",[await deposit(userA.publicKey,100000000)],[userA]);
  evidence.afterA = await snapshot(); expected(evidence.afterA,100,0,"After A / before B"); save();
  check("B formula: 50000000 * 100000000 / 100000000 = 50000000",
    BigInt(50000000)*BigInt(evidence.afterA.totalShares)/BigInt(evidence.afterA.totalTokens)===BigInt(50000000));
  await send("deposit_B_50",[await deposit(userB.publicKey,50000000)],[userB]);
  evidence.afterB = await snapshot(); expected(evidence.afterB,100,50,"After B"); save();
  const zero = await simulate([await deposit(userA.publicKey,0)]);
  evidence.zeroDeposit = {kind:"simulation_only",broadcast:false,signature:null,err:zero.err,logs:zero.logs,unitsConsumed:zero.unitsConsumed};
  check("Zero deposit rejected with custom error 6000",JSON.stringify(zero.err)===JSON.stringify({InstructionError:[0,{Custom:6000}]}));
  const afterZero = await snapshot();
  const withoutSlot = (s: any) => {const {slot,...rest}=s;return rest;};
  check("Zero simulation leaves all balances and counters unchanged",JSON.stringify(withoutSlot(afterZero))===JSON.stringify(withoutSlot(evidence.afterB)));
  evidence.afterZeroSimulation = afterZero;
  check("Program executable unchanged throughout run",(await programInfo()).executableSha256===deployed.executableSha256);
  evidence.payerLamportsAfter=await conn.getBalance(admin.publicKey);
  const names=["vaultState","vaultTokenAccount","shareMint","userCardA","userCardB","tokenAccountA","tokenAccountB","shareAccountA","shareAccountB"];
  const final=await conn.getMultipleAccountsInfo(names.map(n=>new PublicKey(evidence.addresses[n])));
  evidence.finalAccountData=fromEntries(names.map((n,i)=>[n,final[i]!.data.toString("base64")]));
  evidence.status="completed"; evidence.completedAt=new Date().toISOString(); save();
  console.log("Completed: " + checks.length + " checks; " + evidence.transactions.length + " finalized transactions.");
}
main().catch(e=>{
  console.error(e.stack || e.message);
  if (evidence.addresses && fs.existsSync(OUT)) {evidence.status="failed";evidence.error=e.message;save();}
  process.exitCode=1;
});
