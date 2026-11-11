import { ASSETS, HF_ALERT, AAVE_V3_CORE } from "@/config/assets";

export function GET() {
  return Response.json({
    venue: AAVE_V3_CORE.name,
    hfAlert: HF_ALERT,
    assets: ASSETS.map((a) => ({ symbol: a.symbol, debtSymbol: a.debtSymbol ?? "WETH", logo: `/assets/${a.symbol}.png` })),
  });
}
