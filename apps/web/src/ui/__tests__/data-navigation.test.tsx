import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Button } from '../actions/Button';
import { DataTable, type Column } from '../data/DataTable';
import { LoadMore } from '../data/LoadMore';
import { EmptyState } from '../feedback/EmptyState';
import { AppShell, BottomNav, Sidebar, TopBar, type NavItem } from '../navigation/navigation';

interface Row { id: string; code: string; file: string }
const rows: Row[] = [{ id: 'a', code: '4823', file: 'Project_report.docx' }, { id: 'b', code: '4821', file: 'Marksheet_2026.pdf' }];

function cols(onPrint = () => {}): Column<Row>[] {
  return [
    { key: 'code', header: 'Code', cell: (r) => r.code },
    { key: 'file', header: 'File', cell: (r) => r.file },
    { key: 'act', header: 'Action', srOnlyHeader: true, align: 'end', cell: (r) => <Button size="sm" variant="dark" onClick={onPrint}>Print {r.code}</Button> }
  ];
}

function mockMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({ matches, media: q, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), onchange: null, dispatchEvent: vi.fn() })) as never;
}

afterEach(() => { delete (window as { matchMedia?: unknown }).matchMedia; });

describe('DataTable', () => {
  it('renders a captioned table with column headers and rows', () => {
    render(<DataTable caption="Print queue" columns={cols()} rows={rows} getRowKey={(r) => r.id} />);
    const table = screen.getByRole('table', { name: 'Print queue' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Code', 'File', 'Action']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('region', { name: 'Print queue' })).toHaveAttribute('tabindex', '0');
  });

  it('marks the selected row and highlights new rows', () => {
    render(<DataTable caption="Queue" columns={cols()} rows={rows} getRowKey={(r) => r.id} selectedKey="b" highlightKeys={['a']} />);
    const [, first, second] = screen.getAllByRole('row');
    expect(first).toHaveClass('is-new');
    expect(second).toHaveAttribute('aria-current', 'true');
    expect(second).toHaveClass('is-selected');
  });

  it('row click opens details but a click on an inner button does not', async () => {
    const onRowClick = vi.fn();
    const onPrint = vi.fn();
    render(<DataTable caption="Queue" columns={cols(onPrint)} rows={rows} getRowKey={(r) => r.id} onRowClick={onRowClick} />);
    await userEvent.click(screen.getByText('Project_report.docx'));
    expect(onRowClick).toHaveBeenCalledWith(rows[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Print 4821' }));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onPrint).toHaveBeenCalledTimes(1);
  });

  it('shows skeleton rows and busy state while loading', () => {
    render(<DataTable caption="Queue" columns={cols()} rows={[]} getRowKey={(r) => r.id} loading loadingRows={3} />);
    expect(screen.getByRole('table', { hidden: true })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByText('Project_report.docx')).toBeNull();
  });

  it('applies rowAttributes (data-* hooks) to table rows and to phone cards, and a custom loading label', () => {
    const attrs = (r: Row) => ({ 'data-testid': 'order-card', 'data-id': r.id });
    const first = render(<DataTable caption="Queue" columns={cols()} rows={rows} getRowKey={(r) => r.id} rowAttributes={attrs} />);
    expect(screen.getAllByTestId('order-card')).toHaveLength(2);
    expect(screen.getAllByTestId('order-card')[1]).toHaveAttribute('data-id', 'b');
    expect(screen.getAllByTestId('order-card')[0]!.tagName).toBe('TR');
    first.unmount();
    mockMedia(true);
    const second = render(<DataTable caption="Queue" columns={cols()} rows={rows} getRowKey={(r) => r.id} rowAttributes={attrs} renderCard={(r) => <p>{r.code}</p>} />);
    expect(screen.getAllByTestId('order-card')[0]).toHaveAttribute('role', 'listitem');
    second.unmount();
    mockMedia(false);
    render(<DataTable caption="Queue" columns={cols()} rows={[]} getRowKey={(r) => r.id} loading loadingLabel="Loading orders" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading orders');
  });

  it('shows the empty slot instead of an empty table', () => {
    render(<DataTable caption="Queue" columns={cols()} rows={[]} getRowKey={(r) => r.id} empty={<EmptyState title="No jobs waiting" />} />);
    expect(screen.getByRole('heading', { name: 'No jobs waiting' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders cards instead of the table on narrow screens when renderCard is given (never both)', () => {
    mockMedia(true);
    render(<DataTable caption="Queue" columns={cols()} rows={rows} getRowKey={(r) => r.id} renderCard={(r) => <p>{r.code} card</p>} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('list', { name: 'Queue' })).toBeInTheDocument();
    expect(screen.getByText('4823 card')).toBeInTheDocument();
  });

  it('keeps the table on wide screens', () => {
    mockMedia(false);
    render(<DataTable caption="Queue" columns={cols()} rows={rows} getRowKey={(r) => r.id} renderCard={(r) => <p>{r.code} card</p>} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByText('4823 card')).toBeNull();
  });
});

describe('LoadMore', () => {
  it('offers Load more while there is a next page and blocks double clicks while loading', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<LoadMore hasMore onClick={onClick} summary="Showing 9 of 173" />);
    expect(screen.getByText('Showing 9 of 173')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<LoadMore hasMore loading onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: 'Loading…' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows the end marker and an error slot', () => {
    render(<LoadMore hasMore={false} onClick={() => {}} error={<p role="alert">Could not load more</p>} />);
    expect(screen.getByText('End of list')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load more');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

const items: NavItem[] = [
  { to: '/shop', label: 'Print queue', icon: 'list-ordered', end: true, count: 3 },
  { to: '/shop/history', label: 'History', icon: 'clock' },
  { to: '/shop/staff', label: 'Staff', icon: 'users', tag: 'Pro', comingSoon: true }
];

describe('Sidebar, BottomNav, AppShell', () => {
  it('Sidebar is a named nav landmark; the current page has aria-current and counts are announced', () => {
    render(<MemoryRouter initialEntries={['/shop']}><Sidebar label="Shop sections" brand={<span>Brand</span>} items={items} footer={<p>Pilot · day 9 of 14</p>} /></MemoryRouter>);
    const nav = screen.getByRole('navigation', { name: 'Shop sections' });
    const queue = within(nav).getByRole('link', { name: /^Print queue\s*3 items$/ });
    expect(queue).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'History' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('Pilot · day 9 of 14')).toBeInTheDocument();
  });

  it('coming-soon items are not links, are aria-disabled and say so', () => {
    render(<MemoryRouter><Sidebar label="Shop sections" brand="B" items={items} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: /Staff/ })).toBeNull();
    const soon = screen.getByText('Staff').closest('[aria-disabled="true"]');
    expect(soon).not.toBeNull();
    expect(screen.getByText('(coming soon)')).toBeInTheDocument();
  });

  it('onNavigate can cancel navigation (unsaved-changes guard)', async () => {
    const onNavigate = vi.fn((e: React.MouseEvent) => e.preventDefault());
    render(<MemoryRouter initialEntries={['/shop']}><Sidebar label="Shop sections" brand="B" items={items} onNavigate={onNavigate} /></MemoryRouter>);
    await userEvent.click(screen.getByRole('link', { name: 'History' }));
    expect(onNavigate).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'History' })).not.toHaveAttribute('aria-current');
  });

  it('BottomNav omits coming-soon items and shows the count badge', () => {
    render(<MemoryRouter initialEntries={['/shop']}><BottomNav label="Primary" items={items} /></MemoryRouter>);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(nav).getAllByRole('link')).toHaveLength(2);
    expect(within(nav).getByLabelText('3 new')).toBeInTheDocument();
  });

  it('AppShell provides a skip link and a main landmark and renders slots', () => {
    render(
      <MemoryRouter>
        <AppShell sidebar={<aside aria-label="side">S</aside>} topbar={<TopBar start="Sharma Xerox & Cyber" end={<span>RS</span>} />} bottomNav={<nav aria-label="tabs">T</nav>} notice={<p>Payment failed</p>}>
          <h1>Print queue</h1>
        </AppShell>
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute('href', '#pb-main');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'pb-main');
    expect(within(screen.getByRole('main')).getByRole('heading', { name: 'Print queue' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Sharma Xerox & Cyber');
    expect(screen.getByText('Payment failed')).toBeInTheDocument();
  });
});
