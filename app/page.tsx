"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Entity, HolderDetail, LoopsResponse, Market, Position, Tag, Tx } from "@/lib/types";

// ── small helpers ───────────────────────────────────────────────────────────

type TabId = "loops" | "market" | "tx" | "entities";
const TABS: { id: TabId; label: string }[] = [
  { id: "loops", label: "Loops" },
  { id: "market", label: "Market" },
  { id: "tx", label: "Last tx" },
  { id: "entities", label: "Tagged entities" },
];
const TX_TYPES = ["Supply", "Withdraw", "Borrow", "Repay", "Transfer", "Send", "Receive"];
const BRAND = ["#2468fc", "#00c880", "#f2c200", "#fc4434", "#8b5cf6", "#06b6d4", "#fb923c", "#e879f9"];
const DASH = "—";

interface Meta { venue: string; hfAlert: number; assets: { symbol: string; debtSymbol: string; logo: string }[] }
interface RegistryData { entities: Entity[]; tags: { match: string; label: string; entity: string; kind: string }[] }

const fmt = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined || !Number.isFinite(n) ? DASH : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtAmount = (n: number) => fmt(n, Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 1 ? 2 : 4);
const usd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? DASH : n >= 1e9 ? `$${fmt(n / 1e9, 2)}B` : n >= 1e6 ? `$${fmt(n / 1e6, 1)}M` : `$${fmt(n, 0)}`;
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
  ["OpenSea", (a) => `https://opensea.io/${a}`],
  ["Blockscout", (a) => `https://eth.blockscout.com/address/${a}`],
];

// ── small components ────────────────────────────────────────────────────────

