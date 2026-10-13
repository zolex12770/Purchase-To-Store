/**
 * Item and supplier pickers that search the WHOLE master, not a preloaded slice.
 *
 * Every form used to fetch the first 50 items (or suppliers) once and let the
 * search box filter only those. With 12,000+ items and 1,400 suppliers that
 * meant a user could type an exact item code and be told "No matches": the
 * record existed, it was simply not among the 50 that had been loaded. The
 * visible symptom was that only items and suppliers early in the alphabet were
 * ever chosen.
 *
 * These wrap `SearchSelect` with a server search (`/items/search`,
 * `/suppliers/search`), debounced, and always keep the currently chosen record
 * showing even when it is not part of the latest result list.
 */
import { useMemo, useState } from 'react';
import { SearchSelect, type Option } from './ui';
import { useDebounced } from './simple';
import { useItemSearch, useSupplierSearch, type ItemOption, type SupplierOption } from '../lib/masters';

export function ItemSelect({
  value, onChange, selectedCode, selectedDescription, placeholder = 'Type item code or name…',
  disabled, invalid, excludeIds,
}: {
  value: number | null;
  onChange: (id: number | null, item: ItemOption | null) => void;
  /** The chosen item's own code/description, so it shows even when not in the current results. */
  selectedCode?: string;
  selectedDescription?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Items to leave out of the results — e.g. ones already on the document. */
  excludeIds?: ReadonlySet<number>;
}) {
  const [term, setTerm] = useState('');
  const settled = useDebounced(term.trim(), 250);
  const { data, isFetching } = useItemSearch(settled);

  const options = useMemo<Option[]>(
    () => (data ?? [])
      .filter((it) => !excludeIds?.has(it.id) || it.id === value)
      .map((it) => ({
        value: it.id,
        label: it.item_code,
        sublabel: it.item_description,
        meta: [it.uom_code, it.live_stock_qty != null ? `Stock: ${Number(it.live_stock_qty).toFixed(1)}` : null].filter(Boolean).join(' · ') || undefined,
      })),
    [data, excludeIds, value],
  );

  return (
    <SearchSelect
      value={value}
      options={options}
      onSearch={setTerm}
      searching={isFetching || term.trim() !== settled}
      selectedOption={value != null && selectedCode ? { value, label: selectedCode, sublabel: selectedDescription } : null}
      placeholder={placeholder}
      disabled={disabled}
      invalid={invalid}
      emptyText={term.trim() ? 'No item found. Check the item code or name.' : 'Type the item code or name to search.'}
      onChange={(v) => {
        if (v === null) { onChange(null, null); return; }
        const id = Number(v);
        onChange(id, (data ?? []).find((it) => it.id === id) ?? null);
      }}
    />
  );
}

export function SupplierSelect({
  value, onChange, selectedName, placeholder = 'Type supplier name…', disabled, invalid,
}: {
  value: number | null;
  onChange: (id: number | null, supplier: SupplierOption | null) => void;
  /** The chosen supplier's own name, so it shows even when not in the current results. */
  selectedName?: string;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const [term, setTerm] = useState('');
  const settled = useDebounced(term.trim(), 250);
  const { data, isFetching } = useSupplierSearch(settled);

  const options = useMemo<Option[]>(
    () => (data ?? []).map((s) => ({
      value: s.id, label: s.supplier_name,
      sublabel: [s.supplier_code, s.city, s.state].filter(Boolean).join(' · '),
    })),
    [data],
  );

  return (
    <SearchSelect
      value={value}
      options={options}
      onSearch={setTerm}
      searching={isFetching || term.trim() !== settled}
      selectedOption={value != null && selectedName ? { value, label: selectedName } : null}
      placeholder={placeholder}
      disabled={disabled}
      invalid={invalid}
      emptyText={term.trim() ? 'No supplier found. Check the name.' : 'Type the supplier name to search.'}
      onChange={(v) => {
        if (v === null) { onChange(null, null); return; }
        const id = Number(v);
        onChange(id, (data ?? []).find((s) => s.id === id) ?? null);
      }}
    />
  );
}
