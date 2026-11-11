// ─────────────────────────────────────────────────────────────────────────────
// Issuer profile per asset, shown under the Market tab: where live figures are read
// (Kelp's contracts, CoinGecko) and the risk findings and incidents, each with its source.
// Live figures come from the chain; the text below is quoted from the sources named.
// ─────────────────────────────────────────────────────────────────────────────

import type { Address } from "./assets";

export interface RiskProfile {
  issuer: string;
  website: string;
  coingeckoId: string;
  /** Kelp LRT contracts on Ethereum. */
  depositPool: Address;
  oracle: Address;
  backingAssets: { symbol: string; address: Address }[];
  exit: { text: string; source: string };
  findings: { area: string; text: string }[];
  findingsSource: { label: string; date: string };
  incidents: { date: string; title: string; text: string; links: { label: string; url: string }[] }[];
}

const ETH_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

export const RISK: Record<string, RiskProfile> = {
  rsETH: {
    issuer: "Kelp DAO",
    website: "https://kelpdao.xyz",
    coingeckoId: "kelp-dao-restaked-eth",
    depositPool: "0x036676389e48133B63a802f8635AD39E752D375D",
    oracle: "0x349A73444b1a310BAe67ef67973022020d70020d",
    backingAssets: [
      { symbol: "ETH", address: ETH_SENTINEL },
      { symbol: "stETH", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" },
      { symbol: "ETHx", address: "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b" },
    ],
    exit: { text: "DEX liquidity absorbs about 656 rsETH ($1.5M) within 1% price impact, through a single Fluid pool. At scale, rsETH unwinds only through Kelp's 15 to 21 day withdrawal queue.", source: "LlamaRisk, 2 November 2026" },
    findingsSource: { label: "LlamaRisk rsETH re-evaluation", date: "9 November 2026" },
    findings: [
      { area: "Restaking", text: "Backing is restaked through EigenLayer. All delegated stake, 88% of the backing, sits with two operators, P2P.org and Luganodes. Neither allocates slashable stake to an AVS today, but Kelp's 3-of-6 Manager Safe can redelegate without delay." },
      { area: "Underlying LSTs", text: "49% of the backing is stETH, which Kelp values at a fixed 1 ETH, so a stETH discount does not reach the rsETH rate. 12% is ETHx, issued by Stader Labs, whose founders also founded Kelp." },
      { area: "Timelocks", text: "Only code upgrades sit behind Kelp's 10-day timelock. Minting rights, the daily mint cap, oracle sources and the exchange-rate guard can change without delay; the timelock on asset additions was bypassed by Kelp's Mantle Safe on 5 October." },
      { area: "Bridges", text: "Neither the LayerZero nor the CCIP bridge is under a timelock. The LayerZero route behind Aave's Arbitrum reserve has no rate limit and no pause." },
      { area: "Signers", text: "Signer identities are undisclosed. Five keys sit on every Kelp Safe across seven chains, so any three control the Manager role and every bridge contract. The operator and asset-transfer roles include EOAs." },
      { area: "Holder protections", text: "A 3-of-6 Safe can block transfers of any non-exempt holder, after which the Admin Safe can sweep the balance to Kelp's custody, a power used three times since April. Kelp has no policy on loss allocation between Ethereum and bridged holders." },
      { area: "Concentration", text: "Aave V3 Core holds 84% of all rsETH, almost entirely looped against WETH at 12 to 14 times leverage." },
    ],
    incidents: [
      {
        date: "2026-04-18",
        title: "Bridge exploit: 116,500 unbacked rsETH minted",
        text: "A forged message on Kelp's LayerZero bridge minted 116,500 rsETH with no backing, about $292M, widely attributed to the Lazarus Group. About 107,000 of it ended up as collateral on Aave. Aave froze rsETH on V3 and V4, and Kelp paused rsETH contracts on Ethereum and several L2s.",
        links: [
          { label: "The Block", url: "https://www.theblock.co/post/399118/defi-united-detailed-plan" },
          { label: "Cointelegraph", url: "https://cointelegraph.com/news/restaking-platform-kelp-exploited-293-million" },
        ],
      },
      {
        date: "2026-04-28",
        title: "DeFi United recovery plan",
        text: "An Aave-led coalition raised over $300M in ETH to convert into rsETH and restore the bridge backing, liquidate eight affected positions on Aave Ethereum Core and Arbitrum with a temporarily adjusted oracle price, then unfreeze rsETH markets. The shortfall was closed by DeFi United, not by an issuer rule.",
        links: [{ label: "The Block", url: "https://www.theblock.co/post/399118/defi-united-detailed-plan" }],
      },
      {
        date: "2026-10-05",
        title: "Timelock on asset additions bypassed",
        text: "Kelp's Mantle Safe added an asset without going through the timelock.",
        links: [],
      },
    ],
  },
};
