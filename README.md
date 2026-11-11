# TokenLogic · Loop Tracker

Tracks leveraged loop positions on Aave V3 Core. Figures are read when the page is opened, every minute while it stays open, and when **Refresh** is pressed.

| Tab | What it shows | Where it comes from |
|---|---|---|
| Loops | Top holders per asset: supplied, debt, leverage, health factor, liquidations. Select a row for the holder's identity and last transactions. | Blockscout (holder list, labels) + RPC (balances, `getUserAccountData`) + TokenLogic API (liquidations) |
| Offboarding | Progress of the rsETH offboarding against the plan (LlamaRisk, 2 Nov 2026): debt repaid since the baseline, daily history, plan steps ticked from on-chain changes, triggers, and whether each loop still earns at today's rates, +50 and +100 bps. | RPC (past balances, oracle, Pool rates, Pool Configurator events) + `config/plan.ts` for the plan's own figures |
| Market | Supply, price, rates, utilization, debt against it, concentration, reserve status and caps; then the issuer: peg (market price vs exchange rate), backing by asset, share held on Aave, exit liquidity, risk findings and incidents. | TokenLogic API (reserve data, rates), checked against RPC (aToken supply, Aave oracle, Pool configuration) |
| Last tx | Aave actions (Supply, Withdraw, Borrow, Repay, Liquidation) and other token transfers, market-wide and per holder. | Aave Pool events via RPC; liquidations also from the TokenLogic API; other transfers from Blockscout |
| Tagged entities | Tags anyone with access adds on the site (name, reasoning, links), then the team's entities and tagged addresses. | Shared storage (Upstash Redis) + `/data/*.json` |

Each transaction row says where it came from: **Aave Pool** (event read on-chain), **TokenLogic**, or **Transfer** (Blockscout).

## Run it

```bash
npm install
cp .env.example .env.local   # then fill RPC_URL (SITE_PASSWORD is optional locally)
npm run dev                  # http://localhost:3000
```

## Deploy on Vercel

1. Push this folder to a Git repository.
2. In Vercel: **Add New → Project**, import the repository (framework is detected as Next.js).
3. Add the environment variables: `RPC_URL`, `TOKENLOGIC_API_KEY`, and `SITE_PASSWORD` to require a password (optional).
4. In **Storage**, add Upstash Redis (Marketplace) and connect it to the project, so tags added on the site are shared.
5. Deploy. Every later `git push` redeploys automatically.

With `SITE_PASSWORD` set, the site asks for it through the browser's sign-in prompt (any username). Without it, anyone with the link can open the site.

## Everyday changes

| I want to… | Edit |
|---|---|
| Track another asset's offboarding | `config/plan.ts`: baseline, steps. |
| Edit an issuer's risk findings or incidents | `config/risk.ts` |
| Add an asset | `config/assets.ts`: add `{ symbol, underlying }`. Add a logo at `public/assets/<symbol>.png` (optional). |
| Track more or fewer holders | `TOP_HOLDERS` in `config/assets.ts` |
| Change the alert level | `HF_ALERT` in `config/assets.ts` |
| Tag an address | `data/tags.json`. `match` is a full address or a short form like `0x40E9…AbA8`. |
| Add an entity, its links or its outreach status | `data/entities.json` |
| Add an identity note on a wallet | `data/notes.json` |

Commit and push; Vercel redeploys.

## Replace the password with Clerk

`middleware.ts` is the only file involved. Swap its content for `clerkMiddleware()` from `@clerk/nextjs/server`, wrap `app/layout.tsx` in `<ClerkProvider>`, and restrict sign-ins to the team's email domain in the Clerk dashboard (or check the email domain in the middleware).

## Limits to know

- **Not yet run against a live RPC, Blockscout or the authenticated TokenLogic endpoints.** The code was exercised end-to-end against local stand-ins. If a table is empty, look at `lib/blockscout.ts` (field names vary between versions) or `lib/tokenlogic.ts`.
- If the TokenLogic supply differs from the on-chain aToken supply by more than 5 %, the on-chain figure is shown and the Market tab says so.
- Health factor, leverage and drop to liquidation are for the **whole wallet** on Aave (all collateral, all debt), which is what decides liquidation.
- Max LTV and liquidation threshold on the Market tab are the reserve's base settings, outside e-mode.
- "Debt against the market" is the debt of the tracked holders only.
- Aave actions are the Pool's own events over the last ~30 days per holder (`AAVE_EVENTS_LOOKBACK_BLOCKS`, default 216 000) and ~7 days for the market feed. The history is read once (about 140 `eth_getLogs`) and saved in Upstash; after that each refresh reads only the new blocks, one call per feed. If the RPC refuses a block span, it is split automatically. Timestamps are block times. If the event read fails, the site falls back to aToken and debt-token mints and burns from Blockscout.
- Other transfers: latest ~50 per market, ~25 per holder, from Blockscout.
- Answers are cached for 60 seconds per server instance (`CACHE_SECONDS`), so repeated clicks do not burn RPC quota. Refresh bypasses the cache.
- RPC usage with the page open all day: roughly 350 Alchemy compute units a minute, about 15M a month, inside Alchemy's free 30M.
- The site is up to date whenever someone is looking at it, but does nothing while nobody is: no stored history, no alerts sent. Day-over-day changes and Telegram alerts need a scheduled job (Vercel Cron) writing snapshots to the database.
