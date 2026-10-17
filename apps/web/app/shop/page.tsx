'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EventRow, fmt, useAuditFeed } from '../lib';

type Col = { name: string; type: 'text' | 'number' | 'json'; required?: boolean };
type Meta = Record<string, { cols: Col[]; creatable: boolean }>;
type Row = Record<string, unknown> & { id: number };
type Notice = { kind: 'ok' | 'err'; text: string };

const TABS = ['accounts', 'products', 'orders', 'order_items'] as const;
const ACTORS = ['alice', 'bob', 'carol', 'dana', 'erin'];

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/shop-api/${path}`, {
    method, cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(Array.isArray(data.message) ? data.message.join(', ') : data.message ?? `request failed (${r.status})`);
  return data as T;
}

const toInput = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function ShopPage() {
  const [actor, setActor] = useState('');
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>('accounts');
  const [rows, setRows] = useState<Row[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const { events, fresh, error: feedError, pollNow } = useAuditFeed(15, 2000);

  useEffect(() => { try { setActor(localStorage.getItem('shop-actor') ?? ''); } catch { /* storage unavailable */ } }, []);
  useEffect(() => { try { localStorage.setItem('shop-actor', actor); } catch { /* ignore */ } }, [actor]);
  useEffect(() => { send<Meta>('GET', 'meta').then(setMeta).catch((e) => setNotice({ kind: 'err', text: String(e.message ?? e) })); }, []);

  const load = useCallback(() => send<Row[]>('GET', `tables/${tab}`).then(setRows).catch((e) => setNotice({ kind: 'err', text: e.message })), [tab]);
  useEffect(() => { setRows([]); load(); }, [load]);

  /** Run a change; on success reload the table and kick the audit feed so the capture shows up quickly. */
  const run = async (label: string, fn: () => Promise<{ txId?: string }>) => {
    if (!actor.trim()) { setNotice({ kind: 'err', text: 'Enter who you are (top right) before making changes.' }); return false; }
    setBusy(true);
    try {
      const r = await fn();
      setNotice({ kind: 'ok', text: `${label} — recorded as ${actor.trim()}${r.txId ? ` (tx ${r.txId})` : ''}` });
      await load(); pollNow();
      return true;
    } catch (e) {
      setNotice({ kind: 'err', text: (e as Error).message });
      return false;
    } finally { setBusy(false); }
  };

  const spec = meta?.[tab];
  return (
    <>
      <header>
        <h1>Shop <span className="muted">· changes here are captured by Debezium</span></h1>
        <label className="stat" style={{ marginLeft: 'auto' }}>
          Acting as{' '}
          <input list="actors" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="your name" maxLength={50} style={{ width: 140 }} />
          <datalist id="actors">{ACTORS.map((a) => <option key={a} value={a} />)}</datalist>
        </label>
      </header>

      <main>
        <div className="stack">
          <section>
            <div className="filters">
              {TABS.map((t) => (
                <button key={t} onClick={() => { setTab(t); setNotice(null); }} style={tab === t ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}>{t}</button>
              ))}
            </div>
            {notice && <div className={`notice ${notice.kind}`} role="status">{notice.text}</div>}
            {spec && <Grid key={tab} table={tab} cols={spec.cols} rows={rows} busy={busy}
              onSave={(id, values) => run(`Updated ${tab} #${id}`, () => send('PATCH', `tables/${tab}/${id}`, { actor, values }))}
              onDelete={(id) => run(`Deleted ${tab} #${id}`, () => send('DELETE', `tables/${tab}/${id}`, { actor }))} />}
            {spec?.creatable && <NewRow key={`new-${tab}`} cols={spec.cols} busy={busy}
              onCreate={(values) => run(`Created ${tab} row`, () => send('POST', `tables/${tab}`, { actor, values }))} />}
          </section>

          <PlaceOrder busy={busy} onPlace={(accountId, items) =>
            run('Order placed', () => send('POST', 'orders/place', { actor, accountId, items })).then((ok) => { if (ok) load(); return ok; })} />
        </div>

        <section>
          <h2>Live audit feed <span className="muted" style={{ textTransform: 'none' }}>· updates as you change things</span></h2>
          {feedError && <div className="notice err">Audit API unreachable: {feedError}</div>}
          {events.length === 0 && !feedError && <div className="empty">No changes yet. Edit a row on the left.</div>}
          {events.map((e) => <EventRow key={e.event_id} e={e} fresh={fresh.has(e.event_id)} />)}
          <div className="muted" style={{ marginTop: 8 }}>Open the <a href="/">Audit Trail</a> tab for history, transactions and time travel.</div>
        </section>
      </main>
    </>
  );
}

