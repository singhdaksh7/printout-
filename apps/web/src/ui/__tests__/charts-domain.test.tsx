import { render, screen, within } from '@testing-library/react';
import { STATUS_LABEL } from '../../shop/components';
import { BarChart, HBarList, HeartbeatStrip, SegmentedBar } from '../charts/charts';
import {
  FileDeletedLine, JOB_STATUS, JobCode, JobStatusChip, ORDER_STATUS_DISPLAY, OrderStatusChip, PresenceChip, RetentionNotice, ShopStatusChip,
  type JobStatusKind, type LegacyOrderStatus
} from '../domain/domain';

describe('BarChart', () => {
  const data = [{ label: '09', value: 3 }, { label: '10', value: 7, tone: 'highlight' as const }, { label: '11', value: 2, tone: 'muted' as const }];

  it('is an image with a text alternative plus a hidden data table', () => {
    render(<BarChart data={data} title="Busy hours" summary="Busiest at 10 with 7 jobs" valueName="Jobs" />);
    expect(screen.getByRole('img', { name: 'Busy hours. Busiest at 10 with 7 jobs' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByRole('columnheader', { name: 'Jobs' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: '10' })).toBeInTheDocument();
  });

  it('highlights the peak and mutes the partial bucket', () => {
    const { container } = render(<BarChart data={data} title="t" />);
    expect(container.querySelectorAll('.pb-chart__bar--highlight')).toHaveLength(1);
    expect(container.querySelectorAll('.pb-chart__bar--muted')).toHaveLength(1);
    expect(container.querySelectorAll('rect.pb-chart__bar')).toHaveLength(3);
  });

  it('handles empty and all-zero data without NaN geometry', () => {
    const { container, rerender } = render(<BarChart data={[]} title="t" />);
    expect(container.innerHTML).not.toContain('NaN');
    rerender(<BarChart data={[{ label: 'a', value: 0 }]} title="t" />);
    expect(container.innerHTML).not.toContain('NaN');
  });

  it('thins x labels with labelEvery', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ label: `d${i}`, value: i + 1 }));
    const { container } = render(<BarChart data={many} title="t" labelEvery={3} valueLabels={false} />);
    const labels = Array.from(container.querySelectorAll('svg text.pb-chart__tick')).map((n) => n.textContent);
    expect(labels).toContain('d0');
    expect(labels).toContain('d3');
    expect(labels).not.toContain('d1');
  });
});

describe('HBarList, HeartbeatStrip, SegmentedBar', () => {
  it('HBarList is a named list with readable values and proportional bars', () => {
    const { container } = render(<HBarList label="Pages per day" items={[{ label: 'Wed', value: 268 }, { label: 'Sat', value: 330, valueLabel: '330' }]} />);
    expect(screen.getByRole('list', { name: 'Pages per day' })).toBeInTheDocument();
    expect(screen.getByText('268')).toBeInTheDocument();
    const fills = container.querySelectorAll<HTMLElement>('.pb-hbars__fill');
    expect(fills[1]!.style.width).toBe('100%');
    expect(parseFloat(fills[0]!.style.width)).toBeCloseTo((268 / 330) * 100, 1);
  });

  it('HeartbeatStrip exposes a summary and a text legend', () => {
    const { container } = render(<HeartbeatStrip blocks={['online', 'online', 'degraded', 'offline']} summary="Offline since 17:53" axis={['18:45', '18:45']} />);
    expect(screen.getByRole('img', { name: 'Offline since 17:53' })).toBeInTheDocument();
    expect(container.querySelectorAll('.pb-heartbeat__strip > span')).toHaveLength(4);
    expect(screen.getByText('offline in shop hours')).toBeInTheDocument();
  });

  it('SegmentedBar labels each non-empty segment', () => {
    render(<SegmentedBar summary="3 of 6 on latest" segments={[{ label: 'v1.4.2', value: 3, tone: 'ok' }, { label: 'v1.4.1', value: 1, tone: 'warn' }, { label: 'v0', value: 0 }]} caption="50% on latest" />);
    expect(screen.getByRole('img', { name: '3 of 6 on latest' })).toBeInTheDocument();
    expect(screen.getByText('v1.4.2 · 3')).toBeInTheDocument();
    expect(screen.queryByText(/v0/)).toBeNull();
  });
});

describe('domain components', () => {
  it('JobStatusChip uses the design vocabulary for every kind', () => {
    const expected: Record<JobStatusKind, [string, string]> = {
      queued: ['Queued', 'info'], printing: ['Printing', 'orange'], printed: ['Printed', 'ok'], failed: ['Failed', 'err'],
      expired: ['Expired', 'neutral'], cancelled: ['Cancelled', 'neutral'], deleted: ['Deleted', 'ok'], 'paper-out': ['Paper out', 'warn']
    };
    for (const kind of Object.keys(expected) as JobStatusKind[]) {
      const [label, tone] = expected[kind];
      expect(JOB_STATUS[kind]).toEqual({ label, tone });
      const { unmount } = render(<JobStatusChip kind={kind} />);
      expect(screen.getByText(label)).toHaveClass(`pb-chip--${tone}`);
      unmount();
    }
  });

  it('OrderStatusChip keeps the exact wording the shop UI already shows', () => {
    for (const s of Object.keys(ORDER_STATUS_DISPLAY) as LegacyOrderStatus[]) {
      expect(ORDER_STATUS_DISPLAY[s].label).toBe(STATUS_LABEL[s]);
    }
    render(<OrderStatusChip status="PRINTING" />);
    expect(screen.getByText('Print started')).toHaveClass('pb-chip--orange');
  });

  it('ShopStatusChip, PresenceChip', () => {
    render(<><ShopStatusChip status="ACTIVE" /><ShopStatusChip status="past_due" /><ShopStatusChip status="weird_one" /><PresenceChip kind="offline" label="Offline 4 min" /><PresenceChip kind="paper-out" /></>);
    expect(screen.getByText('Active')).toHaveClass('pb-chip--ok');
    expect(screen.getByText('Past due')).toHaveClass('pb-chip--warn');
    expect(screen.getByText('Weird one')).toHaveClass('pb-chip--neutral');
    expect(screen.getByText('Offline 4 min')).toHaveClass('pb-chip--err');
    expect(screen.getByText('Paper out')).toHaveClass('pb-chip--warn');
  });

  it('RetentionNotice words the server deadline and renders nothing without one', () => {
    const { container, rerender } = render(<RetentionNotice at={new Date(2026, 9, 14, 12, 42)} />);
    expect(screen.getByText('Auto-deletes at 12:42')).toHaveClass('pb-chip--warn');
    rerender(<RetentionNotice at={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<RetentionNotice at="not a date" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('JobCode and FileDeletedLine', () => {
    render(<><JobCode code="4821" size="display" /><FileDeletedLine time="11:31:20" /></>);
    expect(screen.getByText('4821')).toHaveClass('pb-jobcode--display');
    expect(screen.getByText(/File deleted/)).toHaveTextContent('File deleted 11:31:20');
  });
});
