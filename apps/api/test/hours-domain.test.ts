import { describe, expect, it } from 'vitest';
import { emptyWeek, evaluateAvailability, localToUtc, parseStoredHours, specialClosuresSchema, todayView, weeklyHoursSchema, type HoursConfig, type WeeklyHours } from '../src/domain/hours.js';

const IST = 'Asia/Kolkata';
const week = (o: Partial<WeeklyHours>): WeeklyHours => ({ ...emptyWeek(), ...o });
const cfg = (o: Partial<HoursConfig> & { operatingHours: WeeklyHours | null }): HoursConfig => ({
  timezone: IST, specialClosures: [], temporaryClosure: null, reopenUntil: null, ...o
});
/** An IST wall-clock instant. */
const ist = (ymd: string, hhmm: string) => new Date(localToUtc(IST, ymd, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))));
// 2026-10-19 is a Monday.
const office = week({ mon: [{ start: '09:00', end: '18:00' }], tue: [{ start: '09:00', end: '18:00' }], wed: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] });

describe('weekly hours validation', () => {
  it('accepts valid weeks incl. overnight, 24h and touching intervals', () => {
    expect(weeklyHoursSchema.safeParse(week({ fri: [{ start: '21:00', end: '02:00' }], sat: [{ start: '02:00', end: '24:00' }], sun: [{ start: '00:00', end: '24:00' }] })).success).toBe(true);
    expect(weeklyHoursSchema.safeParse(week({ mon: [{ start: '09:00', end: '13:00' }, { start: '13:00', end: '17:00' }] })).success).toBe(true);
  });
  it.each([
    ['equal start/end', week({ mon: [{ start: '09:00', end: '09:00' }] })],
    ['overlap same day', week({ mon: [{ start: '09:00', end: '13:00' }, { start: '12:00', end: '17:00' }] })],
    ['overnight spills into next day interval', week({ mon: [{ start: '21:00', end: '02:00' }], tue: [{ start: '01:00', end: '05:00' }] })],
    ['Sunday overnight overlaps Monday morning (week wrap)', week({ sun: [{ start: '22:00', end: '03:00' }], mon: [{ start: '02:00', end: '05:00' }] })],
    ['24h day with another interval', week({ mon: [{ start: '00:00', end: '24:00' }, { start: '01:00', end: '02:00' }] })]
  ])('rejects %s', (_n, w) => expect(weeklyHoursSchema.safeParse(w).success).toBe(false));
  it.each(['9:00', '25:00', '09:60', '24:00'])('rejects malformed start %s', (start) =>
    expect(weeklyHoursSchema.safeParse(week({ mon: [{ start, end: '18:00' }] })).success).toBe(false));
  it('rejects unknown keys, bad dates and duplicate closures', () => {
    expect(weeklyHoursSchema.safeParse({ ...emptyWeek(), foo: [] }).success).toBe(false);
    expect(specialClosuresSchema.safeParse([{ date: '2026-02-30' }]).success).toBe(false);
    expect(specialClosuresSchema.safeParse([{ date: '2026-10-20' }, { date: '2026-10-20' }]).success).toBe(false);
  });
});

