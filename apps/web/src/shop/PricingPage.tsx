import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createPricingRule, deletePricingRule, describeError, errorCode, listPricingRules, updatePricingRule, type PricingRule
} from '../lib/shop-api';
import { ApiError } from '../lib/api';
import { paiseToRupeesInput, parseRupeesToPaise } from '../lib/shop-money';
import { Banner, Button, Card, CardHeader, Checkbox, Chip, Skeleton, TextField, useToast } from '../ui';
import { useUnsavedGuard } from './components';
import { formatPaise } from '../lib/format';

type Colour = 'bw' | 'colour';
type Sides = 'single' | 'duplex';
const COMBOS: { key: string; colourMode: Colour; sides: Sides; label: string }[] = [
  { key: 'bw-single', colourMode: 'bw', sides: 'single', label: 'B&W · Single-sided' },
  { key: 'bw-duplex', colourMode: 'bw', sides: 'duplex', label: 'B&W · Duplex' },
  { key: 'colour-single', colourMode: 'colour', sides: 'single', label: 'Colour · Single-sided' },
  { key: 'colour-duplex', colourMode: 'colour', sides: 'duplex', label: 'Colour · Duplex' }
];
interface Row { value: string; active: boolean }
const comboKey = (c: Colour, s: Sides) => `${c}-${s}`;

function baselineOf(rules: PricingRule[]): Record<string, Row> {
  const out: Record<string, Row> = {};
  for (const c of COMBOS) {
    const r = rules.find((x) => x.colourMode === c.colourMode && x.sides === c.sides && x.paperSize === 'A4');
    out[c.key] = r ? { value: paiseToRupeesInput(r.pricePerSheetPaise), active: r.active } : { value: '', active: true };
  }
  return out;
}

