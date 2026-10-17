import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearTemporaryClosure, describeError, endReopen, getHours, putHours, setTemporaryClosure, startReopen,
  type ShopHours
} from '../lib/shop-api';
import {
  availabilityHeadline, DAY_LABEL, DAYS, emptyWeek, formatDate, formatInstant, isOvernight, TIMEZONES, validateWeek,
  type AfterHoursPolicy, type Day, type Interval, type SpecialClosure, type WeeklyHours
} from '../lib/hours';
import { Banner, Button, Card, CardHeader, Chip, IconButton, RadioGroup, Select, Skeleton, Switch, TextField, useToast } from '../ui';
import { useUnsavedGuard } from './components';

interface Form { useSchedule: boolean; week: WeeklyHours; timezone: string; closures: SpecialClosure[]; policy: AfterHoursPolicy }

const toForm = (h: ShopHours): Form => ({
  useSchedule: h.weeklyHours !== null,
  week: h.weeklyHours ? structuredClone(h.weeklyHours) : emptyWeek(),
  timezone: h.timezone,
  closures: h.specialClosures.map((c) => ({ date: c.date, reason: c.reason ?? null })).sort((a, b) => a.date.localeCompare(b.date)),
  policy: h.afterHoursPolicy
});

const DEFAULT_INTERVAL: Interval = { start: '09:00', end: '18:00' };
const CLOSE_DURATIONS: { value: string; label: string; minutes: number | null }[] = [
  { value: 'open', label: 'Until I reopen the shop', minutes: null },
  { value: '30', label: 'For 30 minutes', minutes: 30 },
  { value: '60', label: 'For 1 hour', minutes: 60 },
  { value: '120', label: 'For 2 hours', minutes: 120 },
  { value: '240', label: 'For 4 hours', minutes: 240 }
];
const REOPEN_DURATIONS = [{ value: '60', label: '1 hour' }, { value: '120', label: '2 hours' }, { value: '240', label: '4 hours' }, { value: '480', label: '8 hours' }];

