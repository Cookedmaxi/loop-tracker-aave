// Where Aave figures come from: reserve settings, prices, balances, debt and health factors.
// Today: read on-chain (lib/chain.ts). Next: the TokenLogic API, behind the same two functions,
// so the pages and the transaction code do not change when the source does.
// Pick with AAVE_SOURCE=onchain (default) or AAVE_SOURCE=tokenlogic.

import type { Address } from "@/config/assets";
import { readMarket, readPositions, type ChainMarket, type ChainPosition, type Reserve } from "./chain";

export interface AaveSource {
  name: string;
  readMarket(r: Reserve): Promise<ChainMarket>;
  readPositions(r: Reserve, holders: Address[]): Promise<ChainPosition[]>;
}

const onchain: AaveSource = { name: "On-chain", readMarket, readPositions };

// Placeholder until the TokenLogic API's endpoints, response format and key are known.
const tokenlogic: AaveSource = {
  name: "TokenLogic API",
  readMarket: () => Promise.reject(new Error("The TokenLogic API source is not connected yet. Set AAVE_SOURCE=onchain.")),
  readPositions: () => Promise.reject(new Error("The TokenLogic API source is not connected yet. Set AAVE_SOURCE=onchain.")),
};

export function aaveSource(): AaveSource {
  return process.env.AAVE_SOURCE === "tokenlogic" ? tokenlogic : onchain;
}