describe('availability (Asia/Kolkata)', () => {
  it('open inside, closed outside, with closing/next opening times', () => {
    const open = evaluateAvailability(cfg({ operatingHours: office }), ist('2026-10-19', '10:00'));
    expect(open).toMatchObject({ state: 'open', reason: 'schedule', closesAt: ist('2026-10-19', '18:00').toISOString() });
    const late = evaluateAvailability(cfg({ operatingHours: office }), ist('2026-10-19', '19:00'));
    expect(late).toMatchObject({ state: 'closed', reason: 'outside_hours', nextOpenAt: ist('2026-10-20', '09:00').toISOString() });
  });
  it('end is exclusive, start inclusive', () => {
    expect(evaluateAvailability(cfg({ operatingHours: office }), ist('2026-10-19', '09:00')).state).toBe('open');
    expect(evaluateAvailability(cfg({ operatingHours: office }), ist('2026-10-19', '18:00')).state).toBe('closed');
  });
  it('uses the IST calendar day, not UTC (23:30 UTC Sunday is Monday 05:00 IST)', () => {
    const a = evaluateAvailability(cfg({ operatingHours: office }), new Date('2026-10-18T23:30:00Z'));
    expect(a).toMatchObject({ state: 'closed', nextOpenAt: ist('2026-10-19', '09:00').toISOString() });
    const b = evaluateAvailability(cfg({ operatingHours: office }), new Date('2026-10-19T04:00:00Z')); // 09:30 IST
    expect(b.state).toBe('open');
  });
  it('multiple intervals: lunch break', () => {
    const c = cfg({ operatingHours: office });
    expect(evaluateAvailability(c, ist('2026-10-21', '13:30'))).toMatchObject({ state: 'closed', nextOpenAt: ist('2026-10-21', '14:00').toISOString() });
    expect(evaluateAvailability(c, ist('2026-10-21', '14:00')).state).toBe('open');
  });
  it('overnight 21:00-02:00 is open after midnight on the next day', () => {
    const c = cfg({ operatingHours: week({ fri: [{ start: '21:00', end: '02:00' }] }) });
    expect(evaluateAvailability(c, ist('2026-10-23', '23:00'))).toMatchObject({ state: 'open', closesAt: ist('2026-10-24', '02:00').toISOString() });
    expect(evaluateAvailability(c, ist('2026-10-24', '01:59')).state).toBe('open'); // Saturday has no intervals of its own
    expect(evaluateAvailability(c, ist('2026-10-24', '02:00')).state).toBe('closed');
    expect(evaluateAvailability(c, ist('2026-10-24', '20:00')).state).toBe('closed');
  });
  it('Sunday overnight wraps into Monday', () => {
    const c = cfg({ operatingHours: week({ sun: [{ start: '22:00', end: '03:00' }] }) });
    expect(evaluateAvailability(c, ist('2026-10-26', '01:00')).state).toBe('open');
  });
  it('touching intervals merge into one open spell', () => {
    const c = cfg({ operatingHours: week({ mon: [{ start: '09:00', end: '13:00' }, { start: '13:00', end: '17:00' }] }) });
    expect(evaluateAvailability(c, ist('2026-10-19', '12:00')).closesAt).toBe(ist('2026-10-19', '17:00').toISOString());
  });
  it('24-hour days chain into one spell', () => {
    const all = week({ mon: [{ start: '00:00', end: '24:00' }], tue: [{ start: '00:00', end: '24:00' }] });
    expect(evaluateAvailability(cfg({ operatingHours: all }), ist('2026-10-19', '12:00')).closesAt).toBe(ist('2026-10-21', '00:00').toISOString());
  });
  it('special closure closes the whole date, including the overnight tail from the day before', () => {
    const c = cfg({ operatingHours: office, specialClosures: [{ date: '2026-10-20', reason: 'Diwali' }] });
    expect(evaluateAvailability(c, ist('2026-10-20', '10:00'))).toMatchObject({ state: 'closed', reason: 'special_closure', closureReason: 'Diwali', nextOpenAt: ist('2026-10-21', '09:00').toISOString() });
    expect(evaluateAvailability(c, ist('2026-10-19', '10:00')).state).toBe('open');
    const night = cfg({ operatingHours: week({ mon: [{ start: '21:00', end: '02:00' }] }), specialClosures: [{ date: '2026-10-20' }] });
    expect(evaluateAvailability(night, ist('2026-10-19', '22:00')).state).toBe('open');
    expect(evaluateAvailability(night, ist('2026-10-20', '01:00')).state).toBe('closed');
    expect(todayView(c, ist('2026-10-20', '10:00'))).toMatchObject({ closedAllDay: true, reason: 'Diwali' });
  });
  it('temporary closure overrides schedule; until lapses automatically', () => {
    const tc = { reason: 'Power cut', startedAt: ist('2026-10-19', '09:30').toISOString(), until: ist('2026-10-19', '11:00').toISOString() };
    const c = cfg({ operatingHours: office, temporaryClosure: tc });
    expect(evaluateAvailability(c, ist('2026-10-19', '10:00'))).toMatchObject({ state: 'closed', reason: 'temporary_closure', closureReason: 'Power cut', nextOpenAt: ist('2026-10-19', '11:00').toISOString() });
    expect(evaluateAvailability(c, ist('2026-10-19', '11:00')).state).toBe('open');
    const open = evaluateAvailability(cfg({ operatingHours: office, temporaryClosure: { ...tc, until: null } }), ist('2026-10-19', '10:00'));
    expect(open).toMatchObject({ state: 'closed', nextOpenAt: null });
  });
  it('closure lasting past closing time points at the next real opening', () => {
    const tc = { startedAt: ist('2026-10-19', '15:00').toISOString(), until: ist('2026-10-19', '20:00').toISOString() };
    const a = evaluateAvailability(cfg({ operatingHours: office, temporaryClosure: tc }), ist('2026-10-19', '16:00'));
    expect(a.nextOpenAt).toBe(ist('2026-10-20', '09:00').toISOString());
  });
  it('emergency reopen beats schedule, special and temporary closures', () => {
    const c = cfg({
      operatingHours: office, specialClosures: [{ date: '2026-10-19' }],
      temporaryClosure: { startedAt: ist('2026-10-19', '08:00').toISOString(), until: null },
      reopenUntil: ist('2026-10-19', '22:00')
    });
    expect(evaluateAvailability(c, ist('2026-10-19', '21:00'))).toMatchObject({ state: 'open', reason: 'emergency_reopen', closesAt: ist('2026-10-19', '22:00').toISOString() });
    expect(evaluateAvailability(c, ist('2026-10-19', '22:00')).state).toBe('closed');
  });
  it('no schedule => unknown, never open; closures still apply', () => {
    expect(evaluateAvailability(cfg({ operatingHours: null }), ist('2026-10-19', '10:00'))).toMatchObject({ state: 'unknown', reason: 'not_configured' });
    expect(evaluateAvailability(cfg({ operatingHours: null, specialClosures: [{ date: '2026-10-19' }] }), ist('2026-10-19', '10:00')).state).toBe('closed');
  });
  it('a week of closed days is closed with no calculable next opening', () => {
    expect(evaluateAvailability(cfg({ operatingHours: emptyWeek() }), ist('2026-10-19', '10:00'))).toMatchObject({ state: 'closed', nextOpenAt: null });
  });
  it('corrupt stored data degrades to no schedule instead of throwing', () => {
    expect(parseStoredHours({ timezone: 'Nope/Zone', operatingHours: { mon: 'x' }, specialClosures: 'bad' })).toMatchObject({ timezone: IST, operatingHours: null, specialClosures: [] });
    expect(parseStoredHours(null).operatingHours).toBeNull();
  });
});

describe('other timezones (DST aware)', () => {
  it('handles America/New_York across the spring-forward change', () => {
    const ny = 'America/New_York';
    const c: HoursConfig = { timezone: ny, operatingHours: week({ sat: [{ start: '09:00', end: '17:00' }] }), specialClosures: [], temporaryClosure: null, reopenUntil: null };
    // 2026-03-07 is Saturday EST (UTC-5): 09:00 local = 14:00Z. 2026-03-14 is Saturday EDT (UTC-4): 09:00 = 13:00Z.
    expect(evaluateAvailability(c, new Date('2026-03-07T14:00:00Z')).state).toBe('open');
    expect(evaluateAvailability(c, new Date('2026-03-14T12:59:00Z')).state).toBe('closed');
    expect(evaluateAvailability(c, new Date('2026-03-14T13:00:00Z')).state).toBe('open');
  });
});
