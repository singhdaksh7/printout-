import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../actions/Button';
import { Banner } from '../feedback/Banner';
import { EmptyState } from '../feedback/EmptyState';
import { Skeleton } from '../feedback/Skeleton';
import { ToastRegion } from '../feedback/ToastRegion';
import { Badge } from '../status/Badge';
import { Chip } from '../status/Chip';
import { ProgressBar } from '../status/ProgressBar';
import { Spinner } from '../status/Spinner';

describe('Chip', () => {
  it('is a non-interactive span with visible text and a decorative dot', () => {
    const { container } = render(<Chip tone="info">Queued</Chip>);
    const chip = screen.getByText('Queued');
    expect(chip.tagName).toBe('SPAN');
    expect(chip).toHaveClass('pb-chip', 'pb-chip--info');
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('.pb-chip__dot')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each(['neutral', 'info', 'orange', 'ok', 'warn', 'err'] as const)('tone %s', (tone) => {
    render(<Chip tone={tone}>x</Chip>);
    expect(screen.getByText('x')).toHaveClass(`pb-chip--${tone}`);
  });

  it('supports size sm and dot=false', () => {
    const { container } = render(<Chip size="sm" dot={false}>Pro</Chip>);
    expect(screen.getByText('Pro')).toHaveClass('pb-chip--sm');
    expect(container.querySelector('.pb-chip__dot')).toBeNull();
  });
});

describe('Badge, Spinner, ProgressBar', () => {
  it('Badge renders count and tags with tone classes', () => {
    render(<><Badge tone="orange">3</Badge><Badge onDark>Pro</Badge><Badge tone="warn" caps>Sample</Badge></>);
    expect(screen.getByText('3')).toHaveClass('pb-badge--orange');
    expect(screen.getByText('Pro')).toHaveClass('pb-badge--on-dark');
    expect(screen.getByText('Sample')).toHaveClass('pb-badge--caps');
  });

  it('Spinner is decorative unless labelled', () => {
    const { container, rerender } = render(<Spinner />);
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
    rerender(<Spinner label="Waiting for COUNTER-PC" />);
    expect(screen.getByRole('status', { name: 'Waiting for COUNTER-PC' })).toBeInTheDocument();
  });

  it('ProgressBar exposes value, clamps it, and requires a name', () => {
    const { rerender } = render(<ProgressBar value={60} label="Printing 4822" />);
    const bar = screen.getByRole('progressbar', { name: 'Printing 4822' });
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar.firstElementChild).toHaveStyle({ width: '60%' });
    rerender(<ProgressBar value={140} label="Printing 4822" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    rerender(<ProgressBar value={-5} label="Printing 4822" />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });
});

describe('Banner', () => {
  it('errors are role=alert, other tones role=status', () => {
    const { rerender } = render(<Banner tone="err" title="Upload failed">Tap Retry.</Banner>);
    expect(screen.getByRole('alert')).toHaveTextContent('Upload failed');
    rerender(<Banner tone="ok" title="File deleted">Deleted at 4:12 pm.</Banner>);
    expect(screen.getByRole('status')).toHaveTextContent('File deleted');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders ordered steps and actions, and dismisses', async () => {
    const onDismiss = vi.fn();
    render(
      <Banner tone="warn" title="Print agent is offline" steps={['Check the PC is switched on', 'Check the PC has internet']} actions={<Button size="sm">Check again</Button>} onDismiss={onDismiss}>
        Printing paused.
      </Banner>
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('list').tagName).toBe('OL');
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('bar layout puts actions on the strip', () => {
    const { container } = render(<Banner tone="err" layout="bar" actions={<Button size="sm">Retry payment</Button>}>Payment failed.</Banner>);
    expect(container.firstChild).toHaveClass('pb-banner--bar');
    expect(screen.getByRole('button', { name: 'Retry payment' })).toBeInTheDocument();
  });
});

describe('ToastRegion, Skeleton, EmptyState', () => {
  it('ToastRegion keeps a polite live region mounted even when empty', () => {
    const { rerender } = render(<ToastRegion message={null} />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    rerender(<ToastRegion message="New job 4823 · Project_report.docx" />);
    expect(screen.getByRole('status')).toHaveTextContent('New job 4823');
  });

  it('Skeleton text is a labelled busy region; block is decorative', () => {
    const { container, rerender } = render(<Skeleton label="Loading jobs" lines={4} />);
    const region = screen.getByRole('status', { name: 'Loading jobs' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelectorAll('.pb-skel--line')).toHaveLength(4);
    rerender(<Skeleton variant="block" width={80} height={20} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(container.firstChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('EmptyState shows title, body, one action and an optional callout', () => {
    render(<EmptyState title="No jobs waiting" action={<Button>Print standee</Button>} callout={<p>Is the QR standee on the counter?</p>}>New jobs appear here.</EmptyState>);
    expect(screen.getByRole('heading', { name: 'No jobs waiting' })).toBeInTheDocument();
    expect(screen.getByText('New jobs appear here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print standee' })).toBeInTheDocument();
    expect(screen.getByText('Is the QR standee on the counter?')).toBeInTheDocument();
  });
});
