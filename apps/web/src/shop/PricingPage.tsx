import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createPricingRule, deletePricingRule, describeError, errorCode, listPricingRules, updatePricingRule, type PricingRule
} from '../lib/shop-api';
import { ApiError } from '../lib/api';
import { paiseToRupeesInput, parseRupeesToPaise } from '../lib/shop-money';
import { Banner, Skeleton, useToast, useUnsavedGuard } from './components';

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

  const load = useCallback(async () => {
    setLoading(true); setLoadError(null);
    try {
      const r = await listPricingRules();
      setRules(r);
      setRows(baselineOf(r));
      return r;
    } catch (e) {
      setLoadError(describeError(e));
      return null;
    } finally { setLoading(false); }
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

  return (
    <section aria-labelledby="pricing-title">
      <div className="sh-pagehead">
        <h1 id="pricing-title">Pricing</h1>
        {dirty && <span className="sh-chip sh-chip-warn" role="status">Unsaved changes</span>}
      </div>
      <p className="sh-muted">Price per sheet for A4 printing, in rupees. Duplex is charged per physical sheet (2 pages per sheet). Orders are priced by the server using these saved prices.</p>
      {loadError && <Banner onRetry={() => void load()}>{loadError}</Banner>}
      {globalError && <Banner>{globalError}</Banner>}
      {loading && rules.length === 0 && !loadError ? <Skeleton lines={4} label="Loading prices" /> : null}
      {(!loading || rules.length > 0) && !loadError && (
        <form className="price-grid" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
          {COMBOS.map((c) => {
            const row = rows[c.key] ?? { value: '', active: true };
            const hasRule = rules.some((r) => comboKey(r.colourMode, r.sides) === c.key);
            const err = rowErrors[c.key];
            const inputId = `price-${c.key}`;
            return (
              <div key={c.key} className={`sh-card price-row${isDirty(c.key) ? ' is-dirty' : ''}`}>
                <div className="price-row-head">
                  <label htmlFor={inputId}><strong>{c.label}</strong></label>
                  {!hasRule && <span className="sh-chip">Not set</span>}
                </div>
                <div className="price-inputs">
                  <span className="price-prefix" aria-hidden="true">₹</span>
                  <input
                    id={inputId} inputMode="decimal" autoComplete="off" placeholder="0.00" value={row.value}
                    aria-invalid={!!err} aria-describedby={err ? `${inputId}-err` : undefined}
                    onChange={(e) => setRow(c.key, { value: e.target.value })}
                  />
                  <span className="sh-muted">per sheet</span>
                </div>
                <div className="price-row-foot">
                  <label className="sh-switch">
                    <input type="checkbox" checked={row.active} onChange={(e) => setRow(c.key, { active: e.target.checked })} />
                    <span>Active</span>
                  </label>
                  {hasRule && (
                    <button type="button" className="sh-btn sh-btn-sm sh-btn-ghost" onClick={() => void remove(c.key)} aria-label={`Remove price for ${c.label}`}>
                      {removing === c.key ? 'Tap again to remove' : 'Remove'}
                    </button>
                  )}
                </div>
                {err && <div id={`${inputId}-err`} className="sh-field-error" role="alert">{err}</div>}
              </div>
            );
          })}
          <div className="sh-actions sh-sticky-actions">
            <button type="submit" className="sh-btn sh-btn-primary" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save prices'}</button>
            <button type="button" className="sh-btn" onClick={reset} disabled={!dirty || saving}>Reset</button>
          </div>
        </form>
      )}
      {toast}
    </section>
  );
}
