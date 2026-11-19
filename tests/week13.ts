import {strict as assert} from "assert";
import {createHash} from "crypto";
import {PublicKey} from "@solana/web3.js";
import {positionEvents,raydiumLiquidityEvents,tokenDelta} from "../scripts/week13-verify";
const program="8Fwjh2gQ9qAQFZ4jVPKPe8G6xEq2dQJatFDv4A6iw2Qa";
function sample(){const b=Buffer.alloc(117);createHash("sha256").update("event:VaultPositionEvent").digest().copy(b,0,0,8);new PublicKey(program).toBuffer().copy(b,8);new PublicKey(program).toBuffer().copy(b,40);b[72]=1;b.writeInt32LE(-120,73);b.writeInt32LE(60,77);b.writeBigUInt64LE(42n,81);b.writeBigUInt64LE(9007199254740993n,97);b.writeBigUInt64LE(3n,105);b.writeInt32LE(-60,113);return "Program data: "+b.toString("base64");}
describe("Week 13 evidence verifier",()=>{
 it("decodes exact amounts beyond Number precision",()=>{const e=positionEvents([`Program ${program} invoke [1]`,sample(),`Program ${program} success`]);assert.equal(e[0].amount0,9007199254740993n);assert.equal(e[0].lower,-120);assert.equal(e[0].liquidity,42n);});
 it("rejects event-shaped data emitted by another program",()=>{assert.equal(positionEvents(["Program 11111111111111111111111111111111 invoke [1]",sample(),"Program 11111111111111111111111111111111 success"]).length,0);});
 it("attributes nested log data to the actual emitter",()=>{assert.equal(positionEvents([`Program ${program} invoke [1]`,"Program 11111111111111111111111111111111 invoke [2]",sample(),"Program 11111111111111111111111111111111 success",sample(),`Program ${program} success`]).length,1);});
 const b=(amount:string,owner="vault",mint="mint")=>({accountIndex:4,owner,mint,uiTokenAmount:{amount,decimals:6}});
 it("uses exact on-chain raw token deltas",()=>assert.equal(tokenDelta({preTokenBalances:[b("9007199254740993")],postTokenBalances:[b("9007199254740996")]},4,"vault","mint"),3n));
 it("fails closed on missing balances",()=>assert.throws(()=>tokenDelta({preTokenBalances:[],postTokenBalances:[]},4,"vault","mint")));
 it("rejects spoofed authority and mint metadata",()=>{assert.throws(()=>tokenDelta({preTokenBalances:[b("1","attacker")],postTokenBalances:[b("2")]},4,"vault","mint"));assert.throws(()=>tokenDelta({preTokenBalances:[b("1","vault","other")],postTokenBalances:[b("2")]},4,"vault","mint"));});
});

describe("Raydium event evidence",()=>{
 const ray="DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH";
 function event(){const b=Buffer.alloc(92);createHash("sha256").update("event:LiquidityCalculateEvent").digest().copy(b,0,0,8);b.writeBigUInt64LE(123n,8);b.writeBigUInt64LE(1n,32);b.writeInt32LE(-120,40);b.writeBigUInt64LE(999n,44);b.writeBigUInt64LE(7n,60);return "Program data: "+b.toString("base64");}
 it("decodes price, principal and fees from the pinned Raydium schema",()=>{const e=raydiumLiquidityEvents([`Program ${ray} invoke [2]`,event(),`Program ${ray} success`])[0];assert.equal(e.sqrtPriceX64,1n<<64n);assert.equal(e.principal0,999n);assert.equal(e.fee0,7n);assert.equal(e.tick,-120);});
 it("rejects Raydium-shaped data emitted by the Vault",()=>assert.equal(raydiumLiquidityEvents([`Program ${program} invoke [1]`,event(),`Program ${program} success`]).length,0));
});
