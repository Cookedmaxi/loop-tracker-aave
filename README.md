# TokenLogic · Loop Tracker

Tracks leveraged loop positions on Aave V3 Core. Every figure is read on-chain when the page is opened or when **Refresh** is pressed.

| Tab | What it shows | Where it comes from |
|---|---|---|
| Loops | Top holders per asset: supplied, debt, leverage, health factor. Select a row for the holder's identity and last transactions. | Blockscout (holder list, transfers, labels) + RPC (balances, `getUserAccountData`) |
| Market | Supply in tokens, ETH and USD, debt against it, concentration, reserve status and caps. | RPC (aToken supply, Aave oracle, Pool configuration) |
| Last tx | Market-wide moves and each tracked holder's transfers, with filters. | Blockscout |
| Tagged entities | Entities, how each is approached, interactions with holders, tagged addresses. | `/data/*.json` (team-maintained) matched against on-chain addresses |

The only things that are not on-chain are the team's own tags and notes in `/data`.

## Run it

```bash
npm install
cp .env.example .env.local   # then fill RPC_URL (SITE_PASSWORD is optional locally)
npm run dev                  # http://localhost:3000
```

## Deploy on Vercel

1. Push this folder to a Git repository.
2. In Vercel: **Add New → Project**, import the repository (framework is detected as Next.js).
3. Add two environment variables: `RPC_URL` and `SITE_PASSWORD`.
4. Deploy. Every later `git push` redeploys automatically.

The site asks for the password through the browser's sign-in prompt (any username). In production it refuses to start without `SITE_PASSWORD`.

## Everyday changes

| I want to… | Edit |
|---|---|
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

- **Not yet run against a live RPC or the live Blockscout API.** The code was exercised end-to-end against local stand-ins that mimic both. Blockscout field names vary between versions; `lib/blockscout.ts` reads both spellings and is the first place to look if a table is empty.
- Health factor, leverage and drop to liquidation are for the **whole wallet** on Aave (all collateral, all debt), which is what decides liquidation.
- Max LTV and liquidation threshold on the Market tab are the reserve's base settings, outside e-mode.
- "Debt against the market" is the debt of the tracked holders only.
- Transactions are ERC-20 transfers (latest ~50 per market, ~25 per holder). Supply, Withdraw, Borrow and Repay are recognised from mints and burns of the aToken and the debt token.
- Answers are cached for 60 seconds per server instance (`CACHE_SECONDS`), so repeated clicks do not burn RPC quota. Refresh bypasses the cache.
- No history is stored yet: the site shows the chain as it is now. Day-over-day changes and Telegram alerts need a database and a scheduled job.
