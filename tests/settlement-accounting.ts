import {strict as assert} from "assert";
import {redemptionAmount} from "../scripts/week13-settlement-verify";
describe("settlement redemption accounting",()=>{
 it("values existing shares against actual settled assets",()=>assert.equal(redemptionAmount(50n,199500000n,200n),49875000n));
 it("floors partial redemptions",()=>assert.equal(redemptionAmount(1n,10n,3n),3n));
 it("returns all residual units to the final shareholder",()=>{const first=redemptionAmount(1n,10n,3n);assert.equal(first+redemptionAmount(2n,10n-first,2n),10n);});
 it("detects a zero-output rounding edge",()=>assert.equal(redemptionAmount(1n,2n,3n),0n));
 it("preserves precision at the u64 maximum",()=>{const m=(1n<<64n)-1n;assert.equal(redemptionAmount(m,m,m),m);});
 it("rejects zero and excessive share requests",()=>{assert.throws(()=>redemptionAmount(0n,10n,3n));assert.throws(()=>redemptionAmount(4n,10n,3n));assert.throws(()=>redemptionAmount(1n,10n,0n));});
 it("never creates value across sequential floor-rounded redemptions",()=>{for(let a=1n;a<40n;a++)for(let s=2n;s<25n;s++)for(let b=1n;b<s;b++){const first=redemptionAmount(b,a,s);assert(first<=a);assert.equal(first+redemptionAmount(s-b,a-first,s-b),a);}});
});