export default function HoursSection() {
  const [server, setServer] = useState<ShopHours | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [newClosure, setNewClosure] = useState<{ date: string; reason: string }>({ date: '', reason: '' });
  const [closureError, setClosureError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const stash = useRef<Partial<Record<Day, Interval[]>>>({});
  const { show, node: toast } = useToast();

  const apply = useCallback((h: ShopHours) => { setServer(h); setForm(toForm(h)); }, []);
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    getHours().then((h) => { if (alive) apply(h); }).catch((e) => { if (alive) setLoadError(describeError(e)); });
    return () => { alive = false; };
  }, [attempt, apply]);

  const dirty = useMemo(() => !!server && !!form && JSON.stringify(form) !== JSON.stringify(toForm(server)), [server, form]);
  useUnsavedGuard(dirty, 'hours');
  const weekErrors = useMemo(() => (form?.useSchedule ? validateWeek(form.week) : {}), [form]);
  const hasErrors = Object.keys(weekErrors).length > 0;

  if (loadError) {
    return (
      <Card as="section" aria-labelledby="hrs-title">
        <CardHeader id="hrs-title" title="Operating hours" />
        <Banner tone="err" actions={<Button size="sm" variant="dark" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>{loadError}</Banner>
      </Card>
    );
  }
  if (!server || !form) return <Card as="section" aria-labelledby="hrs-title"><CardHeader id="hrs-title" title="Operating hours" /><Skeleton lines={4} label="Loading operating hours" /></Card>;

  const set = (patch: Partial<Form>) => { setForm((f) => (f ? { ...f, ...patch } : f)); setError(null); };
  const setDay = (day: Day, intervals: Interval[]) => set({ week: { ...form.week, [day]: intervals } });
  const setInterval_ = (day: Day, i: number, patch: Partial<Interval>) =>
    setDay(day, form.week[day].map((iv, idx) => (idx === i ? { ...iv, ...patch } : iv)));

  const headline = availabilityHeadline(server.availability, server.timezone);

  async function save() {
    if (!form || saving) return;
    setShowErrors(true);
    if (hasErrors) return;
    setSaving(true); setError(null);
    try {
      const h = await putHours({
        timezone: form.timezone,
        weeklyHours: form.useSchedule ? form.week : null,
        specialClosures: form.closures,
        afterHoursPolicy: form.policy
      });
      apply(h); setShowErrors(false);
      show('Operating hours saved');
    } catch (e) { setError(describeError(e)); } finally { setSaving(false); }
  }

  function addClosure() {
    if (!form) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newClosure.date)) { setClosureError('Choose a date.'); return; }
    if (form.closures.some((c) => c.date === newClosure.date)) { setClosureError('That date is already in the list.'); return; }
    setClosureError(null);
    set({ closures: [...form.closures, { date: newClosure.date, reason: newClosure.reason.trim() || null }].sort((a, b) => a.date.localeCompare(b.date)) });
    setNewClosure({ date: '', reason: '' });
  }

  return (
    <Card as="section" aria-labelledby="hrs-title" className="pb-hours">
      <CardHeader id="hrs-title" title="Operating hours" meta={dirty ? <Chip tone="warn" role="status">Unsaved hours changes</Chip> : undefined} />
      <p className="pb-muted pb-hours__lead">Customers see these hours on your shop page. Times use your shop timezone.</p>

      <div className={`pb-hours__status pb-hours__status--${headline.tone}`} role="status" aria-label="Current shop status">
        <strong>{headline.title}</strong>{headline.detail && <span> · {headline.detail}</span>}
        {server.availability.closureReason && <span> · {server.availability.closureReason}</span>}
      </div>

      <ClosureControls server={server} onChange={apply} onToast={show} />

      {error && <Banner tone="err">{error}</Banner>}

      <div className="pb-hours__form">
        <Switch label="Use a weekly schedule" checked={form.useSchedule} hint="Turn off to stop showing opening hours. Nothing is deleted until you save." onChange={(e) => {
          const on = e.target.checked;
          // A brand-new schedule starts from a common default (Mon-Sat, 9-6) instead of a week of closed days.
          const blank = DAYS.every((d) => form.week[d].length === 0);
          set(on && blank ? { useSchedule: true, week: { ...emptyWeek(), mon: [{ ...DEFAULT_INTERVAL }], tue: [{ ...DEFAULT_INTERVAL }], wed: [{ ...DEFAULT_INTERVAL }], thu: [{ ...DEFAULT_INTERVAL }], fri: [{ ...DEFAULT_INTERVAL }], sat: [{ ...DEFAULT_INTERVAL }] } } : { useSchedule: on });
        }} />

        {form.useSchedule && (
          <>
            <Select label="Timezone" value={form.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {[...new Set([form.timezone, ...TIMEZONES])].map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </Select>

            <div className="pb-hours__days">
              {DAYS.map((day) => {
                const intervals = form.week[day];
                const err = showErrors ? weekErrors[day] : undefined;
                const open = intervals.length > 0;
                return (
                  <fieldset key={day} className="pb-hours__day" aria-describedby={err ? `hrs-err-${day}` : undefined}>
                    <legend className="pb-sr-only">{DAY_LABEL[day]}</legend>
                    <div className="pb-hours__dayhead">
                      <Switch
                        label={<span className="pb-hours__dayname">{DAY_LABEL[day]}<span className="pb-hours__state">{open ? 'Open' : 'Closed'}</span></span>}
                        aria-label={`${DAY_LABEL[day]} open`}
                        checked={open}
                        onChange={(e) => {
                          if (e.target.checked) setDay(day, stash.current[day]?.length ? stash.current[day]! : [{ ...DEFAULT_INTERVAL }]);
                          else { stash.current[day] = intervals; setDay(day, []); }
                        }}
                      />
                    </div>
                    {open && (
                      <div className="pb-hours__intervals">
                        {intervals.map((iv, i) => (
                          <div key={i} className="pb-hours__interval">
                            <TextField label={`${DAY_LABEL[day]} opens${intervals.length > 1 ? ` (${i + 1})` : ''}`} hideLabel type="time" step={60} value={iv.start === '00:00' && iv.end === '24:00' ? '00:00' : iv.start} disabled={iv.start === '00:00' && iv.end === '24:00'} onChange={(e) => setInterval_(day, i, { start: e.target.value })} />
                            <span aria-hidden="true">to</span>
                            {iv.start === '00:00' && iv.end === '24:00'
                              ? <span className="pb-hours__24">Open 24 hours</span>
                              : <TextField label={`${DAY_LABEL[day]} closes${intervals.length > 1 ? ` (${i + 1})` : ''}`} hideLabel type="time" step={60} value={iv.end} onChange={(e) => setInterval_(day, i, { end: e.target.value })} />}
                            {isOvernight(iv) && iv.start !== iv.end && <Chip size="sm" tone="info" dot={false}>closes next day</Chip>}
                            <IconButton icon="x" size="sm" label={`Remove ${DAY_LABEL[day]} interval ${i + 1}`} onClick={() => setDay(day, intervals.filter((_x, idx) => idx !== i))} />
                          </div>
                        ))}
                        <div className="pb-hours__dayactions">
                          {intervals.length < 6 && !(intervals.length === 1 && intervals[0]!.end === '24:00' && intervals[0]!.start === '00:00') && (
                            <Button size="sm" variant="ghost" iconStart="plus" onClick={() => setDay(day, [...intervals, { start: '17:00', end: '21:00' }])}>Add hours for {DAY_LABEL[day]}</Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setDay(day, [{ start: '00:00', end: '24:00' }])}>Open 24 hours on {DAY_LABEL[day]}</Button>
                        </div>
                      </div>
                    )}
                    {err && <p id={`hrs-err-${day}`} className="pb-field__error" role="alert">{DAY_LABEL[day]}: {err}</p>}
                  </fieldset>
                );
              })}
            </div>
            <p className="pb-muted pb-small">A closing time earlier than the opening time means the shop stays open past midnight (for example 9:00 PM to 2:00 AM).</p>
          </>
        )}

        <section aria-labelledby="hrs-closures" className="pb-hours__closures">
          <h3 id="hrs-closures" className="pb-h3">Holidays and special closures</h3>
          <p className="pb-muted pb-small">A closed date closes the whole day. Reasons are shown to customers.</p>
          <div className="pb-hours__addclosure">
            <TextField label="Closure date" type="date" value={newClosure.date} error={closureError} onChange={(e) => { setNewClosure((n) => ({ ...n, date: e.target.value })); setClosureError(null); }} />
            <TextField label="Reason (optional)" maxLength={100} value={newClosure.reason} onChange={(e) => setNewClosure((n) => ({ ...n, reason: e.target.value }))} />
            <Button variant="outline" iconStart="plus" onClick={addClosure}>Add closed date</Button>
          </div>
          {form.closures.length > 0 && (
            <ul className="pb-hours__closurelist" aria-label="Closed dates">
              {form.closures.map((c) => (
                <li key={c.date}>
                  <span><strong>{formatDate(c.date)}</strong>{c.reason ? ` · ${c.reason}` : ''}</span>
                  <IconButton icon="x" size="sm" label={`Remove closure on ${formatDate(c.date)}`} onClick={() => set({ closures: form.closures.filter((x) => x.date !== c.date) })} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <RadioGroup<AfterHoursPolicy>
          legend="When the shop is closed"
          variant="list"
          value={form.policy}
          onChange={(policy) => set({ policy })}
          options={[
            { value: 'ACCEPT', label: 'Accept new orders', description: 'Customers can still send files and place orders. You will see them when you open.' },
            { value: 'BLOCK', label: 'Do not accept new orders', description: 'Customers can see your hours but cannot upload or place orders until you open. Existing orders are not affected.' }
          ]}
        />
        {form.policy === 'BLOCK' && !form.useSchedule && server.availability.state === 'unknown' && (
          <Banner tone="info">Without a weekly schedule, orders are only blocked during a temporary closure or on closed dates.</Banner>
        )}

        <div className="pb-ratecard__actions">
          <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving} loading={saving}>{saving ? 'Saving…' : 'Save operating hours'}</Button>
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => { apply(server); setShowErrors(false); setError(null); }}>Cancel changes</Button>
        </div>
      </div>
      {toast}
    </Card>
  );
}

/** Immediate actions (they apply at once, independent of the form): temporary closure and emergency reopen. */
function ClosureControls({ server, onChange, onToast }: { server: ShopHours; onChange: (h: ShopHours) => void; onToast: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('open');
  const [reopenFor, setReopenFor] = useState('120');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = server.availability;
  const closure = a.reason === 'temporary_closure' ? server.temporaryClosure : null;

  async function run(fn: () => Promise<ShopHours>, done: string) {
    if (busy) return;
    setBusy(true); setError(null);
    try { onChange(await fn()); onToast(done); } catch (e) { setError(describeError(e)); } finally { setBusy(false); }
  }

  return (
    <div className="pb-hours__quick" role="group" aria-label="Temporary closure and reopening">
      {error && <Banner tone="err">{error}</Banner>}
      {closure ? (
        <Banner tone="warn" title="Temporary closure is on" actions={<Button size="sm" variant="dark" disabled={busy} onClick={() => void run(() => clearTemporaryClosure(), 'Shop reopened')}>Reopen now</Button>}>
          {closure.reason ? `${closure.reason}. ` : ''}{closure.until ? `Closed until ${formatInstant(closure.until, server.timezone, a.serverTime)}.` : 'Closed until you reopen.'}
        </Banner>
      ) : server.reopenUntil ? (
        <Banner tone="info" title="Emergency reopening is on" actions={<Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => endReopen(), 'Back to your normal hours')}>End reopening</Button>}>
          Customers see you as open until {formatInstant(server.reopenUntil, server.timezone, a.serverTime)}, whatever your schedule says.
        </Banner>
      ) : (
        <div className="pb-hours__closenow">
          {a.state === 'closed' ? (
            <div className="pb-hours__reopen">
              <Select label="Reopen for" value={reopenFor} onChange={(e) => setReopenFor(e.target.value)} wrapperClassName="pb-hours__reopensel">
                {REOPEN_DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </Select>
              <Button variant="outline" disabled={busy} onClick={() => void run(() => startReopen(Number(reopenFor)), 'Shop reopened temporarily')}>Reopen shop now</Button>
            </div>
          ) : (
            <div className="pb-hours__close">
              <TextField label="Reason for closing (optional)" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
              <Select label="Close" value={duration} onChange={(e) => setDuration(e.target.value)}>
                {CLOSE_DURATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </Select>
              <Button variant="dark" disabled={busy} onClick={() => {
                const minutes = CLOSE_DURATIONS.find((d) => d.value === duration)?.minutes ?? null;
                void run(() => setTemporaryClosure({ reason: reason.trim() || null, until: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null }), 'Shop closed temporarily');
              }}>Close shop now</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
