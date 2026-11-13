"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KELP_INPUTS } from "@/config/kelp";
import * as KM from "@/lib/kelp-model";
import type { CommunityTag, Entity, HolderDetail, LookupResponse, LoopsResponse, MappingHolder, MappingResponse, Market, PlanResponse, Position, RiskResponse, Tag, Tx } from "@/lib/types";

// ── small helpers ───────────────────────────────────────────────────────────

type TabId = "loops" | "plan" | "mapping" | "market" | "tx" | "entities" | "data";
const TABS: { id: TabId; label: string }[] = [
  { id: "loops", label: "Loops" },
  { id: "plan", label: "Offboarding" },
  { id: "mapping", label: "Mapping" },
  { id: "market", label: "Market" },
  { id: "tx", label: "Last tx" },
  { id: "entities", label: "Tagged entities" },
  { id: "data", label: "Data" },
];
const TX_TYPES = ["Supply", "Withdraw", "Borrow", "Repay", "Liquidation", "Transfer", "Send", "Receive"];
const BRAND = ["#2468fc", "#00c880", "#f2c200", "#fc4434", "#8b5cf6", "#06b6d4", "#fb923c", "#e879f9"];
const DASH = "—";

interface Meta { venue: string; hfAlert: number; assets: { symbol: string; debtSymbol: string; logo: string; aaveUrl?: string; etherscanUrl?: string }[] }
interface RegistryData { entities: Entity[]; tags: { match: string; label: string; entity: string; kind: string }[] }

const fmt = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? DASH : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtAmount = (n: number) => fmt(n, Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 2 : 4);
const usd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? DASH : n >= 1e9 ? `$${fmt(n / 1e9, 2)}B` : n >= 1e7 ? `$${fmt(n / 1e6, 1)}M` : n >= 1e6 ? `$${fmt(n / 1e6, 2)}M` : n >= 1e4 ? `$${fmt(n / 1e3, 0)}k` : `$${fmt(n, 0)}`;
const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined || !Number.isFinite(n) ? DASH : `${fmt(n, digits)}%`);
const short = (a: string | null | undefined) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : DASH);
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

const EXPLORERS: [string, (a: string) => string][] = [
  ["Etherscan", (a) => `https://etherscan.io/address/${a}`],
  ["DeBank", (a) => `https://debank.com/profile/${a}`],
  ["Arkham", (a) => `https://intel.arkm.com/explorer/address/${a}`],
];

// ── small components ────────────────────────────────────────────────────────

