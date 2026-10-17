import type { PublicAvailability } from '../lib/customer-api';
import { availabilityHeadline, DAY_LABEL, DAYS, describeDay, formatDate, describeInterval } from '../lib/hours';
import { Chip } from '../ui';
import './availability.css';

/**
 * Open/closed status for the public shop page. Everything shown comes from the API (`availability`), which is computed
 * server-side from the shop's settings; the device clock is never used to decide open or closed. When the state is
 * unknown (no schedule configured) nothing about being open is claimed.
 */
export function AvailabilityPanel({ availability: a }: { availability?: PublicAvailability | undefined }) {
  if (!a) return null;
  const head = availabilityHeadline(a, a.timezone);
  const hasHours = !!a.weeklyHours;
  if (a.state === 'unknown' && !hasHours && a.upcomingClosures.length === 0) return null;

  const tone = head.tone === 'ok' ? 'ok' : head.tone === 'err' ? 'err' : 'neutral';
  const todayLine = a.today
    ? a.today.closedAllDay
      ? `Today: closed${a.today.reason ? ` (${a.today.reason})` : ''}`
      : `Today: ${a.today.intervals.map(describeInterval).join(', ')}`
    : null;
  const closureNote = a.temporaryClosure?.reason ?? (a.reason === 'special_closure' ? a.closureReason : null);

  return (
    <section className="cx-card cx-avail" aria-labelledby="cx-avail-h">
      <h2 className="cx-h2" id="cx-avail-h">Opening hours</h2>
      <p className="cx-avail__status" role="status">
        <Chip tone={tone === 'ok' ? 'ok' : tone === 'err' ? 'err' : 'neutral'}>{head.title}</Chip>
        {head.detail && <span className="cx-avail__detail">{head.detail}</span>}
      </p>
      {closureNote && <p className="cx-avail__note">{closureNote}</p>}
      {a.orderingBlocked && (
        <p className="cx-avail__note"><strong>New orders are paused while the shop is closed.</strong> You can still track any order you already placed.</p>
      )}
      {a.state === 'closed' && !a.orderingBlocked && a.reason !== 'temporary_closure' && (
        <p className="cx-muted cx-small">You can still send your order now; the shop will see it when it opens.</p>
      )}
      {todayLine && <p className="cx-avail__today">{todayLine}</p>}
      {hasHours && (
        <details className="cx-avail__week">
          <summary>Weekly hours</summary>
          <table>
            <caption className="cx-sr">Weekly opening hours ({a.timezone})</caption>
            <tbody>
              {DAYS.map((d) => (
                <tr key={d} aria-current={a.today?.day === d ? 'date' : undefined} className={a.today?.day === d ? 'is-today' : undefined}>
                  <th scope="row">{DAY_LABEL[d]}</th>
                  <td>{describeDay(a.weeklyHours![d])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="cx-small cx-muted">Times are in {a.timezone.replace('_', ' ')} time.</p>
        </details>
      )}
      {a.upcomingClosures.length > 0 && (
        <details className="cx-avail__week">
          <summary>Upcoming closures</summary>
          <ul>{a.upcomingClosures.slice(0, 10).map((c) => <li key={c.date}>{formatDate(c.date)}{c.reason ? ` · ${c.reason}` : ''}</li>)}</ul>
        </details>
      )}
    </section>
  );
}
