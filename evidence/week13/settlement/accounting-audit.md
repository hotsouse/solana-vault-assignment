# Pre-implementation accounting audit

- Existing swap account constraints bind A as input and B as output; reverse support is absent.
- Position close zeros tracked liquidity and burns/closes the NFT, but deliberately leaves strategy_active true and residual B in custody.
- total_tokens records idle A while the strategy is active; it cannot price redeemable shares until B has been fully converted.
- Existing share issuance falls back to 1:1 when total_tokens is zero even if shares remain. Reject that insolvent state instead.
- Existing deposit/withdraw do not compare recorded shares with mint supply or recorded assets with actual A. Add fail-closed consistency checks when unlocked.
- UserCard is participation history, not the source of share ownership; SPL token balances and mint supply are authoritative. Preserve transferable shares and floor rounding.
- Settlement will preserve total_shares, require canonical closed tracked position/NFT and zero B, then assign actual A to total_tokens. Repeated settlement with unchanged balances is rejected.
- A full-balance reverse swap is a separate locked operation. Exact input and zero residual B are verified; finalization alone unlocks. Failure leaves the lock in place.
- Out-of-band share burning creates a supply mismatch and is rejected conservatively. Idle A donations require administrator reconciliation before redemption.