function AssetLogo({ symbol, src }: { symbol: string; src?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span className="logo fallback" aria-hidden="true">{symbol.slice(0, 1)}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="logo" src={src} alt="" onError={() => setBroken(true)} />;
}

/** Every asset's logo, overlapping: the "All assets" mark. */
function AssetStack({ assets }: { assets: { symbol: string; logo: string }[] }) {
  return (
    <span className="logo-stack" aria-hidden="true">
      {assets.map((a, i) => <span key={a.symbol} style={{ zIndex: assets.length - i }}><AssetLogo symbol={a.symbol} src={a.logo} /></span>)}
    </span>
  );
}

function EntityTag({ entity, colors, community }: { entity: string | null | undefined; colors: Map<string, string>; community?: boolean }) {
  if (!entity) return <span className="muted">{DASH}</span>;
  return (
    <span className={`tag ${community ? "community" : ""}`} title={community ? "Tagged by the team on the site, not yet in data/tags.json" : undefined}>
      <i className="dot" style={{ background: colors.get(entity) ?? "var(--muted)" }} aria-hidden="true" />
      {entity}
    </span>
  );
}

function Addr({ address }: { address: string | null | undefined }) {
  if (!address) return <span className="muted">{DASH}</span>;
  return <a className="link mono" href={`https://etherscan.io/address/${address}`} target="_blank" rel="noopener noreferrer">{short(address)}</a>;
}

function HealthFactor({ value, alert }: { value: number | null; alert: number }) {
  if (value === null) return <span className="muted">{DASH}</span>;
  const tone = value < alert ? "bad" : value < alert + 0.03 ? "warn" : "good";
  const buffer = Math.max(0, Math.min(1, (value - 1) / 0.1)); // full bar = 10% above liquidation
  return (
    <span className={`hf ${tone}`}>
      <span className="meter" aria-hidden="true"><i style={{ width: `${buffer * 100}%` }} /></span>
      <span className="num">{fmt(value, 3)}</span>
    </span>
  );
}

function Cell({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="cell">
      <p className="k">{label}</p>
      <p className={`v ${tone ?? ""}`}>{value}{sub ? <small>{sub}</small> : null}</p>
    </div>
  );
}

/** Stablecoin borrowers: debt is shown in USD, and they borrow rather than loop. */
const isStable = (debtSymbol: string | undefined) => debtSymbol === "Stablecoins";

const holderName = (p: Position) => p.tag?.label ?? p.ens ?? p.contractName ?? (p.isContract ? "Contract" : "Wallet");

function TxTable({ rows, colors, showWallet }: { rows: Tx[]; colors: Map<string, string>; showWallet: boolean }) {
  return (
    <div className="scroll">
      <table className="stack txs">
        <thead>
          <tr>
            <th>Time</th>
            {showWallet ? <th>Wallet</th> : null}
            <th>Type</th>
            <th className="r">Amount</th>
            <th>Token</th>
            <th>Counterparty</th>
            <th>Tag</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="nw time">{when(t.timestamp)}</td>
              {showWallet ? (
                <td className="who">
                  {t.walletRank ? `#${t.walletRank} ` : ""}{t.walletTag?.label ?? ""}
                  <span className="sub"><Addr address={t.wallet} /></span>
                </td>
              ) : null}
              <td className="nw" data-label="Type">
                {t.action}
                <span className="sub" title={t.source === "Aave event" ? "Read from the Aave Pool contract" : t.source === "TokenLogic" ? "Reported by the TokenLogic API" : "Token transfer from Blockscout"}>{t.source === "Aave event" ? "Aave Pool" : t.source}</span>
                {t.detail ? <span className="sub">{t.detail}</span> : null}
              </td>
              <td className="r" data-label="Amount">{fmtAmount(t.amount)}</td>
              <td className="nw" data-label="Token">{t.tokenSymbol || short(t.tokenAddress)}</td>
              <td data-label="Counterparty">
                {t.counterpartyTag?.label ?? ""}
                <span className={t.counterpartyTag ? "sub" : ""}><Addr address={t.counterparty} /></span>
              </td>
              <td data-label="Tag"><EntityTag entity={t.counterpartyTag?.entity} colors={colors} /></td>
              <td data-label="Tx"><a className="link mono" href={`https://etherscan.io/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer">{t.txHash.slice(0, 10)}…</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function Page() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [picked, setPicked] = useState<string[]>([]); // empty = all assets
  const [tab, setTab] = useState<TabId>("loops");
  const [loops, setLoops] = useState<Record<string, LoopsResponse>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<{ asset: string; address: string } | null>(null);
  const [urlReady, setUrlReady] = useState(false);
  const [lookupQ, setLookupQ] = useState<string | null>(null);
  const [tx, setTx] = useState<Record<string, Tx[]>>({});
  const [txBusy, setTxBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [community, setCommunity] = useState<CommunityTag[]>([]);
  const [communityError, setCommunityError] = useState<string | null>(null);
  const loadCommunity = useCallback(() => {
    getJson<{ tags: CommunityTag[] }>("/api/community-tags").then((r) => { setCommunity(r.tags); setCommunityError(null); }).catch((e) => setCommunityError(e.message));
  }, []);

  const assets = useMemo(() => meta?.assets ?? [], [meta]);
  const shown = useMemo(() => (picked.length ? assets.filter((a) => picked.includes(a.symbol)) : assets), [assets, picked]);
  const logoOf = useCallback((symbol: string) => assets.find((a) => a.symbol === symbol)?.logo, [assets]);
  const hfAlert = meta?.hfAlert ?? 1.03;

  const colors = useMemo(() => {
    const map = new Map<string, string>();
    const names = [...(registry?.entities ?? []).map((e) => e.entity), ...community.map((t) => t.entity)];
    Array.from(new Set(names)).filter((e) => !/^unknown/i.test(e)).forEach((e, i) => map.set(e, BRAND[i % BRAND.length]));
    return map;
  }, [registry, community]);
  /** Newest community tag per address, used where the team has no tag yet. */
  const communityOf = useMemo(() => {
    const m = new Map<string, CommunityTag>();
    for (const t of community) if (!m.has(t.address.toLowerCase())) m.set(t.address.toLowerCase(), t);
    return m;
  }, [community]);

  // Reads positions and market figures from the chain for every asset.
  const loadLoops = useCallback(async (list: Meta["assets"], fresh: boolean) => {
    setBusy(true);
    const results = await Promise.all(list.map(async (a) => {
      try { return [a.symbol, await getJson<LoopsResponse>(`/api/loops?asset=${a.symbol}${fresh ? "&fresh=1" : ""}`), null] as const; }
      catch (e) { return [a.symbol, null, e instanceof Error ? e.message : "Failed to load"] as const; }
    }));
    setLoops((prev) => { const next = { ...prev }; for (const [s, data] of results) if (data) next[s] = data; return next; });
    setErrors(Object.fromEntries(results.filter(([, , err]) => err).map(([s, , err]) => [s, err as string])));
    setBusy(false);
  }, []);

  const loadTx = useCallback(async (list: Meta["assets"], fresh: boolean) => {
    setTxBusy(true);
    setTxError(null);
    try {
      const entries = await Promise.all(list.flatMap((a) => (["market", "holders"] as const).map(async (scope) => {
        const r = await getJson<{ transfers: Tx[] }>(`/api/tx?asset=${a.symbol}&scope=${scope}${fresh ? "&fresh=1" : ""}`);
        return [`${a.symbol}:${scope}`, r.transfers] as const;
      })));
      setTx((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    } catch (e) {
      setTxError(e instanceof Error ? e.message : "Failed to load transactions");
    }
    setTxBusy(false);
  }, []);

  useEffect(() => {
    const fromHash = window.location.hash.replace("#", "") as TabId;
    if (TABS.some((t) => t.id === fromHash)) setTab(fromHash);
    // Shared links: ?asset=rsETH&holder=0x…#loops opens that asset with that holder selected.
    const q = new URLSearchParams(window.location.search);
    if (q.get("lookup")) setLookupQ(q.get("lookup"));
    getJson<Meta>("/api/assets").then((m) => {
      setMeta(m);
      const a = m.assets.find((x) => x.symbol.toLowerCase() === (q.get("asset") ?? "").toLowerCase());
      if (a) setPicked([a.symbol]);
      const h = q.get("holder");
      // On All assets, the holder's asset travels as "of".
      const of = a ?? m.assets.find((x) => x.symbol.toLowerCase() === (q.get("of") ?? "").toLowerCase());
      if (of && h && /^0x[0-9a-fA-F]{40}$/.test(h)) setSel({ asset: of.symbol, address: h });
      setUrlReady(true);
    }).catch((e) => setErrors({ site: e.message }));
    getJson<RegistryData>("/api/registry").then(setRegistry).catch(() => setRegistry({ entities: [], tags: [] }));
    loadCommunity();
  }, [loadLoops, loadCommunity]);

  const needsTx = tab === "tx" || tab === "entities";
  const txLoaded = shown.length > 0 && shown.every((a) => tx[`${a.symbol}:market`] && tx[`${a.symbol}:holders`]);
  useEffect(() => {
    if (needsTx && !txLoaded && !txBusy && !txError && shown.length) loadTx(shown, false);
  }, [needsTx, txLoaded, txBusy, txError, shown, loadTx]);

  // Positions are read for the assets on screen; others load when picked.
  useEffect(() => {
    const missing = shown.filter((a) => !loops[a.symbol] && !errors[a.symbol]);
    if (missing.length && !busy) loadLoops(missing, false);
  }, [shown, loops, busy, errors, loadLoops]);

  const refresh = () => {
    loadLoops(shown, true);
    if (needsTx || Object.keys(tx).length) loadTx(shown, true);
  };
  // Re-read every minute while the page is open and visible, and on coming back to the tab.
  // The server caches answers for 60 s, so many open tabs still cost one chain read a minute.
  const latest = { assets, shown, needsTx, txCount: Object.keys(tx).length, busy: busy || txBusy };
  const ref = useRef(latest);
  ref.current = latest;
  useEffect(() => {
    const tick = () => {
      const s = ref.current;
      if (document.visibilityState !== "visible" || s.busy || !s.assets.length) return;
      loadLoops(s.shown, false);
      if (s.needsTx || s.txCount) loadTx(s.shown, false);
    };
    const id = window.setInterval(tick, 60_000);
    const onShow = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onShow);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onShow); };
  }, [loadLoops, loadTx]);

  const openTab = (id: TabId) => setTab(id);
  // The address bar always reflects what is on screen, so any view can be copied and shared.
  useEffect(() => {
    if (!urlReady) return;
    const q = new URLSearchParams();
    if (picked.length === 1) q.set("asset", picked[0]);
    if (lookupQ && tab === "loops") q.set("lookup", lookupQ);
    if (sel && tab === "loops" && (picked.length !== 1 || sel.asset === picked[0])) {
      if (picked.length !== 1) q.set("of", sel.asset);
      q.set("holder", sel.address);
    }
    const next = `${window.location.pathname}${q.toString() ? `?${q}` : ""}#${tab}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, "", next);
  }, [urlReady, picked, sel, tab, lookupQ]);

  const positions = useMemo(() => shown.flatMap((a) => (loops[a.symbol]?.positions ?? []).map((p) => ({ asset: a.symbol, p }))), [shown, loops]);
  const largest = useMemo(() => positions.reduce<Row | null>((b, x) => (!b || x.p.debtUsd > b.p.debtUsd ? x : b), null), [positions]);
  const current = positions.find((x) => sel && x.asset === sel.asset && x.p.address.toLowerCase() === sel.address.toLowerCase()) ?? (shown.length > 1 ? largest : positions[0]) ?? null;
  const asOf = shown.map((a) => loops[a.symbol]?.asOf).filter(Boolean).sort()[0];

  return (
    <>
      <header className="bar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tokenlogic.png" alt="TokenLogic" />
          <span className="slash">/</span>
          <span className="brand-name">Core Offboarding Monitor</span>
        </div>
        <nav className="nav" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => openTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <div className="tools">
          {assets.length ? (
            <label className="asset-pick">
              {shown.length === 1 ? <AssetLogo symbol={shown[0].symbol} src={shown[0].logo} /> : <AssetStack assets={assets} />}
              <span className="sr">Asset</span>
              <select aria-label="Asset" value={picked.length === 1 ? picked[0] : assets.length === 1 ? assets[0].symbol : ""} onChange={(e) => { setPicked(e.target.value ? [e.target.value] : []); setSel(null); }}>
                {assets.length > 1 ? <option value="">All assets</option> : null}
                {assets.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
              </select>
            </label>
          ) : null}
          <button className="chip plain" onClick={refresh} disabled={busy || txBusy}>
            <span className={busy || txBusy ? "spin" : ""} aria-hidden="true">↻</span> {busy || txBusy ? "Reading chain" : "Refresh"}
          </button>
          {asOf ? <span className="asof">Read {when(asOf)}</span> : null}
        </div>
      </header>

      <main className="page">
        {Object.entries(errors).map(([key, message]) => (
          <p className="error" key={key} role="alert"><strong>{key === "site" ? "Site" : key}:</strong> {message}</p>
        ))}
        {!meta && !errors.site ? <p className="empty">Loading…</p> : null}

        {tab === "loops" ? (
          <LoopsTab shown={shown} loops={loops} busy={busy} positions={positions} current={current} hfAlert={hfAlert} colors={colors} logoOf={logoOf} communityOf={communityOf} community={community} onAsset={(s) => { setPicked([s]); setSel(null); }}
            onSearch={(v) => setLookupQ(v)}
            lookup={lookupQ ? <LookupPanel key={lookupQ} query={lookupQ} logoOf={logoOf} colors={colors} onClose={() => setLookupQ(null)}
              onOpen={(asset, address) => { setPicked([asset]); setSel({ asset, address }); setLookupQ(null); }} /> : null}
            onPick={(asset, address) => setSel({ asset, address })} />
        ) : null}
        {tab === "plan" ? <PlanTab shown={shown} logoOf={logoOf} onPick={(s) => { setPicked([s]); setSel(null); }} onAll={() => { setPicked([]); setSel(null); }} /> : null}
        {tab === "mapping" ? <MappingTab shown={shown} logoOf={logoOf} onPick={(s) => { setPicked([s]); setSel(null); }} /> : null}
        {tab === "market" ? (shown.length > 1 ? <MarketOverview shown={shown} loops={loops} busy={busy} logoOf={logoOf} onAsset={(s) => { setPicked([s]); setSel(null); }} /> : <MarketTab shown={shown} loops={loops} busy={busy} logoOf={logoOf} />) : null}
        {tab === "tx" ? (
          <TxTab shown={shown} tx={tx} busy={txBusy} error={txError} positions={positions} colors={colors} entities={registry?.entities ?? []} onRetry={() => loadTx(shown, true)} />
        ) : null}
        {tab === "entities" ? (
          <EntitiesTab registry={registry} positions={positions} shown={shown} allAssets={assets} logoOf={logoOf} tx={tx} txBusy={txBusy} colors={colors}
            community={community} communityError={communityError} onCommunityChange={loadCommunity} />
        ) : null}
        {tab === "data" ? <DataTab asOf={asOf} /> : null}
      </main>
    </>
  );
}

// ── Loops ───────────────────────────────────────────────────────────────────

type Shown = Meta["assets"];
type Row = { asset: string; p: Position };

function LoopsTab(props: {
  shown: Shown; loops: Record<string, LoopsResponse>; busy: boolean; positions: Row[]; current: Row | null; hfAlert: number;
  colors: Map<string, string>; logoOf: (s: string) => string | undefined; onPick: (asset: string, address: string) => void;
  communityOf: Map<string, CommunityTag>; community: CommunityTag[]; onAsset: (symbol: string) => void;
  onSearch: (v: string) => void; lookup: React.ReactNode;
}) {
  const { shown, loops, busy, positions, current, hfAlert, colors, logoOf, onPick, communityOf, community } = props;
  const many = shown.length > 1;
  const holder = useHolder(props.current?.asset, props.current?.p.address);
  // Across assets, one list ranked by the debt each position backs, whatever the asset.
  const visible = many ? [...positions].sort((a, b) => b.p.debtUsd - a.p.debtUsd || b.p.supplied * (loops[b.asset]?.market.priceUsd ?? 0) - a.p.supplied * (loops[a.asset]?.market.priceUsd ?? 0)) : positions;
  const scan = shown.length === 1 ? loops[shown[0].symbol]?.market.scan : undefined;
  return (
    <>
      {many ? <LoopsOverview shown={shown} loops={loops} busy={busy} hfAlert={hfAlert} logoOf={logoOf} onAsset={props.onAsset} /> : shown.map((a) => {
        const m = loops[a.symbol]?.market;
        if (!m) return <div className="panel" key={a.symbol}><p className="empty">{busy ? `Reading ${a.symbol} positions from the chain…` : `No data for ${a.symbol}.`}</p></div>;
        return (
          <div className="panel strip" key={a.symbol}>
            <div className="cell">
              <p className="k"><a className="title-link" href={a.aaveUrl} target="_blank" rel="noopener noreferrer" title={`${a.symbol} on ${m.venue}, in the Aave app`}>{m.venue} ↗</a></p>
              <a className="asset-name title-link" href={a.etherscanUrl} target="_blank" rel="noopener noreferrer" title={`${a.symbol} token on Etherscan`}><AssetLogo symbol={a.symbol} src={logoOf(a.symbol)} />{a.symbol}</a>
            </div>
            <Cell label="Tracked positions" value={fmt(m.tracked)} sub={`${fmt(m.scan?.withDebt ?? m.looping)} with ${usd(m.scan?.minDebtUsd ?? 10000)}+ of ${isStable(m.debtSymbol) ? "stablecoin debt" : `${m.debtSymbol} debt`}`} />
            <Cell label={`${a.symbol} supplied`} value={fmt(m.trackedSupplied)} sub={`${pct(m.trackedSharePct, m.trackedSharePct > 99 && m.trackedSharePct < 100 ? 2 : 1)} of the market`} />
            <Cell label={isStable(m.debtSymbol) ? "Debt backed" : `${m.debtSymbol} borrowed`} value={isStable(m.debtSymbol) ? usd(m.trackedDebtUsd) : fmt(m.trackedDebt)} sub={isStable(m.debtSymbol) ? "stablecoins, pro rata to collateral" : usd(m.trackedDebtUsd)} />
            <Cell label="Debt ÷ collateral" value={pct(m.debtToCollateralPct)} />
            <Cell label={`Health factor below ${hfAlert.toFixed(2)}`} value={fmt(m.underAlert)} tone={m.underAlert ? "bad" : ""} sub="tracked holders" />
            {isStable(m.debtSymbol) ? <Cell label="Collateral value" value={usd(m.trackedSupplied * m.priceUsd)} sub={`${a.symbol} at $${fmt(m.priceUsd, 0)}`} /> : <Cell label={`${m.debtSymbol} borrow APY`} value={pct(m.debtBorrowApy, 2)} sub="cost of the loop · TokenLogic" />}
          </div>
        );
      })}

      {props.lookup}
      <div className="master">
        <div className="panel master-list">
          <div className="panel-head">
            <div className="head-actions"><h2>Positions</h2><SearchBox onSearch={props.onSearch} /></div>
            <p className="hint">{many ? `${positions.length} positions across ${shown.length} assets, largest debt first · select a row` : scan ? `Every position backing ${usd(scan.minDebtUsd)}+ of debt (${scan.withDebt}), plus the largest holders · select a row` : "Select a row to open the holder"}</p>
          </div>
          {positions.length ? (
            <div className="scroll positions-scroll">
              <table className="stack positions">
                <thead>
                  <tr>
                    <th>#</th>
                    {many ? <th>Asset</th> : null}
                    <th>Holder</th>
                    <th>Tag</th>
                    <th className="r">Supplied</th>
                    <th className="r">Share</th>
                    <th className="r">Debt</th>
                    <th className="r">Leverage</th>
                    <th className="r">Health factor</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(({ asset, p }, i) => {
                    const on = current?.asset === asset && current.p.address === p.address;
                    return (
                      <tr key={`${asset}:${p.address}`} className={`pick ${on ? "on" : ""}`} onClick={() => onPick(asset, p.address)}>
                        <td className="num muted rank">{many ? i + 1 : p.rank}</td>
                        {many ? <td className="nw" data-label="Asset"><span className="asset-inline"><AssetLogo symbol={asset} src={logoOf(asset)} />{asset}</span></td> : null}
                        <td className="who">
                          <button className="rowbtn" aria-pressed={on} onClick={(e) => { e.stopPropagation(); onPick(asset, p.address); }}>{holderName(p)}</button>
                          <span className="sub">{short(p.address)}</span>
                        </td>
                        <td className="tagcell">{p.tag ? <EntityTag entity={p.tag.entity} colors={colors} /> : <EntityTag entity={communityOf.get(p.address.toLowerCase())?.entity} colors={colors} community />}</td>
                        <td className="r" data-label="Supplied">{fmtAmount(p.supplied)}</td>
                        <td className="r" data-label="Share">{pct(p.sharePct, p.sharePct < 1 ? 2 : 1)}</td>
                        <td className="r" data-label="Debt">{p.debt > 0 ? (many ? <>{usd(p.debtUsd)}<span className="sub">{isStable(loops[asset]?.market.debtSymbol) ? "stablecoins" : `${fmtAmount(p.debt)} ${loops[asset]?.market.debtSymbol}`}</span></> : isStable(loops[asset]?.market.debtSymbol) ? usd(p.debtUsd) : fmtAmount(p.debt)) : DASH}</td>
                        <td className="r" data-label="Leverage">{p.leverage ? `${fmt(p.leverage, 1)}x` : DASH}</td>
                        <td className="r" data-label="Health factor"><HealthFactor value={p.healthFactor} alert={hfAlert} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="empty">{busy ? "Reading positions from the chain…" : "No position to show."}</p>}
          {scan?.capped ? <p className="note warn pad">Holder scan hit its cap of {fmt(scan.scanned)} wallets; positions below that are not counted. Raise MAX_HOLDERS_SCANNED in config/assets.ts.</p> : null}
        </div>

        <div className="master-detail">
          {current ? <PositionCard row={current} market={loops[current.asset]?.market} hfAlert={hfAlert} colors={colors} /> : null}
          {current ? <HolderIdentity row={current} detail={holder.detail} colors={colors} community={community.filter((t) => t.address.toLowerCase() === current.p.address.toLowerCase())} /> : null}
        </div>
      </div>

      {current ? <HolderTx key={`${current.asset}:${current.p.address}`} row={current} rows={holder.rows} error={holder.error} colors={colors} /> : null}
      <Liquidations positions={positions} source={shown.length ? loops[shown[0].symbol]?.market.source : undefined} />
      <ReportPanel kind="loops" asset={shown.length === 1 ? shown[0].symbol : undefined} />

      <p className="note">
        Health factor, leverage and the drop to liquidation come from Aave for the whole wallet: every collateral and every debt it holds on {shown.length ? loops[shown[0].symbol]?.market.venue ?? "Aave" : "Aave"}, not only this asset.
        Health factors below {hfAlert.toFixed(2)} are shown in red. The meter fills as the position moves away from liquidation and is full at 1.10.
      </p>
    </>
  );
}

/** Every liquidation of a tracked holder over 90 days, kept apart from the positions themselves. */
function Liquidations({ positions, source }: { positions: Row[]; source?: string }) {
  const rows = positions
    .flatMap(({ asset, p }) => (p.liquidations ?? []).map((l) => ({ asset, p, l })))
    .sort((a, b) => b.l.timestamp.localeCompare(a.l.timestamp));
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Liquidations</h2>
        <p className="hint">Tracked holders, last 90 days · TokenLogic API</p>
      </div>
      {rows.length ? (
        <div className="scroll">
          <table className="stack txs">
            <thead><tr><th>Time</th><th>Holder</th><th className="r">Collateral seized</th><th className="r">Debt repaid</th><th>Tx</th></tr></thead>
            <tbody>
              {rows.map(({ asset, p, l }) => (
                <tr key={`${l.txHash}:${p.address}`}>
                  <td className="nw time">{when(l.timestamp)}</td>
                  <td className="who">#{p.rank} {holderName(p)}<span className="sub"><Addr address={p.address} /> · {asset}</span></td>
                  <td className="r" data-label="Collateral seized">{fmtAmount(l.collateralAmount)} {l.collateralSymbol}</td>
                  <td className="r" data-label="Debt repaid">{fmtAmount(l.debtAmount)} {l.debtSymbol} · {usd(l.debtUsd)}</td>
                  <td data-label="Tx"><a className="link mono" href={`https://etherscan.io/tx/${l.txHash}`} target="_blank" rel="noopener noreferrer">{l.txHash.slice(0, 10)}…</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">{source === "TokenLogic API" ? "No tracked holder was liquidated in the last 90 days." : "Liquidation history comes from the TokenLogic API: add TOKENLOGIC_API_KEY to show it. Liquidations still appear in each holder’s transactions."}</p>
      )}
    </div>
  );
}

function PositionCard({ row, market, hfAlert, colors }: { row: Row; market?: Market; hfAlert: number; colors: Map<string, string> }) {
  const { asset, p } = row;
  const debtSymbol = market?.debtSymbol ?? "debt asset";
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Selected position</h2>
        <div className="head-actions">
          <p className="hint num">#{p.rank} on {asset}</p>
          <CopyLink asset={asset} address={p.address} />
        </div>
      </div>
      <div className="body">
        <div className="dmeta">
          <h3 className="dname">{holderName(p)}</h3>
          <EntityTag entity={p.tag?.entity} colors={colors} />
        </div>
        <div className="mono">{p.address}</div>
        <div className="links">
          {EXPLORERS.map(([name, url]) => <a key={name} className="btn" href={url(p.address)} target="_blank" rel="noopener noreferrer">{name}</a>)}
        </div>
        <div className="big">
          <div className="cell"><p className="k">Health factor</p><p className="v"><HealthFactor value={p.healthFactor} alert={hfAlert} /></p></div>
          <Cell label="Leverage" value={p.leverage ? `${fmt(p.leverage, 1)}x` : DASH} />
          <Cell label="Drop to liquidation" value={pct(p.dropToLiquidationPct, 2)} />
        </div>
        <div>
          <div className="kv"><span>{asset} supplied</span><span>{fmtAmount(p.supplied)} · {usd(p.suppliedUsd)}</span></div>
          <div className="kv"><span>Share of the market</span><span>{pct(p.sharePct, 2)}</span></div>
          <div className="kv"><span>{isStable(debtSymbol) ? "Debt backed by it" : `${debtSymbol} borrowed`}</span><span>{p.debt > 0 ? (isStable(debtSymbol) ? usd(p.debtUsd) : `${fmtAmount(p.debt)} · ${usd(p.debtUsd)}`) : "None"}</span></div>
          <div className="kv"><span>All collateral on Aave</span><span>{usd(p.totalCollateralUsd)}</span></div>
          <div className="kv"><span>All debt on Aave</span><span>{usd(p.totalDebtUsd)}</span></div>
          <div className="kv"><span>Net equity</span><span>{usd(p.totalCollateralUsd - p.totalDebtUsd)}</span></div>
          <div className="kv"><span>Position</span><span>{p.loops ? (isStable(debtSymbol) ? "Borrows stablecoins against it" : `${asset}/${debtSymbol} loop`) : p.totalDebtUsd > 0 ? "Borrows other assets" : "Supply only"}</span></div>
        </div>
      </div>
    </div>
  );
}

/** Identity and transactions of the selected holder, loaded once for both panels. */
function useHolder(asset: string | undefined, address: string | undefined) {
  const [detail, setDetail] = useState<HolderDetail | null>(null);
  const [rows, setRows] = useState<Tx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!asset || !address) return;
    let live = true;
    setDetail(null); setRows(null); setError(null);
    getJson<HolderDetail>(`/api/holder?address=${address}`).then((d) => live && setDetail(d)).catch(() => {});
    getJson<{ transfers: Tx[] }>(`/api/tx?asset=${asset}&address=${address}`)
      .then((r) => live && setRows(r.transfers))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Failed to load"));
    return () => { live = false; };
  }, [asset, address]);
  return { detail, rows, error };
}

const teamTag = (t: { entity: string; label: string }) => (t.label.toLowerCase().startsWith(t.entity.toLowerCase()) ? t.label : `${t.entity} · ${t.label}`);

function HolderIdentity({ row, detail, colors, community }: { row: Row; detail: HolderDetail | null; colors: Map<string, string>; community: CommunityTag[] }) {
  const { p } = row;
  return (
      <div className="panel">
        <div className="panel-head">
          <h2>Identity · {holderName(p)}</h2>
          <p className="hint">What links this wallet to a known entity</p>
        </div>
        <div className="body">
          <div>
            <div className="kv"><span>Team tag</span><span>{detail?.tag ? teamTag(detail.tag) : "Not tagged"}</span></div>
            <div className="kv"><span>Type</span><span>{p.isContract ? "Contract" : "Wallet (EOA)"}</span></div>
            <div className="kv"><span>Contract name</span><span>{detail?.name ?? p.contractName ?? DASH}</span></div>
            <div className="kv"><span>ENS</span><span>{detail?.ens ?? p.ens ?? DASH}</span></div>
            <div className="kv"><span>Deployed by</span><span><Addr address={detail?.creator} /></span></div>
            <div className="kv"><span>Public labels</span><span>{detail?.publicTags.length ? detail.publicTags.join(", ") : "None found"}</span></div>
          </div>
          {detail?.notes.length ? (
            <div className="notes-list">
              <p className="k">Team notes</p>
              {detail.notes.map((n, i) => (
                <div className="note-item" key={i}>
                  <div className="note-meta"><EntityTag entity={n.linkedEntity} colors={colors} /><span>{n.source} · {n.confidence}</span></div>
                  <p>{n.finding}</p>
                </div>
              ))}
            </div>
          ) : <p className="note">No team note on this wallet yet. Add one in data/notes.json.</p>}
          {community.length ? (
            <div className="ctags">
              <p className="k">Tagged on the site</p>
              {community.map((t) => <CommunityCard key={t.id} t={t} colors={colors} />)}
            </div>
          ) : <p className="note">Nobody has tagged this wallet on the site yet. Add a tag in Tagged entities.</p>}
          <p className="note">Contract name, ENS, deployer and public labels are read from Blockscout. Counterparties in the transactions are matched against the team’s tagged addresses.</p>
        </div>
      </div>
  );
}

function HolderTx({ row, rows, error, colors }: { row: Row; rows: Tx[] | null; error: string | null; colors: Map<string, string> }) {
  const { asset, p } = row;
  const [scope, setScope] = useState<"asset" | "all">("asset");
  const list = (rows ?? []).filter((t) => scope === "all" || t.assetRelated);
  return (
      <div className="panel">
        <div className="panel-head">
          <h2>Last transactions · {holderName(p)}</h2>
          <div className="seg" role="group" aria-label="Transactions shown">
            <button aria-pressed={scope === "asset"} onClick={() => setScope("asset")}>{asset} loop only</button>
            <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>All tokens</button>
          </div>
        </div>
        {error ? <p className="empty">Could not load transactions: {error}</p>
          : rows === null ? <p className="empty">Reading transactions…</p>
          : list.length ? <TxTable rows={list} colors={colors} showWallet={false} />
          : <p className="empty">{scope === "asset" ? `No recent ${asset} loop transaction. Switch to all tokens to see the wallet’s other activity.` : "No recent token transfer for this wallet."}</p>}
      </div>
  );
}

// ── Offboarding ─────────────────────────────────────────────────────────────

const signed = (n: number | null | undefined, digits = 1) => (n == null || !Number.isFinite(n) ? DASH : `${n > 0 ? "+" : ""}${fmt(n, digits)}%`);
const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function useNarrow(query = "(max-width: 700px)") {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    on(); m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/** Daily debt of the loops; hover or touch a day to read it. */
function DebtChart({ plan }: { plan: PlanResponse }) {
  const narrow = useNarrow();
  const [hover, setHover] = useState<number | null>(null);
  const pts = plan.history;
  if (pts.length < 2) return <p className="empty">The daily history fills in once the RPC serves past blocks.</p>;
  // Drawn at the size it is shown, so labels stay readable on a phone.
  const W = narrow ? 340 : 640, H = narrow ? 220 : 240, L = narrow ? 44 : 56, R = 12, T = 22, B = 28;
  const values = pts.map((p) => p.debt);
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.15, hi * 0.01);
  const min = Math.max(0, lo - pad), max = hi + pad;
  const x = (i: number) => L + (i / (pts.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - min) / (max - min)) * (H - T - B);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.debt).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H - B} L${x(0).toFixed(1)},${H - B} Z`;
  const bi = pts.findIndex((p) => p.date === plan.baseline.date);
  const ticks = [min, (min + max) / 2, max];
  const k = (v: number) => (plan.path === "lt" ? usd(v) : v >= 1000 ? `${fmt(v / 1000, v >= 100000 ? 0 : 1)}k` : fmt(v, 0));

  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(pts.length - 1, Math.round(((px - L) / (W - L - R)) * (pts.length - 1)))));
  };
  const h = hover != null ? pts[hover] : null;
  const prev = hover != null && hover > 0 ? pts[hover - 1] : null;
  const vsBase = h && bi >= 0 ? (h.debt / pts[bi].debt - 1) * 100 : null;
  const leftPct = hover != null ? (x(hover) / W) * 100 : 0;

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${plan.debtSymbol} debt of the tracked loops, daily`}
        onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="debt-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2468fc" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#2468fc" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="axis">{k(v)}</text>
          </g>
        ))}
        <path d={area} className="area" />
        <path d={line} className="line" />
        {bi >= 0 ? (
          <g>
            <line x1={x(bi)} x2={x(bi)} y1={T - 8} y2={H - B} className="mark" />
            <text x={x(bi) + (bi > pts.length * 0.7 ? -6 : 6)} y={T - 10} textAnchor={bi > pts.length * 0.7 ? "end" : "start"} className="axis strong">{narrow ? "Baseline" : "ARFC baseline"} · {dayLabel(plan.baseline.date)}</text>
            <circle cx={x(bi)} cy={y(pts[bi].debt)} r={3.5} className="dot-base" />
          </g>
        ) : null}
        {hover == null ? <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1].debt)} r={4} className="dot-now" /> : null}
        {hover != null && h ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T - 8} y2={H - B} className="guide" />
            <circle cx={x(hover)} cy={y(h.debt)} r={4.5} className="dot-now" />
          </g>
        ) : null}
        <text x={L} y={H - 8} className="axis">{dayLabel(pts[0].date)}</text>
        <text x={W - R} y={H - 8} textAnchor="end" className="axis">{dayLabel(pts[pts.length - 1].date)}</text>
        <rect x={L} y={0} width={W - L - R} height={H} fill="transparent" />
      </svg>
      {h ? (
        <div className={`tip ${leftPct > 60 ? "left" : ""}`} style={{ left: `${leftPct}%` }}>
          <p className="tip-date">{dayLabel(h.date)} {h.date.slice(0, 4)} · 00:00 UTC</p>
          {plan.path === "rate" ? <div className="tip-row"><span>{plan.debtSymbol} debt</span><strong>{fmt(h.debt)}</strong></div> : null}
          <div className="tip-row"><span>{plan.path === "rate" ? "Value" : "Debt backed"}</span><strong>{usd(h.debtUsd)}</strong></div>
          {prev ? <div className="tip-row"><span>Day change</span><strong className={h.debt < prev.debt ? "pos" : h.debt > prev.debt ? "warn" : ""}>{h.debt - prev.debt > 0 ? "+" : "−"}{plan.path === "rate" ? fmt(Math.abs(h.debt - prev.debt)) : usd(Math.abs(h.debtUsd - prev.debtUsd))}</strong></div> : null}
          {vsBase != null ? <div className="tip-row"><span>vs baseline</span><strong>{signed(vsBase, 2)}</strong></div> : null}
          <div className="tip-row"><span>{plan.symbol} on Aave</span><strong>{fmt(h.supplied)}</strong></div>
          <p className="tip-foot">Block {h.block.toLocaleString("en-US")}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Collateral that becomes liquidatable as the LT is cut; hover a bar to read it. */
function LtChart({ sim, symbol }: { sim: NonNullable<PlanResponse["ltSim"]>; symbol: string }) {
  const narrow = useNarrow();
  const [hover, setHover] = useState<number | null>(null);
  const cuts = sim.cuts;
  const W = narrow ? 340 : 640, H = narrow ? 220 : 240, L = narrow ? 44 : 56, R = 12, T = 18, B = 30;
  const limit = Math.max(2e6, (sim.trackedCollateralUsd || 0) * 0.05);
  const max = Math.max(...cuts.map((c) => c.liquidatableUsd), limit) * 1.1 || 1;
  const bw = (W - L - R) / cuts.length;
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const h = hover != null ? cuts[hover] : null;
  const pick = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(cuts.length - 1, Math.floor((px - L) / bw))));
  };
  const leftPct = hover != null ? ((L + (hover + 0.5) * bw) / W) * 100 : 0;
  const k = (v: number) => (v >= 1e6 ? `$${fmt(v / 1e6, 0)}M` : v >= 1e3 ? `$${fmt(v / 1e3, 0)}k` : `$${fmt(v, 0)}`);
  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${symbol} collateral liquidatable per LT cut`} onPointerMove={pick} onPointerDown={pick} onPointerLeave={() => setHover(null)}>
        {[0, max / 2, max].map((v) => (
          <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 8} y={y(v) + 4} textAnchor="end" className="axis">{k(v)}</text></g>
        ))}
        {cuts.map((c, i) => {
          const ok = c.liquidatableUsd < 2e6 && c.sharePct < 5;
          return <rect key={c.points} x={L + i * bw + 1.5} width={bw - 3} height={Math.max(2, y(0) - y(c.liquidatableUsd))} y={Math.min(y(c.liquidatableUsd), y(0) - 2)} className={`bar ${ok ? "ok" : "over"} ${hover === i ? "on" : ""}`} rx={2} />;
        })}
        <line x1={L} x2={W - R} y1={y(2e6)} y2={y(2e6)} className="trigger" />
        <text x={W - R} y={y(2e6) - 6} textAnchor="end" className="axis warn">$2M</text>
        {[1, 5, 10, 15, 20, 25].map((p) => <text key={p} x={L + (p - 0.5) * bw} y={H - 10} textAnchor="middle" className="axis">−{p}</text>)}
        <rect x={L} y={0} width={W - L - R} height={H} fill="transparent" />
      </svg>
      {h ? (
        <div className={`tip ${leftPct > 60 ? "left" : ""}`} style={{ left: `${leftPct}%` }}>
          <p className="tip-date">LT cut by {h.points} point{h.points > 1 ? "s" : ""} → {fmt(h.ltAfterPct, 0)}%</p>
          <div className="tip-row"><span>Liquidatable</span><strong>{usd(h.liquidatableUsd)}</strong></div>
          <div className="tip-row"><span>Share of collateral</span><strong>{pct(h.sharePct, 2)}</strong></div>
          <div className="tip-row"><span>Positions</span><strong>{h.positions}</strong></div>
          <div className="tip-row"><span>ARFC rule</span><strong className={h.liquidatableUsd < 2e6 && h.sharePct < 5 ? "pos" : "warn"}>{h.liquidatableUsd < 2e6 && h.sharePct < 5 ? "within" : "over"}</strong></div>
        </div>
      ) : null}
    </div>
  );
}

function LtSimPanel({ plan }: { plan: PlanResponse }) {
  const s = plan.ltSim!;
  const ns = s.nextStep;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>What would an LT cut liquidate?</h2>
        <p className="hint">The ARFC’s follow-up control, held as a last resort · today’s positions held constant</p>
      </div>
      <div className="strip inner">
        <Cell label="Liquidation threshold" value={pct(s.ltPct, 0)} sub={s.baselineLtPct != null ? `${s.ltPct < s.baselineLtPct ? `cut from ${s.baselineLtPct}%` : "unchanged since the ARFC"}` : undefined} />
        <Cell label="Next 2-point step" value={usd(ns.liquidatableUsd)} tone={ns.under2M && ns.under5Pct ? "pos" : "warn"} sub={`${pct(ns.sharePct, 2)} of collateral · ${ns.under2M && ns.under5Pct ? "within the ARFC rule" : "over the ARFC rule"}`} />
        <Cell label="Points cuttable within the rule" value={`${s.maxSafePoints}`} sub="consecutive points under $2M and 5%" />
        <Cell label="Borrowers tracked" value={fmt(s.borrowers)} sub={`${pct(s.coveragePct)} of the supply`} />
      </div>
      <div className="body">
        <div className="lt-chart"><LtChart sim={s} symbol={plan.symbol} /></div>
        <p className="note">Each bar: {plan.symbol} collateral held by wallets whose health factor would fall below 1 if the LT were that many points lower. Green bars stay within the ARFC rule for a step (less than $2M and less than 5% of the remaining collateral liquidatable). A wallet’s health factor falls by its {plan.symbol} collateral × the cut ÷ its debt. Wallets using {plan.symbol} in an E-Mode follow the E-Mode’s LT instead and are counted here as if they did not.</p>
      </div>
    </div>
  );
}

function PlanOverview({ shown, onPick }: { shown: Shown; onPick: (symbol: string) => void }) {
  const [rows, setRows] = useState<Record<string, PlanResponse | null>>({});
  useEffect(() => {
    let live = true;
    for (const a of shown) getJson<{ plan: PlanResponse | null }>(`/api/plan?asset=${a.symbol}`).then((r) => live && setRows((x) => ({ ...x, [a.symbol]: r.plan }))).catch(() => live && setRows((x) => ({ ...x, [a.symbol]: null })));
    return () => { live = false; };
  }, [shown]);
  const list = shown.map((a) => ({ a, p: rows[a.symbol] })).filter((x) => x.p !== null);
  const totalNow = list.reduce((s, x) => s + (x.p?.now.debtUsd ?? 0), 0);
  const totalBase = list.reduce((s, x) => s + (x.p?.baseline.debtUsd ?? 0), 0);
  const ready = list.map((x) => x.p).filter((p): p is PlanResponse => !!p);
  return (
    <>
    <div className="panel">
      <div className="panel-head">
        <div>
          <a className="eyebrow title-link" href={list[0]?.p?.url ?? "#"} target="_blank" rel="noopener noreferrer">ARFC: Repositioning Aave V3 Core around Established, Liquid Collateral ↗</a>
          <h2>All assets in scope</h2>
        </div>
        <p className="hint">Debt backed: {usd(totalNow)} today vs {usd(totalBase)} on 9 Nov (ARFC) · select a row</p>
      </div>
      <div className="scroll">
        <table className="stack overview">
          <thead><tr><th>Asset</th><th>Resolution</th><th className="r">Debt backed</th><th className="r">ARFC, 9 Nov</th><th className="r">Since 9 Nov</th><th className="r">30 days</th><th>Initial measures</th><th>Follow-up</th></tr></thead>
          <tbody>
            {shown.map((a) => {
              const p = rows[a.symbol];
              if (p === null) return null;
              if (!p) return <tr key={a.symbol}><td>{a.symbol}</td><td colSpan={7} className="muted">Reading…</td></tr>;
              const init = p.steps.filter((s) => s.stage === "Initial measures");
              const follow = p.steps.find((s) => s.stage.startsWith("Follow-up"));
              const since = p.baseline.debtUsd ? (p.now.debtUsd / p.baseline.debtUsd - 1) * 100 : null;
              return (
                <tr key={a.symbol} className="click" onClick={() => onPick(a.symbol)}>
                  <td className="nw"><strong>{a.symbol}</strong><span className="sub">{p.debtSymbol}</span></td>
                  <td data-label="Resolution">{p.resolution}<span className="sub">{p.path === "rate" ? "rate path last" : "LT cuts last"}</span></td>
                  <td className="r" data-label="Debt backed">{usd(p.now.debtUsd)}</td>
                  <td className="r" data-label="ARFC">{usd(p.baseline.debtUsd)}</td>
                  <td className={`r ${since != null && since < 0 ? "pos" : ""}`} data-label="Since 9 Nov">{signed(since, 1)}</td>
                  <td className={`r ${p.trend.declining ? "pos" : p.trend.declining === false ? "warn" : ""}`} data-label="30 days">{signed(p.trend.change30Pct, 1)}</td>
                  <td data-label="Initial">{init.filter((s) => s.doneAt).length}/{init.length} done</td>
                  <td data-label="Follow-up">{follow?.doneAt ? <span className="status wait">Applied</span> : <span className="status pending">Not triggered</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    {ready.length === shown.length && ready.length ? <OffboardingCalendar plans={ready} baselineDate={ready[0].baseline.date} title={`All ${ready.length} assets`} /> : <div className="panel"><p className="empty">Reading each asset’s daily history for the combined calendar…</p></div>}
    </>
  );
}

function StepStatus({ s, plan }: { s: PlanResponse["steps"][number]; plan: PlanResponse }) {
  if (s.doneAt) return <span className="status done">Done{s.doneAt !== "before tracking" ? ` · ${dayLabel(s.doneAt.slice(0, 10))}` : ""}</span>;
  if (!s.tracked) return plan.trend.declining == null ? <span className="status pending">Ongoing</span> : plan.trend.declining ? <span className="status done">Exposure falling</span> : <span className="status wait">Not falling</span>;
  if (s.stage.startsWith("Follow-up")) return <span className="status pending">Not triggered</span>;
  return <span className="status pending">Awaiting AIP</span>;
}

function PlanTab({ shown, logoOf, onPick, onAll }: { shown: Shown; logoOf: (s: string) => string | undefined; onPick: (symbol: string) => void; onAll: () => void }) {
  const asset = shown.length === 1 ? shown[0] : undefined;
  const [plan, setPlan] = useState<PlanResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!asset) return;
    let live = true;
    const load = () => getJson<{ plan: PlanResponse | null }>(`/api/plan?asset=${asset.symbol}`).then((r) => live && (setPlan(r.plan), setError(null))).catch((e) => live && setError(e instanceof Error ? e.message : "Failed"));
    setPlan(undefined); load();
    const id = window.setInterval(() => document.visibilityState === "visible" && load(), 60_000);
    return () => { live = false; window.clearInterval(id); };
  }, [asset]);

  if (!asset) return <><PlanOverview shown={shown} onPick={onPick} /><ReportPanel /></>;
  if (error) return <div className="panel"><p className="empty">Could not read the plan: {error}</p></div>;
  if (plan === undefined) return <div className="panel"><p className="empty">Reading {asset.symbol}’s offboarding progress from the chain… The first visit backfills the daily history.</p></div>;
  if (plan === null) return <div className="panel"><p className="empty">No offboarding plan is set for {asset.symbol}. Add one in config/plan.ts.</p></div>;

  const b = plan.baseline, n = plan.now, c = plan.carry, tr = plan.trend;
  const sinceBase = b.debtTokens ? (n.debt / b.debtTokens - 1) * 100 : null;
  const roeNow = c?.roe[0]?.pct ?? null;
  const stages = [...new Set(plan.steps.map((s) => s.stage))];
  return (
    <>
      <div className="panel">
        <div className="panel-head plan-head">
          <div>
            <a className="eyebrow title-link" href={plan.url} target="_blank" rel="noopener noreferrer" title="Read the ARFC on the Aave governance forum">{plan.title} ↗</a>
            <div className="asset-name">
              <AssetLogo symbol={asset.symbol} src={logoOf(asset.symbol)} />
              <a className="title-link" href={asset.etherscanUrl} target="_blank" rel="noopener noreferrer">{asset.symbol}</a>
              <span className="pill">{plan.resolution}</span><span className="pill ghost">{plan.pathLabel}</span>
            </div>
          </div>
          <div className="plan-meta">
            <p className="hint">Figures marked ARFC: {plan.source}. Everything else is read on-chain.</p>
            <button className="chip plain" onClick={onAll}>All assets · monthly report</button>
          </div>
        </div>
        <div className="strip inner">
          <Cell label={plan.path === "rate" ? `${plan.debtSymbol} debt backed` : "Debt backed"} value={plan.path === "rate" ? fmt(n.debt) : usd(n.debtUsd)} sub={plan.path === "rate" ? `${usd(n.debtUsd)} · ${n.positions} loops` : `${n.positions} borrowers tracked · ${plan.debtSymbol.toLowerCase()}`} />
          <Cell label={`Since ${dayLabel(b.date)}`} value={signed(sinceBase, 2)} tone={sinceBase != null && sinceBase < 0 ? "pos" : ""} sub={`ARFC baseline ${usd(b.debtUsd)}`} />
          <Cell label="Exposure, 30 days" value={signed(tr.change30Pct)} tone={tr.declining ? "pos" : tr.declining === false ? "warn" : ""} sub={tr.declining == null ? "needs history" : tr.declining ? "falling: no further measure" : "not falling: follow-up can apply"} />
          {plan.swap.into.length ? <Cell label={`Moved to ${plan.swap.into.join(", ")}`} value={pct(plan.swap.sharePct)} sub={`${usd(plan.swap.movedUsd)} of the loops’ ETH collateral`} /> : null}
          {plan.path === "rate" ? <Cell label="Loop return on equity" value={signed(roeNow)} tone={roeNow == null ? "" : roeNow > 0 ? "warn" : "pos"} sub={c?.breakevenBps != null ? `negative at +${c.breakevenBps} bps` : undefined} /> : null}
          {plan.ltSim ? <Cell label="Next 2-point LT cut" value={usd(plan.ltSim.nextStep.liquidatableUsd)} tone={plan.ltSim.nextStep.under2M && plan.ltSim.nextStep.under5Pct ? "pos" : "warn"} sub="would become liquidatable" /> : null}
          <Cell label="DAO revenue at stake" value={usd(b.revenueUsd)} sub="a year · ARFC" />
        </div>
      </div>

      <div className="split">
        <div className="panel">
          <div className="panel-head">
            <h2>{plan.path === "rate" ? `${plan.debtSymbol} debt of the loops, daily` : `Debt backed by ${plan.symbol}, daily`}</h2>
            <p className="hint">Hover or tap a day</p>
          </div>
          <div className="body">
            <DebtChart plan={plan} />
            <div className="kv"><span>Last 7 days</span><span>{signed(tr.change7Pct, 2)}{tr.perWeekTokens != null ? ` · ${plan.path === "rate" ? `${fmt(Math.abs(tr.perWeekTokens))} ${plan.debtSymbol}` : usd(Math.abs(tr.perWeekTokens) * (n.debt ? n.debtUsd / n.debt : 1))} ${tr.perWeekTokens >= 0 ? "repaid" : "added"}` : ""}</span></div>
            <div className="kv"><span>Last 30 days</span><span>{signed(tr.change30Pct, 2)}</span></div>
            <p className="note">Tracked loop positions at 00:00 UTC each day. Wallets that left the top holders before today are not counted in past days, so earlier days slightly understate the debt.</p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>ARFC steps</h2><p className="hint">Checked against on-chain changes</p></div>
          {stages.map((stage) => (
            <div key={stage}>
              <p className="stage">{stage}</p>
              <ol className="steps">
                {plan.steps.filter((s) => s.stage === stage).map((s, i) => (
                  <li key={i}>
                    <div>
                      <p>{s.label}</p>
                      {s.note ? <p className="step-note">{s.note}</p> : null}
                      {s.detail ? <p className="step-note">On-chain: {s.detail}</p> : null}
                      {s.txHash ? <a className="link mono step-tx" href={`https://etherscan.io/tx/${s.txHash}`} target="_blank" rel="noopener noreferrer">{s.txHash.slice(0, 10)}…</a> : null}
                    </div>
                    <StepStatus s={s} plan={plan} />
                  </li>
                ))}
              </ol>
            </div>
          ))}
          <div className="body">{plan.notes.map((x) => <p className="note" key={x}>{x}</p>)}</div>
        </div>
      </div>

      <OffboardingCalendar plans={[plan]} baselineDate={b.date} title={`${plan.symbol} exposure, day by day`} />

      {plan.symbol === "rsETH" ? <KelpPanel /> : null}

      <ReportPanel kind="offboarding" asset={plan.symbol} />

      {plan.path === "lt" && plan.ltSim ? <LtSimPanel plan={plan} /> : null}
      {plan.path === "rate" ? (
      <div className="panel">
        <div className="panel-head">
          <h2>Do the loops still pay?</h2>
          <p className="hint">Return on equity = leverage × {plan.symbol} yield − (leverage − 1) × {plan.debtSymbol} borrow rate</p>
        </div>
        {c ? (
          <>
            <div className="strip inner">
              <Cell label={`${plan.symbol} yield, 30 days`} value={pct(c.yieldPct, 2)} sub="exchange-rate growth" />
              <Cell label={`${plan.debtSymbol} borrow rate`} value={pct(c.borrowPct, 2)} sub={`30-day average ${pct(c.borrowAvg30Pct, 2)}`} />
              <Cell label="Spread" value={signed(c.yieldPct != null ? c.yieldPct - c.borrowPct : null, 2)} sub="yield minus borrow rate" />
              <Cell label={`${plan.debtSymbol} reserve factor`} value={pct(c.reserveFactorPct, 0)} sub="rises with the rate path, if used" />
            </div>
            <div className="scroll">
              <table className="stack carry">
                <thead>
                  <tr><th>Position</th><th className="r">Leverage</th><th className="r">{plan.debtSymbol} debt</th>{plan.swap.into.length ? <th className="r">Moved to {plan.swap.into.join("/")}</th> : null}{c.roe.map((r) => <th className="r" key={r.bps}>{r.bps ? `ROE at +${r.bps} bps` : "ROE today"}</th>)}<th className="r">Turns negative at</th></tr>
                </thead>
                <tbody>
                  <tr className="total">
                    <td>All loops</td>
                    <td className="r" data-label="Leverage">{c.avgLeverage ? `${fmt(c.avgLeverage, 1)}x` : DASH}</td>
                    <td className="r" data-label="Debt">{usd(n.debtUsd)}</td>
                    {plan.swap.into.length ? <td className="r" data-label="Moved">{plan.swap.movedUsd ? usd(plan.swap.movedUsd) : DASH}</td> : null}
                    {c.roe.map((r) => <td className={`r ${r.pct == null ? "" : r.pct > 0 ? "warn" : "pos"}`} key={r.bps} data-label={r.bps ? `+${r.bps} bps` : "Today"}>{signed(r.pct)}</td>)}
                    <td className="r" data-label="Negative at">{c.breakevenBps != null ? `+${c.breakevenBps} bps` : DASH}</td>
                  </tr>
                  {c.positions.map((p) => (
                    <tr key={p.address}>
                      <td className="who">#{p.rank} {p.label ?? short(p.address)}<span className="sub"><Addr address={p.address} /></span></td>
                      <td className="r" data-label="Leverage">{p.leverage ? `${fmt(p.leverage, 1)}x` : DASH}</td>
                      <td className="r" data-label="Debt">{usd(p.debtUsd)}</td>
                      {plan.swap.into.length ? <td className={`r ${p.movedUsd > 1000 ? "pos" : ""}`} data-label="Moved">{p.movedUsd > 1000 ? usd(p.movedUsd) : DASH}</td> : null}
                      {p.roe.map((r) => <td className={`r ${r.pct == null ? "" : r.pct > 0 ? "warn" : "pos"}`} key={r.bps} data-label={r.bps ? `+${r.bps} bps` : "Today"}>{signed(r.pct)}</td>)}
                      <td className="r" data-label="Negative at">{p.breakevenBps != null ? `+${p.breakevenBps} bps` : DASH}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note pad">Amber: the loop still earns, so the holder has no reason to unwind. Green: it loses money. The +50 and +100 bps columns are the ARFC’s last-resort rate path. “Moved” is wstETH, weETH and cbETH the wallet supplies on Core, the in-place migration the ARFC enables. Leverage is account-wide. Rates are annual, before gas and Kelp’s withdrawal queue.</p>
          </>
        ) : <p className="empty">Rates could not be read from the chain.</p>}
      </div>
      ) : null}

      <div className="panel">
        <div className="panel-head"><h2>Parameter changes on-chain</h2><p className="hint">{[plan.symbol, plan.path === "rate" ? plan.debtSymbol : null, ...plan.swap.into].filter(Boolean).join(", ")} and E-Mode changes from the Aave Pool Configurator, since 22 October</p></div>
        {plan.changes.length ? (
          <ul className="changes">
            {plan.changes.map((ch) => (
              <li key={`${ch.txHash}:${ch.text}`}>
                <span className="when">{when(ch.timestamp)}</span>
                <span className="what">{ch.text}</span>
                <a className="link mono" href={`https://etherscan.io/tx/${ch.txHash}`} target="_blank" rel="noopener noreferrer">{ch.txHash.slice(0, 10)}…</a>
              </li>
            ))}
          </ul>
        ) : <p className="empty">No change since 22 October. The ARFC’s AIP will appear here, and its steps above will tick, the moment it executes.</p>}
      </div>

      {plan.warnings.length ? <div className="panel"><div className="body">{plan.warnings.map((w) => <p className="note warn" key={w}>{w}</p>)}</div></div> : null}
    </>
  );
}

// ── Monthly report ──────────────────────────────────────────────────────────

/** Just enough Markdown for the report: headings, paragraphs, lists, tables, bold and links. */
function inlineMd(s: string, key: string) {
  const parts: React.ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push(m[1] ? <a key={`${key}-${i++}`} className="link" href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a> : <strong key={`${key}-${i++}`}>{m[3]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (l.startsWith("### ")) out.push(<h4 key={i}>{l.slice(4)}</h4>);
    else if (l.startsWith("## ")) out.push(<h3 key={i}>{l.slice(3)}</h3>);
    else if (l.startsWith("# ")) out.push(<h2 key={i} className="report-title">{l.slice(2)}</h2>);
    else if (l.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) { rows.push(lines[i].slice(1, -1).split("|").map((c) => c.trim())); i++; }
      i--;
      const [head, , ...body] = rows;
      out.push(
        <div className="scroll" key={i}><table className="report-table"><thead><tr>{head.map((h, j) => <th key={j}>{h}</th>)}</tr></thead>
          <tbody>{body.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{inlineMd(c, `${i}-${j}-${k}`)}</td>)}</tr>)}</tbody></table></div>,
      );
    } else if (l.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- ")) { items.push(lines[i].slice(2)); i++; }
      i--;
      out.push(<ul key={i}>{items.map((x, j) => <li key={j}>{inlineMd(x, `${i}-${j}`)}</li>)}</ul>);
    } else out.push(<p key={i}>{inlineMd(l, String(i))}</p>);
  }
  return <div className="report">{out}</div>;
}

