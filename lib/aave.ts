// Aave figures for a reserve, from two sources:
// - TokenLogic API: supply, borrows, utilization, prices and rates. With TOKENLOGIC_API_KEY
//   it uses /v1/aave/reserves; without a key, only the public interest-rate endpoints.
// - On-chain (lib/chain.ts): reserve settings (LTV, liquidation threshold, frozen, caps) and
//   every wallet's position, which the API does not give. On-chain values also stand in
//   when the API does not answer.

import { AAVE_V3_CORE } from "@/config/assets";
import { readMarket, type ChainMarket, type Reserve } from "./chain";
import { hasTokenLogicKey, latestRate, reserveLatest } from "./tokenlogic";

export interface AaveMarket extends ChainMarket {
  source: "TokenLogic API" | "On-chain";
  supplyApy: number | null;      // %, collateral asset
  debtBorrowApy: number | null;  // %, debt asset
  utilization: number | null;    // %, collateral asset
  borrowedTokens: number | null; // collateral asset borrowed on the reserve
  dataAsOf: string | null;       // TokenLogic's lastUpdated
  notes: string[];               // why a figure fell back to on-chain
}

const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x) * 100);

export async function readAaveMarket(r: Reserve): Promise<AaveMarket> {
  const base = await readMarket(r);
  const out: AaveMarket = { ...base, source: "On-chain", supplyApy: null, debtBorrowApy: null, utilization: null, borrowedTokens: null, dataAsOf: null, notes: [] };

  if (hasTokenLogicKey()) {
    try {
      const [own, debt] = await Promise.all([
        reserveLatest(AAVE_V3_CORE.marketKey, r.underlying),
        reserveLatest(AAVE_V3_CORE.marketKey, r.debtUnderlying),
      ]);
      if (own.row) {
        // Supply must agree with the chain; if it does not, keep the chain's figure and say so.
        const gap = base.suppliedTokens ? Math.abs(own.row.deposits / base.suppliedTokens - 1) : 0;
        if (gap <= 0.05) out.suppliedTokens = own.row.deposits;
        else out.notes.push(`TokenLogic supply differs from the chain by ${(gap * 100).toFixed(1)}%; on-chain supply shown.`);
        if (own.row.reserve_price > 0) out.priceUsd = own.row.reserve_price;
        out.supplyApy = pct(own.row.supply_apy);
        out.utilization = pct(own.row.utilization);
        out.borrowedTokens = own.row.borrows;
        out.source = "TokenLogic API";
        out.dataAsOf = own.lastUpdated;
      }
      if (debt.row) {
        if (debt.row.reserve_price > 0) out.debtPriceUsd = debt.row.reserve_price;
        out.debtBorrowApy = pct(debt.row.borrow_apy);
      }
      return out;
    } catch (err) {
      out.notes.push(`TokenLogic API unavailable (${err instanceof Error ? err.message : "error"}); on-chain figures shown.`);
    }
  }

  // No key, or the keyed endpoints failed: rates from the public endpoint.
  const [own, debt] = await Promise.all([
    latestRate(r.symbol, AAVE_V3_CORE.ratesMarket, AAVE_V3_CORE.chain).catch(() => null),
    latestRate(r.debtSymbol, AAVE_V3_CORE.ratesMarket, AAVE_V3_CORE.chain).catch(() => null),
  ]);
  out.supplyApy = pct(own?.deposit_apy);
  out.debtBorrowApy = pct(debt?.borrow_apy);
  return out;
}
