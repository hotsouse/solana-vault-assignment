pub mod settlement;
use settlement::*;
pub mod position;
use position::*;
pub mod swap;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};
use swap::*;

#[cfg(not(feature = "settlement-deployment"))]
declare_id!("8Fwjh2gQ9qAQFZ4jVPKPe8G6xEq2dQJatFDv4A6iw2Qa");
#[cfg(feature = "settlement-deployment")]
declare_id!("Cm1i9GJUXXvZPA1cDeZ62FjCsmz8w8LJXe91drJYWYx9");

#[program]
pub mod simple_vault {
    use super::*;

    pub fn open_position<'info>(
        ctx: Context<'_, '_, '_, 'info, PositionOperation<'info>>,
        lower: i32,
        upper: i32,
        liquidity: u128,
        max_0: u64,
        max_1: u64,
    ) -> Result<()> {
        position::open(ctx, lower, upper, liquidity, max_0, max_1)
    }
    pub fn collect_position_fees<'info>(
        ctx: Context<'_, '_, '_, 'info, PositionOperation<'info>>,
    ) -> Result<()> {
        position::manage(ctx, false, 0, 0)
    }
    pub fn close_position<'info>(
        ctx: Context<'_, '_, '_, 'info, PositionOperation<'info>>,
        min_0: u64,
        min_1: u64,
    ) -> Result<()> {
        position::manage(ctx, true, min_0, min_1)
    }

    pub fn reverse_swap_via_raydium<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, ReverseSwap<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        settlement::reverse(ctx, amount_in, minimum_amount_out)
    }
    pub fn settle_strategy(ctx: Context<SettleStrategy>) -> Result<()> {
        settlement::finalize(ctx)
    }

    pub fn initialize_swap(ctx: Context<InitializeSwap>) -> Result<()> {
        swap::initialize(ctx)
    }
    pub fn swap_via_raydium<'a, 'b, 'c: 'info, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, SwapViaRaydium<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        swap::swap(ctx, amount_in, minimum_amount_out)
    }

    /// Создать vault для конкретного SPL-токена.
    /// Создаёт: VaultState PDA, vault_token_account PDA, share_mint PDA.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault_state;
        vault.admin = ctx.accounts.admin.key();
        vault.token_mint = ctx.accounts.token_mint.key();
        vault.vault_token_account = ctx.accounts.vault_token_account.key();
        vault.share_mint = ctx.accounts.share_mint.key();
        vault.total_tokens = 0;
        vault.total_shares = 0;
        vault.bump = ctx.bumps.vault_state;

        msg!("Vault initialized for mint: {}", vault.token_mint);
        Ok(())
    }

    /// Создать личную «карточку» пользователя в vault.
    /// У каждого пользователя ровно одна карточка (PDA от vault + user).
    pub fn create_user_card(ctx: Context<CreateUserCard>) -> Result<()> {
        let card = &mut ctx.accounts.user_card;
        card.vault = ctx.accounts.vault_state.key();
        card.owner = ctx.accounts.user.key();
        card.bump = ctx.bumps.user_card;

        msg!("User card created for: {}", card.owner);
        Ok(())
    }

    /// Пользователь вносит `amount` токенов → получает share-токены.
    ///
    /// Формула:
    ///   Первый депозит:       shares = amount  (1:1)
    ///   Последующие депозиты: shares = amount * total_shares / total_tokens
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.vault_state.strategy_active,
            VaultError::StrategyActive
        );
        require!(amount > 0, VaultError::ZeroAmount);

        check_strategy_token_account(
            &ctx.accounts.strategy_token_account,
            ctx.accounts.vault_state.key(),
        )?;
        check_idle_accounting(
            &ctx.accounts.vault_state,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.share_mint,
        )?;
        require!(
            ctx.accounts.vault_state.total_shares > 0 || ctx.accounts.vault_state.total_tokens == 0,
            VaultError::OrphanAssets
        );
        require!(
            ctx.accounts.vault_state.total_shares == 0 || ctx.accounts.vault_state.total_tokens > 0,
            VaultError::InsolventVault
        );
        let vault = &ctx.accounts.vault_state;

        // Сколько shares получит пользователь
        let shares = if vault.total_shares == 0 {
            amount // первый депозит: 1 share = 1 token
        } else {
            (amount as u128)
                .checked_mul(vault.total_shares as u128)
                .and_then(|v| v.checked_div(vault.total_tokens as u128))
                .and_then(|v| u64::try_from(v).ok())
                .ok_or(VaultError::MathOverflow)?
        };
        require!(shares > 0, VaultError::SharesTooSmall);

        // 1. Переводим токены: пользователь → vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        // 2. Печатаем shares пользователю (подписывает vault PDA)
        let token_mint_key = ctx.accounts.vault_state.token_mint;
        let seeds = &[
            b"vault".as_ref(),
            token_mint_key.as_ref(),
            &[ctx.accounts.vault_state.bump],
        ];
        let signer = &[&seeds[..]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    to: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer,
            ),
            shares,
        )?;

        // 3. Обновляем vault и карточку пользователя
        let vault = &mut ctx.accounts.vault_state;
        vault.total_tokens = vault
            .total_tokens
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        vault.total_shares = vault
            .total_shares
            .checked_add(shares)
            .ok_or(VaultError::MathOverflow)?;

        let card = &mut ctx.accounts.user_card;
        card.deposited = card
            .deposited
            .checked_add(amount)
            .ok_or(VaultError::MathOverflow)?;
        card.shares = card
            .shares
            .checked_add(shares)
            .ok_or(VaultError::MathOverflow)?;

        msg!(
            "Deposit: {} tokens -> {} shares (total_tokens={}, total_shares={})",
            amount,
            shares,
            vault.total_tokens,
            vault.total_shares
        );
        Ok(())
    }

    /// Пользователь возвращает shares и получает соответствующее количество токенов.
    pub fn withdraw(ctx: Context<Withdraw>, shares_amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.vault_state.strategy_active,
            VaultError::StrategyActive
        );
        require!(shares_amount > 0, VaultError::ZeroAmount);

        check_strategy_token_account(
            &ctx.accounts.strategy_token_account,
            ctx.accounts.vault_state.key(),
        )?;
        check_idle_accounting(
            &ctx.accounts.vault_state,
            &ctx.accounts.vault_token_account,
            &ctx.accounts.share_mint,
        )?;
        let vault = &ctx.accounts.vault_state;
        require!(vault.total_shares > 0, VaultError::VaultEmpty);
        require!(
            shares_amount <= ctx.accounts.user_share_account.amount,
            VaultError::InsufficientShares
        );

        let tokens_out = tokens_for_shares(shares_amount, vault.total_tokens, vault.total_shares)
            .ok_or(VaultError::MathOverflow)?;
        require!(tokens_out > 0, VaultError::WithdrawTooSmall);

        // Сжигаем shares от имени пользователя. Если баланса не хватает, Token Program
        // отклонит CPI, а Solana откатит всю транзакцию.
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.share_mint.to_account_info(),
                    from: ctx.accounts.user_share_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares_amount,
        )?;

        // Vault PDA подписывает перевод из своего токен-аккаунта.
        let token_mint_key = ctx.accounts.vault_state.token_mint;
        let bump = [ctx.accounts.vault_state.bump];
        let seeds: &[&[u8]] = &[b"vault", token_mint_key.as_ref(), &bump];
        let signer = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.vault_state.to_account_info(),
                },
                signer,
            ),
            tokens_out,
        )?;

        let vault = &mut ctx.accounts.vault_state;
        vault.total_tokens = vault
            .total_tokens
            .checked_sub(tokens_out)
            .ok_or(VaultError::MathOverflow)?;
        vault.total_shares = vault
            .total_shares
            .checked_sub(shares_amount)
            .ok_or(VaultError::MathOverflow)?;

        // Shares можно передать другому пользователю. Карточка хранит историю
        // участия, поэтому её счётчики не должны переполняться при таком выводе.
        let card = &mut ctx.accounts.user_card;
        card.deposited = card.deposited.saturating_sub(tokens_out);
        card.shares = card.shares.saturating_sub(shares_amount);

        msg!(
            "Withdraw: {} shares -> {} tokens (total_tokens={}, total_shares={})",
            shares_amount,
            tokens_out,
            vault.total_tokens,
            vault.total_shares
        );
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    /// VaultState PDA — seeds: ["vault", token_mint]
    #[account(
        init,
        payer = admin,
        space = VaultState::LEN,
        seeds = [b"vault", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Token account, принадлежащий vault PDA
    #[account(
        init,
        payer = admin,
        token::mint = token_mint,
        token::authority = vault_state,
        seeds = [b"vault_tokens", token_mint.key().as_ref()],
        bump,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Mint для shares — выпускается vault PDA
    #[account(
        init,
        payer = admin,
        mint::decimals = 6,
        mint::authority = vault_state,
        seeds = [b"share_mint", token_mint.key().as_ref()],
        bump,
    )]
    pub share_mint: Account<'info, Mint>,

    /// SPL-токен, который принимает vault
    pub token_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateUserCard<'info> {
    #[account(
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// UserCard PDA — seeds: ["user_card", vault_state, user]
    #[account(
        init,
        payer = user,
        space = UserCard::LEN,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    /// Карточка пользователя — депозит возможен только после create_user_card
    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
    )]
    pub user_card: Account<'info, UserCard>,

    /// Токен-аккаунт vault — принимает токены
    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.token_mint.as_ref()],
        bump,
        token::mint = vault_state.token_mint,
        token::authority = vault_state,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// Share mint — vault печатает shares
    #[account(
        mut,
        seeds = [b"share_mint", vault_state.token_mint.as_ref()],
        bump,
        mint::authority = vault_state,
    )]
    pub share_mint: Account<'info, Mint>,

    /// Токен-аккаунт пользователя (откуда списываем токены)
    #[account(
        mut,
        token::mint = vault_state.token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    /// Share-аккаунт пользователя (куда придут shares)
    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user,
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    /// CHECK: Canonical strategy token account may be uninitialized before initialize_swap.
    #[account(seeds=[b"vault_output",vault_state.key().as_ref()],bump)]
    pub strategy_token_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault_state.token_mint.as_ref()],
        bump = vault_state.bump,
    )]
    pub vault_state: Account<'info, VaultState>,

    #[account(
        mut,
        seeds = [b"user_card", vault_state.key().as_ref(), user.key().as_ref()],
        bump = user_card.bump,
    )]
    pub user_card: Account<'info, UserCard>,

    #[account(
        mut,
        seeds = [b"vault_tokens", vault_state.token_mint.as_ref()],
        bump,
        token::mint = vault_state.token_mint,
        token::authority = vault_state,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"share_mint", vault_state.token_mint.as_ref()],
        bump,
        mint::authority = vault_state,
    )]
    pub share_mint: Account<'info, Mint>,

    #[account(
        mut,
        token::mint = vault_state.token_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user,
    )]
    pub user_share_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    /// CHECK: Canonical strategy token account may be uninitialized before initialize_swap.
    #[account(seeds=[b"vault_output",vault_state.key().as_ref()],bump)]
    pub strategy_token_account: UncheckedAccount<'info>,
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

