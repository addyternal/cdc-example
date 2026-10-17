import { isDeepStrictEqual } from 'node:util';

export type Row = Record<string, unknown>;
export interface FieldDiff {
  field: string;
  from: unknown;
  to: unknown;
}

/** Per-field before -> after, for the fields that actually changed. */
export function diffRows(before: Row | null, after: Row | null): FieldDiff[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((k) => !isDeepStrictEqual(before?.[k], after?.[k]))
    .sort()
    .map((field) => ({ field, from: before?.[field] ?? null, to: after?.[field] ?? null }));
}
