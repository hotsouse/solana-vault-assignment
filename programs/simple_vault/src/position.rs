use crate::{swap::SwapConfig, VaultError, VaultState};
use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    memo::Memo,
    metadata::Metadata,
    token::{Mint, Token, TokenAccount},
    token_interface::Token2022,
};
use raydium_amm_v3::{
    cpi,
    program::AmmV3,
    states::{PersonalPositionState, PoolState, TickArrayBitmapExtension, TickArrayState},
};

#[account]
#[derive(Default)]
pub struct PositionState {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub nft_mint: Pubkey,
    pub personal_position: Pubkey,
    pub lower: i32,
    pub upper: i32,
    pub liquidity: u128,
    pub active: bool,
    pub bump: u8,
}
impl PositionState {
    pub const LEN: usize = 8 + 32 * 4 + 4 * 2 + 16 + 2;
}

// The shared account set supports atomic open+fund and decrease+burn.
// Uninitialized Raydium accounts are checked by its CPI and deserialized afterward.
#[derive(Accounts)]
pub struct PositionOperation<'info> {
    #[account(mut,seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,has_one=admin @ VaultError::Unauthorized)]
    pub vault_state: Box<Account<'info, VaultState>>,
    #[account(seeds=[b"swap_config",vault_state.key().as_ref()],bump=swap_config.bump,
        constraint=swap_config.vault==vault_state.key() @ VaultError::InvalidPool)]
    pub swap_config: Box<Account<'info, SwapConfig>>,
    #[account(init_if_needed,payer=admin,space=PositionState::LEN,seeds=[b"position",vault_state.key().as_ref()],bump)]
    pub position_state: Box<Account<'info, PositionState>>,
    #[account(mut,address=swap_config.pool @ VaultError::InvalidPool)]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut,seeds=[b"vault_tokens",vault_state.token_mint.as_ref()],bump,
        address=vault_state.vault_token_account,token::mint=vault_state.token_mint,token::authority=vault_state)]
    pub token_a: Box<Account<'info, TokenAccount>>,
    #[account(mut,seeds=[b"vault_output",vault_state.key().as_ref()],bump,
        token::mint=swap_config.output_mint,token::authority=vault_state)]
    pub token_b: Box<Account<'info, TokenAccount>>,
    #[account(mut,address=pool_state.load()?.token_vault_0,token::authority=pool_state,token::mint=mint_0)]
    pub token_vault_0: Box<Account<'info, TokenAccount>>,
    #[account(mut,address=pool_state.load()?.token_vault_1,token::authority=pool_state,token::mint=mint_1)]
    pub token_vault_1: Box<Account<'info, TokenAccount>>,
    #[account(address=pool_state.load()?.token_mint_0)]
    pub mint_0: Box<Account<'info, Mint>>,
    #[account(address=pool_state.load()?.token_mint_1)]
    pub mint_1: Box<Account<'info, Mint>>,
    /// CHECK: New signer for open; exact stored mint, owner and supply checked on manage.
    #[account(mut)]
    pub nft_mint: UncheckedAccount<'info>,
    /// CHECK: Raydium creates Vault ATA on open; custody checked before and after CPI.
    #[account(mut)]
    pub nft_account: UncheckedAccount<'info>,
    /// CHECK: Canonical Raydium position PDA and data validated below.
    #[account(mut,seeds=[b"position",nft_mint.key().as_ref()],bump,seeds::program=clmm_program.key())]
    pub personal_position: UncheckedAccount<'info>,
    /// CHECK: Deprecated and unused by the pinned Raydium interface.
    pub protocol_position: UncheckedAccount<'info>,
    /// CHECK: Raydium validates creation; canonical tick-array addresses checked below.
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: Raydium validates creation; canonical tick-array addresses checked below.
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    /// CHECK: Metadata disabled; canonical address supplied by orchestration.
    #[account(mut)]
    pub metadata_account: UncheckedAccount<'info>,
    pub clmm_program: Program<'info, AmmV3>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub metadata_program: Program<'info, Metadata>,
    pub memo_program: Program<'info, Memo>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