function AssetLogo({ symbol, src }: { symbol: string; src?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span className="logo fallback" aria-hidden="true">{symbol.slice(0, 1)}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="logo" src={src} alt="" onError={() => setBroken(true)} />;
}

function EntityTag({ entity, colors }: { entity: string | null | undefined; colors: Map<string, string> }) {
  if (!entity) return <span className="muted">{DASH}</span>;
  return (
    <span className="tag">
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

const holderName = (p: Position) => p.tag?.label ?? p.ens ?? p.contractName ?? (p.isContract ? "Contract" : "Wallet");

function TxTable({ rows, colors, showWallet }: { rows: Tx[]; colors: Map<string, string>; showWallet: boolean }) {
  return (
    <div className="scroll">
      <table>
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
              <td className="nw">{when(t.timestamp)}</td>
              {showWallet ? (
                <td>
                  {t.walletRank ? `#${t.walletRank} ` : ""}{t.walletTag?.label ?? ""}
                  <span className="sub"><Addr address={t.wallet} /></span>
                </td>
              ) : null}
              <td className="nw">{t.action}</td>
              <td className="r">{fmtAmount(t.amount)}</td>
              <td className="nw">{t.tokenSymbol || short(t.tokenAddress)}</td>
              <td>
                {t.counterpartyTag?.label ?? ""}
                <span className={t.counterpartyTag ? "sub" : ""}><Addr address={t.counterparty} /></span>
              </td>
              <td><EntityTag entity={t.counterpartyTag?.entity} colors={colors} /></td>
              <td><a className="link mono" href={`https://etherscan.io/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer">{t.txHash.slice(0, 10)}…</a></td>
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
  const [tx, setTx] = useState<Record<string, Tx[]>>({});
  const [txBusy, setTxBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const assets = useMemo(() => meta?.assets ?? [], [meta]);
  const shown = useMemo(() => (picked.length ? assets.filter((a) => picked.includes(a.symbol)) : assets), [assets, picked]);
  const logoOf = useCallback((symbol: string) => assets.find((a) => a.symbol === symbol)?.logo, [assets]);
  const hfAlert = meta?.hfAlert ?? 1.03;

  const colors = useMemo(() => {
    const map = new Map<string, string>();
    (registry?.entities ?? []).filter((e) => !/^unknown/i.test(e.entity)).forEach((e, i) => map.set(e.entity, BRAND[i % BRAND.length]));
    return map;
  }, [registry]);

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
    getJson<Meta>("/api/assets").then((m) => { setMeta(m); loadLoops(m.assets, false); }).catch((e) => setErrors({ site: e.message }));
    getJson<RegistryData>("/api/registry").then(setRegistry).catch(() => setRegistry({ entities: [], tags: [] }));
  }, [loadLoops]);

  const needsTx = tab === "tx" || tab === "entities";
  const txLoaded = shown.length > 0 && shown.every((a) => tx[`${a.symbol}:market`] && tx[`${a.symbol}:holders`]);
  useEffect(() => {
    if (needsTx && !txLoaded && !txBusy && !txError && shown.length) loadTx(shown, false);
  }, [needsTx, txLoaded, txBusy, txError, shown, loadTx]);

  const refresh = () => {
    loadLoops(assets, true);
    if (needsTx || Object.keys(tx).length) loadTx(shown, true);
  };
  const openTab = (id: TabId) => { setTab(id); window.history.replaceState(null, "", `#${id}`); };
  const toggleAsset = (symbol: string) => {
    const base = picked.length ? picked : [];
    const next = base.includes(symbol) ? base.filter((s) => s !== symbol) : [...base, symbol];
    setPicked(next.length === assets.length ? [] : next);
  };

  const positions = useMemo(() => shown.flatMap((a) => (loops[a.symbol]?.positions ?? []).map((p) => ({ asset: a.symbol, p }))), [shown, loops]);
  const current = positions.find((x) => sel && x.asset === sel.asset && x.p.address === sel.address) ?? positions[0] ?? null;
  const asOf = shown.map((a) => loops[a.symbol]?.asOf).filter(Boolean).sort()[0];

  return (
    <>
      <header className="bar">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tokenlogic.png" alt="TokenLogic" />
          <span className="slash">/</span>
          <span>Loops</span>
        </div>
        <nav className="nav" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => openTab(t.id)}>{t.label}</button>
          ))}
        </nav>
        <div className="tools">
          {assets.length > 1 ? (
            <button className="chip plain" aria-pressed={picked.length === 0} onClick={() => setPicked([])}>All assets</button>
          ) : null}
          {assets.map((a) => (
            <button key={a.symbol} className="chip" aria-pressed={assets.length === 1 || picked.includes(a.symbol)} onClick={() => toggleAsset(a.symbol)}>
              <AssetLogo symbol={a.symbol} src={a.logo} />{a.symbol}
            </button>
          ))}
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
          <LoopsTab shown={shown} loops={loops} busy={busy} positions={positions} current={current} hfAlert={hfAlert} colors={colors} logoOf={logoOf}
            onPick={(asset, address) => setSel({ asset, address })} />
        ) : null}
        {tab === "market" ? <MarketTab shown={shown} loops={loops} busy={busy} logoOf={logoOf} /> : null}
        {tab === "tx" ? (
          <TxTab shown={shown} tx={tx} busy={txBusy} error={txError} positions={positions} colors={colors} entities={registry?.entities ?? []} onRetry={() => loadTx(shown, true)} />
        ) : null}
        {tab === "entities" ? (
          <EntitiesTab registry={registry} positions={positions} shown={shown} tx={tx} txBusy={txBusy} colors={colors} />
        ) : null}
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
}) {
  const { shown, loops, busy, positions, current, hfAlert, colors, logoOf, onPick } = props;
  const many = shown.length > 1;
  return (
    <>
      {shown.map((a) => {
        const m = loops[a.symbol]?.market;
        if (!m) return <div className="panel" key={a.symbol}><p className="empty">{busy ? `Reading ${a.symbol} positions from the chain…` : `No data for ${a.symbol}.`}</p></div>;
        return (
          <div className="panel strip" key={a.symbol}>
            <div className="cell">
              <p className="k">{m.venue}</p>
              <div className="asset-name"><AssetLogo symbol={a.symbol} src={logoOf(a.symbol)} />{a.symbol}</div>
            </div>
            <Cell label="Tracked holders" value={fmt(m.tracked)} sub={`${fmt(m.looping)} loop against ${m.debtSymbol}`} />
            <Cell label={`${a.symbol} supplied`} value={fmt(m.trackedSupplied)} sub={`${pct(m.trackedSharePct)} of the market`} />
            <Cell label={`${m.debtSymbol} borrowed`} value={fmt(m.trackedDebt)} sub={usd(m.trackedDebtUsd)} />
            <Cell label="Debt ÷ collateral" value={pct(m.debtToCollateralPct)} />
            <Cell label={`Health factor below ${hfAlert.toFixed(2)}`} value={fmt(m.underAlert)} tone={m.underAlert ? "bad" : ""} sub="tracked holders" />
          </div>
        );
      })}

      <div className="split">
        <div className="panel">
          <div className="panel-head">
            <h2>Positions</h2>
            <p className="hint">Select a row to open the holder</p>
          </div>
          {positions.length ? (
            <div className="scroll">
              <table>
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
                  {positions.map(({ asset, p }) => {
                    const on = current?.asset === asset && current.p.address === p.address;
                    return (
                      <tr key={`${asset}:${p.address}`} className={`pick ${on ? "on" : ""}`} onClick={() => onPick(asset, p.address)}>
                        <td className="num muted">{p.rank}</td>
                        {many ? <td className="nw">{asset}</td> : null}
                        <td>
                          <button className="rowbtn" aria-pressed={on} onClick={(e) => { e.stopPropagation(); onPick(asset, p.address); }}>{holderName(p)}</button>
                          <span className="sub">{short(p.address)}</span>
                        </td>
                        <td><EntityTag entity={p.tag?.entity} colors={colors} /></td>
                        <td className="r">{fmtAmount(p.supplied)}</td>
                        <td className="r">{pct(p.sharePct, p.sharePct < 1 ? 2 : 1)}</td>
                        <td className="r">{p.debt > 0 ? fmtAmount(p.debt) : DASH}</td>
                        <td className="r">{p.leverage ? `${fmt(p.leverage, 1)}x` : DASH}</td>
                        <td className="r"><HealthFactor value={p.healthFactor} alert={hfAlert} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <p className="empty">{busy ? "Reading positions from the chain…" : "No position to show."}</p>}
        </div>

        {current ? <PositionCard row={current} market={loops[current.asset]?.market} hfAlert={hfAlert} colors={colors} /> : null}
      </div>

      {current ? <HolderFile row={current} colors={colors} /> : null}

      <p className="note">
        Health factor, leverage and the drop to liquidation come from Aave for the whole wallet: every collateral and every debt it holds on {shown.length ? loops[shown[0].symbol]?.market.venue ?? "Aave" : "Aave"}, not only this asset.
        Health factors below {hfAlert.toFixed(2)} are shown in red. The meter fills as the position moves away from liquidation and is full at 1.10.
      </p>
    </>
  );
}

function PositionCard({ row, market, hfAlert, colors }: { row: Row; market?: Market; hfAlert: number; colors: Map<string, string> }) {
  const { asset, p } = row;
  const debtSymbol = market?.debtSymbol ?? "debt asset";
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Selected position</h2>
        <p className="hint num">#{p.rank} on {asset}</p>
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
          <div className="kv"><span>{debtSymbol} borrowed</span><span>{p.debt > 0 ? `${fmtAmount(p.debt)} · ${usd(p.debtUsd)}` : "None"}</span></div>
          <div className="kv"><span>All collateral on Aave</span><span>{usd(p.totalCollateralUsd)}</span></div>
          <div className="kv"><span>All debt on Aave</span><span>{usd(p.totalDebtUsd)}</span></div>
          <div className="kv"><span>Net equity</span><span>{usd(p.totalCollateralUsd - p.totalDebtUsd)}</span></div>
          <div className="kv"><span>Position</span><span>{p.loops ? `${asset}/${debtSymbol} loop` : p.totalDebtUsd > 0 ? "Borrows other assets" : "Supply only"}</span></div>
        </div>
      </div>
    </div>
  );
}

function HolderFile({ row, colors }: { row: Row; colors: Map<string, string> }) {
  const { asset, p } = row;
  const [detail, setDetail] = useState<HolderDetail | null>(null);
  const [rows, setRows] = useState<Tx[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<"asset" | "all">("asset");

  useEffect(() => {
    let live = true;
    setDetail(null); setRows(null); setError(null);
    getJson<HolderDetail>(`/api/holder?address=${p.address}`).then((d) => live && setDetail(d)).catch(() => {});
    getJson<{ transfers: Tx[] }>(`/api/tx?asset=${asset}&address=${p.address}`)
      .then((r) => live && setRows(r.transfers))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Failed to load"));
    return () => { live = false; };
  }, [asset, p.address]);

  const list = (rows ?? []).filter((t) => scope === "all" || t.assetRelated);
  return (
    <div className="two">
      <div className="panel">
        <div className="panel-head">
          <h2>Identity · {holderName(p)}</h2>
          <p className="hint">What links this wallet to a known entity</p>
        </div>
        <div className="body">
          <div>
            <div className="kv"><span>Team tag</span><span>{detail?.tag ? `${detail.tag.entity} · ${detail.tag.label}` : "Not tagged"}</span></div>
            <div className="kv"><span>Type</span><span>{p.isContract ? "Contract" : "Wallet (EOA)"}</span></div>
            <div className="kv"><span>Contract name</span><span>{detail?.name ?? p.contractName ?? DASH}</span></div>
            <div className="kv"><span>ENS</span><span>{detail?.ens ?? p.ens ?? DASH}</span></div>
            <div className="kv"><span>Deployed by</span><span><Addr address={detail?.creator} /></span></div>
            <div className="kv"><span>Public labels</span><span>{detail?.publicTags.length ? detail.publicTags.join(", ") : "None found"}</span></div>
          </div>
          {detail?.notes.length ? (
            <div className="scroll">
              <table>
                <thead><tr><th>Source</th><th>Finding</th><th>Linked to</th><th>Confidence</th></tr></thead>
                <tbody>
                  {detail.notes.map((n, i) => (
                    <tr key={i}>
                      <td className="top nw">{n.source}</td>
                      <td className="top">{n.finding}</td>
                      <td className="top"><EntityTag entity={n.linkedEntity} colors={colors} /></td>
                      <td className="top nw">{n.confidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="note">No team note on this wallet yet. Add one in data/notes.json.</p>}
          <p className="note">Contract name, ENS, deployer and public labels are read from Blockscout. Counterparties in the transactions are matched against the team’s tagged addresses.</p>
        </div>
      </div>

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
    </div>
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
          <div className="panel" key={a.symbol}>
            <div className="panel-head">
              <div className="asset-name"><AssetLogo symbol={a.symbol} src={logoOf(a.symbol)} />{a.symbol} on {m.venue}</div>
              <p className="hint">Read {when(loops[a.symbol].asOf)}</p>
            </div>
            <div className="strip">
              <Cell label={`Supplied, in ${a.symbol}`} value={fmt(m.suppliedTokens)} />
              <Cell label={`Supplied, value in ${m.debtSymbol === "WETH" ? "ETH" : m.debtSymbol}`} value={fmt(m.suppliedInDebtAsset)} sub={`${a.symbol} supplied × ${fmt(m.rate, 4)}`} />
              <Cell label="Supplied, value in USD" value={usd(m.suppliedUsd)} />
              <Cell label={`${m.debtSymbol} debt against it`} value={fmt(m.trackedDebt)} sub="tracked holders" />
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
              <Cell label={`${a.symbol} price`} value={`$${fmt(m.priceUsd, 2)}`} sub="Aave oracle" />
            </div>
          </div>
        );
      })}
      <p className="note">
        Values use the Aave oracle price at the time of reading. Debt against the market is what the tracked holders borrow in the loop’s debt asset; smaller holders are not included.
      </p>
    </>
  );
}

// ── Last tx ─────────────────────────────────────────────────────────────────

type TxFilter = "all" | "holders" | "holders_asset" | "entities";
const TX_FILTERS: { id: TxFilter; label: string }[] = [
  { id: "all", label: "All market" },
  { id: "holders", label: "Tracked holders" },
  { id: "holders_asset", label: "Holders · loop only" },
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
    if (filter === "holders_asset" && !(t.walletRank && t.assetRelated)) return false;
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
        <p className="hint">Token transfers read from Blockscout, newest first</p>
      </div>
      <div className="filters">
        <div className="seg" role="group" aria-label="Transactions shown">
          {TX_FILTERS.map((f) => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
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
        : <p className="empty">{all.length ? "No transaction matches these filters." : "No recent transaction found."}</p>}
      <div className="body">
        <p className="note">
          All market: the latest supplies, withdrawals and transfers on the selected markets. Tracked holders: the latest token transfers of each tracked holder, on any token.
          Holders · loop only: those that touch the loop’s collateral or debt. Tagged entities: transfers whose counterparty is one of the team’s tagged addresses.
        </p>
      </div>
    </div>
  );
}

// ── Tagged entities ─────────────────────────────────────────────────────────

function EntitiesTab(props: { registry: RegistryData | null; positions: Row[]; shown: Shown; tx: Record<string, Tx[]>; txBusy: boolean; colors: Map<string, string> }) {
  const { registry, positions, shown, tx, txBusy, colors } = props;
  const entities = registry?.entities ?? [];
  const holdersTx = shown.flatMap((a) => tx[`${a.symbol}:holders`] ?? []);

  const byEntity = (name: string) => positions.filter((x) => x.p.tag?.entity === name);
  const untagged = positions.filter((x) => !x.p.tag);
  const cols = Array.from(new Set(holdersTx.map((t) => t.counterpartyTag?.entity).filter((e): e is string => Boolean(e))));
  const countFor = (address: string, name: string) => holdersTx.filter((t) => t.wallet.toLowerCase() === address.toLowerCase() && t.counterpartyTag?.entity === name).length;
  const link = (url: string, text: string) => (url ? <a className="link" href={url} target="_blank" rel="noopener noreferrer">{text}</a> : <span className="muted">{DASH}</span>);

  return (
    <>
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
