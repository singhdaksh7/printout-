import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ComponentShowcase from '../showcase/ComponentShowcase';

function renderShowcase() {
  return render(<MemoryRouter initialEntries={['/ui-showcase']}><ComponentShowcase /></MemoryRouter>);
}

describe('ComponentShowcase (development only)', () => {
  it('renders every section without console errors or warnings', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderShowcase();
    for (const name of ['Tokens and type', 'Actions', 'Inputs and selections', 'Status, chips, badges and progress', 'Feedback', 'Cards, stats, key-values and timeline', 'Overlays', 'Data display', 'Navigation and shell', 'Charts', 'Icons']) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(err.mock.calls.map((c) => c.join(' '))).toEqual([]);
    // React Router's own v7 future-flag notices are not about our components.
    expect(warn.mock.calls.map((c) => c.join(' ')).filter((m) => !m.includes('React Router Future Flag'))).toEqual([]);
    err.mockRestore();
    warn.mockRestore();
  });

  it('demonstrates all five button variants, loading and disabled states', () => {
    renderShowcase();
    for (const v of ['primary', 'dark', 'outline', 'ghost', 'danger']) {
      expect(screen.getAllByRole('button', { name: new RegExp(`^${v} (sm|md|lg)$`) })).toHaveLength(3);
    }
    expect(screen.getByRole('button', { name: 'Disabled' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving' })).toHaveAttribute('aria-busy', 'true');
  });

  it('opens and closes the modal and the drawer', async () => {
    renderShowcase();
    await userEvent.click(screen.getByRole('button', { name: 'Open danger modal' }));
    const dlg = screen.getByRole('dialog', { name: 'Suspend Sharma Xerox & Cyber?' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    expect(screen.getByRole('dialog', { name: /4823/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('labels placeholder numbers as sample data', () => {
    renderShowcase();
    expect(screen.getAllByText('Sample').length).toBeGreaterThan(2);
  });
});