#[account]
#[derive(Default)]
pub struct VaultState {
    pub admin: Pubkey,               // 32
    pub token_mint: Pubkey,          // 32 — SPL-токен vault'а
    pub vault_token_account: Pubkey, // 32 — PDA для токенов
    pub share_mint: Pubkey,          // 32 — mint для shares
    pub total_tokens: u64,           // 8  — всего токенов в vault
    pub total_shares: u64,           // 8  — всего выпущено shares
    pub strategy_active: bool,
    pub bump: u8, // 1
}

impl VaultState {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 1;
}

/// Карточка пользователя в vault.
#[account]
#[derive(Default)]
pub struct UserCard {
    pub vault: Pubkey,  // 32 — к какому vault относится
    pub owner: Pubkey,  // 32 — владелец карточки
    pub deposited: u64, // 8 — сколько токенов внёс пользователь
    pub shares: u64,    // 8 — сколько shares у пользователя
    pub bump: u8,       // 1
}

impl UserCard {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Position is already active")]
    PositionActive,
    #[msg("No active position")]
    NoPosition,
    #[msg("Invalid position or NFT custody")]
    InvalidPosition,
    #[msg("Invalid tick range or alignment")]
    InvalidTicks,
    #[msg("Reward-bearing pools are unsupported")]
    UnsupportedRewards,
    #[msg("Only the vault administrator may swap")]
    Unauthorized,
    #[msg("Pool is not bound to this vault")]
    InvalidPool,
    #[msg("Wrong swap mint pair")]
    InvalidMint,
    #[msg("Input balance is insufficient")]
    InsufficientBalance,
    #[msg("Minimum output must be positive")]
    InvalidMinimum,
    #[msg("Invalid CLMM tick array or bitmap")]
    InvalidTickArray,
    #[msg("Pool has no active liquidity")]
    NoLiquidity,
    #[msg("Exact input swap was only partially filled")]
    PartialFill,
    #[msg("Received less than minimum output")]
    SlippageExceeded,
    #[msg("Single-token deposits and withdrawals are disabled after rebalancing")]
    StrategyActive,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Shares would be zero - deposit too small")]
    SharesTooSmall,
    #[msg("Vault has no outstanding shares")]
    VaultEmpty,
    #[msg("Withdrawal rounds down to zero tokens")]
    WithdrawTooSmall,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Recorded assets differ from the actual token balance")]
    StaleAccounting,
    #[msg("Recorded shares differ from the SPL mint supply")]
    ShareSupplyMismatch,
    #[msg("TOKEN_B must be fully converted before unlocking")]
    UnsettledTokenB,
    #[msg("Reverse swap must consume the entire TOKEN_B balance")]
    IncompleteConversion,
    #[msg("Strategy is not active")]
    StrategyInactive,
    #[msg("Settlement is already reconciled")]
    AlreadySettled,
    #[msg("Outstanding shares have no backing assets")]
    InsolventVault,
    #[msg("Requested redemption exceeds the user's share balance")]
    InsufficientShares,
    #[msg("Assets without outstanding shares require explicit handling")]
    OrphanAssets,
}

