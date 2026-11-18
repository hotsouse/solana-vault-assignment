import { AnchorProvider, Program, Wallet, Idl, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Raydium, DEVNET_PROGRAM_ID, DEV_API_URLS, PoolUtils } from "@raydium-io/raydium-sdk-v2";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
export const CLMM = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
export const POOL = new PublicKey("EKwcP1HdZsti8ALXNvAUAduWfYLXH76DeJkcH39auM1f");
export const INPUT = new PublicKey("7bdCcN9agJ3TSSjTFctxM4TGFVecBRd6gLNYoWYyvawF");
export const OUTPUT = new PublicKey("CwHVUNisByLqXM7mN47nhtcfG8AkYxeJ3tBdFB66yZAt");
export const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export function save(name: string, value: unknown) {
  writeFileSync(resolve("evidence",name),JSON.stringify(value,(_,v)=>typeof v==="bigint"?v.toString():v,2)+"\n");
}
export {minimumOut} from "./math";
import {minimumOut} from "./math";
export async function context() {
  const connection=new Connection(process.env.DEVNET_RPC??"https://api.devnet.solana.com","confirmed");
  if(await connection.getGenesisHash()!==GENESIS) throw new Error("Only Solana Devnet is allowed");
  const owner=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET??resolve(homedir(),".config/solana/id.json"),"utf8"))));
  const raydium=await Raydium.load({connection,owner,cluster:"devnet",disableFeatureCheck:true,disableLoadToken:true,urlConfigs:DEV_API_URLS,blockhashCommitment:"confirmed"});
  return {connection,owner,raydium};
}
export function vaultProgram(connection: Connection,owner: Keypair) {
  const provider=new AnchorProvider(connection,new Wallet(owner),{commitment:"confirmed"});
  const idl=JSON.parse(readFileSync(resolve("target/idl/simple_vault.json"),"utf8")) as Idl;
  return new Program(idl,provider);
}
export function pdas(programId: PublicKey,mint=INPUT) {
  const pda=(...s:Buffer[])=>PublicKey.findProgramAddressSync(s,programId)[0];
  const vaultState=pda(Buffer.from("vault"),mint.toBuffer());
  return {vaultState,vaultTokenAccount:pda(Buffer.from("vault_tokens"),mint.toBuffer()),
    shareMint:pda(Buffer.from("share_mint"),mint.toBuffer()),
    swapConfig:pda(Buffer.from("swap_config"),vaultState.toBuffer()),
    outputTokenAccount:pda(Buffer.from("vault_output"),vaultState.toBuffer()),
    userCard:(user:PublicKey)=>pda(Buffer.from("user_card"),vaultState.toBuffer(),user.toBuffer())};
}
export async function quote(raydium: Raydium,amount: BN) {
  const data=await raydium.clmm.getPoolInfoFromRpc(POOL.toBase58());
  const q=PoolUtils.computeAmountOut({poolInfo:data.computePoolInfo,
    tickArrayCache:data.tickData[POOL.toBase58()],baseMint:INPUT,
    epochInfo:await raydium.connection.getEpochInfo(),amountIn:amount,slippage:0,
    catchLiquidityInsufficient:false});
  if(!q.allTrade) throw new Error("Insufficient active liquidity for exact input");
  return {...data,quote:q,expected:BigInt(q.amountOut.amount.toString()),
    minimum:minimumOut(BigInt(q.amountOut.amount.toString()))};
}
