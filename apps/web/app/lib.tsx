'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export type Diff = { field: string; from: unknown; to: unknown };
export type Ev = {
  event_id: string; lsn: string; source_table?: string; pk?: { id: number }; op: 'c' | 'u' | 'd' | 'r';
  tx_id: string | null; source_ts: string; actor: string | null; diff: Diff[];
};

export const OPS = { c: 'INSERT', u: 'UPDATE', d: 'DELETE', r: 'SNAPSHOT' } as const;
export const fmt = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
export const when = (s: string) => new Date(s).toLocaleString();

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(`/api/${path}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export function Diffs({ diff, op }: { diff: Diff[]; op: string }) {
  if (op === 'r') return <div className="muted">initial snapshot row</div>;
  const shown = diff.filter((d) => d.field !== 'updated_at' || diff.length === 1);
  return (
    <div className="diff mono">
      {shown.map((d) => (
        <div key={d.field}>
          <span className="f">{d.field}</span>{' '}
          {op !== 'c' && <span className="from">{fmt(d.from)}</span>}
          {op === 'u' && ' → '}
          {op !== 'd' && <span className="to">{fmt(d.to)}</span>}
        </div>
      ))}
    </div>
  );
}

export function EventRow({ e, selected, fresh, onSelect, onTx }: {
  e: Ev; selected?: boolean; fresh?: boolean; onSelect?: () => void; onTx?: (tx: string) => void;
}) {
  return (
    <div className={`ev ${selected ? 'sel' : ''} ${fresh ? 'fresh' : ''}`} onClick={onSelect}>
      <div className="row1">
        <span className={`badge op-${e.op}`}>{OPS[e.op]}</span>
        {e.source_table && <b>{e.source_table} #{e.pk?.id}</b>}
        <span className="muted">by</span> <b>{e.actor ?? 'unknown'}</b>
        <span className="muted">{when(e.source_ts)}</span>
        {e.tx_id && onTx && (
          <button className="link mono" onClick={(ev) => { ev.stopPropagation(); onTx(e.tx_id!); }}>tx {e.tx_id}</button>
        )}
      </div>
      <Diffs diff={e.diff} op={e.op} />
    </div>
  );
}

/**
 * Polls the audit feed. Events that appear after the first load are flagged `fresh` so the UI can
 * highlight them; `pollNow()` forces a quick re-poll burst (used right after the user makes a change,
 * since the change takes ~1s to travel Postgres → Debezium → Redis → writer → audit DB).
 */
export function useAuditFeed(limit: number, intervalMs = 2000) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const f = await get<Ev[]>(`events?limit=${limit}`);
      const prev = seen.current;
      if (prev) {
        const added = f.filter((e) => !prev.has(e.event_id)).map((e) => e.event_id);
        if (added.length) {
          setFresh(new Set(added));
          setTimeout(() => setFresh(new Set()), 2500);
        }
      }
      seen.current = new Set(f.map((e) => e.event_id));
      setEvents(f);
      setError(null);
    } catch (e) { setError(String(e)); }
  }, [limit]);

  useEffect(() => { load(); const t = setInterval(load, intervalMs); return () => clearInterval(t); }, [load, intervalMs]);

  const pollNow = useCallback(() => {
    [300, 900, 1600, 2600].forEach((ms) => setTimeout(load, ms));
  }, [load]);

  return { events, fresh, error, pollNow };
}
