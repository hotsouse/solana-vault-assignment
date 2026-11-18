export function minimumOut(expected: bigint, bps=100): bigint {
  if(expected<=0n || !Number.isInteger(bps) || bps<0 || bps>=10000) throw new Error("Invalid quote/slippage");
  const min=expected*BigInt(10000-bps)/10000n;
  if(min===0n) throw new Error("Minimum rounds to zero");
  return min;
}
