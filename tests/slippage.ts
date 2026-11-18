import {strict as assert} from "assert";
import {minimumOut} from "../scripts/math";
describe("integer slippage",()=>{
 it("floors 1% below the expected amount",()=>assert.equal(minimumOut(12345n),12221n));
 it("preserves precision above Number.MAX_SAFE_INTEGER",()=>{
 const v=18446744073709551615n;assert.equal(minimumOut(v),v*99n/100n);});
 it("rejects zero expected output",()=>assert.throws(()=>minimumOut(0n)));
 it("rejects a zero minimum",()=>assert.throws(()=>minimumOut(1n)));
 it("rejects invalid basis points",()=>{for(const b of [-1,10000,1.5,NaN]) assert.throws(()=>minimumOut(10000n,b));});
 it("accepts exact output with zero slippage",()=>assert.equal(minimumOut(100n,0),100n));
});