function Grid({ table, cols, rows, busy, onSave, onDelete }: {
  table: string; cols: Col[]; rows: Row[]; busy: boolean;
  onSave: (id: number, values: Record<string, string>) => Promise<boolean>;
  onDelete: (id: number) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const editable = useMemo(() => new Set(cols.map((c) => c.name)), [cols]);
  const shown = useMemo(() => (rows[0] ? Object.keys(rows[0]).filter((c) => !['created_at', 'updated_at'].includes(c) || editable.has(c)) : []), [rows, editable]);

  const start = (r: Row) => { setEditing(r.id); setDraft(Object.fromEntries(cols.map((c) => [c.name, toInput(r[c.name])]))); };
  const save = async (r: Row) => {
    // Only send fields that actually changed so unrelated columns stay out of the audit diff.
    const changed = Object.fromEntries(cols.filter((c) => draft[c.name] !== toInput(r[c.name])).map((c) => [c.name, draft[c.name]]));
    if (Object.keys(changed).length === 0) { setEditing(null); return; }
    if (await onSave(r.id, changed)) setEditing(null);
  };

  return (
    <div className="scroll" style={{ maxHeight: 420 }}>
      <table>
        {/* Actions come first so they are never pushed out of view by wide rows. */}
        <thead><tr><th />{shown.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: 'nowrap' }}>
                {editing === r.id ? (
                  <>
                    <button disabled={busy} onClick={() => save(r)}>Save</button>{' '}
                    <button onClick={() => setEditing(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button disabled={busy} onClick={() => start(r)}>Edit</button>{' '}
                    <button disabled={busy} onClick={() => { if (confirm(`Delete ${table} #${r.id}?`)) onDelete(r.id); }}>Delete</button>
                  </>
                )}
              </td>
              {shown.map((c) => (
                <td key={c}>
                  {editing === r.id && editable.has(c)
                    ? <input value={draft[c] ?? ''} onChange={(e) => setDraft({ ...draft, [c]: e.target.value })} style={{ width: 130 }} aria-label={`${c} for ${table} ${r.id}`} />
                    : fmt(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="empty">No rows.</div>}
    </div>
  );
}

function NewRow({ cols, busy, onCreate }: { cols: Col[]; busy: boolean; onCreate: (v: Record<string, string>) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Record<string, string>>({});
  if (!open) return <div style={{ marginTop: 10 }}><button onClick={() => setOpen(true)}>+ New</button></div>;
  return (
    <form style={{ marginTop: 10, display: 'grid', gap: 6, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}
      onSubmit={async (e) => { e.preventDefault(); if (await onCreate(v)) { setV({}); setOpen(false); } }}>
      {cols.map((c) => (
        <label key={c.name} className="muted">{c.name}{c.required ? ' *' : ''}
          <input value={v[c.name] ?? ''} onChange={(e) => setV({ ...v, [c.name]: e.target.value })} style={{ width: '100%' }} required={c.required} />
        </label>
      ))}
      <div style={{ gridColumn: '1 / -1' }}>
        <button type="submit" disabled={busy}>Create</button>{' '}
        <button type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

function PlaceOrder({ busy, onPlace }: { busy: boolean; onPlace: (accountId: number, items: { productId: number; qty: number }[]) => Promise<boolean> }) {
  const [accounts, setAccounts] = useState<Row[]>([]);
  const [products, setProducts] = useState<Row[]>([]);
  const [accountId, setAccountId] = useState('');
  const [lines, setLines] = useState<{ productId: string; qty: string }[]>([{ productId: '', qty: '1' }]);

  const refresh = useCallback(() => {
    send<Row[]>('GET', 'tables/accounts').then(setAccounts).catch(() => undefined);
    send<Row[]>('GET', 'tables/products').then(setProducts).catch(() => undefined);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const valid = accountId && lines.every((l) => l.productId && Number(l.qty) >= 1);
  const setLine = (i: number, patch: Partial<{ productId: string; qty: string }>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <section>
      <h2>Place an order <span className="muted" style={{ textTransform: 'none' }}>· one transaction touching several tables</span></h2>
      <div className="filters">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="account">
          <option value="">choose account…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>#{a.id} {String(a.name)}</option>)}
        </select>
      </div>
      {lines.map((l, i) => (
        <div className="filters" key={i}>
          <select value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })} aria-label="product">
            <option value="">choose product…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{String(p.name)} · ${fmt(p.price)} · stock {fmt(p.stock)}</option>)}
          </select>
          <input type="number" min={1} max={100} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} style={{ width: 70 }} aria-label="quantity" />
          {lines.length > 1 && <button onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>}
        </div>
      ))}
      <button onClick={() => setLines([...lines, { productId: '', qty: '1' }])}>+ line</button>{' '}
      <button disabled={busy || !valid} onClick={async () => {
        const items = lines.map((l) => ({ productId: Number(l.productId), qty: Number(l.qty) }));
        if (await onPlace(Number(accountId), items)) { setLines([{ productId: '', qty: '1' }]); refresh(); }
      }}>Place order</button>
    </section>
  );
}
