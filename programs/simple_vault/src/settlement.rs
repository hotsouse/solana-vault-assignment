use crate::{
    position::PositionState,
    swap::{self, *},
    VaultError, VaultState,
};
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};
use raydium_amm_v3::states::PoolState;

#[derive(Accounts)]
pub struct ReverseSwap<'info> {
    pub swap: SwapViaRaydium<'info>,
    #[account(seeds=[b"position",swap.vault_state.key().as_ref()],bump=position_state.bump,
        constraint=position_state.vault==swap.vault_state.key() @ VaultError::InvalidPosition,
        constraint=position_state.pool==swap.swap_config.pool @ VaultError::InvalidPool)]
    pub position_state: Box<Account<'info, PositionState>>,
}
pub fn reverse<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, ReverseSwap<'info>>,
    amount: u64,
    minimum: u64,
) -> Result<()> {
    require!(
        ctx.accounts.swap.vault_state.strategy_active
            || ctx.accounts.swap.output_token_account.amount > 0,
        VaultError::StrategyInactive
    );
    require!(
        !ctx.accounts.position_state.active && ctx.accounts.position_state.liquidity == 0,
        VaultError::PositionActive
    );
    require!(amount > 0, VaultError::ZeroAmount);
    require!(
        amount == ctx.accounts.swap.output_token_account.amount,
        VaultError::IncompleteConversion
    );
    swap::execute(
        &mut ctx.accounts.swap,
        ctx.remaining_accounts,
        amount,
        minimum,
        true,
    )?;
    require!(
        ctx.accounts.swap.output_token_account.amount == 0,
        VaultError::UnsettledTokenB
    );
    // execute deliberately retains strategy_active; only finalization may unlock.
    Ok(())
}

#[derive(Accounts)]
pub struct SettleStrategy<'info> {
    #[account(mut,seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,has_one=admin @ VaultError::Unauthorized)]
    pub vault_state: Box<Account<'info, VaultState>>,
    #[account(seeds=[b"swap_config",vault_state.key().as_ref()],bump=swap_config.bump,
        constraint=swap_config.vault==vault_state.key() @ VaultError::InvalidPool)]
    pub swap_config: Box<Account<'info, SwapConfig>>,
    #[account(seeds=[b"position",vault_state.key().as_ref()],bump=position_state.bump,
        constraint=position_state.vault==vault_state.key() @ VaultError::InvalidPosition,
        constraint=position_state.pool==swap_config.pool @ VaultError::InvalidPool)]
    pub position_state: Box<Account<'info, PositionState>>,
    #[account(address=swap_config.pool @ VaultError::InvalidPool)]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(seeds=[b"vault_tokens",vault_state.token_mint.as_ref()],bump,address=vault_state.vault_token_account,
        token::mint=vault_state.token_mint,token::authority=vault_state)]
    pub token_a: Box<Account<'info, TokenAccount>>,
    #[account(seeds=[b"vault_output",vault_state.key().as_ref()],bump,token::mint=swap_config.output_mint,token::authority=vault_state)]
    pub token_b: Box<Account<'info, TokenAccount>>,
    #[account(seeds=[b"share_mint",vault_state.token_mint.as_ref()],bump,address=vault_state.share_mint,mint::authority=vault_state)]
    pub share_mint: Box<Account<'info, Mint>>,
    #[account(address=position_state.nft_mint @ VaultError::InvalidPosition)]
    pub nft_mint: Box<Account<'info, Mint>>,
    /// CHECK: Canonical Vault NFT ATA; must no longer contain token-account data.
    #[account(constraint=nft_account.key()==anchor_spl::associated_token::get_associated_token_address(&vault_state.key(),&nft_mint.key()) @ VaultError::InvalidPosition)]
    pub nft_account: UncheckedAccount<'info>,
    /// CHECK: Stored and canonical Raydium PDA; must have been closed to the system program.
    #[account(address=position_state.personal_position @ VaultError::InvalidPosition,
        seeds=[b"position",nft_mint.key().as_ref()],bump,seeds::program=raydium_amm_v3::ID)]
    pub personal_position: UncheckedAccount<'info>,
    pub admin: Signer<'info>,
}
pub fn finalize(ctx: Context<SettleStrategy>) -> Result<()> {
    let a = ctx.accounts;
    require!(
        !a.position_state.active && a.position_state.liquidity == 0,
        VaultError::PositionActive
    );
    require!(
        a.nft_mint.supply == 0 && a.nft_mint.decimals == 0 && a.nft_mint.mint_authority.is_none(),
        VaultError::InvalidPosition
    );
    require!(
        a.nft_account.data_is_empty() && *a.nft_account.owner == anchor_lang::system_program::ID,
        VaultError::InvalidPosition
    );
    require!(
        a.personal_position.data_is_empty()
            && *a.personal_position.owner == anchor_lang::system_program::ID,
        VaultError::InvalidPosition
    );
    let p = a.pool_state.load()?;
    require!(
        (p.token_mint_0 == a.token_a.mint && p.token_mint_1 == a.token_b.mint)
            || (p.token_mint_1 == a.token_a.mint && p.token_mint_0 == a.token_b.mint),
        VaultError::InvalidMint
    );
    require!(a.token_b.amount == 0, VaultError::UnsettledTokenB);
    require!(
        a.share_mint.supply == a.vault_state.total_shares,
        VaultError::ShareSupplyMismatch
    );
    require!(a.vault_state.total_shares > 0, VaultError::VaultEmpty);
    require!(a.token_a.amount > 0, VaultError::InsolventVault);
    // Also permits explicit administrator reconciliation of idle A donations.
    require!(
        a.vault_state.strategy_active || a.vault_state.total_tokens != a.token_a.amount,
        VaultError::AlreadySettled
    );
    let previous = a.vault_state.total_tokens;
    a.vault_state.total_tokens = a.token_a.amount;
    a.vault_state.strategy_active = false;
    emit!(StrategySettled {
        vault: a.vault_state.key(),
        previous_assets: previous,
        assets: a.token_a.amount,
        shares: a.vault_state.total_shares,
        token_b: a.token_b.amount,
        nft: a.nft_mint.key()
    });
    Ok(())
}
#[event]
pub struct StrategySettled {
    pub vault: Pubkey,
    pub previous_assets: u64,
    pub assets: u64,
    pub shares: u64,
    pub token_b: u64,
    pub nft: Pubkey,
}
