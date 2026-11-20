use crate::{VaultError, VaultState};
use anchor_lang::prelude::*;
use anchor_spl::{
    memo::Memo,
    token::{Mint, Token, TokenAccount},
    token_interface::Token2022,
};
use raydium_amm_v3::{
    cpi,
    program::AmmV3,
    states::{AmmConfig, ObservationState, PoolState, TickArrayBitmapExtension, TickArrayState},
};

#[account]
pub struct SwapConfig {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub output_mint: Pubkey,
    pub bump: u8,
}
impl SwapConfig {
    pub const LEN: usize = 8 + 32 * 3 + 1;
}

#[derive(Accounts)]
pub struct InitializeSwap<'info> {
    #[account(seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,has_one=admin @ VaultError::Unauthorized)]
    pub vault_state: Box<Account<'info, VaultState>>,
    #[account(init,payer=admin,space=SwapConfig::LEN,seeds=[b"swap_config",vault_state.key().as_ref()],bump)]
    pub swap_config: Box<Account<'info, SwapConfig>>,
    #[account(init,payer=admin,seeds=[b"vault_output",vault_state.key().as_ref()],bump,token::mint=output_mint,token::authority=vault_state)]
    pub output_token_account: Box<Account<'info, TokenAccount>>,
    pub output_mint: Box<Account<'info, Mint>>,
    pub pool_state: AccountLoader<'info, PoolState>,
    pub clmm_program: Program<'info, AmmV3>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