export default function PricingPage() {
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  const { show, node: toast } = useToast();

  const base = useMemo(() => baselineOf(rules), [rules]);

  // Only the most recent load may touch the form. StrictMode (dev), Retry and the reload after Save can have two requests in flight;
  // an older or slower response must not reset prices the shopkeeper has started typing.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setLoading(true); setLoadError(null);
    try {
      const r = await listPricingRules();
      if (mine !== latest.current) return null;
      setRules(r);
      setRows(baselineOf(r));
      return r;
    } catch (e) {
      if (mine !== latest.current) return null;
      setLoadError(describeError(e));
      return null;
    } finally { if (mine === latest.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const isDirty = (k: string) => {
    const a = rows[k], b = base[k];
    if (!a || !b) return false;
    const hasRule = rules.some((r) => comboKey(r.colourMode, r.sides) === k);
    if (!hasRule && a.value.trim() === '') return false;
    return a.value.trim() !== b.value || a.active !== b.active;
  };
  const dirtyKeys = COMBOS.map((c) => c.key).filter(isDirty);
  const dirty = dirtyKeys.length > 0;
  useUnsavedGuard(dirty, 'pricing');

  const setRow = (k: string, patch: Partial<Row>) => {
    setRows((r) => ({ ...r, [k]: { ...(r[k] as Row), ...patch } }));
    setRowErrors((e) => { const n = { ...e }; delete n[k]; return n; });
    setGlobalError(null);
  };

  async function save() {
    if (saving || !dirty) return;
    setGlobalError(null);
    const errs: Record<string, string> = {};
    const parsed: Record<string, number> = {};
    for (const k of dirtyKeys) {
      const p = parseRupeesToPaise(rows[k]!.value);
      if (p.ok) parsed[k] = p.paise; else errs[k] = p.error;
    }
    setRowErrors(errs);
    if (Object.keys(errs).length) { setGlobalError('Fix the highlighted prices and try again.'); return; }
    setSaving(true);
    const failed: Record<string, string> = {};
    let fatal: string | null = null;
    let done = 0;
    for (const k of dirtyKeys) {
      const combo = COMBOS.find((c) => c.key === k)!;
      const existing = rules.find((r) => comboKey(r.colourMode, r.sides) === k && r.paperSize === 'A4');
      try {
        if (existing) await updatePricingRule(existing.id, { pricePerSheetPaise: parsed[k]!, active: rows[k]!.active });
        else await createPricingRule({ paperSize: 'A4', colourMode: combo.colourMode, sides: combo.sides, pricePerSheetPaise: parsed[k]!, active: rows[k]!.active });
        done++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) failed[k] = 'A rule for this combination already exists. Reloaded the latest prices.';
        else if (e instanceof ApiError && (e.status === 401 || e.code === 'NETWORK_ERROR')) { fatal = describeError(e); break; }
        else failed[k] = describeError(e);
      }
    }
    const fresh = await load();
    if (fresh) {
      // keep the user's unsaved edits on rows that failed
      setRows((cur) => {
        const b = baselineOf(fresh); const out = { ...b };
        for (const k of Object.keys(failed)) if (!/already exists/.test(failed[k]!)) out[k] = rows[k]!;
        return { ...cur, ...out };
      });
    }
    setRowErrors(failed);
    setSaving(false);
    if (fatal) setGlobalError(fatal);
    else if (Object.keys(failed).length) setGlobalError('Some prices could not be saved.');
    else if (done) show('Pricing saved');
  }

  function reset() { setRows(base); setRowErrors({}); setGlobalError(null); }

  async function remove(k: string) {
    const existing = rules.find((r) => comboKey(r.colourMode, r.sides) === k);
    if (!existing) return;
    if (removing !== k) { setRemoving(k); return; }
    setRemoving(null);
    try {
      await deletePricingRule(existing.id);
      await load();
      show('Price removed. Customers cannot order this option until you set a price.');
    } catch (e) {
      setRowErrors((x) => ({ ...x, [k]: describeError(e) }));
      if (errorCode(e) === 'NOT_FOUND') void load();
    }
  }

  /** A worked example from the price typed in the field (never a stored or sample value): 10 pages, duplex prints 2 pages per sheet. */
  function example(c: (typeof COMBOS)[number], value: string): string | null {
    const p = parseRupeesToPaise(value);
    if (!p.ok) return null;
    const sheets = c.sides === 'duplex' ? 5 : 10;
    return `Example: 10 pages ${c.sides === 'duplex' ? 'double-sided' : 'single-sided'} = ${sheets} sheets = ${formatPaise(p.paise * sheets)}.`;
  }

  return (
    <section aria-labelledby="pricing-title" className="pb-theme pb-page">
      <div className="pb-pagehead">
        <div>
          <h1 id="pricing-title" className="pb-h1">Rate card</h1>
          <p className="pb-muted pb-pagehead__sub">Price per sheet for A4 printing, in rupees. Duplex is charged per physical sheet (2 pages per sheet). Orders are priced by the server using these saved prices.</p>
        </div>
        {dirty && <Chip tone="warn" role="status">Unsaved changes</Chip>}
      </div>
      {loadError && <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => void load()}>Retry</Button>}>{loadError}</Banner>}
      {globalError && <Banner tone="err">{globalError}</Banner>}
      {loading && rules.length === 0 && !loadError ? <Skeleton lines={4} label="Loading prices" /> : null}
      {(!loading || rules.length > 0) && !loadError && (
        <form className="pb-ratecard" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          <div className="pb-ratecard__grid">
            {COMBOS.map((c) => {
              const row = rows[c.key] ?? { value: '', active: true };
              const hasRule = rules.some((r) => comboKey(r.colourMode, r.sides) === c.key);
              const err = rowErrors[c.key];
              return (
                <Card key={c.key} className={isDirty(c.key) ? 'pb-ratecard__row is-dirty' : 'pb-ratecard__row'}>
                  <TextField
                    label={c.label}
                    startAdornment="₹"
                    endAdornment={<span className="pb-muted">per sheet</span>}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={row.value}
                    error={err ?? null}
                    helperText={example(c, row.value)}
                    onChange={(e) => setRow(c.key, { value: e.target.value })}
                  />
                  <div className="pb-ratecard__foot">
                    {!hasRule && <Chip size="sm" dot={false}>Not set</Chip>}
                    <Checkbox label="Active" checked={row.active} onChange={(e) => setRow(c.key, { active: e.target.checked })} />
                    {hasRule && (
                      <Button variant="ghost" size="sm" onClick={() => void remove(c.key)} aria-label={`Remove price for ${c.label}`}>
                        {removing === c.key ? 'Tap again to remove' : 'Remove'}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
          <div className="pb-ratecard__actions">
            <Button type="submit" variant="primary" disabled={!dirty || saving} loading={saving}>{saving ? 'Saving…' : 'Save prices'}</Button>
            <Button variant="ghost" onClick={reset} disabled={!dirty || saving}>Reset</Button>
          </div>
        </form>
      )}
      {toast}
    </section>
  );
}