fn read_position(a: &PositionOperation) -> Result<PersonalPositionState> {
    require_keys_eq!(
        *a.personal_position.owner,
        raydium_amm_v3::ID,
        VaultError::InvalidPosition
    );
    PersonalPositionState::try_deserialize(&mut &a.personal_position.try_borrow_data()?[..])
}
fn custody(a: &PositionOperation) -> Result<PersonalPositionState> {
    let p = read_position(a)?;
    require_keys_eq!(p.pool_id, a.pool_state.key(), VaultError::InvalidPool);
    require_keys_eq!(p.nft_mint, a.nft_mint.key(), VaultError::InvalidPosition);
    require_keys_eq!(
        *a.nft_account.owner,
        anchor_spl::token::ID,
        VaultError::InvalidPosition
    );
    require_keys_eq!(
        *a.nft_mint.owner,
        anchor_spl::token::ID,
        VaultError::InvalidPosition
    );
    let nft = TokenAccount::try_deserialize(&mut &a.nft_account.try_borrow_data()?[..])?;
    let mint = Mint::try_deserialize(&mut &a.nft_mint.try_borrow_data()?[..])?;
    require_keys_eq!(nft.owner, a.vault_state.key(), VaultError::InvalidPosition);
    require_keys_eq!(nft.mint, a.nft_mint.key(), VaultError::InvalidPosition);
    require!(
        nft.amount == 1
            && mint.supply == 1
            && mint.decimals == 0
            && nft.delegate.is_none()
            && nft.close_authority.is_none(),
        VaultError::InvalidPosition
    );
    Ok(p)
}
fn validate(a: &PositionOperation, lower: i32, upper: i32) -> Result<(i32, i32)> {
    let p = a.pool_state.load()?;
    let spacing = p.tick_spacing;
    require!(valid_ticks(lower, upper, spacing), VaultError::InvalidTicks);
    require!(
        (p.token_mint_0 == a.token_a.mint && p.token_mint_1 == a.token_b.mint)
            || (p.token_mint_1 == a.token_a.mint && p.token_mint_0 == a.token_b.mint),
        VaultError::InvalidMint
    );
    let lo = TickArrayState::get_array_start_index(lower, spacing);
    let hi = TickArrayState::get_array_start_index(upper, spacing);
    for (account, start) in [(&a.tick_array_lower, lo), (&a.tick_array_upper, hi)] {
        let expected = Pubkey::find_program_address(
            &[
                b"tick_array",
                a.pool_state.key().as_ref(),
                &start.to_be_bytes(),
            ],
            &raydium_amm_v3::ID,
        )
        .0;
        require_keys_eq!(account.key(), expected, VaultError::InvalidTickArray);
    }
    Ok((lo, hi))
}
pub fn valid_ticks(lower: i32, upper: i32, spacing: u16) -> bool {
    spacing > 0
        && lower >= -443636
        && upper <= 443636
        && lower < upper
        && lower % i32::from(spacing) == 0
        && upper % i32::from(spacing) == 0
}
fn remaining<'info>(a: &PositionOperation<'info>, accounts: &[AccountInfo<'info>]) -> Result<()> {
    // Reward-bearing pools are deliberately excluded: no arbitrary reward destinations.
    require!(
        a.pool_state
            .load()?
            .reward_infos
            .iter()
            .all(|r| r.token_mint == Pubkey::default()),
        VaultError::UnsupportedRewards
    );
    require!(accounts.len() <= 1, VaultError::InvalidTickArray);
    if let Some(info) = accounts.first() {
        require_keys_eq!(
            info.key(),
            TickArrayBitmapExtension::key(a.pool_state.key()),
            VaultError::InvalidTickArray
        );
        require_keys_eq!(
            *info.owner,
            raydium_amm_v3::ID,
            VaultError::InvalidTickArray
        );
        require!(info.is_writable, VaultError::InvalidTickArray);
    }
    Ok(())
}
fn ordered<'info>(a: &PositionOperation<'info>) -> (AccountInfo<'info>, AccountInfo<'info>) {
    if a.token_a.mint == a.mint_0.key() {
        (a.token_a.to_account_info(), a.token_b.to_account_info())
    } else {
        (a.token_b.to_account_info(), a.token_a.to_account_info())
    }
}

