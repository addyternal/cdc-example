'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ev, EventRow, fmt, get, when } from './lib';

type Stats = { events: number; latest: string | null; tables: { table: string; events: number; rows: number }[]; actors: { actor: string; changes: number }[] };

export default function Page() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [feed, setFeed] = useState<Ev[]>([]);
  const [table, setTable] = useState('');
  const [actor, setActor] = useState('');
  const [sel, setSel] = useState<{ table: string; id: number } | null>(null);
  const [history, setHistory] = useState<Ev[]>([]);
  const [tx, setTx] = useState<{ id: string; events: Ev[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: '40' });
    if (table) p.set('table', table);
    if (actor) p.set('actor', actor);
    return p.toString();
  }, [table, actor]);

  const refresh = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([get<Stats>('stats'), get<Ev[]>(`events?${qs}`)]);
      setStats(s); setFeed(f); setErr(null);
    } catch (e) { setErr(String(e)); }
  }, [qs]);

  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, [refresh]);

  useEffect(() => {
    if (!sel) return;
    get<Ev[]>(`records/${sel.table}/${sel.id}/history`).then(setHistory).catch((e) => setErr(String(e)));
  }, [sel, stats?.events]);

  const openTx = (id: string) => get<Ev[]>(`transactions/${id}`).then((events) => setTx({ id, events })).catch((e) => setErr(String(e)));

  return (
    <>
      <header>
        <h1>Audit Trail <span className="muted">· captured by Debezium</span></h1>
        {stats && <>
          <span className="stat"><b>{stats.events}</b> events</span>
          {stats.tables.map((t) => <span key={t.table} className="stat">{t.table} <b>{t.events}</b></span>)}
        </>}
        {err && <span style={{ color: 'var(--d)' }}>API error: {err}</span>}
      </header>
      <main>
        <section>
          <h2>Live changes</h2>
          <div className="filters">
            <select value={table} onChange={(e) => setTable(e.target.value)}>
              <option value="">all tables</option>
              {stats?.tables.map((t) => <option key={t.table}>{t.table}</option>)}
            </select>
            <select value={actor} onChange={(e) => setActor(e.target.value)}>
              <option value="">all actors</option>
              {stats?.actors.map((a) => <option key={a.actor}>{a.actor}</option>)}
            </select>
          </div>
          {feed.length === 0 && <div className="empty">No changes yet. Make one in the Shop tab.</div>}
          {feed.map((e) => (
            <EventRow key={e.event_id} e={e} onTx={openTx}
              selected={sel?.table === e.source_table && sel?.id === e.pk?.id}
              onSelect={() => e.source_table && e.pk && setSel({ table: e.source_table, id: e.pk.id })} />
          ))}
        </section>

        <div className="stack">
          <section>
            <h2>{sel ? `History · ${sel.table} #${sel.id}` : 'Record history'}</h2>
            {!sel && <div className="empty">Select a change to see that record&apos;s full timeline.</div>}
            {[...history].reverse().map((e) => <EventRow key={e.event_id} e={e} onTx={openTx} />)}
          </section>

          {tx && (
            <section>
              <h2>Transaction {tx.id} <button className="link" onClick={() => setTx(null)}>close</button></h2>
              {tx.events.map((e) => <EventRow key={e.event_id} e={e} />)}
            </section>
          )}

          <TimeTravel tables={stats?.tables.map((t) => t.table) ?? []} />
        </div>
      </main>
    </>
  );
}

function TimeTravel({ tables }: { tables: string[] }) {
  const [table, setTable] = useState('accounts');
  const [minutes, setMinutes] = useState(0); // minutes ago
  const [range, setRange] = useState(60);
  const [data, setData] = useState<{ asOf: string; count: number; rows: Record<string, unknown>[] } | null>(null);
  // Time-dependent values are computed only after mount: rendering Date.now()/locale text during SSR
  // would differ from the browser's render (hydration mismatch). `tick` keeps "now" actually current.
  const [mounted, setMounted] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { setMounted(true); const t = setInterval(() => setTick((n) => n + 1), 5000); return () => clearInterval(t); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ts = useMemo(() => (mounted ? new Date(Date.now() - minutes * 60_000).toISOString() : ''), [minutes, mounted, minutes === 0 ? tick : 0]);

  useEffect(() => {
    if (!ts) return;
    const t = setTimeout(() => get<typeof data>(`tables/${table}/as-of?ts=${encodeURIComponent(ts)}`).then(setData).catch(() => setData(null)), 150);
    return () => clearTimeout(t);
  }, [table, ts]);

  const cols = data?.rows[0] ? Object.keys(data.rows[0]).filter((c) => !['created_at', 'updated_at', 'profile', 'attrs'].includes(c)) : [];
  return (
    <section>
      <h2>Time travel</h2>
      <div className="filters">
        <select value={table} onChange={(e) => setTable(e.target.value)}>
          {(tables.length ? tables : ['accounts']).map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={range} onChange={(e) => { setRange(Number(e.target.value)); setMinutes(0); }}>
          <option value={15}>last 15 min</option><option value={60}>last hour</option>
          <option value={1440}>last day</option>
        </select>
        <button onClick={() => setMinutes(0)}>now</button>
      </div>
      <input type="range" min={0} max={range} value={range - minutes}
        onChange={(e) => setMinutes(range - Number(e.target.value))} />
      <div className="muted">as of <b>{ts ? when(ts) : '…'}</b>{minutes === 0 ? ' (now)' : ` (${minutes} min ago)`} · {data?.count ?? '…'} rows</div>
      <div className="scroll">
        <table>
          <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{data?.rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{fmt(r[c])}</td>)}</tr>)}</tbody>
        </table>
        {data && data.count === 0 && <div className="empty">Table did not exist yet at this time.</div>}
      </div>
    </section>
  );
}
