import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../actions/Button';
import { Card, CardHeader, StatTile } from '../layout/Card';
import { KeyValueList } from '../layout/KeyValueList';
import { Timeline } from '../layout/Timeline';
import { Drawer } from '../overlays/Drawer';
import { Modal } from '../overlays/Modal';

describe('Card, CardHeader, StatTile', () => {
  it('renders the requested element, padding and accent', () => {
    const { container } = render(<Card as="section" padding="sm" accent="err" aria-labelledby="t"><CardHeader id="t" title="Alerts" meta="4 open" as="h3" /></Card>);
    expect(container.firstChild).toHaveClass('pb-card', 'pb-card--pad-sm', 'pb-card--err');
    expect((container.firstChild as HTMLElement).tagName).toBe('SECTION');
    expect(screen.getByRole('heading', { level: 3, name: 'Alerts' })).toBeInTheDocument();
    expect(screen.getByText('4 open')).toBeInTheDocument();
  });

  it('StatTile shows label, value, hint and a SAMPLE tag when given', () => {
    render(<StatTile label="Jobs today" value="173" hint="158 last Wednesday" tag="Sample" accent="warn" />);
    expect(screen.getByText('Jobs today')).toBeInTheDocument();
    expect(screen.getByText('173')).toHaveClass('pb-stat__value');
    expect(screen.getByText('158 last Wednesday')).toBeInTheDocument();
    expect(screen.getByText('Sample')).toBeInTheDocument();
  });

  it('StatTile loading announces itself and hides the value', () => {
    render(<StatTile label="Printed today" value="27" loading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading Printed today');
    expect(screen.queryByText('27')).toBeNull();
  });
});

describe('KeyValueList and Timeline', () => {
  it('KeyValueList is a description list', () => {
    render(<KeyValueList items={[{ label: 'Copies', value: '1' }, { label: 'Agent ID', value: 'agt_B4L7', mono: true }]} />);
    expect(screen.getByText('Copies').tagName).toBe('DT');
    expect(screen.getByText('1').tagName).toBe('DD');
    expect(screen.getByText('agt_B4L7')).toHaveClass('pb-mono');
  });

  it('Timeline is an ordered list with time and text', () => {
    render(<Timeline items={[{ time: '18:41', children: 'Job 4823 queued' }, { time: '14 Oct', tone: 'ok', children: 'Payment received' }]} />);
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('18:41')).toHaveClass('pb-mono');
  });
});

function ModalHarness({ busy = false, onClose = () => {} }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Modal title="Cancel job 4821?" busy={busy} onClose={() => { onClose(); setOpen(false); }} footer={<><Button>Keep job</Button><Button variant="danger">Cancel job</Button></>}>
          <input aria-label="Reason" />
        </Modal>
      )}
    </>
  );
}

describe('Modal', () => {
  it('is a named, modal dialog that focuses its first control', async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByText('Open'));
    const dialog = screen.getByRole('dialog', { name: 'Cancel job 4821?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Reason')).toHaveFocus();
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByText('Open'));
    const cancel = screen.getByRole('button', { name: 'Cancel job' });
    cancel.focus();
    await userEvent.tab();
    expect(screen.getByLabelText('Reason')).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(cancel).toHaveFocus();
  });

  it('closes on Escape and on scrim click, and returns focus to the opener', async () => {
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    const opener = screen.getByText('Open');
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    const scrim = screen.getByRole('dialog').parentElement!;
    await userEvent.pointer({ keys: '[MouseLeft]', target: scrim });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores Escape and scrim clicks while busy', async () => {
    const onClose = vi.fn();
    render(<ModalHarness busy onClose={onClose} />);
    await userEvent.click(screen.getByText('Open'));
    await userEvent.keyboard('{Escape}');
    await userEvent.pointer({ keys: '[MouseLeft]', target: screen.getByRole('dialog').parentElement! });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-busy', 'true');
  });

  it('danger tone and size are reflected in classes', () => {
    render(<Modal title="Suspend shop?" tone="danger" size="sm" onClose={() => {}}>Body</Modal>);
    expect(screen.getByRole('dialog')).toHaveClass('pb-modal--danger', 'pb-modal--sm');
  });
});

describe('Drawer', () => {
  it('is a named dialog with a Close button, header and sticky footer', async () => {
    const onClose = vi.fn();
    render(<Drawer title="Job 4823" header={<strong>4823 Queued</strong>} onClose={onClose} footer={<Button variant="primary">Print</Button>}>details</Drawer>);
    const dlg = screen.getByRole('dialog', { name: '4823 Queued' });
    expect(within(dlg).getByRole('button', { name: 'Print' })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape and traps focus', async () => {
    const onClose = vi.fn();
    render(<Drawer title="Job 4823" onClose={onClose}><button>Inner</button></Drawer>);
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('disables Close while busy', () => {
    render(<Drawer title="Job" busy onClose={() => {}}>x</Drawer>);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  });
});