pub fn open<'info>(
    ctx: Context<'_, '_, '_, 'info, PositionOperation<'info>>,
    lower: i32,
    upper: i32,
    liquidity: u128,
    max_0: u64,
    max_1: u64,
) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.position_state.active, VaultError::PositionActive);
    require!(
        liquidity > 0 && liquidity <= i128::MAX as u128 && max_0 > 0 && max_1 > 0,
        VaultError::ZeroAmount
    );
    require!(a.nft_mint.is_signer, VaultError::InvalidPosition);
    let (lo, hi) = validate(a, lower, upper)?;
    remaining(a, ctx.remaining_accounts)?;
    let tick = a.pool_state.load()?.tick_current;
    require!(tick >= lower && tick < upper, VaultError::InvalidTicks);
    let before_a = a.token_a.amount;
    let before_b = a.token_b.amount;
    let (t0, t1) = ordered(a);
    let mint = a.vault_state.token_mint;
    let bump = [a.vault_state.bump];
    let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &bump];
    let signer = &[seeds];
    // Admin pays rent, but transfers no tokens. NFT is minted directly into Vault custody.
    cpi::open_position_v2(
        CpiContext::new(
            a.clmm_program.to_account_info(),
            cpi::accounts::OpenPositionV2 {
                payer: a.admin.to_account_info(),
                position_nft_owner: a.vault_state.to_account_info(),
                position_nft_mint: a.nft_mint.to_account_info(),
                position_nft_account: a.nft_account.to_account_info(),
                metadata_account: a.metadata_account.to_account_info(),
                pool_state: a.pool_state.to_account_info(),
                protocol_position: a.protocol_position.to_account_info(),
                tick_array_lower: a.tick_array_lower.to_account_info(),
                tick_array_upper: a.tick_array_upper.to_account_info(),
                personal_position: a.personal_position.to_account_info(),
                token_account_0: t0.clone(),
                token_account_1: t1.clone(),
                token_vault_0: a.token_vault_0.to_account_info(),
                token_vault_1: a.token_vault_1.to_account_info(),
                rent: a.rent.to_account_info(),
                system_program: a.system_program.to_account_info(),
                token_program: a.token_program.to_account_info(),
                associated_token_program: a.associated_token_program.to_account_info(),
                metadata_program: a.metadata_program.to_account_info(),
                token_program_2022: a.token_program_2022.to_account_info(),
                vault_0_mint: a.mint_0.to_account_info(),
                vault_1_mint: a.mint_1.to_account_info(),
            },
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
        lower,
        upper,
        lo,
        hi,
        0,
        0,
        0,
        false,
        None,
    )?;
    cpi::increase_liquidity_v2(
        CpiContext::new_with_signer(
            a.clmm_program.to_account_info(),
            cpi::accounts::IncreaseLiquidityV2 {
                pool_state: a.pool_state.to_account_info(),
                protocol_position: a.protocol_position.to_account_info(),
                tick_array_lower: a.tick_array_lower.to_account_info(),
                tick_array_upper: a.tick_array_upper.to_account_info(),
                personal_position: a.personal_position.to_account_info(),
                token_account_0: t0.clone(),
                token_account_1: t1.clone(),
                token_vault_0: a.token_vault_0.to_account_info(),
                token_vault_1: a.token_vault_1.to_account_info(),
                token_program: a.token_program.to_account_info(),
                token_program_2022: a.token_program_2022.to_account_info(),
                vault_0_mint: a.mint_0.to_account_info(),
                vault_1_mint: a.mint_1.to_account_info(),
                nft_owner: a.vault_state.to_account_info(),
                nft_account: a.nft_account.to_account_info(),
            },
            signer,
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
        liquidity,
        max_0,
        max_1,
        None,
    )?;
    let p = custody(a)?;
    require!(
        p.liquidity == liquidity && p.tick_lower_index == lower && p.tick_upper_index == upper,
        VaultError::InvalidPosition
    );
    a.token_a.reload()?;
    a.token_b.reload()?;
    let da = before_a
        .checked_sub(a.token_a.amount)
        .ok_or(VaultError::MathOverflow)?;
    let db = before_b
        .checked_sub(a.token_b.amount)
        .ok_or(VaultError::MathOverflow)?;
    let (d0, d1) = if a.token_a.mint == a.mint_0.key() {
        (da, db)
    } else {
        (db, da)
    };
    require!(
        d0 > 0 && d1 > 0 && d0 <= max_0 && d1 <= max_1,
        VaultError::SlippageExceeded
    );
    a.position_state.set_inner(PositionState {
        vault: a.vault_state.key(),
        pool: a.pool_state.key(),
        nft_mint: a.nft_mint.key(),
        personal_position: a.personal_position.key(),
        lower,
        upper,
        liquidity,
        active: true,
        bump: ctx.bumps.position_state,
    });
    a.vault_state.strategy_active = true;
    a.vault_state.total_tokens = a.token_a.amount;
    emit!(VaultPositionEvent {
        vault: a.vault_state.key(),
        nft: a.nft_mint.key(),
        action: 0,
        lower,
        upper,
        liquidity,
        amount_0: d0,
        amount_1: d1,
        tick
    });
    Ok(())
}
pub fn manage<'info>(
    ctx: Context<'_, '_, '_, 'info, PositionOperation<'info>>,
    close: bool,
    min_0: u64,
    min_1: u64,
) -> Result<()> {
    let a = ctx.accounts;
    require!(a.position_state.active, VaultError::NoPosition);
    require_keys_eq!(
        a.position_state.vault,
        a.vault_state.key(),
        VaultError::InvalidPosition
    );
    require_keys_eq!(
        a.position_state.pool,
        a.pool_state.key(),
        VaultError::InvalidPool
    );
    require_keys_eq!(
        a.position_state.nft_mint,
        a.nft_mint.key(),
        VaultError::InvalidPosition
    );
    require_keys_eq!(
        a.position_state.personal_position,
        a.personal_position.key(),
        VaultError::InvalidPosition
    );
    let p = custody(a)?;
    require!(
        p.liquidity > 0
            && p.liquidity == a.position_state.liquidity
            && p.tick_lower_index == a.position_state.lower
            && p.tick_upper_index == a.position_state.upper,
        VaultError::InvalidPosition
    );
    validate(a, p.tick_lower_index, p.tick_upper_index)?;
    remaining(a, ctx.remaining_accounts)?;
    // At an out-of-range close one principal output is legitimately zero.
    require!(!close || min_0 > 0 || min_1 > 0, VaultError::InvalidMinimum);
    let before_a = a.token_a.amount;
    let before_b = a.token_b.amount;
    let (t0, t1) = ordered(a);
    let mint = a.vault_state.token_mint;
    let bump = [a.vault_state.bump];
    let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &bump];
    let signer = &[seeds];
    let liquidity = if close { p.liquidity } else { 0 };
    cpi::decrease_liquidity_v2(
        CpiContext::new_with_signer(
            a.clmm_program.to_account_info(),
            cpi::accounts::DecreaseLiquidityV2 {
                pool_state: a.pool_state.to_account_info(),
                protocol_position: a.protocol_position.to_account_info(),
                tick_array_lower: a.tick_array_lower.to_account_info(),
                tick_array_upper: a.tick_array_upper.to_account_info(),
                personal_position: a.personal_position.to_account_info(),
                token_vault_0: a.token_vault_0.to_account_info(),
                token_vault_1: a.token_vault_1.to_account_info(),
                token_program: a.token_program.to_account_info(),
                token_program_2022: a.token_program_2022.to_account_info(),
                vault_0_mint: a.mint_0.to_account_info(),
                vault_1_mint: a.mint_1.to_account_info(),
                nft_owner: a.vault_state.to_account_info(),
                nft_account: a.nft_account.to_account_info(),
                recipient_token_account_0: t0.clone(),
                recipient_token_account_1: t1.clone(),
                memo_program: a.memo_program.to_account_info(),
            },
            signer,
        )
        .with_remaining_accounts(ctx.remaining_accounts.to_vec()),
        liquidity,
        min_0,
        min_1,
    )?;
    let after = read_position(a)?;
    require!(
        after.liquidity == if close { 0 } else { p.liquidity },
        VaultError::InvalidPosition
    );
    if close {
        cpi::close_position(CpiContext::new_with_signer(
            a.clmm_program.to_account_info(),
            cpi::accounts::ClosePosition {
                nft_owner: a.vault_state.to_account_info(),
                position_nft_mint: a.nft_mint.to_account_info(),
                position_nft_account: a.nft_account.to_account_info(),
                personal_position: a.personal_position.to_account_info(),
                system_program: a.system_program.to_account_info(),
                token_program: a.token_program.to_account_info(),
            },
            signer,
        ))?;
        require!(
            a.personal_position.data_is_empty() && a.nft_account.data_is_empty(),
            VaultError::InvalidPosition
        );
        a.position_state.active = false;
        a.position_state.liquidity = 0;
    } else {
        custody(a)?;
    }
    a.token_a.reload()?;
    a.token_b.reload()?;
    let da = a
        .token_a
        .amount
        .checked_sub(before_a)
        .ok_or(VaultError::MathOverflow)?;
    let db = a
        .token_b
        .amount
        .checked_sub(before_b)
        .ok_or(VaultError::MathOverflow)?;
    let (d0, d1) = if a.token_a.mint == a.mint_0.key() {
        (da, db)
    } else {
        (db, da)
    };
    require!(d0 >= min_0 && d1 >= min_1, VaultError::SlippageExceeded);
    // Remain locked even after close: TOKEN_B and fees have not been settled to TOKEN_A.
    a.vault_state.strategy_active = true;
    a.vault_state.total_tokens = a.token_a.amount;
    emit!(VaultPositionEvent {
        vault: a.vault_state.key(),
        nft: a.nft_mint.key(),
        action: if close { 2 } else { 1 },
        lower: p.tick_lower_index,
        upper: p.tick_upper_index,
        liquidity,
        amount_0: d0,
        amount_1: d1,
        tick: a.pool_state.load()?.tick_current
    });
    Ok(())
}
#[event]
pub struct VaultPositionEvent {
    pub vault: Pubkey,
    pub nft: Pubkey,
    pub action: u8,
    pub lower: i32,
    pub upper: i32,
    pub liquidity: u128,
    pub amount_0: u64,
    pub amount_1: u64,
    pub tick: i32,
}
#[cfg(test)]
mod tests {
    use super::valid_ticks;
    #[test]
    fn tick_boundaries() {
        assert!(valid_ticks(-60, 60, 60));
        assert!(valid_ticks(-443636, 443636, 1));
        for (lo, hi, s) in [
            (0, 0, 1),
            (60, -60, 60),
            (-61, 60, 60),
            (-60, 61, 60),
            (-443637, 0, 1),
            (0, 443637, 1),
            (-60, 60, 0),
        ] {
            assert!(!valid_ticks(lo, hi, s));
        }
    }
}
