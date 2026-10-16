import { createRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button, buttonClass } from '../actions/Button';
import { IconButton } from '../actions/IconButton';
import { SegmentedControl } from '../actions/SegmentedControl';

describe('Button', () => {
  it('is type="button" by default and never submits a form by accident', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Button>Preview</Button></form>);
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('type', 'button');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits a form only when type="submit"', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Button type="submit">Send to shop</Button></form>);
    await userEvent.click(screen.getByRole('button', { name: 'Send to shop' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('activates with Enter and Space', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Print</Button>);
    screen.getByRole('button').focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('loading ignores click, keyboard and form submit, keeps its label and reports busy', async () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Button type="submit" loading onClick={onClick}>Save rate card</Button></form>);
    const b = screen.getByRole('button', { name: 'Save rate card' });
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).toBeEnabled(); // stays focusable so keyboard users do not lose their place
    await userEvent.click(b);
    b.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disabled does not fire onClick', async () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Print</Button>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards its ref and passes native props through', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} data-testid="x" aria-label="Go">Go</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(screen.getByTestId('x')).toHaveAttribute('aria-label', 'Go');
  });

  it.each(['primary', 'dark', 'outline', 'ghost', 'danger'] as const)('variant %s and each size produce documented classes', (variant) => {
    for (const size of ['sm', 'md', 'lg'] as const) {
      const cls = buttonClass({ variant, size });
      expect(cls).toContain(`pb-btn--${variant}`);
      expect(cls).toContain(`pb-btn--${size}`);
    }
  });

  it('buttonClass styles other elements (e.g. links) and supports fullWidth', () => {
    render(<a href="/x" className={buttonClass({ variant: 'outline', fullWidth: true })}>Go to print queue</a>);
    expect(screen.getByRole('link', { name: 'Go to print queue' })).toHaveClass('pb-btn', 'pb-btn--outline', 'pb-btn--block');
  });
});

describe('IconButton', () => {
  it('has the required accessible name and is type="button"', async () => {
    const onClick = vi.fn();
    render(<IconButton icon="x" label="Close" onClick={onClick} />);
    const b = screen.getByRole('button', { name: 'Close' });
    expect(b).toHaveAttribute('type', 'button');
    await userEvent.click(b);
    expect(onClick).toHaveBeenCalled();
  });
});

describe('SegmentedControl', () => {
  function Demo({ onChange = () => {} }: { onChange?: (v: string) => void }) {
    const [v, setV] = useState('active');
    return (
      <SegmentedControl label="Queue filter" value={v} onChange={(x) => { setV(x); onChange(x); }} options={[{ value: 'active', label: 'Active', count: 3 }, { value: 'all', label: 'All today' }]} />
    );
  }

  it('is a named radiogroup with the current value checked and counts shown', () => {
    render(<Demo />);
    expect(screen.getByRole('radiogroup', { name: 'Queue filter' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Active/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Active 3/ })).toBeInTheDocument();
  });

  it('changes with click and with arrow keys', async () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'All today' }));
    expect(onChange).toHaveBeenLastCalledWith('all');
    screen.getByRole('radio', { name: 'All today' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('active');
    expect(screen.getByRole('radio', { name: /Active/ })).toBeChecked();
  });
});