pub fn initialize(ctx: Context<InitializeSwap>) -> Result<()> {
    let pool = ctx.accounts.pool_state.load()?;
    let input = ctx.accounts.vault_state.token_mint;
    let output = ctx.accounts.output_mint.key();
    require!(input != output, VaultError::InvalidMint);
    require!(
        (pool.token_mint_0 == input && pool.token_mint_1 == output)
            || (pool.token_mint_1 == input && pool.token_mint_0 == output),
        VaultError::InvalidMint
    );
    ctx.accounts.swap_config.set_inner(SwapConfig {
        vault: ctx.accounts.vault_state.key(),
        pool: ctx.accounts.pool_state.key(),
        output_mint: output,
        bump: ctx.bumps.swap_config,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SwapViaRaydium<'info> {
    #[account(mut,seeds=[b"vault",vault_state.token_mint.as_ref()],bump=vault_state.bump,
        has_one=admin @ VaultError::Unauthorized)]
    pub vault_state: Box<Account<'info, VaultState>>,
    #[account(seeds=[b"swap_config",vault_state.key().as_ref()],bump=swap_config.bump,
        constraint=swap_config.vault==vault_state.key() @ VaultError::InvalidPool)]
    pub swap_config: Box<Account<'info, SwapConfig>>,
    #[account(mut,address=swap_config.pool @ VaultError::InvalidPool)]
    pub pool_state: AccountLoader<'info, PoolState>,
    #[account(mut,seeds=[b"vault_tokens",vault_state.token_mint.as_ref()],bump,
        address=vault_state.vault_token_account,token::mint=input_mint,token::authority=vault_state)]
    pub input_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut,seeds=[b"vault_output",vault_state.key().as_ref()],bump,
        token::mint=output_mint,token::authority=vault_state)]
    pub output_token_account: Box<Account<'info, TokenAccount>>,
    #[account(address=vault_state.token_mint @ VaultError::InvalidMint)]
    pub input_mint: Box<Account<'info, Mint>>,
    #[account(address=swap_config.output_mint @ VaultError::InvalidMint)]
    pub output_mint: Box<Account<'info, Mint>>,
    #[account(address=pool_state.load()?.amm_config)]
    pub amm_config: Box<Account<'info, AmmConfig>>,
    #[account(mut,address=pool_state.load()?.observation_key)]
    pub observation_state: AccountLoader<'info, ObservationState>,
    #[account(mut,token::mint=input_mint,token::authority=pool_state)]
    pub input_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut,token::mint=output_mint,token::authority=pool_state)]
    pub output_vault: Box<Account<'info, TokenAccount>>,
    pub admin: Signer<'info>,
    pub clmm_program: Program<'info, AmmV3>,
    pub token_program: Program<'info, Token>,
    pub token_program_2022: Program<'info, Token2022>,
    pub memo_program: Program<'info, Memo>,
}
pub fn swap<'a, 'b, 'c: 'info, 'info>(
    ctx: Context<'a, 'b, 'c, 'info, SwapViaRaydium<'info>>,
    amount_in: u64,
    minimum_amount_out: u64,
) -> Result<()> {
    execute(
        ctx.accounts,
        ctx.remaining_accounts,
        amount_in,
        minimum_amount_out,
        false,
    )
}
pub fn execute<'info>(
    a: &mut SwapViaRaydium<'info>,
    remaining_accounts: &'info [AccountInfo<'info>],
    amount_in: u64,
    minimum_amount_out: u64,
    reverse: bool,
) -> Result<()> {
    let balance_in = if reverse {
        a.output_token_account.amount
    } else {
        a.input_token_account.amount
    };
    let balance_out = if reverse {
        a.input_token_account.amount
    } else {
        a.output_token_account.amount
    };
    let input_mint_key = if reverse {
        a.output_mint.key()
    } else {
        a.input_mint.key()
    };
    let output_mint_key = if reverse {
        a.input_mint.key()
    } else {
        a.output_mint.key()
    };
    let input_vault_key = if reverse {
        a.output_vault.key()
    } else {
        a.input_vault.key()
    };
    let output_vault_key = if reverse {
        a.input_vault.key()
    } else {
        a.output_vault.key()
    };
    require!(amount_in > 0, VaultError::ZeroAmount);
    require!(minimum_amount_out > 0, VaultError::InvalidMinimum);
    require!(balance_in >= amount_in, VaultError::InsufficientBalance);
    let before_input = balance_in;
    let before_output = balance_out;
    let sqrt_before;
    {
        let p = a.pool_state.load()?;
        let zero_for_one = p.token_mint_0 == input_mint_key;
        require!(
            (zero_for_one && p.token_mint_1 == output_mint_key)
                || (!zero_for_one
                    && p.token_mint_1 == input_mint_key
                    && p.token_mint_0 == output_mint_key),
            VaultError::InvalidMint
        );
        let (expected_input, expected_output) = if zero_for_one {
            (p.token_vault_0, p.token_vault_1)
        } else {
            (p.token_vault_1, p.token_vault_0)
        };
        require_keys_eq!(expected_input, input_vault_key, VaultError::InvalidPool);
        require_keys_eq!(expected_output, output_vault_key, VaultError::InvalidPool);
        require!(p.liquidity > 0, VaultError::NoLiquidity);
        sqrt_before = p.sqrt_price_x64;
    }
    require!(
        !remaining_accounts.is_empty() && remaining_accounts.len() <= 8,
        VaultError::InvalidTickArray
    );
    let bitmap = TickArrayBitmapExtension::key(a.pool_state.key());
    let mut tick_count = 0;
    for info in remaining_accounts {
        require_keys_eq!(
            *info.owner,
            raydium_amm_v3::ID,
            VaultError::InvalidTickArray
        );
        require!(
            info.is_writable && !info.is_signer,
            VaultError::InvalidTickArray
        );
        if info.key() == bitmap {
            let loader = AccountLoader::<TickArrayBitmapExtension>::try_from(info)?;
            require_keys_eq!(
                loader.load()?.pool_id,
                a.pool_state.key(),
                VaultError::InvalidTickArray
            );
        } else {
            let loader = AccountLoader::<TickArrayState>::try_from(info)?;
            require_keys_eq!(
                loader.load()?.pool_id,
                a.pool_state.key(),
                VaultError::InvalidTickArray
            );
            tick_count += 1;
        }
    }
    require!(tick_count > 0, VaultError::InvalidTickArray);
    let mint = a.vault_state.token_mint;
    let bump = [a.vault_state.bump];
    let seeds: &[&[u8]] = &[b"vault", mint.as_ref(), &bump];
    let signer = &[seeds];
    let accounts = cpi::accounts::SwapSingleV2 {
        payer: a.vault_state.to_account_info(),
        amm_config: a.amm_config.to_account_info(),
        pool_state: a.pool_state.to_account_info(),
        input_token_account: if reverse {
            a.output_token_account.to_account_info()
        } else {
            a.input_token_account.to_account_info()
        },
        output_token_account: if reverse {
            a.input_token_account.to_account_info()
        } else {
            a.output_token_account.to_account_info()
        },
        input_vault: if reverse {
            a.output_vault.to_account_info()
        } else {
            a.input_vault.to_account_info()
        },
        output_vault: if reverse {
            a.input_vault.to_account_info()
        } else {
            a.output_vault.to_account_info()
        },
        observation_state: a.observation_state.to_account_info(),
        token_program: a.token_program.to_account_info(),
        token_program_2022: a.token_program_2022.to_account_info(),
        memo_program: a.memo_program.to_account_info(),
        input_vault_mint: if reverse {
            a.output_mint.to_account_info()
        } else {
            a.input_mint.to_account_info()
        },
        output_vault_mint: if reverse {
            a.input_mint.to_account_info()
        } else {
            a.output_mint.to_account_info()
        },
    };
    cpi::swap_v2(
        CpiContext::new_with_signer(a.clmm_program.to_account_info(), accounts, signer)
            .with_remaining_accounts(remaining_accounts.to_vec()),
        amount_in,
        minimum_amount_out,
        0,
        true,
    )?;
    a.input_token_account.reload()?;
    a.output_token_account.reload()?;
    let after_input = if reverse {
        a.output_token_account.amount
    } else {
        a.input_token_account.amount
    };
    let after_output = if reverse {
        a.input_token_account.amount
    } else {
        a.output_token_account.amount
    };
    let spent = before_input
        .checked_sub(after_input)
        .ok_or(VaultError::MathOverflow)?;
    let received = after_output
        .checked_sub(before_output)
        .ok_or(VaultError::MathOverflow)?;
    require!(spent == amount_in, VaultError::PartialFill);
    require!(received >= minimum_amount_out, VaultError::SlippageExceeded);
    a.vault_state.total_tokens = a.input_token_account.amount;
    a.vault_state.strategy_active = true;
    emit!(VaultSwap {
        vault: a.vault_state.key(),
        pool: a.pool_state.key(),
        amount_in: spent,
        amount_out: received,
        minimum_amount_out,
        sqrt_price_before: sqrt_before,
        sqrt_price_after: a.pool_state.load()?.sqrt_price_x64,
    });
    Ok(())
}
#[event]
pub struct VaultSwap {
    pub vault: Pubkey,
    pub pool: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub minimum_amount_out: u64,
    pub sqrt_price_before: u128,
    pub sqrt_price_after: u128,
}