fn check_strategy_token_account(info: &AccountInfo, vault: Pubkey) -> Result<()> {
    if info.data_is_empty() {
        require_keys_eq!(
            *info.owner,
            anchor_lang::system_program::ID,
            VaultError::InvalidMint
        );
        return Ok(());
    }
    require_keys_eq!(*info.owner, anchor_spl::token::ID, VaultError::InvalidMint);
    let account = TokenAccount::try_deserialize(&mut &info.try_borrow_data()?[..])?;
    require_keys_eq!(account.owner, vault, VaultError::InvalidMint);
    require!(account.amount == 0, VaultError::UnsettledTokenB);
    Ok(())
}
fn check_idle_accounting(vault: &VaultState, tokens: &TokenAccount, mint: &Mint) -> Result<()> {
    require!(
        vault.total_shares == mint.supply,
        VaultError::ShareSupplyMismatch
    );
    require!(
        vault.total_tokens == tokens.amount,
        VaultError::StaleAccounting
    );
    Ok(())
}

fn tokens_for_shares(shares_amount: u64, total_tokens: u64, total_shares: u64) -> Option<u64> {
    (shares_amount as u128)
        .checked_mul(total_tokens as u128)
        .and_then(|value| value.checked_div(total_shares as u128))
        .and_then(|value| u64::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::tokens_for_shares;

    #[test]
    fn withdrawal_calculation_uses_integer_rounding_down() {
        assert_eq!(tokens_for_shares(2, 10, 3), Some(6));
    }

    #[test]
    fn withdrawal_calculation_can_round_down_to_zero() {
        assert_eq!(tokens_for_shares(1, 2, 3), Some(0));
    }

    #[test]
    fn withdrawal_calculation_rejects_division_by_zero() {
        assert_eq!(tokens_for_shares(1, 2, 0), None);
    }
}

#[cfg(test)]
mod settlement_accounting_tests {
    use super::*;
    #[test]
    fn final_redemption_returns_every_remaining_unit() {
        assert_eq!(tokens_for_shares(7, 101, 7), Some(101));
    }
    #[test]
    fn split_rounding_never_overdraws() {
        for assets in 1..50 {
            for shares in 1..30 {
                for burn in 1..shares {
                    let first = tokens_for_shares(burn, assets, shares).unwrap();
                    let last =
                        tokens_for_shares(shares - burn, assets - first, shares - burn).unwrap();
                    assert_eq!(first + last, assets);
                }
            }
        }
    }
    #[test]
    fn checked_redemption_handles_u64_limits() {
        assert_eq!(
            tokens_for_shares(u64::MAX, u64::MAX, u64::MAX),
            Some(u64::MAX)
        );
    }
}
