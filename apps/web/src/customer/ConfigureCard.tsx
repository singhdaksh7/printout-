import { useId } from 'react';
import { MAX_COPIES, copiesError as validateCopies, type Config } from './config';

type Props = {
  cfg: Config; onChange: (patch: Partial<Config>) => void; pageCount: number | null;
  copiesError: string | null; pagesError: string | null; serverPageError?: string | null;
};

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; t: string }[]; onChange: (v: T) => void }) {
  const id = useId();
  return (
    <div className="cx-field">
      <span className="cx-label" id={id}>{label}</span>
      <div className="cx-seg" role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={value === o.v} className={`cx-seg-btn${value === o.v ? ' is-on' : ''}`} onClick={() => onChange(o.v)}>{o.t}</button>
        ))}
      </div>
    </div>
  );
}

export function ConfigureCard({ cfg, onChange, pageCount, copiesError, pagesError, serverPageError }: Props) {
  const copiesId = useId(), pagesId = useId();
  const n = /^\d+$/.test(cfg.copies) ? Number(cfg.copies) : 1;
  const step = (d: number) => onChange({ copies: String(Math.min(MAX_COPIES, Math.max(1, n + d))) });
  const pagesMsg = (cfg.pageText.trim() ? pagesError : null) ?? serverPageError ?? null;
  return (
    <section className="cx-card" aria-labelledby="cx-config-h">
      <h2 className="cx-h2" id="cx-config-h">2. Print options</h2>
      <div className="cx-field"><span className="cx-label">Paper</span><span className="cx-chip">A4</span></div>
      <Segmented label="Colour" value={cfg.colourMode} onChange={(colourMode) => onChange({ colourMode })} options={[{ v: 'bw', t: 'Black & white' }, { v: 'colour', t: 'Colour' }]} />
      <Segmented label="Sides" value={cfg.sides} onChange={(sides) => onChange({ sides })} options={[{ v: 'single', t: 'Single-sided' }, { v: 'duplex', t: 'Double-sided' }]} />

      <div className="cx-field">
        <label className="cx-label" htmlFor={copiesId}>Copies</label>
        <div className="cx-stepper">
          <button type="button" className="cx-btn cx-step" aria-label="Decrease copies" onClick={() => step(-1)} disabled={n <= 1}>−</button>
          <input id={copiesId} className="cx-input cx-tnum cx-copies" inputMode="numeric" autoComplete="off" value={cfg.copies}
            aria-invalid={!!copiesError} aria-describedby={copiesError ? `${copiesId}-e` : undefined}
            onChange={(e) => onChange({ copies: e.target.value.replace(/[^\d]/g, '').slice(0, 5) })}
            onBlur={() => { if (validateCopies(cfg.copies)) return; onChange({ copies: String(Number(cfg.copies)) }); }} />
          <button type="button" className="cx-btn cx-step" aria-label="Increase copies" onClick={() => step(1)} disabled={n >= MAX_COPIES}>+</button>
        </div>
        {copiesError && <p className="cx-field-err" id={`${copiesId}-e`} role="alert">{copiesError}</p>}
      </div>

      <Segmented label="Pages" value={cfg.pageMode} onChange={(pageMode) => onChange({ pageMode })}
        options={pageCount !== null && pageCount <= 1 ? [{ v: 'all', t: 'All pages' }] : [{ v: 'all', t: 'All pages' }, { v: 'custom', t: 'Custom' }]} />
      {cfg.pageMode === 'custom' && (
        <div className="cx-field">
          <label className="cx-label" htmlFor={pagesId}>Pages to print{pageCount ? ` (1–${pageCount})` : ''}</label>
          <input id={pagesId} className="cx-input" placeholder="e.g. 1-5, 8, 10-12" autoComplete="off" autoCapitalize="off" spellCheck={false}
            value={cfg.pageText} aria-invalid={!!pagesMsg} aria-describedby={pagesMsg ? `${pagesId}-e` : undefined}
            onChange={(e) => onChange({ pageText: e.target.value })} />
          {pagesMsg && <p className="cx-field-err" id={`${pagesId}-e`} role="alert">{pagesMsg}</p>}
        </div>
      )}
    </section>
  );
}
