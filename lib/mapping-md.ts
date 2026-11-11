// The mapping as Markdown, laid out like the team's mapping documents.

import type { MappingHolder, MappingResponse } from "./types";

const usd = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`);
const num = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n >= 0.0001 ? n.toFixed(4) : n.toPrecision(2));
const pct = (n: number | null | undefined, d = 1) => (n == null || !Number.isFinite(n) ? "—" : n < 0.1 && n > 0 ? "<0.1%" : `${n.toFixed(d)}%`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const debank = (a: string) => `[${short(a)}](https://debank.com/profile/${a})`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export const loopCell = (x: MappingHolder, symbol: string) =>
  x.kind === "Loop" ? `Yes — ${symbol}/${x.loopsAgainst}` : x.kind === "Supply only" ? "No — supply only" : x.kind === "Borrows stables" ? "No — borrows stables" : `No — borrows ${x.debts[0]?.symbol ?? "other assets"}`;
export const debtCell = (x: MappingHolder) => (x.debts.length ? x.debts.slice(0, 3).map((d) => `${num(d.amount)} ${d.symbol}`).join(" + ") : "—");
export const tagCell = (x: MappingHolder) => x.tag ?? (x.ens ? `${x.isContract ? "Contract" : "EOA"} — ${x.ens}` : x.isContract ? (x.contractName ? `Contract: ${x.contractName}` : "Contract, unlabeled") : "EOA, unlabeled");

export function mappingMarkdown(m: MappingResponse): string {
  const L: string[] = [];
  const s = m.symbol;
  L.push(`# ${s} on Aave V3 Core — Holder & Loop Breakdown`, "", `${day(m.readAt)} · Loop Tracker`, "");
  L.push("## Summary", "");
  L.push(`The ${s} market on Aave V3 Core: ${m.loopers} of ${m.listed} listed holders loop ${s}, holding ${pct(m.loopSharePct)} of the supply; together the holders back ${usd(m.debtBackedUsd)} of debt.`, "");
  L.push(`- **Total supplied:** ${num(m.totalSupplied)} ${s} (≈ ${usd(m.totalSuppliedUsd)} at $${m.priceUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}), across ${m.holderCount ?? m.listed} holders.`);
  L.push(`- **Concentration:** the #1 holder holds ${pct(m.top1Pct)} of the market; the top 3 hold ${pct(m.top3Pct)} and the top 10 ${pct(m.top10Pct)}.`);
  L.push(`- **Debt backed:** ${m.debtByAsset.slice(0, 5).map((d) => `${num(d.amount)} ${d.symbol}`).join(", ")} (pro rata to each wallet's collateral mix).`);
  if (m.leverageRange) L.push(`- **Looping:** ${m.bigLoops} loops above $10k of debt, at ${m.leverageRange[0].toFixed(1)}–${m.leverageRange[1].toFixed(1)}x leverage and ${m.ltvRange ? `${m.ltvRange[0].toFixed(0)}–${m.ltvRange[1].toFixed(0)}%` : "—"} LTV.`);
  L.push(`- **Rest of the book:** ${m.othersCount} holders that do not loop hold ${num(m.othersSupplied)} ${s}; they supply only or borrow other assets against it.`, "");
  if (m.known.length || m.unknown.length) {
    L.push("**Known holders, contact directly:**", "");
    for (const k of m.known) L.push(`- ${k.website ? `[${k.entity}](${k.website})` : k.entity}${k.x ? ` ([X](${k.x}))` : ""} — ${k.ranks.map((r) => `#${r}`).join(", ")}, ${usd(k.debtUsd)} of debt${k.status ? `. ${k.status}` : ""}${k.approach ? ` Approach: ${k.approach}.` : ""}`);
    if (m.unknown.length) L.push("", `**Unknown positions (${m.unknown.map((u) => `#${u.rank}`).join(", ")}):** no public label; reach through a short on-chain message from a public TokenLogic address pointing to the forum post, announced on the forum or X first so they can verify it.`);
    L.push("");
  }
  L.push("## Holders", "");
  L.push(`${m.listed} holders above $${m.dustUsd} are listed. Links open each wallet on DeBank.`, "");
  L.push(`| # | Holder (DeBank) | ${s} supplied | Share | Loops ${s}? | Aave debt | Health factor | Entity tag |`, "| --- | --- | ---: | ---: | --- | --- | ---: | --- |");
  for (const x of m.holders) L.push(`| ${x.rank} | ${debank(x.address)} | ${num(x.supplied)} | ${pct(x.sharePct)} | ${loopCell(x, s)} | ${debtCell(x)} | ${x.healthFactor ? x.healthFactor.toFixed(3) : "—"} | ${tagCell(x)} |`);
  L.push("", `## ${m.loopers > m.loops.length / 2 ? "Loop details" : "Borrower details"}`, "");
  L.push(`Every position backing $10k or more of debt (${m.loops.length}).`, "");
  L.push(`| # | Holder | ${s} collateral | Debt | Debt ÷ ${s} units | LTV | Leverage | Net equity | Health factor | Drop to liquidation |`, "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const x of m.loops) L.push(`| ${x.rank} | ${debank(x.address)} ${x.tag ? `(${x.tag})` : ""} | ${usd(x.suppliedUsd)} | ${debtCell(x)} | ${x.debtPerUnit?.toFixed(3) ?? "—"} | ${pct(x.ltvPct)} | ${x.leverage ? `${x.leverage.toFixed(1)}x` : "—"} | ${usd(x.netEquityUsd)} | ${x.healthFactor?.toFixed(3) ?? "—"} | ${pct(x.dropToLiquidationPct, 2)} |`);
  if (m.notes.length) { L.push("", "Notes on individual positions:", ""); for (const n of m.notes) L.push(`- **#${n.rank}** — ${n.text}`); }
  L.push("", "## Methodology & caveats", "");
  L.push(`Balances, debts and health factors are read on-chain from Aave V3 Core on ${day(m.readAt)}: aToken and variable-debt balances per wallet, and the Pool's own getUserAccountData.`, "");
  L.push("- **Debt backed:** a wallet's debt attributed to this asset pro rata to its collateral mix.");
  L.push("- **Drop to liquidation:** how far this asset can fall against what is borrowed before the health factor reaches 1, other collateral held constant.");
  L.push("- **Spark:** checked for every position above $10k of debt.");
  L.push("- **Entity tags:** team tags, tags added on the site, contract names and ENS; no Arkham or DeBank labels are read automatically.", "");
  if (m.questions.length) { L.push("Open questions:", ""); for (const q of m.questions) L.push(`- ${q}`); L.push(""); }
  return L.join("\n");
}