function ReportPanel({ kind = "offboarding", asset }: { kind?: "offboarding" | "loops"; asset?: string }) {
  const [report, setReport] = useState<{ markdown: string; generatedAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const qs = new URLSearchParams({ kind, ...(asset ? { asset } : {}) }).toString();
  useEffect(() => { setReport(null); setError(null); }, [qs]);
  const scope = asset ?? "all assets";
  const title = kind === "loops" ? `Loop positions report · ${scope}` : asset ? `Offboarding report · ${asset}` : "Monthly progress report · all assets";
  const what = kind === "loops" ? "Market summary, every tracked position with health factor and leverage, liquidations · Markdown" : asset ? "Debt against the baseline, trend, loop economics, plan steps and on-chain changes · Markdown" : "Summary, one section per asset, on-chain changes of the month · Markdown, ready for the forum";
  const build = () => {
    setBusy(true); setError(null);
    getJson<{ markdown: string; generatedAt: string }>(`/api/report?${qs}`).then(setReport).catch((e) => setError(e instanceof Error ? e.message : "Failed")).finally(() => setBusy(false));
  };
  const copy = async () => {
    if (!report) return;
    try { await navigator.clipboard.writeText(report.markdown); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <div><h2>{title}</h2><p className="hint">{what}</p></div>
        <div className="report-actions">
          <button className="chip plain" onClick={build} disabled={busy}><span className={busy ? "spin" : ""} aria-hidden="true">↻</span> {busy ? "Building" : report ? "Rebuild" : "Build report"}</button>
          {report ? <button className="chip plain" onClick={copy}>{copied ? "Copied" : "Copy Markdown"}</button> : null}
          <a className="chip plain" href={`/api/report?${qs}&download=1`}>Download .md</a>
        </div>
      </div>
      {error ? <p className="empty">Could not build the report: {error}</p> : report ? <div className="body"><Markdown text={report.markdown} /></div> : <p className="empty">Builds from today’s on-chain figures for {scope}. Preview it here, or download it directly; the first build can take a few seconds.</p>}
    </div>
  );
}

// ── Data ────────────────────────────────────────────────────────────────────

interface Status {
  checkedAt: string; cacheSeconds: number;
  checks: { name: string; ok: boolean | null; ms: number | null; detail: string; asOf: string | null; usedFor: string }[];
  history: { feed: string; lastBlock: number; events: number; newest: string | null; where: string }[];
}

const ago = (iso: string | null) => {
  if (!iso) return DASH;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

const SOURCES: [string, string][] = [
  ["Top holders, holder count", "Blockscout"],
  ["Supplied, borrowed, health factor, leverage of each holder", "Ethereum RPC (aToken and debt-token balances, Pool getUserAccountData)"],
  ["Reserve status, LTV, liquidation threshold, caps", "Ethereum RPC (Pool configuration)"],
  ["Price", "TokenLogic API with a key, else the Aave oracle on-chain"],
  ["Market supply, utilization, supply and borrow APY", "TokenLogic API (supply checked against the on-chain aToken supply)"],
  ["Supply, Withdraw, Borrow, Repay, Liquidation rows", "Ethereum RPC: the Aave Pool's own events, with block times"],
  ["Liquidation history (90 days)", "TokenLogic API"],
  ["Other token transfers", "Blockscout"],
  ["Contract name, ENS, deployer, public labels", "Blockscout"],
  ["Team tags and notes", "The repository (data/*.json)"],
  ["Tags added on the site", "Shared storage (Upstash)"],
  ["Offboarding: daily debt history, collateral yield, borrow rate", "Ethereum RPC (past balances and oracle prices, Pool reserve data)"],
  ["Market: exchange rate, backing, deposits paused", "Ethereum RPC: Kelp's oracle and deposit pool, rsETH supply"],
  ["Market: market price and peg", "CoinGecko (every 10 minutes)"],
  ["Market: risk findings and incidents", "config/risk.ts, quoted from LlamaRisk and press, with links"],
  ["Offboarding: plan steps and parameter changes", "Ethereum RPC: Aave Pool Configurator events; plan figures from config/plan.ts"],
];

function DataTab({ asOf }: { asOf?: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = useCallback(() => {
    setBusy(true); setError(null);
    getJson<Status>("/api/status").then(setStatus).catch((e) => setError(e instanceof Error ? e.message : "Failed")).finally(() => setBusy(false));
  }, []);
  useEffect(() => { check(); const id = window.setInterval(check, 60_000); return () => window.clearInterval(id); }, [check]);

  const core = status?.checks.filter((c) => c.ok !== null && c.name !== "Shared storage") ?? [];
  const live = core.length > 0 && core.every((c) => c.ok);
  const rpc = status?.checks[0];
  return (
    <>
      <div className="panel strip">
        <div className="cell">
          <p className="k">Site</p>
          <p className="v"><span className={`dot ${status ? (live ? "ok" : "bad") : ""}`} aria-hidden="true" />{status ? (live ? "Live" : "Degraded") : busy ? "Checking…" : DASH}</p>
          <p className="sub">{status ? `checked ${ago(status.checkedAt)}` : ""}</p>
        </div>
        <Cell label="Positions last read" value={asOf ? ago(asOf) : DASH} sub={asOf ? when(asOf) : "open the Loops tab"} />
        <Cell label="Latest block" value={rpc?.ok ? rpc.detail.match(/Block ([\d,]+)/)?.[1] ?? DASH : DASH} sub={rpc?.asOf ? `mined ${ago(rpc.asOf)}` : ""} />
        <Cell label="Refresh" value="Every minute" sub={`while the page is open · server cache ${status?.cacheSeconds ?? 60}s`} />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Data sources</h2>
          <button className="chip plain" onClick={check} disabled={busy}><span className={busy ? "spin" : ""} aria-hidden="true">↻</span> {busy ? "Checking" : "Check now"}</button>
        </div>
        {error ? <p className="empty">Could not check the sources: {error}</p> : !status ? <p className="empty">Checking every source…</p> : (
          <div className="scroll">
            <table className="stack status">
              <thead><tr><th>Source</th><th>Status</th><th>Latest data</th><th className="r">Response</th><th>Used for</th></tr></thead>
              <tbody>
                {status.checks.map((c) => (
                  <tr key={c.name}>
                    <td className="top nw"><strong>{c.name}</strong></td>
                    <td className="top" data-label="Status"><span className={`dot ${c.ok === null ? "" : c.ok ? "ok" : "bad"}`} aria-hidden="true" />{c.detail}</td>
                    <td className="top nw" data-label="Latest data">{c.asOf ? ago(c.asOf) : DASH}</td>
                    <td className="top r nw" data-label="Response">{c.ms != null ? `${c.ms} ms` : DASH}</td>
                    <td className="top finding" data-label="Used for">{c.usedFor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="two">
        <div className="panel">
          <div className="panel-head"><h2>Where each figure comes from</h2></div>
          <div className="body">
            {SOURCES.map(([what, from]) => <div className="kv" key={what}><span>{what}</span><span>{from}</span></div>)}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Saved Aave history</h2>
            <p className="hint">Read once, then only new blocks</p>
          </div>
          {status?.history.length ? (
            <div className="body">
              {status.history.map((h) => (
                <div className="kv" key={h.feed}><span>{h.feed}</span><span>{h.events} events · to block {h.lastBlock.toLocaleString("en-US")} · latest {ago(h.newest)} · {h.where}</span></div>
              ))}
            </div>
          ) : <p className="empty">Nothing saved yet. It fills the first time someone opens Last tx or a holder.</p>}
        </div>
      </div>
    </>
  );
}

// ── Mapping ─────────────────────────────────────────────────────────────────

const DEBT_COLORS = ["#2468fc", "#00c880", "#f2c200", "#8b5cf6", "#06b6d4", "#fb923c", "#e879f9", "#fc4434"];
const num4 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? DASH : n >= 100 ? fmt(n, 0) : n >= 1 ? fmt(n, 2) : n >= 0.0001 ? fmt(n, 4) : n.toPrecision(2));
const kindLabel = (x: MappingHolder, s: string) => (x.kind === "Loop" ? `Loop · ${s}/${x.loopsAgainst}` : x.kind);

function MappingTab({ shown, logoOf, onPick }: { shown: Shown; logoOf: (s: string) => string | undefined; onPick: (symbol: string) => void }) {
  const asset = shown.length === 1 ? shown[0] : undefined;
  const [data, setData] = useState<{ mapping: MappingResponse; markdown: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "loops" | "borrow" | "supply">("all");
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState(false);
  const [hoverDebt, setHoverDebt] = useState<number | null>(null);
  useEffect(() => {
    if (!asset) return;
    let live = true;
    setData(null); setError(null);
    getJson<{ mapping: MappingResponse; markdown: string }>(`/api/mapping?asset=${asset.symbol}`).then((r) => live && setData(r)).catch((e) => live && setError(e instanceof Error ? e.message : "Failed"));
    return () => { live = false; };
  }, [asset]);

  if (!asset) return (
    <div className="panel">
      <div className="panel-head"><h2>Holder mapping</h2><p className="hint">Pick an asset</p></div>
      <div className="pick-grid">{shown.map((a) => <button key={a.symbol} className="pick-card" onClick={() => onPick(a.symbol)}><AssetLogo symbol={a.symbol} src={logoOf(a.symbol)} /> {a.symbol}</button>)}</div>
    </div>
  );
  if (error) return <div className="panel"><p className="empty">Could not build the mapping: {error}</p></div>;
  if (!data) return <div className="panel"><p className="empty">Mapping every {asset.symbol} holder: balances, debt by asset, other collateral and Spark positions… This takes a few seconds the first time.</p></div>;

  const m = data.mapping, s = m.symbol;
  const ql = q.trim().toLowerCase();
  const rows = m.holders.filter((x) => (filter === "all" || (filter === "loops" ? x.kind === "Loop" : filter === "supply" ? x.kind === "Supply only" : x.kind.startsWith("Borrows"))) && (!ql || x.address.toLowerCase().includes(ql) || (x.tag ?? "").toLowerCase().includes(ql) || (x.ens ?? "").toLowerCase().includes(ql)));
  const debtTotal = m.debtByAsset.reduce((t, d) => t + d.usd, 0) || 1;
  const copy = async () => { try { await navigator.clipboard.writeText(data.markdown); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* blocked */ } };
  const loopsTotal = m.loops.reduce((t, x) => t + x.debtBackedUsd, 0);

  return (
    <>
      <div className="panel">
        <div className="panel-head plan-head">
          <div>
            <p className="eyebrow">Holder & loop breakdown · read {when(m.readAt)}</p>
            <div className="asset-name"><AssetLogo symbol={s} src={logoOf(s)} /><a className="title-link" href={asset.etherscanUrl} target="_blank" rel="noopener noreferrer">{s}</a><span className="muted">on Aave V3 Core</span></div>
          </div>
          <div className="report-actions">
            <button className="chip plain" onClick={copy}>{copied ? "Copied" : "Copy Markdown"}</button>
            <a className="chip plain" href={`/api/mapping?asset=${s}&format=md`}>Download .md</a>
          </div>
        </div>
        <div className="strip inner">
          <Cell label={`${s} supplied`} value={fmt(m.totalSupplied)} sub={`${usd(m.totalSuppliedUsd)} · ${fmt(m.holderCount ?? m.listed)} holders`} />
          <Cell label="Concentration" value={pct(m.top1Pct)} sub={`#1 holder · top 3 ${pct(m.top3Pct)} · top 10 ${pct(m.top10Pct)}`} />
          <Cell label={m.analytics.mode === "loop" ? `Holders looping ${s}` : `Holders borrowing against ${s}`} value={fmt(m.loopers)} sub={`${pct(m.loopSharePct)} of the supply · ${m.bigLoops} above $10k`} />
          <Cell label="Debt backed" value={usd(m.debtBackedUsd)} sub="pro rata to collateral mix" />
          <Cell label={m.analytics.mode === "loop" ? "Loop leverage" : "Leverage"} value={m.leverageRange ? `${fmt(m.leverageRange[0], 1)}–${fmt(m.leverageRange[1], 1)}x` : DASH} sub={m.ltvRange ? `LTV ${fmt(m.ltvRange[0], 0)}–${fmt(m.ltvRange[1], 0)}%` : undefined} />
          <Cell label="Rest of the book" value={fmt(m.othersCount)} sub={`holders, ${num4(m.othersSupplied)} ${s}`} />
        </div>
        <div className="body">
          <p className="k">Debt backed by {s}, by asset</p>
          <div className="stack-bar tall" onPointerLeave={() => setHoverDebt(null)}>
            {m.debtByAsset.map((d, i) => <div key={d.symbol} style={{ width: `${(d.usd / debtTotal) * 100}%`, background: DEBT_COLORS[i % DEBT_COLORS.length], opacity: hoverDebt == null || hoverDebt === i ? 1 : 0.35 }} onPointerEnter={() => setHoverDebt(i)} />)}
          </div>
          <div className="legend">
            {m.debtByAsset.slice(0, 8).map((d, i) => (
              <span key={d.symbol} className={hoverDebt === i ? "on" : ""} onPointerEnter={() => setHoverDebt(i)} onPointerLeave={() => setHoverDebt(null)}>
                <i className="sw" style={{ background: DEBT_COLORS[i % DEBT_COLORS.length] }} />{d.symbol} {num4(d.amount)} · {pct((d.usd / debtTotal) * 100)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <MappingRisk m={m} />

      <div className="two">
        <div className="panel">
          <div className="panel-head"><h2>Who to contact</h2><p className="hint">Known entities among the holders</p></div>
          {m.known.length ? (
            <ul className="findings">
              {m.known.map((k) => (
                <li key={k.entity}>
                  <span className="area">{k.ranks.map((r) => `#${r}`).join(" · ")} · {usd(k.debtUsd)} of debt</span>
                  <p><strong>{k.website ? <a className="link" href={k.website} target="_blank" rel="noopener noreferrer">{k.entity}</a> : k.entity}</strong>{k.x ? <> · <a className="link" href={k.x} target="_blank" rel="noopener noreferrer">X</a></> : null}{k.status ? ` — ${k.status}` : ""}</p>
                  {k.approach ? <p className="step-note">Approach: {k.approach}</p> : null}
                </li>
              ))}
            </ul>
          ) : <p className="empty">No tagged entity among the holders yet. Tag wallets in Tagged entities.</p>}
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Unknown positions</h2><p className="hint">{m.analytics.mode === "loop" ? "Loops" : "Positions"} above $10k with no label</p></div>
          {m.unknown.length ? (
            <ul className="findings">
              {m.unknown.map((u) => (
                <li key={u.address}><span className="area">#{u.rank} · {pct(u.sharePct)} of supply</span><p><a className="link mono" href={`https://debank.com/profile/${u.address}`} target="_blank" rel="noopener noreferrer">{short(u.address)}</a> backs {usd(u.debtUsd)}</p></li>
              ))}
            </ul>
          ) : <p className="empty">Every loop above $10k carries a label.</p>}
          {m.questions.length ? <div className="body"><p className="k">Open questions</p>{m.questions.map((x) => <p className="note" key={x}>{x}</p>)}</div> : null}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Holders</h2>
          <p className="hint">{m.listed} holders above ${m.dustUsd} · addresses open on DeBank</p>
        </div>
        <div className="filters">
          <div className="seg" role="group" aria-label="Holders shown">
            {([["all", "All"], ["loops", `Loop ${s}`], ["borrow", "Borrow other"], ["supply", "Supply only"]] as const).map(([k, l]) => <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
          <input className="search" placeholder="Search address, tag or ENS" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="scroll positions-scroll">
          <table className="stack mapping">
            <thead><tr><th>#</th><th>Holder</th><th className="r">{s} supplied</th><th className="r">Share</th><th>Loops {s}?</th><th>Aave debt</th><th className="r">Health factor</th><th>Entity tag</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.address}>
                  <td className="muted">{x.rank}</td>
                  <td data-label="Holder"><a className="link mono" href={`https://debank.com/profile/${x.address}`} target="_blank" rel="noopener noreferrer">{short(x.address)}</a>{x.debtBackedUsd >= 10_000 || x.rank <= 12 ? <a className="open-site" href={`/?asset=${s}&holder=${x.address}#loops`} title="Open this position on the site">position ↗</a> : null}</td>
                  <td className="r" data-label="Supplied">{num4(x.supplied)}</td>
                  <td className="r" data-label="Share">{x.sharePct < 0.1 ? "<0.1%" : pct(x.sharePct)}</td>
                  <td data-label="Loops?"><span className={`status ${x.kind === "Loop" ? "wait" : x.kind === "Supply only" ? "pending" : "done"}`}>{kindLabel(x, s)}</span></td>
                  <td data-label="Debt">{x.debts.length ? x.debts.slice(0, 3).map((d) => `${num4(d.amount)} ${d.symbol}`).join(" + ") : DASH}{x.spark ? <span className="sub">+ Spark {usd(x.spark.debtUsd)}</span> : null}</td>
                  <td className="r" data-label="HF">{x.healthFactor ? <HealthFactor value={x.healthFactor} alert={1.03} /> : DASH}</td>
                  <td data-label="Tag">{x.tag ?? (x.ens ? <span>{x.ens}</span> : <span className="muted">{x.isContract ? x.contractName ?? "Contract" : "EOA"}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>{m.analytics.mode === "loop" ? "Loop details" : "Borrower details"}</h2><p className="hint">{m.loops.length} positions backing $10k+ · {usd(loopsTotal)} of debt</p></div>
        <div className="scroll">
          <table className="stack mapping">
            <thead><tr><th>#</th><th>Holder</th><th className="r">{s} collateral, USD</th><th>Debt</th><th className="r">Debt ÷ {s}</th><th className="r">LTV</th><th className="r">Leverage</th><th className="r">Net equity</th><th className="r">Health factor</th><th className="r">Drop to liquidation</th><th className="r">Share of all Aave debt in that asset</th></tr></thead>
            <tbody>
              {m.loops.map((x) => (
                <tr key={x.address}>
                  <td className="muted">{x.rank}</td>
                  <td className="who" data-label="Holder"><a className="link mono" href={`https://debank.com/profile/${x.address}`} target="_blank" rel="noopener noreferrer">{short(x.address)}</a>{x.debtBackedUsd >= 10_000 || x.rank <= 12 ? <a className="open-site" href={`/?asset=${s}&holder=${x.address}#loops`} title="Open this position on the site">position ↗</a> : null}<span className="sub">{x.tag ?? (x.isContract ? x.contractName ?? "Contract" : "EOA")}{x.spark ? " · also on Spark" : ""}</span></td>
                  <td className="r" data-label="Collateral">{usd(x.suppliedUsd)}</td>
                  <td data-label="Debt">{x.debts.slice(0, 2).map((d) => `${num4(d.amount)} ${d.symbol}`).join(" + ")}</td>
                  <td className={`r ${x.debtPerUnit && x.debtPerUnit > 1 ? "warn" : ""}`} data-label="Debt ÷ units">{x.debtPerUnit?.toFixed(3) ?? DASH}</td>
                  <td className="r" data-label="LTV">{pct(x.ltvPct)}</td>
                  <td className="r" data-label="Leverage">{x.leverage ? `${fmt(x.leverage, 1)}x` : DASH}</td>
                  <td className="r" data-label="Net equity">{usd(x.netEquityUsd)}</td>
                  <td className="r" data-label="HF">{x.healthFactor ? <HealthFactor value={x.healthFactor} alert={1.03} /> : DASH}</td>
                  <td className={`r ${x.dropToLiquidationPct != null && x.dropToLiquidationPct < 2 ? "bad" : ""}`} data-label="Drop to liquidation">{pct(x.dropToLiquidationPct, 2)}</td>
                  <td className="r" data-label="Share of debt">{pct(x.shareOfDebtPct, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {m.notes.length ? (
          <div className="body">
            <p className="k">Notes on individual loops</p>
            <ul className="notes-ul">{m.notes.map((n, i) => <li key={i}><strong>#{n.rank}</strong> — {n.text}</li>)}</ul>
          </div>
        ) : null}
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Methodology & caveats</h2></div>
        <div className="body">
          <p className="note">Balances, debts and health factors are read on-chain from Aave V3 Core: aToken and variable-debt balances for every listed wallet, and the Pool’s getUserAccountData. Debt backed is a wallet’s debt attributed to {s} pro rata to its collateral mix. Drop to liquidation is how far {s} can fall against what is borrowed before the health factor reaches 1, other collateral held constant. Spark is checked for every position above $10k of debt. Entity tags come from the team’s tags, tags added on the site, contract names and ENS; Arkham and DeBank labels are not read automatically.</p>
        </div>
      </div>
    </>
  );
}

// ── Market ──────────────────────────────────────────────────────────────────

function MarketTab({ shown, loops, busy, logoOf }: { shown: Shown; loops: Record<string, LoopsResponse>; busy: boolean; logoOf: (s: string) => string | undefined }) {
  return (
    <>
      {shown.map((a) => {
        const m = loops[a.symbol]?.market;
        if (!m) return <div className="panel" key={a.symbol}><p className="empty">{busy ? `Reading the ${a.symbol} market…` : `No data for ${a.symbol}.`}</p></div>;
        const status = m.paused ? "Paused" : m.frozen ? "Frozen" : m.active ? "Active" : "Inactive";
        return (
          <Fragment key={a.symbol}>
          <div className="panel">
            <div className="panel-head">
              <div className="asset-name">
                <AssetLogo symbol={a.symbol} src={logoOf(a.symbol)} />
                <a className="title-link" href={a.etherscanUrl} target="_blank" rel="noopener noreferrer" title={`${a.symbol} token on Etherscan`}>{a.symbol}</a>
                <span className="muted">on</span>
                <a className="title-link" href={a.aaveUrl} target="_blank" rel="noopener noreferrer" title={`${a.symbol} on ${m.venue}, in the Aave app`}>{m.venue} ↗</a>
              </div>
              <p className="hint">Read {when(loops[a.symbol].asOf)}</p>
            </div>
            <div className="strip">
              <Cell label={`Supplied, in ${a.symbol}`} value={fmt(m.suppliedTokens)} />
              <Cell label={`Supplied, value in ${m.debtSymbol === "WETH" ? "ETH" : m.debtSymbol}`} value={fmt(m.suppliedInDebtAsset)} sub={`${a.symbol} supplied × ${fmt(m.rate, 4)}`} />
              <Cell label="Supplied, value in USD" value={usd(m.suppliedUsd)} />
              <Cell label={`${m.debtSymbol} debt against it`} value={isStable(m.debtSymbol) ? usd(m.trackedDebtUsd) : fmt(m.trackedDebt)} sub="tracked holders" />
              <Cell label="Debt, value in USD" value={usd(m.trackedDebtUsd)} />
              <Cell label="Debt ÷ collateral" value={pct(m.debtToCollateralPct)} sub="tracked holders" />
              <Cell label={`Net equity, in ${m.debtSymbol === "WETH" ? "ETH" : m.debtSymbol}`} value={fmt(m.netEquityInDebtAsset)} sub="tracked holders" />
              <Cell label="Holders" value={fmt(m.holders)} sub={`${fmt(m.tracked)} tracked, ${pct(m.trackedSharePct, 2)} of supply`} />
              <Cell label="Largest holder" value={pct(m.top1SharePct)} />
              <Cell label="Top 3 holders" value={pct(m.top3SharePct)} />
              <Cell label="Top 10 holders" value={pct(m.top10SharePct)} />
              <Cell label="Reserve status" value={status} tone={status === "Active" ? "" : "warn"} />
              <Cell label="Max LTV" value={pct(m.ltvPct, 2)} sub="outside e-mode" />
              <Cell label="Liquidation threshold" value={pct(m.liquidationThresholdPct, 2)} sub="outside e-mode" />
              <Cell label="Supply cap" value={m.supplyCap ? fmt(m.supplyCap) : "None"} />
              <Cell label={`${a.symbol} price`} value={`$${fmt(m.priceUsd, 2)}`} sub={m.source === "TokenLogic API" ? "TokenLogic API" : "Aave oracle"} />
              <Cell label={`${a.symbol} supply APY`} value={pct(m.supplyApy, 2)} sub="TokenLogic" />
              {isStable(m.debtSymbol) ? null : <Cell label={`${m.debtSymbol} borrow APY`} value={pct(m.debtBorrowApy, 2)} sub="TokenLogic" />}
              {m.utilization !== null ? <Cell label="Utilization" value={pct(m.utilization, 1)} sub={m.borrowedTokens !== null ? `${fmt(m.borrowedTokens)} ${a.symbol} borrowed` : undefined} /> : null}
              {m.source === "TokenLogic API" ? <Cell label="Liquidations, 90 days" value={fmt(m.liquidations90d)} sub="whole market · TokenLogic" tone={m.liquidations90d ? "warn" : ""} /> : null}
            </div>
            <div className="body">
              <p className="note">
                Supply, prices and rates: {m.source === "TokenLogic API" ? `TokenLogic API${m.dataAsOf ? `, updated ${when(m.dataAsOf)}` : ""}` : "on-chain, with rates from TokenLogic’s public endpoint"}.
                Reserve settings and positions: on-chain.
              </p>
              {m.notes.map((n) => <p className="note warn" key={n}>{n}</p>)}
            </div>
          </div>
          <RiskPanel asset={a} />
          </Fragment>
        );
      })}
      <p className="note">
        Values use the Aave oracle price at the time of reading. Debt against the market is what the tracked holders borrow in the loop’s debt asset; smaller holders are not included.
      </p>
    </>
  );
}

// ── Market: issuer risk ─────────────────────────────────────────────────────

const BACKING_COLORS = ["#2468fc", "#00c880", "#f2c200", "#8b5cf6", "#06b6d4"];

function RiskPanel({ asset }: { asset: Shown[number] }) {
  const [risk, setRisk] = useState<RiskResponse | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => getJson<{ risk: RiskResponse | null }>(`/api/risk?asset=${asset.symbol}`).then((r) => live && (setRisk(r.risk), setError(null))).catch((e) => live && setError(e instanceof Error ? e.message : "Failed"));
    load();
    const id = window.setInterval(() => document.visibilityState === "visible" && load(), 10 * 60_000);
    return () => { live = false; window.clearInterval(id); };
  }, [asset.symbol]);

  if (risk === null) return null;
  if (error) return <div className="panel"><p className="empty">Could not read {asset.symbol}’s peg and backing: {error}</p></div>;
  if (!risk) return <div className="panel"><p className="empty">Reading {asset.symbol}’s peg and backing…</p></div>;

  const peg = risk.market?.pegPct ?? null;
  const pegTone = peg == null ? "" : Math.abs(peg) < 0.5 ? "pos" : Math.abs(peg) < 2 ? "warn" : "bad";
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Issuer · {risk.issuer}</p>
            <h2>{risk.symbol}: peg, backing and risk</h2>
          </div>
          <p className="hint">Read {when(risk.readAt)} · refreshed every 10 minutes</p>
        </div>
        <div className="strip inner">
          <Cell label="Market price vs exchange rate" value={signed(peg, 2)} tone={pegTone} sub={risk.market ? `${fmt(risk.market.priceEth, 4)} ETH on ${risk.market.source} · rate ${fmt(risk.exchangeRate, 4)}` : "market price unavailable"} />
          <Cell label="Exchange rate" value={`${fmt(risk.exchangeRate, 4)} ETH`} sub={`${risk.rateSource}${risk.rateSource === "Kelp oracle" ? ` · Aave uses ${fmt(risk.aaveRate, 4)}` : ""}`} />
          <Cell label={`${risk.symbol} supply on Ethereum`} value={fmt(risk.supply)} sub={risk.market ? usd(risk.supply * risk.market.priceUsd) : undefined} />
          <Cell label="Held on Aave V3 Core" value={pct(risk.onAavePct)} tone={risk.onAavePct && risk.onAavePct > 50 ? "warn" : ""} sub={`${fmt(risk.onAave)} ${risk.symbol}`} />
          <Cell label="Kelp deposits" value={risk.depositsPaused == null ? DASH : risk.depositsPaused ? "Paused" : "Open"} tone={risk.depositsPaused ? "warn" : ""} sub="deposit pool" />
          <Cell label="Market price, 24 h" value={signed(risk.market?.change24hPct, 2)} sub="in ETH" />
        </div>
        <div className="risk-grid">
          <div className="body">
            <p className="k">Backing{risk.backedEth ? ` · ${fmt(risk.backedEth)} ETH in Kelp’s deposit pool` : ""}</p>
            {risk.backing.some((b) => b.sharePct != null) ? (
              <>
                <div className="stack-bar" role="img" aria-label="Backing by asset">
                  {risk.backing.map((b, i) => b.sharePct ? <div key={b.symbol} style={{ width: `${b.sharePct}%`, background: BACKING_COLORS[i % BACKING_COLORS.length] }} title={`${b.symbol} ${pct(b.sharePct)}`} /> : null)}
                </div>
                {risk.backing.map((b, i) => (
                  <div className="kv" key={b.symbol}>
                    <span><i className="sw" style={{ background: BACKING_COLORS[i % BACKING_COLORS.length] }} />{b.symbol}</span>
                    <span>{b.tokens != null ? `${fmt(b.tokens)} ${b.symbol}` : DASH}{b.eth != null && b.symbol !== "ETH" ? ` · ${fmt(b.eth)} ETH` : ""} · {pct(b.sharePct)}</span>
                  </div>
                ))}
                <p className="note">Kelp’s own accounting: stETH counts at 1 ETH, so a stETH discount does not lower the rsETH rate.</p>
              </>
            ) : <p className="note">Kelp’s deposit pool did not answer.</p>}
          </div>
          <div className="body">
            <p className="k">Exit liquidity</p>
            <p className="plain">{risk.exit.text}</p>
            <p className="note">{risk.exit.source}</p>
          </div>
        </div>
        {risk.warnings.map((w) => <p className="note warn pad" key={w}>{w}</p>)}
      </div>

      <div className="two">
        <div className="panel">
          <div className="panel-head"><h2>Risk findings</h2><p className="hint">{risk.findingsSource.label}, {risk.findingsSource.date}</p></div>
          <ul className="findings">
            {risk.findings.map((f) => <li key={f.area}><span className="area">{f.area}</span><p>{f.text}</p></li>)}
          </ul>
        </div>
        <div className="panel">
          <div className="panel-head"><h2>Incidents</h2><p className="hint">Exploits and governance events</p></div>
          <ol className="incidents">
            {risk.incidents.map((x) => (
              <li key={x.date + x.title}>
                <span className="when">{dayLabel(x.date)} {x.date.slice(0, 4)}</span>
                <div>
                  <p className="title">{x.title}</p>
                  <p>{x.text}</p>
                  {x.links.length ? <p className="links-inline">{x.links.map((l) => <a key={l.url} className="link" href={l.url} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </>
  );
}

// ── Last tx ─────────────────────────────────────────────────────────────────

type TxFilter = "all" | "holders" | "entities";
const TX_FILTERS: { id: TxFilter; label: string }[] = [
  { id: "all", label: "All market" },
  { id: "holders", label: "Tracked holders" },
  { id: "entities", label: "Tagged entities" },
];

function TxTab(props: {
  shown: Shown; tx: Record<string, Tx[]>; busy: boolean; error: string | null; positions: Row[]; colors: Map<string, string>; entities: Entity[]; onRetry: () => void;
}) {
  const { shown, tx, busy, error, positions, colors, entities, onRetry } = props;
  const [filter, setFilter] = useState<TxFilter>("all");
  const [holder, setHolder] = useState("");
  const [entity, setEntity] = useState("");
  const [type, setType] = useState("");
  const [loopOnly, setLoopOnly] = useState(true);

  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: Tx[] = [];
    for (const a of shown) for (const scope of ["market", "holders"] as const) for (const t of tx[`${a.symbol}:${scope}`] ?? []) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out.sort((x, y) => y.timestamp.localeCompare(x.timestamp));
  }, [shown, tx]);

  const rows = all.filter((t) => {
    if (filter === "holders" && !t.walletRank) return false;
    if (loopOnly && !t.assetRelated) return false;
    if (filter === "entities" && !t.counterpartyTag) return false;
    if (holder && t.wallet.toLowerCase() !== holder) return false;
    if (entity && t.counterpartyTag?.entity !== entity && t.walletTag?.entity !== entity) return false;
    if (type && t.action !== type) return false;
    return true;
  }).slice(0, 300);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Last transactions</h2>
        <p className="hint">Aave actions read from the Pool contract, other transfers from Blockscout, newest first</p>
      </div>
      <div className="filters">
        <div className="seg" role="group" aria-label="Transactions shown">
          {TX_FILTERS.map((f) => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Tokens shown">
          <button aria-pressed={loopOnly} onClick={() => setLoopOnly(true)}>{shown.length === 1 ? `${shown[0].symbol} loop only` : "Loop only"}</button>
          <button aria-pressed={!loopOnly} onClick={() => setLoopOnly(false)}>All tokens</button>
        </div>
        <select aria-label="Holder" value={holder} onChange={(e) => setHolder(e.target.value)}>
          <option value="">All holders</option>
          {positions.map(({ asset, p }) => <option key={`${asset}:${p.address}`} value={p.address.toLowerCase()}>#{p.rank} {holderName(p)} · {short(p.address)}</option>)}
        </select>
        <select aria-label="Entity tag" value={entity} onChange={(e) => setEntity(e.target.value)}>
          <option value="">All entity tags</option>
          {entities.map((e) => <option key={e.entity} value={e.entity}>{e.entity}</option>)}
        </select>
        <select aria-label="Transaction type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {TX_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {error ? <p className="empty">Could not load transactions: {error} <button className="chip plain" onClick={onRetry}>Try again</button></p>
        : busy && !all.length ? <p className="empty">Reading transactions for {shown.length ? shown.map((a) => a.symbol).join(", ") : "the selected assets"}…</p>
        : rows.length ? <TxTable rows={rows} colors={colors} showWallet />
        : <p className="empty">{all.length ? (loopOnly ? "No loop transaction matches these filters. Switch to all tokens to see the holders’ other activity." : "No transaction matches these filters.") : "No recent transaction found."}</p>}
      <div className="body">
        <p className="note">
          Loop only (default): Aave actions and transfers that touch the loop: the collateral and its aToken, the borrowed asset and its debt token, and liquidations. All tokens adds the holders’ other transfers.
          All market: every wallet on the selected market. Tracked holders: the top holders only. Tagged entities: transactions whose counterparty is one of the tagged addresses.
        </p>
      </div>
    </div>
  );
}

// ── Tagged entities ─────────────────────────────────────────────────────────

function EntitiesTab(props: {
  registry: RegistryData | null; positions: Row[]; shown: Shown; tx: Record<string, Tx[]>; txBusy: boolean; colors: Map<string, string>;
  community: CommunityTag[]; communityError: string | null; onCommunityChange: () => void;
  allAssets: { symbol: string; logo: string }[]; logoOf: (s: string) => string | undefined;
}) {
  const { registry, positions, shown, tx, txBusy, colors, community, communityError, onCommunityChange } = props;
  const entities = registry?.entities ?? [];
  const holdersTx = shown.flatMap((a) => tx[`${a.symbol}:holders`] ?? []);

  const byEntity = (name: string) => positions.filter((x) => x.p.tag?.entity === name);
  const untagged = positions.filter((x) => !x.p.tag);
  const cols = Array.from(new Set(holdersTx.map((t) => t.counterpartyTag?.entity).filter((e): e is string => Boolean(e))));
  const countFor = (address: string, name: string) => holdersTx.filter((t) => t.wallet.toLowerCase() === address.toLowerCase() && t.counterpartyTag?.entity === name).length;
  const link = (url: string, text: string) => (url ? <a className="link" href={url} target="_blank" rel="noopener noreferrer">{text}</a> : <span className="muted">{DASH}</span>);

  return (
    <>
      <HolderExport assets={props.allAssets} initial={shown.length === 1 ? shown[0].symbol : "all"} logoOf={props.logoOf} />

      <CommunityPanel positions={positions} entities={Array.from(new Set([...entities.map((e) => e.entity), ...community.map((t) => t.entity)]))}
        tags={community} error={communityError} colors={colors} onChange={onCommunityChange} />

      <div className="panel">
        <div className="panel-head">
          <h2>Entities</h2>
          <p className="hint">Tracked positions per tag, and how each is approached</p>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr><th>Tag</th><th>Kind</th><th className="r">Holders</th><th className="r">Share of market</th><th>Approach</th><th>Status</th><th>Site</th><th>X</th></tr>
            </thead>
            <tbody>
              {entities.map((e) => {
                const mine = byEntity(e.entity);
                return (
                  <tr key={e.entity}>
                    <td className="top"><EntityTag entity={e.entity} colors={colors} /></td>
                    <td className="top">{e.kind || DASH}</td>
                    <td className="top r">{mine.length ? fmt(mine.length) : DASH}</td>
                    <td className="top r">{mine.length ? pct(mine.reduce((s, x) => s + x.p.sharePct, 0), 2) : DASH}</td>
                    <td className="top nw">{e.approach || DASH}</td>
                    <td className="top">{e.status || DASH}</td>
                    <td className="top nw">{link(e.website, e.website.replace(/^https:\/\//, ""))}</td>
                    <td className="top nw">{link(e.x, `@${e.x.split("/").pop()}`)}</td>
                  </tr>
                );
              })}
              {untagged.length ? (
                <tr>
                  <td className="top"><span className="tag"><i className="dot" style={{ background: "var(--muted)" }} aria-hidden="true" />Not tagged yet</span></td>
                  <td className="top">Tracked holders with no tag</td>
                  <td className="top r">{fmt(untagged.length)}</td>
                  <td className="top r">{pct(untagged.reduce((s, x) => s + x.p.sharePct, 0), 2)}</td>
                  <td className="top" colSpan={4}>Add them in data/tags.json: {untagged.map((x) => short(x.p.address)).join(", ")}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Tagged entity × holder interactions</h2>
          <p className="hint">Recent transfers between each tracked holder and each tagged entity</p>
        </div>
        {txBusy && !holdersTx.length ? <p className="empty">Reading the holders’ transactions…</p>
          : !cols.length ? <p className="empty">No recent transfer between a tracked holder and a tagged address.</p>
          : (
            <div className="scroll">
              <table>
                <thead><tr><th>Holder</th>{cols.map((c) => <th key={c}><EntityTag entity={c} colors={colors} /></th>)}</tr></thead>
                <tbody>
                  {positions.map(({ asset, p }) => (
                    <tr key={`${asset}:${p.address}`}>
                      <td>#{p.rank} {holderName(p)}<span className="sub">{short(p.address)}</span></td>
                      {cols.map((c) => { const n = countFor(p.address, c); return <td key={c}>{n ? <span className="count">{n}</span> : <span className="muted">{DASH}</span>}</td>; })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Tagged addresses</h2>
          <p className="hint">Edited in data/tags.json. A short form like 0x40E9…AbA8 matches the full address.</p>
        </div>
        <div className="scroll">
          <table>
            <thead><tr><th>Label</th><th>Tag</th><th>Kind</th><th>Address</th></tr></thead>
            <tbody>
              {(registry?.tags ?? []).map((t) => (
                <tr key={t.match}>
                  <td>{t.label}</td>
                  <td><EntityTag entity={t.entity} colors={colors} /></td>
                  <td className="nw">{t.kind}</td>
                  <td className="mono">{/^0x[0-9a-fA-F]{40}$/.test(t.match) ? <Addr address={t.match} /> : t.match}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// ── Community tags ──────────────────────────────────────────────────────────

function CommunityCard({ t, colors, onRemove, mine }: { t: CommunityTag; colors: Map<string, string>; onRemove?: () => void; mine?: boolean }) {
  return (
    <div className="ccard">
      <div className="ccard-head">
        <EntityTag entity={t.entity} colors={colors} community />
        {t.label ? <span>{t.label}</span> : null}
        <span className={`conf ${t.confidence.toLowerCase()}`}>{t.confidence}</span>
      </div>
      <p className="ccard-why">{t.reasoning}</p>
      {t.links.length ? (
        <div className="ccard-links">{t.links.map((l) => <a key={l} className="link" href={l} target="_blank" rel="noopener noreferrer">{l.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}</a>)}</div>
      ) : null}
      <p className="ccard-by">
        Tagged by <strong>{t.author}</strong> · {when(t.createdAt)}
        {mine && onRemove ? <button className="textbtn" onClick={onRemove}>Remove</button> : null}
      </p>
    </div>
  );
}

const NAME_KEY = "loop-tracker:name";

function CommunityPanel({ positions, entities, tags, error, colors, onChange }: {
  positions: Row[]; entities: string[]; tags: CommunityTag[]; error: string | null; colors: Map<string, string>; onChange: () => void;
}) {
  const [author, setAuthor] = useState("");
  const [holder, setHolder] = useState("");
  const [other, setOther] = useState("");
  const [entity, setEntity] = useState("");
  const [label, setLabel] = useState("");
  const [confidence, setConfidence] = useState<CommunityTag["confidence"]>("Probable");
  const [reasoning, setReasoning] = useState("");
  const [links, setLinks] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => { try { setAuthor(localStorage.getItem(NAME_KEY) ?? ""); } catch { /* storage blocked */ } }, []);
  const address = holder === "other" ? other.trim() : holder;
  const nameOf = (a: string) => {
    const r = positions.find((x) => x.p.address.toLowerCase() === a.toLowerCase());
    return r ? `#${r.p.rank} ${holderName(r.p)}` : short(a);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true); setMessage(null);
    try {
      const res = await fetch("/api/community-tags", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ author, address, entity, label, confidence, reasoning, links: links.split(/\s+/).filter(Boolean) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Could not save (${res.status})`);
      try { localStorage.setItem(NAME_KEY, author); } catch { /* storage blocked */ }
      setMessage({ ok: true, text: `Saved. Everyone with access now sees ${entity} on ${nameOf(address)}.` });
      setReasoning(""); setLinks(""); setLabel("");
      onChange();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Could not save" });
    }
    setSending(false);
  }

  async function remove(t: CommunityTag) {
    const res = await fetch(`/api/community-tags?id=${encodeURIComponent(t.id)}&author=${encodeURIComponent(author)}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setMessage({ ok: false, text: body.error ?? "Could not remove" });
    onChange();
  }

  const shownTags = filter ? tags.filter((t) => t.address.toLowerCase() === filter) : tags;
  return (
    <div className="two community">
      <div className="panel">
        <div className="panel-head">
          <h2>Tag a holder</h2>
          <p className="hint">Visible to everyone with access to the site</p>
        </div>
        <form className="body form" onSubmit={submit}>
          <label className="field">
            <span>Your name</span>
            <input id="ct-author" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="e.g. Elliot" maxLength={40} required />
          </label>
          <label className="field">
            <span>Holder</span>
            <select id="ct-holder" value={holder} onChange={(e) => setHolder(e.target.value)} required>
              <option value="" disabled>Choose a holder</option>
              {positions.map(({ asset, p }) => <option key={`${asset}:${p.address}`} value={p.address}>#{p.rank} {holderName(p)} · {short(p.address)}</option>)}
              <option value="other">Another address…</option>
            </select>
          </label>
          {holder === "other" ? (
            <label className="field">
              <span>Address</span>
              <input id="ct-address" className="mono" value={other} onChange={(e) => setOther(e.target.value)} placeholder="0x…" pattern="0x[0-9a-fA-F]{40}" required />
            </label>
          ) : null}
          <div className="row2">
            <label className="field">
              <span>Entity</span>
              <input id="ct-entity" list="ct-entities" value={entity} onChange={(e) => setEntity(e.target.value)} placeholder="e.g. Kelp" maxLength={60} required />
              <datalist id="ct-entities">{entities.map((n) => <option key={n} value={n} />)}</datalist>
            </label>
            <label className="field">
              <span>Confidence</span>
              <select id="ct-confidence" value={confidence} onChange={(e) => setConfidence(e.target.value as CommunityTag["confidence"])}>
                <option>Confirmed</option><option>Probable</option><option>Possible</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Label <em>optional</em></span>
            <input id="ct-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Treasury Safe 2" maxLength={60} />
          </label>
          <label className="field">
            <span>Why you think so</span>
            <textarea id="ct-reasoning" value={reasoning} onChange={(e) => setReasoning(e.target.value)} rows={4} maxLength={1500} required
              placeholder="What links this wallet to the entity: funding source, shared deployer, a post, a conversation…" />
          </label>
          <label className="field">
            <span>Links <em>optional, one per line</em></span>
            <textarea id="ct-links" className="mono" value={links} onChange={(e) => setLinks(e.target.value)} rows={2} placeholder="https://etherscan.io/tx/…" />
          </label>
          <div className="formfoot">
            <button className="primary" type="submit" disabled={sending}>{sending ? "Saving…" : "Add tag"}</button>
            {message ? <p className={message.ok ? "good" : "bad"} role="status">{message.text}</p> : null}
          </div>
        </form>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Tagged on the site <span className="muted">{tags.length}</span></h2>
          <select aria-label="Filter by holder" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All holders</option>
            {Array.from(new Set(tags.map((t) => t.address.toLowerCase()))).map((a) => <option key={a} value={a}>{nameOf(a)}</option>)}
          </select>
        </div>
        {error ? <p className="empty">Could not load community tags: {error}</p>
          : shownTags.length ? (
            <div className="body clist">
              {shownTags.map((t) => (
                <div key={t.id}>
                  <p className="k">{nameOf(t.address)} <span className="mono">{short(t.address)}</span></p>
                  <CommunityCard t={t} colors={colors} mine={Boolean(author) && t.author.toLowerCase() === author.trim().toLowerCase()} onRemove={() => remove(t)} />
                </div>
              ))}
            </div>
          ) : <p className="empty">No tag yet. The first one you add shows here for everyone.</p>}
      </div>
    </div>
  );
}


function MappingRisk({ m }: { m: MappingResponse }) {
  const a = m.analytics;
  const s = m.symbol;
  const [hover, setHover] = useState<number | null>(null);
  const total = m.loops.reduce((x, l) => x + l.debtBackedUsd, 0) || 1;
  const maxHf = Math.max(1, ...a.hfBuckets.map((b) => b.debtUsd));
  const what = a.mode === "loop" ? `${s}/${m.loops[0]?.loopsAgainst ?? "debt"} exchange rate` : `${s} price`;
  const h = hover != null ? a.ladder[hover] : null;
  return (
    <div className="panel">
      <div className="panel-head"><h2>Liquidation and concentration</h2><p className="hint">{m.loops.length} positions backing $10k+ · other collateral held constant</p></div>
      <div className="strip inner">
        <Cell label="Debt-weighted HF" value={a.weightedHf ? a.weightedHf.toFixed(3) : DASH} sub="across positions above $10k" />
        <Cell label="Largest position" value={pct(a.debtTop1Pct)} sub={`of debt · top 3 ${pct(a.debtTop3Pct)} · top 10 ${pct(a.debtTop10Pct)}`} />
        <Cell label="80% of the debt" value={`${a.positionsFor80Pct} positions`} sub={`HHI ${Math.round(a.hhi).toLocaleString("en-US")}${a.hhi > 2500 ? " · highly concentrated" : a.hhi > 1500 ? " · concentrated" : ""}`} />
        <Cell label="Held by contracts" value={pct(a.contractDebtPct)} sub="of the debt (Safes, vaults, proxies)" />
        <Cell label="Identified" value={pct(a.identifiedDebtPct)} sub="of the debt has an entity tag" />
        <Cell label="Also on Spark" value={a.sparkPositions ? usd(a.sparkDebtUsd) : DASH} sub={`${a.sparkPositions} position${a.sparkPositions === 1 ? "" : "s"} with Spark debt`} />
      </div>
      <div className="two-inner">
        <div className="body">
          <p className="k">Debt liquidated if the {what} falls by…</p>
          <div className="ladder" onPointerLeave={() => setHover(null)}>
            {a.ladder.map((l, i) => (
              <div key={l.dropPct} className={`rung${hover === i ? " on" : ""}`} onPointerEnter={() => setHover(i)}>
                <span className="lab">−{l.dropPct}%</span>
                <span className="lbar"><i style={{ width: `${(l.debtUsd / total) * 100}%` }} /></span>
                <span className="val">{l.debtUsd ? usd(l.debtUsd) : DASH}</span>
              </div>
            ))}
          </div>
          <p className="note">{h ? `At −${h.dropPct}%: ${h.positions} positions, ${usd(h.debtUsd)} of debt (${pct((h.debtUsd / total) * 100)}) and ${usd(h.collateralUsd)} of ${s} collateral become liquidatable.` : `Hover a row. ${a.mode === "loop" ? "Loops are exposed to the exchange rate, not the ETH price: a depeg or an oracle cut is what liquidates them." : "Borrowers are exposed to the price; an LT cut of d points acts like a fall of about d/LT."}`}</p>
        </div>
        <div className="body">
          <p className="k">Debt by health factor</p>
          <div className="ladder">
            {a.hfBuckets.map((b, i) => (
              <div key={b.label} className="rung">
                <span className="lab">{b.label}</span>
                <span className="lbar"><i className={i < 2 ? "bad" : i < 3 ? "warn" : "ok"} style={{ width: `${(b.debtUsd / maxHf) * 100}%` }} /></span>
                <span className="val">{b.debtUsd ? `${usd(b.debtUsd)} · ${b.positions}` : DASH}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── All assets: Loops overview ──────────────────────────────────────────────

const ASSET_COLORS = ["#2468fc", "#00c880", "#f2c200", "#8b5cf6", "#06b6d4", "#fb923c", "#e879f9", "#fc4434"];

function ShareBar({ parts, logoOf }: { parts: { symbol: string; value: number }[]; logoOf: (s: string) => string | undefined }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = parts.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <>
      <div className="stack-bar tall" onPointerLeave={() => setHover(null)}>
        {parts.map((d, i) => <div key={d.symbol} style={{ width: `${(d.value / total) * 100}%`, background: ASSET_COLORS[i % ASSET_COLORS.length], opacity: hover == null || hover === i ? 1 : 0.35 }} onPointerEnter={() => setHover(i)} />)}
      </div>
      <div className="legend">
        {parts.map((d, i) => (
          <span key={d.symbol} className={hover === i ? "on" : ""} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
            <i className="sw" style={{ background: ASSET_COLORS[i % ASSET_COLORS.length] }} /><AssetLogo symbol={d.symbol} src={logoOf(d.symbol)} />{d.symbol} {usd(d.value)} · {pct((d.value / total) * 100)}
          </span>
        ))}
      </div>
    </>
  );
}

function LoopsOverview({ shown, loops, busy, hfAlert, logoOf, onAsset }: { shown: Shown; loops: Record<string, LoopsResponse>; busy: boolean; hfAlert: number; logoOf: (s: string) => string | undefined; onAsset: (s: string) => void }) {
  const rows = shown.map((a) => ({ a, m: loops[a.symbol]?.market })).filter((x): x is { a: Shown[number]; m: Market } => !!x.m);
  const coll = (m: Market) => m.trackedSupplied * m.priceUsd;
  const tot = {
    positions: rows.reduce((s, x) => s + x.m.tracked, 0),
    withDebt: rows.reduce((s, x) => s + (x.m.scan?.withDebt ?? x.m.looping), 0),
    coll: rows.reduce((s, x) => s + coll(x.m), 0),
    debt: rows.reduce((s, x) => s + x.m.trackedDebtUsd, 0),
    alert: rows.reduce((s, x) => s + x.m.underAlert, 0),
  };
  const byDebt = [...rows].sort((x, y) => y.m.trackedDebtUsd - x.m.trackedDebtUsd);
  return (
    <div className="panel">
      <div className="panel-head">
        <div><p className="eyebrow">Aave V3 Core · all tracked assets</p><div className="asset-name"><AssetStack assets={shown.map((a) => ({ symbol: a.symbol, logo: a.logo }))} />{shown.length} assets in scope</div></div>
        <p className="hint">{busy && rows.length < shown.length ? `Reading ${shown.length - rows.length} more…` : "Select a row to open the asset"}</p>
      </div>
      <div className="strip inner">
        <Cell label="Tracked positions" value={fmt(tot.positions)} sub={`${fmt(tot.withDebt)} with $10k+ of debt`} />
        <Cell label="Collateral" value={usd(tot.coll)} sub="tracked holders, Aave oracle" />
        <Cell label="Debt backed" value={usd(tot.debt)} sub="pro rata to collateral mix" />
        <Cell label="Debt ÷ collateral" value={pct(tot.coll ? (tot.debt / tot.coll) * 100 : null)} sub="weighted by value" />
        <Cell label="Net equity" value={usd(tot.coll - tot.debt)} sub="collateral minus debt" />
        <Cell label={`Health factor below ${hfAlert.toFixed(2)}`} value={fmt(tot.alert)} tone={tot.alert ? "bad" : ""} sub="tracked holders" />
      </div>
      <div className="body">
        <p className="k">Debt backed, by asset</p>
        <ShareBar parts={byDebt.map((x) => ({ symbol: x.a.symbol, value: x.m.trackedDebtUsd }))} logoOf={logoOf} />
      </div>
      <div className="scroll">
        <table className="stack overview">
          <thead><tr><th>Asset</th><th className="r">Positions</th><th className="r">Supplied</th><th className="r">Collateral</th><th className="r">Debt backed</th><th className="r">Share of debt</th><th className="r">Debt ÷ collateral</th><th className="r">HF &lt; {hfAlert.toFixed(2)}</th><th className="r">Debt and its cost</th></tr></thead>
          <tbody>
            {byDebt.map(({ a, m }) => (
              <tr key={a.symbol} className="click" onClick={() => onAsset(a.symbol)}>
                <td className="nw"><span className="asset-inline"><AssetLogo symbol={a.symbol} src={logoOf(a.symbol)} /><strong>{a.symbol}</strong></span></td>
                <td className="r" data-label="Positions">{fmt(m.tracked)}<span className="sub">{fmt(m.scan?.withDebt ?? m.looping)} ≥ $10k</span></td>
                <td className="r" data-label="Supplied">{fmt(m.trackedSupplied)}<span className="sub">{pct(m.trackedSharePct, 1)} of market</span></td>
                <td className="r" data-label="Collateral">{usd(coll(m))}</td>
                <td className="r" data-label="Debt backed">{usd(m.trackedDebtUsd)}</td>
                <td className="r" data-label="Share">{pct(tot.debt ? (m.trackedDebtUsd / tot.debt) * 100 : null)}</td>
                <td className="r" data-label="Debt ÷ collateral">{pct(m.debtToCollateralPct)}</td>
                <td className={`r ${m.underAlert ? "neg" : ""}`} data-label="HF alert">{fmt(m.underAlert)}</td>
                <td className="r" data-label="Debt">{isStable(m.debtSymbol) ? "Stablecoins" : `${m.debtSymbol} · ${pct(m.debtBorrowApy, 2)}`}</td>
              </tr>
            ))}
            {rows.length > 1 ? (
              <tr className="total">
                <td>All assets</td>
                <td className="r" data-label="Positions">{fmt(tot.positions)}</td><td className="r" data-label="Supplied">{DASH}</td>
                <td className="r" data-label="Collateral">{usd(tot.coll)}</td><td className="r" data-label="Debt backed">{usd(tot.debt)}</td>
                <td className="r" data-label="Share">100%</td><td className="r" data-label="Debt ÷ collateral">{pct(tot.coll ? (tot.debt / tot.coll) * 100 : null)}</td>
                <td className="r" data-label="HF alert">{fmt(tot.alert)}</td><td className="r" data-label="Debt">{DASH}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── All assets: Market overview ─────────────────────────────────────────────

function MarketOverview({ shown, loops, busy, logoOf, onAsset }: { shown: Shown; loops: Record<string, LoopsResponse>; busy: boolean; logoOf: (s: string) => string | undefined; onAsset: (s: string) => void }) {
  const rows = shown.map((a) => ({ a, m: loops[a.symbol]?.market })).filter((x): x is { a: Shown[number]; m: Market } => !!x.m).sort((x, y) => y.m.suppliedUsd - x.m.suppliedUsd);
  const supplied = rows.reduce((s, x) => s + x.m.suppliedUsd, 0);
  const debt = rows.reduce((s, x) => s + x.m.trackedDebtUsd, 0);
  const trackedColl = rows.reduce((s, x) => s + x.m.trackedSupplied * x.m.priceUsd, 0);
  const holders = rows.reduce((s, x) => s + (x.m.holders ?? 0), 0);
  const frozen = rows.filter((x) => x.m.frozen || x.m.paused).length;
  const liq = rows.reduce((s, x) => s + (x.m.liquidations90d ?? 0), 0);
  const wApy = supplied ? rows.reduce((s, x) => s + (x.m.supplyApy ?? 0) * x.m.suppliedUsd, 0) / supplied : null;
  const status = (m: Market) => (m.paused ? "Paused" : m.frozen ? "Frozen" : m.active ? "Active" : "Inactive");
  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <div><p className="eyebrow">Aave V3 Core · combined markets</p><div className="asset-name"><AssetStack assets={shown.map((a) => ({ symbol: a.symbol, logo: a.logo }))} />Global view</div></div>
          <p className="hint">{busy && rows.length < shown.length ? `Reading ${shown.length - rows.length} more…` : "Select a row for the asset’s market and issuer risk"}</p>
        </div>
        <div className="strip inner">
          <Cell label="Supplied, all markets" value={usd(supplied)} sub={`${rows.length} reserves, Aave oracle`} />
          <Cell label="Debt backed" value={usd(debt)} sub="tracked holders" />
          <Cell label="Debt ÷ collateral" value={pct(trackedColl ? (debt / trackedColl) * 100 : null)} sub="tracked holders, weighted" />
          <Cell label="Net equity" value={usd(trackedColl - debt)} sub="tracked holders" />
          <Cell label="Holders" value={fmt(holders)} sub="sum across reserves" />
          <Cell label="Reserves frozen" value={`${frozen} / ${rows.length}`} tone={frozen ? "warn" : ""} sub="LTV 0, no new supply" />
          <Cell label="Supply APY, weighted" value={pct(wApy, 2)} sub="by supplied value · TokenLogic" />
          <Cell label="Liquidations, 90 days" value={fmt(liq)} tone={liq ? "warn" : ""} sub="whole markets · TokenLogic" />
        </div>
        <div className="body">
          <p className="k">Supplied value, by reserve</p>
          <ShareBar parts={rows.map((x) => ({ symbol: x.a.symbol, value: x.m.suppliedUsd }))} logoOf={logoOf} />
        </div>
        <div className="scroll">
          <table className="stack overview">
            <thead><tr><th>Reserve</th><th>Status</th><th className="r">Supplied</th><th className="r">Share</th><th className="r">Supply cap used</th><th className="r">Holders</th><th className="r">Top 10</th><th className="r">LTV / LT</th><th className="r">Supply APY</th><th className="r">Debt asset</th><th className="r">Utilization</th><th className="r">Liq. 90d</th></tr></thead>
            <tbody>
              {rows.map(({ a, m }) => (
                <tr key={a.symbol} className="click" onClick={() => onAsset(a.symbol)}>
                  <td className="nw"><span className="asset-inline"><AssetLogo symbol={a.symbol} src={logoOf(a.symbol)} /><strong>{a.symbol}</strong></span><span className="sub">${fmt(m.priceUsd, 0)}</span></td>
                  <td data-label="Status"><span className={`status ${status(m) === "Active" ? "done" : "wait"}`}>{status(m)}</span></td>
                  <td className="r" data-label="Supplied">{usd(m.suppliedUsd)}<span className="sub">{fmt(m.suppliedTokens)} {a.symbol}</span></td>
                  <td className="r" data-label="Share">{pct(supplied ? (m.suppliedUsd / supplied) * 100 : null)}</td>
                  <td className="r" data-label="Cap used">{m.supplyCap ? pct((m.suppliedTokens / m.supplyCap) * 100) : "No cap"}</td>
                  <td className="r" data-label="Holders">{fmt(m.holders)}</td>
                  <td className="r" data-label="Top 10">{pct(m.top10SharePct)}</td>
                  <td className="r" data-label="LTV / LT">{pct(m.ltvPct, 0)} / {pct(m.liquidationThresholdPct, 0)}</td>
                  <td className="r" data-label="Supply APY">{pct(m.supplyApy, 2)}</td>
                  <td className="r" data-label="Debt asset">{isStable(m.debtSymbol) ? "Stablecoins" : <>{m.debtSymbol}<span className="sub">{pct(m.debtBorrowApy, 2)} borrow</span></>}</td>
                  <td className="r" data-label="Utilization">{pct(m.utilization)}</td>
                  <td className={`r ${m.liquidations90d ? "warn" : ""}`} data-label="Liq. 90d">{fmt(m.liquidations90d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="note">Supplied values use the Aave oracle at the time of reading. Debt and net equity cover the tracked holders: every position backing $10k+ of debt plus the largest holders. Pick an asset for its full market panel and issuer risk.</p>
    </>
  );
}

// ── Offboarding calendar ────────────────────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type CalPoint = { date: string; coll: number; debt: number; collUsd: number; debtUsd: number };

/** Daily points from a plan's history: collateral in the asset, debt in the debt asset, and both in USD. */
function calPoints(p: PlanResponse): CalPoint[] {
  return p.history.map((d) => {
    const dpx = d.debt > 0 ? d.debtUsd / d.debt : 0;
    return { date: d.date, coll: d.supplied, debt: d.debt, collUsd: d.supplied * d.rate * dpx, debtUsd: d.debtUsd };
  });
}

const unitAmount = (n: number) => fmt(n, Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 10 ? 1 : Math.abs(n) >= 0.1 ? 2 : 4);

function OffboardingCalendar({ plans, baselineDate, title }: { plans: PlanResponse[]; baselineDate: string; title: string }) {
  // Unit first: an asset's own count (rsETH, osETH…), or USD, the only unit that adds up across assets.
  const [unit, setUnit] = useState<string>(plans.length === 1 ? plans[0].symbol : "$");
  const [measure, setMeasure] = useState<"coll" | "debt">("coll");
  const [hover, setHover] = useState<string | null>(null);
  const plan = plans.find((p) => p.symbol === unit) ?? null;
  const usdMode = !plan;
  const stableDebt = plan?.debtSymbol === "Stablecoins";
  const label = usdMode ? "$" : measure === "coll" ? plan!.symbol : stableDebt ? "USD of stablecoins" : plan!.debtSymbol;

  const points = useMemo<CalPoint[]>(() => {
    if (plan) return calPoints(plan);
    const per = plans.map((p) => new Map(calPoints(p).map((d) => [d.date, d])));
    if (!per.length) return [];
    const dates = [...per[0].keys()].filter((d) => per.every((m) => m.has(d))).sort();
    return dates.map((date) => ({ date, coll: 0, debt: 0, collUsd: per.reduce((s, m) => s + m.get(date)!.collUsd, 0), debtUsd: per.reduce((s, m) => s + m.get(date)!.debtUsd, 0) }));
  }, [plan, plans]);
  const val = (d: CalPoint) => (usdMode ? (measure === "coll" ? d.collUsd : d.debtUsd) : measure === "coll" ? d.coll : d.debt);
  const valUsd = (d: CalPoint) => (measure === "coll" ? d.collUsd : d.debtUsd);
  const days = points.map((d, i) => {
    const prev = points[i - 1];
    const v = val(d), pv = prev ? val(prev) : null;
    return { ...d, v, usdV: valUsd(d), change: pv != null ? v - pv : null, changeUsd: prev ? valUsd(d) - valUsd(prev) : null, changePct: pv ? (v / pv - 1) * 100 : null };
  });

  const fv = (n: number | null | undefined) => (n == null ? DASH : usdMode || stableDebt && measure === "debt" ? usd(n) : `${unitAmount(n)} ${label}`);
  const fs = (n: number | null | undefined) => (n == null ? DASH : `${n > 0 ? "+" : n < 0 ? "−" : ""}${fv(Math.abs(n))}`);
  const fsUsd = (n: number | null | undefined) => (n == null ? DASH : `${n > 0 ? "+" : n < 0 ? "−" : ""}${usd(Math.abs(n))}`);
  /** Second line: the USD value when the first line is in units. */
  const sub$ = (n: number | null | undefined, signedIt = false) => (usdMode || (stableDebt && measure === "debt") ? undefined : signedIt ? fsUsd(n) : usd(n));

  const switcher = (
    <div className="cal-switch">
      <div className="seg" role="group" aria-label="Unit">
        {plans.map((p) => <button key={p.symbol} aria-pressed={unit === p.symbol} onClick={() => setUnit(p.symbol)}>{p.symbol}</button>)}
        <button aria-pressed={usdMode} onClick={() => setUnit("$")}>Value $</button>
      </div>
      <div className="seg" role="group" aria-label="Measure">
        <button aria-pressed={measure === "coll"} onClick={() => setMeasure("coll")}>{usdMode ? "Collateral" : `${plan!.symbol} supplied`}</button>
        <button aria-pressed={measure === "debt"} onClick={() => setMeasure("debt")}>{usdMode ? "Debt" : `${stableDebt ? "Stablecoin" : plan!.debtSymbol} debt`}</button>
      </div>
    </div>
  );
  if (days.length < 2) return <div className="panel"><div className="panel-head"><div><p className="eyebrow">Offboarding calendar</p><h2>{title}</h2></div>{switcher}</div><p className="empty">The calendar fills as the daily history is read from the chain.</p></div>;

  const byDate = new Map(days.map((d) => [d.date, d]));
  const last = days[days.length - 1];
  const at = (n: number) => days[Math.max(0, days.length - 1 - n)];
  const base = byDate.get(baselineDate) ?? days.find((d) => d.date >= baselineDate) ?? null;
  const maxAbs = Math.max(1e-9, ...days.map((d) => Math.abs(d.change ?? 0)));
  const since = base ? last.v - base.v : null;
  const d30 = last.v - at(30).v, n30 = Math.min(30, days.length - 1);
  const pace = n30 ? d30 / n30 : 0;
  const eta = pace < 0 ? Math.ceil(last.v / -pace) : null;
  const afterBase = base ? days.filter((d) => d.date > base.date && d.change != null) : [];
  const down = afterBase.filter((d) => (d.change ?? 0) < 0).length;
  const best = days.reduce((b, d) => (d.change != null && (b == null || d.change < (b.change ?? 0)) ? d : b), null as (typeof days)[number] | null);
  const what = measure === "coll" ? (usdMode ? "collateral" : `${plan!.symbol} supplied`) : "debt";

  const months: { key: string; y: number; m: number }[] = [];
  for (const d of days) { const [y, m] = d.date.split("-").map(Number); const key = `${y}-${m}`; if (!months.some((x) => x.key === key)) months.push({ key, y, m }); }
  const monthly = months.map(({ key, y, m }) => {
    const xs = days.filter((d) => d.date.startsWith(`${y}-${String(m).padStart(2, "0")}`));
    const prevEnd = days[days.indexOf(xs[0]) - 1];
    const start = prevEnd ? prevEnd.v : xs[0].v, end = xs[xs.length - 1].v;
    const startUsd = prevEnd ? prevEnd.usdV : xs[0].usdV, endUsd = xs[xs.length - 1].usdV;
    const ch = xs.filter((d) => d.change != null);
    return { key, label: `${MONTHS[m - 1]} ${y}`, start, end, change: end - start, changeUsd: endUsd - startUsd, changePct: start ? (end / start - 1) * 100 : null,
      best: ch.reduce((b, d) => (b == null || (d.change ?? 0) < (b.change ?? 0) ? d : b), null as (typeof days)[number] | null),
      worst: ch.reduce((b, d) => (b == null || (d.change ?? 0) > (b.change ?? 0) ? d : b), null as (typeof days)[number] | null),
      down: ch.filter((d) => (d.change ?? 0) < 0).length, n: ch.length,
      partial: Number(xs[0].date.slice(8)) > 1 ? `from ${dayLabel(xs[0].date)}` : Number(xs[xs.length - 1].date.slice(8)) < new Date(Date.UTC(y, m, 0)).getUTCDate() ? "to date" : null };
  });
  const h = hover ? byDate.get(hover) : last;
  const tone = (c: number | null) => {
    if (c == null) return undefined;
    const k = Math.max(0.18, Math.min(1, Math.sqrt(Math.abs(c) / maxAbs)));
    return { background: `color-mix(in srgb, ${c < 0 ? "var(--green)" : "var(--red)"} ${Math.round(k * 100)}%, var(--raised))` };
  };
  const toneOf = (n: number | null) => (n == null || n === 0 ? "" : n < 0 ? "pos" : "warn");
  const units = (d: CalPoint, which: "coll" | "debt") => (which === "coll" ? `${unitAmount(d.coll)} ${plan!.symbol}` : stableDebt ? usd(d.debtUsd) : `${unitAmount(d.debt)} ${plan!.debtSymbol}`);
  return (
    <div className="panel cal-panel">
      <div className="panel-head">
        <div><p className="eyebrow">Offboarding calendar</p><h2>{title}</h2></div>
        {switcher}
      </div>
      <div className="strip inner">
        <Cell label={`${usdMode || measure === "debt" ? what[0].toUpperCase() + what.slice(1) : what} today`} value={fv(last.v)} sub={sub$(last.usdV) ?? `read ${dayLabel(last.date)}`} />
        <Cell label={`Since ARFC, ${dayLabel(baselineDate)}`} value={fs(since)} tone={toneOf(since)} sub={base ? [base.v ? signed((last.v / base.v - 1) * 100, 2) : null, sub$(last.usdV - base.usdV, true)].filter(Boolean).join(" · ") : "baseline not in history"} />
        <Cell label="Last 24 hours" value={fs(last.change)} tone={toneOf(last.change)} sub={[signed(last.changePct, 2), sub$(last.changeUsd, true)].filter(Boolean).join(" · ")} />
        <Cell label="Last 7 days" value={fs(last.v - at(7).v)} tone={toneOf(last.v - at(7).v)} sub={[at(7).v ? signed((last.v / at(7).v - 1) * 100, 2) : null, sub$(last.usdV - at(7).usdV, true)].filter(Boolean).join(" · ")} />
        <Cell label="Last 30 days" value={fs(d30)} tone={toneOf(d30)} sub={`${fs(pace)} a day on average`} />
        <Cell label="At this pace" value={eta ? (eta > 3650 ? "> 10 years" : `${fmt(eta)} days`) : "Not falling"} tone={eta ? "" : "warn"} sub={eta ? `to zero, ~${new Date(Date.parse(last.date) + eta * 864e5).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })}` : "30-day trend is flat or up"} />
        <Cell label="Days falling since ARFC" value={afterBase.length ? `${down} / ${afterBase.length}` : DASH} sub={best ? `largest fall ${fs(best.change)}, ${dayLabel(best.date)}` : undefined} />
      </div>
      <div className="cal-wrap">
        <div className="cal-months" onPointerLeave={() => setHover(null)}>
          {months.map(({ key, y, m }) => {
            const first = new Date(Date.UTC(y, m - 1, 1));
            const lead = (first.getUTCDay() + 6) % 7;
            const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
            return (
              <div className="cal-month" key={key}>
                <p className="cal-title">{MONTHS[m - 1].slice(0, 3)} {y}</p>
                <div className="cal-grid">
                  {["M", "T", "W", "T", "F", "S", "S"].map((w, i) => <span className="cal-wd" key={i}>{w}</span>)}
                  {Array.from({ length: lead }, (_, i) => <span key={`l${i}`} />)}
                  {Array.from({ length: n }, (_, i) => {
                    const date = `${y}-${String(m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
                    const d = byDate.get(date);
                    return (
                      <button key={date} type="button" className={`cal-day${d ? "" : " none"}${date === baselineDate ? " base" : ""}${hover === date ? " on" : ""}`} style={d ? tone(d.change) : undefined}
                        onPointerEnter={() => d && setHover(date)} onFocus={() => d && setHover(date)} onClick={() => d && setHover(date)} aria-label={d ? `${date}: ${fs(d.change)}` : date} disabled={!d}>
                        <span>{i + 1}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cal-side">
          <p className="k">{h ? new Date(`${h.date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }) : ""}</p>
          {h ? (
            <>
              <p className={`cal-big ${(h.change ?? 0) < 0 ? "pos" : h.change ? "neg" : ""}`}>{fs(h.change)}</p>
              <p className="muted">{[signed(h.changePct, 2), sub$(h.changeUsd, true)].filter(Boolean).join(" · ")} {what} that day</p>
              {plan ? (
                <>
                  <div className="kv"><span>{plan.symbol} supplied</span><span>{units(h, "coll")}<span className="sub">{usd(h.collUsd)}</span></span></div>
                  <div className="kv"><span>{stableDebt ? "Stablecoin" : plan.debtSymbol} debt</span><span>{units(h, "debt")}{stableDebt ? null : <span className="sub">{usd(h.debtUsd)}</span>}</span></div>
                </>
              ) : (
                <>
                  <div className="kv"><span>Collateral</span><span>{usd(h.collUsd)}</span></div>
                  <div className="kv"><span>Debt</span><span>{usd(h.debtUsd)}</span></div>
                </>
              )}
              <div className="kv"><span>Debt ÷ collateral</span><span>{pct(h.collUsd ? (h.debtUsd / h.collUsd) * 100 : null)}</span></div>
              {base ? <div className="kv"><span>vs ARFC baseline</span><span>{base.v ? signed((h.v / base.v - 1) * 100, 2) : DASH}</span></div> : null}
            </>
          ) : null}
          <div className="cal-legend"><span>Fall</span><i style={tone(-maxAbs)} /><i style={tone(-maxAbs / 4)} /><i style={tone(-maxAbs / 25)} /><i style={tone(maxAbs / 25)} /><i style={tone(maxAbs / 4)} /><i style={tone(maxAbs)} /><span>Rise</span></div>
          <p className="note">Ringed day: ARFC baseline. Each cell is the change in {what}{usdMode ? " (USD)" : ` (${label})`} from the day before, at 00:00 UTC. {usdMode ? "USD moves with prices; pick an asset to see the count itself." : `${plan!.symbol} supplied is the whole Aave V3 Core reserve; debt covers the tracked positions.`}</p>
        </div>
      </div>
      <div className="scroll">
        <table className="stack overview">
          <thead><tr><th>Month</th><th className="r">Start</th><th className="r">End</th><th className="r">Change</th><th className="r">%</th><th className="r">Largest fall</th><th className="r">Largest rise</th><th className="r">Days falling</th></tr></thead>
          <tbody>
            {[...monthly].reverse().map((r) => (
              <tr key={r.key}>
                <td className="nw"><strong>{r.label}</strong>{r.partial ? <span className="sub">{r.partial}</span> : null}</td>
                <td className="r" data-label="Start">{fv(r.start)}</td>
                <td className="r" data-label="End">{fv(r.end)}</td>
                <td className={`r ${r.change < 0 ? "pos" : r.change > 0 ? "neg" : ""}`} data-label="Change">{fs(r.change)}{sub$(r.changeUsd, true) ? <span className="sub">{sub$(r.changeUsd, true)}</span> : null}</td>
                <td className={`r ${r.change < 0 ? "pos" : r.change > 0 ? "neg" : ""}`} data-label="%">{signed(r.changePct, 2)}</td>
                <td className="r" data-label="Largest fall">{r.best && (r.best.change ?? 0) < 0 ? <>{fs(r.best.change)}<span className="sub">{dayLabel(r.best.date)}</span></> : DASH}</td>
                <td className="r" data-label="Largest rise">{r.worst && (r.worst.change ?? 0) > 0 ? <>{fs(r.worst.change)}<span className="sub">{dayLabel(r.worst.date)}</span></> : DASH}</td>
                <td className="r" data-label="Days falling">{r.down} / {r.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


/** Link that opens the site on this asset with this holder selected. */
function holderLink(asset: string, address: string) {
  return `${window.location.origin}/?asset=${encodeURIComponent(asset)}&holder=${address}#loops`;
}

function CopyLink({ asset, address }: { asset: string; address: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    const url = holderLink(asset, address);
    try { await navigator.clipboard.writeText(url); } catch { window.prompt("Link to this position", url); return; }
    setDone(true); window.setTimeout(() => setDone(false), 1600);
  };
  return <button className="chip plain small" onClick={copy} title="Copy a link that opens the site on this position">{done ? "Link copied" : "Copy link"}</button>;
}


// ── Address lookup ──────────────────────────────────────────────────────────

function SearchBox({ onSearch, className = "" }: { onSearch: (v: string) => void; className?: string }) {
  const [v, setV] = useState("");
  const submit = (e: React.FormEvent) => { e.preventDefault(); const x = v.trim(); if (x) onSearch(x); };
  return (
    <form className={`search ${className}`} onSubmit={submit} role="search">
      <span aria-hidden="true">⌕</span>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Look up an address or ENS" aria-label="Look up an address or ENS name" spellCheck={false} autoComplete="off" />
    </form>
  );
}

function LookupPanel({ query, logoOf, colors, onClose, onOpen }: { query: string; logoOf: (s: string) => string | undefined; colors: Map<string, string>; onClose: () => void; onOpen: (asset: string, address: string) => void }) {
  const [res, setRes] = useState<LookupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getJson<LookupResponse>(`/api/lookup?address=${encodeURIComponent(query)}`).then((r) => live && setRes(r)).catch((e) => live && setError(e instanceof Error ? e.message : "Failed"));
    return () => { live = false; };
  }, [query]);
  const held = res?.holdings.filter((h) => h.supplied > 0) ?? [];
  const verdict = !res ? "" : held.some((h) => h.kind === "Loop") ? "Loops a tracked asset" : held.some((h) => h.debtBackedUsd > 0) ? "Borrows against a tracked asset" : held.length ? "Holds a tracked asset, no debt" : res.controls.length ? "Controls tracked positions" : "Not a holder of any tracked asset";
  return (
    <div className="panel lookup">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Address lookup</p>
          <h2 className="mono lookup-addr">{res?.ens ? `${res.ens} · ` : ""}{res?.address ?? query}</h2>
        </div>
        <div className="head-actions">
          {res ? <span className={`status ${held.length || res.controls.length ? "done" : "pending"}`}>{verdict}</span> : null}
          <button className="chip plain small" onClick={onClose} aria-label="Close lookup">Close</button>
        </div>
      </div>
      {error ? <p className="empty">{error}</p> : !res ? <p className="empty">Reading the address on every tracked asset…</p> : (
        <>
          <div className="body lookup-meta">
            {res.tag ? <EntityTag entity={res.tag.entity} colors={colors} /> : null}
            <span className="muted">{res.tag ? res.tag.label : "No team tag"}{res.isContract ? " · contract" : " · wallet"}</span>
            {res.community.map((t) => <span key={t.id} className="muted">· site tag: {t.entity}{t.label ? ` (${t.label})` : ""}</span>)}
            <span className="links">{EXPLORERS.map(([name, url]) => <a key={name} className="btn" href={url(res.address)} target="_blank" rel="noopener noreferrer">{name}</a>)}</span>
          </div>
          {res.entity?.status ? <div className="body"><p className="note">{res.entity.status}{res.entity.approach ? ` Approach: ${res.entity.approach}.` : ""}</p></div> : null}
          <div className="scroll">
            <table className="stack overview">
              <thead><tr><th>Asset</th><th>Position</th><th className="r">Supplied</th><th className="r">Share</th><th className="r">Debt backed</th><th className="r">Account debt</th><th className="r">Health factor</th><th></th></tr></thead>
              <tbody>
                {res.holdings.map((h) => (
                  <tr key={h.symbol} className={h.supplied > 0 ? "" : "dim"}>
                    <td className="nw"><span className="asset-inline"><AssetLogo symbol={h.symbol} src={logoOf(h.symbol)} /><strong>{h.symbol}</strong></span></td>
                    <td data-label="Position">{h.kind}{h.rank ? <span className="sub">#{h.rank} holder</span> : null}</td>
                    <td className="r" data-label="Supplied">{h.supplied > 0 ? <>{fmtAmount(h.supplied)} {h.symbol}<span className="sub">{usd(h.suppliedUsd)}</span></> : DASH}</td>
                    <td className="r" data-label="Share">{h.supplied > 0 ? pct(h.sharePct, h.sharePct < 1 ? 2 : 1) : DASH}</td>
                    <td className="r" data-label="Debt backed">{h.debtBackedUsd > 0 ? <>{usd(h.debtBackedUsd)}{h.debts.length ? <span className="sub">{h.debts.slice(0, 2).map((d) => d.symbol).join(" + ")}</span> : null}</> : DASH}</td>
                    <td className="r" data-label="Account debt">{h.supplied > 0 && h.totalDebtUsd > 0 ? usd(h.totalDebtUsd) : DASH}</td>
                    <td className="r" data-label="Health factor">{h.supplied > 0 && h.healthFactor ? <HealthFactor value={h.healthFactor} alert={1.03} /> : DASH}</td>
                    <td className="r">{h.tracked ? <button className="chip plain small" onClick={() => onOpen(h.symbol, res.address)}>Open position</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {res.controls.length ? (
            <div className="body">
              <p className="k">Positions this address controls</p>
              {res.controls.map((x) => (
                <div className="kv" key={`${x.asset}:${x.address}`}>
                  <span>{x.via} of <span className="mono">{short(x.address)}</span>{x.tag ? ` · ${x.tag}` : ""}</span>
                  <span>{x.asset} #{x.rank} · {usd(x.debtBackedUsd)} debt <button className="chip plain small" onClick={() => onOpen(x.asset, x.address)}>Open</button></span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="body">
            {res.spark ? <p className="note">Also on Spark: {usd(res.spark.collateralUsd)} collateral, {usd(res.spark.debtUsd)} debt{res.spark.healthFactor ? `, health factor ${res.spark.healthFactor.toFixed(3)}` : ""}.</p> : null}
            <p className="note">Read on-chain {when(res.readAt)}. “Controls” covers Safe signers and contract owners of tracked positions backing $10k+ of debt.{res.holdings.some((h) => !h.mappingRead) ? " Some holder lists were still building; search again in a minute for ranks." : ""}</p>
          </div>
        </>
      )}
    </div>
  );
}


// ── Kelp revenue model (rsETH) ──────────────────────────────────────────────

function KelpPanel() {
  const K = KELP_INPUTS;
  const coreRseth = K.positions.reduce((s, p) => s + p.rseth, 0) + 259; // + #11, the Contango loop
  const coreDebt = K.markets[0].wethDebt as number;
  const allRseth = K.markets.reduce((s, m) => s + m.rseth, 0);
  const allDebt = K.markets.reduce((s, m) => s + (m.wethDebt ?? 0), 0);
  const [caseKey, setCase] = useState<keyof typeof K.unwind>("base");
  const [scope, setScope] = useState<"core" | "all">("core");
  const [y, setY] = useState<number>(K.yields.baseNet);
  const [feeBps, setFee] = useState<number>(K.feeBps);
  const p: KM.KelpParams = {
    rseth: scope === "core" ? coreRseth : allRseth, rsethEth: K.rsethEth, ethUsd: K.ethUsd, netYieldPct: y, feeBps,
    unwindDays: K.unwind[caseKey], cycleDays: K.cycleDays, fastExitDays: K.fastExitDays, horizonDays: K.horizonDays,
    wethDebt: scope === "core" ? coreDebt : allDebt,
  };
  const s = KM.scenarios(p);
  const sched = KM.schedule(p);
  const eth = (v: number) => `${fmt(v, v < 100 ? 1 : 0)} ETH`;
  const isoB = KM.isolatedBorrow(K.weth.supplyApy, K.isolated.utilization, K.isolated.reserveFactor);
  const cut = KM.rateCutPct(s.gap, p);
  const L = 11.8;
  const opts: [string, number][] = [
    ["Core today", K.weth.borrowApy], ["Core after +50 bps", K.weth.borrowApy + 0.5], ["Core after +100 bps", K.weth.borrowApy + 1],
    ["Isolated market", isoB], ["Isolated + Kelp gap as incentive", isoB - cut],
  ];
  return (
    <div className="panel">
      <div className="panel-head">
        <div><p className="eyebrow">Kelp revenue model</p><h2>What Kelp earns on the loops: stall, fast exit or migration</h2></div>
        <p className="hint">Inputs read {dayLabel(K.asOf)}</p>
      </div>
      <div className="strip inner">
        <Cell label="Kelp fee" value={`${feeBps / 100}% of rewards`} sub="LRTConfig on-chain (docs say 10%)" />
        <Cell label="rsETH yield, net" value={pct(y, 2)} sub={`stETH ${pct(K.yields.stethApr7d, 2)} · 30d ${pct(K.yields.rsethNet30d, 2)} · 90d ${pct(K.yields.rsethNet90d, 2)}`} />
        <Cell label="Kelp fee on the loops" value={eth(s.annualFullTvl)} sub={`${usd(s.annualFullTvl * K.ethUsd)} a year at full TVL`} />
        <Cell label="Aave share of rsETH" value={pct((allRseth / K.rsethSupply) * 100, 0)} sub={`${fmt(allRseth)} of ${fmt(K.rsethSupply)} rsETH`} />
        <Cell label="Fee minted, 30 days" value={`${fmt(K.feeMinted.d30, 1)} rsETH`} sub="LRTOracle FeeMinted events" />
      </div>
      <div className="body kelp-controls">
        <div className="seg" role="group" aria-label="Unwind case">
          {(Object.keys(K.unwind) as (keyof typeof K.unwind)[]).map((k) => <button key={k} aria-pressed={caseKey === k} onClick={() => setCase(k)}>{k === "assisted" ? "Kelp-assisted" : k === "base" ? "Base" : "Slow"} · {K.unwind[k]} d</button>)}
        </div>
        <div className="seg" role="group" aria-label="Scope">
          <button aria-pressed={scope === "core"} onClick={() => setScope("core")}>Core loops</button>
          <button aria-pressed={scope === "all"} onClick={() => setScope("all")}>All rsETH on Aave</button>
        </div>
        <div className="seg" role="group" aria-label="Yield">
          {[K.yields.rsethNet90d, K.yields.baseNet, K.yields.rsethNet30d].map((v) => <button key={v} aria-pressed={y === v} onClick={() => setY(v)}>{pct(v, 2)}</button>)}
        </div>
        <div className="seg" role="group" aria-label="Fee">
          {[500, 1000].map((v) => <button key={v} aria-pressed={feeBps === v} onClick={() => setFee(v)}>Fee {v / 100}%</button>)}
        </div>
      </div>
      <div className="scroll">
        <table className="stack overview">
          <thead><tr><th>Next 12 months</th><th className="r">Kelp's fee</th><th className="r">USD</th><th>What happens</th></tr></thead>
          <tbody>
            <tr><td className="nw"><strong>A · Kelp stalls</strong></td><td className="r" data-label="Fee">{eth(s.A)}</td><td className="r" data-label="USD">{usd(s.A * K.ethUsd)}</td><td data-label="What">Loops unwind through Kelp's queue, one batch every {K.cycleDays} days, gone by day {K.unwind[caseKey]}</td></tr>
            <tr><td className="nw"><strong>B1 · Fast exit</strong></td><td className="r" data-label="Fee">{eth(s.B1)}</td><td className="r" data-label="USD">{usd(s.B1 * K.ethUsd)}</td><td data-label="What">A bridge loan clears the loops in about {K.fastExitDays} days; the TVL leaves Kelp</td></tr>
            <tr><td className="nw"><strong>B2 · Migration</strong></td><td className="r" data-label="Fee">{eth(s.B2)}</td><td className="r" data-label="USD">{usd(s.B2 * K.ethUsd)}</td><td data-label="What">Loops move to an isolated rsETH market on Aave; Kelp keeps the TVL</td></tr>
            <tr className="total"><td>Gap A − B1</td><td className="r" data-label="Fee">{eth(s.gap)}</td><td className="r" data-label="USD">{usd(s.gap * K.ethUsd)}</td><td data-label="What">What Kelp gains by stalling, and the most we can ask it to give back</td></tr>
            <tr className="total"><td>Migration gain B2 − A</td><td className="r" data-label="Fee">{eth(s.migrationGain)}</td><td className="r" data-label="USD">{usd(s.migrationGain * K.ethUsd)}</td><td data-label="What">What Kelp gains by migrating instead of stalling, in year one</td></tr>
          </tbody>
        </table>
      </div>
      <div className="two-inner">
        <div className="body">
          <p className="k">Unwind, cycle by cycle ({caseKey === "assisted" ? "Kelp-assisted" : caseKey})</p>
          <table className="mini">
            <thead><tr><th>Cycle</th><th className="r">Day</th><th className="r">Redeemed</th><th className="r">rsETH left</th><th className="r">Kelp fee</th></tr></thead>
            <tbody>{sched.map((c) => <tr key={c.cycle}><td>{c.cycle}</td><td className="r">{c.endDay}</td><td className="r">{fmt(c.redeemed)}</td><td className="r">{fmt(c.rsethEnd)}</td><td className="r">{fmt(c.feeEth, 1)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="body">
          <p className="k">Isolated market: WETH rate and loop return at {L}x</p>
          <table className="mini">
            <thead><tr><th>Option</th><th className="r">WETH borrow</th><th className="r">Spread</th><th className="r">Return on equity</th></tr></thead>
            <tbody>{opts.map(([n, b]) => { const r = KM.roe(L, y, b); return <tr key={n}><td>{n}</td><td className="r">{pct(b, 2)}</td><td className="r">{fmt((y - b) * 100, 0)} bps</td><td className={`r ${r < 0 ? "neg" : n.startsWith("Isolated") ? "pos" : ""}`}>{pct(r, 1)}</td></tr>; })}</tbody>
          </table>
          <p className="note">The gap as an incentive cuts the borrow rate by {fmt(cut * 100, 1)} bps. The isolated market pays lenders Core's {pct(K.weth.supplyApy, 2)} at {K.isolated.utilization}% utilization and a {K.isolated.reserveFactor}% reserve factor; it needs about {fmt(p.wethDebt / (K.isolated.utilization / 100))} WETH of lenders.</p>
        </div>
      </div>
      <p className="note body">Cycle length and range from Dialectic; equal batches rebuilt from them. Fee from the contract (5%), not the docs (10%). Kelp's instant-withdrawal fee (0.5%, switched off for ETH) is not in these figures.</p>
    </div>
  );
}


/** CSV of every holder above the dust line, from the holder mapping: one asset or all. */
function HolderExport({ assets, initial, logoOf }: { assets: { symbol: string; logo: string }[]; initial: string; logoOf: (s: string) => string | undefined }) {
  const [asset, setAsset] = useState(initial);
  useEffect(() => setAsset(initial), [initial]);
  const href = `/api/holders?asset=${encodeURIComponent(asset)}`;
  return (
    <div className="panel">
      <div className="panel-head">
        <div><h2>Export holders</h2><p className="hint">Every holder above $50 with tag, position type, collateral, debt by asset, health factor, leverage and Spark debt · CSV</p></div>
        <div className="head-actions export">
          <select value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="Asset to export">
            <option value="all">All assets</option>
            {assets.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
          </select>
          <a className="chip plain" href={href} download>{asset !== "all" ? <AssetLogo symbol={asset} src={logoOf(asset)} /> : null} Download CSV</a>
        </div>
      </div>
      <p className="note body">{asset === "all" ? `One file with the holders of all ${assets.length} assets, one row per wallet and asset. The first export can take up to a minute while each holder list is read.` : `Holders of ${asset} on Aave V3 Core, largest first.`}</p>
    </div>
  );
}
