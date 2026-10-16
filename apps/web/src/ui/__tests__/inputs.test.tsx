import { createRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Checkbox } from '../inputs/Checkbox';
import { RadioGroup } from '../inputs/RadioGroup';
import { Switch } from '../inputs/Switch';
import { Select } from '../inputs/Select';
import { TextArea } from '../inputs/TextArea';
import { TextField } from '../inputs/TextField';

describe('TextField', () => {
  it('associates the label with the input', () => {
    render(<TextField label="Pages" />);
    expect(screen.getByLabelText('Pages')).toBeInstanceOf(HTMLInputElement);
  });

  it('describes the input with helper text, and with the error instead when invalid', () => {
    const { rerender } = render(<TextField label="Pages" helperText="Example: 1-4, 7" />);
    const input = screen.getByLabelText('Pages');
    expect(input).toHaveAccessibleDescription('Example: 1-4, 7');
    expect(input).not.toHaveAttribute('aria-invalid');
    rerender(<TextField label="Pages" helperText="Example: 1-4, 7" error="This file has 38 pages. Enter pages between 1 and 38." />);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('This file has 38 pages. Enter pages between 1 and 38.');
    expect(screen.getByRole('alert')).toHaveTextContent('between 1 and 38');
  });

  it('merges a consumer aria-describedby with its own', () => {
    render(<><p id="ext">External hint</p><TextField label="Price" helperText="Per page" aria-describedby="ext" /></>);
    expect(screen.getByLabelText('Price')).toHaveAccessibleDescription('External hint Per page');
  });

  it('generates unique stable ids even when two labels are identical', () => {
    render(<><TextField label="Pages" /><TextField label="Pages" /></>);
    const [a, b] = screen.getAllByLabelText('Pages');
    expect(a!.id).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
  });

  it('keeps a caller-provided id', () => {
    render(<TextField label="Email" id="login-email" />);
    expect(screen.getByLabelText('Email')).toHaveAttribute('id', 'login-email');
  });

  it('forwards its ref and works controlled and uncontrolled', async () => {
    const ref = createRef<HTMLInputElement>();
    function Controlled() {
      const [v, setV] = useState('2');
      return <TextField label="Copies" ref={ref} value={v} onChange={(e) => setV(e.target.value)} />;
    }
    render(<><Controlled /><TextField label="Free" defaultValue="a" /></>);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    await userEvent.type(screen.getByLabelText('Copies'), '5');
    expect(screen.getByLabelText('Copies')).toHaveValue('25');
    await userEvent.type(screen.getByLabelText('Free'), 'b');
    expect(screen.getByLabelText('Free')).toHaveValue('ab');
  });

  it('supports required, disabled and readOnly natively and focuses with the keyboard', async () => {
    render(<><TextField label="A" required /><TextField label="B" disabled /><TextField label="C" readOnly defaultValue="x" /></>);
    expect(screen.getByLabelText('A')).toBeRequired();
    expect(screen.getByLabelText('B')).toBeDisabled();
    expect(screen.getByLabelText('C')).toHaveAttribute('readonly');
    await userEvent.tab();
    expect(screen.getByLabelText('A')).toHaveFocus();
  });

  it('renders adornments and keeps a hidden label available to assistive tech', () => {
    render(<TextField label="Search jobs" hideLabel startAdornment="₹" type="search" />);
    expect(screen.getByLabelText('Search jobs')).toBeInTheDocument();
    expect(screen.getByText('₹')).toBeInTheDocument();
    expect(screen.getByText('Search jobs')).toHaveClass('pb-sr-only');
  });
});

describe('TextArea', () => {
  it('has label, description, invalid state and a ref', () => {
    const ref = createRef<HTMLTextAreaElement>();
    const { rerender } = render(<TextArea label="Reason" helperText="At least 10 characters." ref={ref} />);
    expect(screen.getByLabelText('Reason')).toHaveAccessibleDescription('At least 10 characters.');
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
    rerender(<TextArea label="Reason" error="Too short" />);
    expect(screen.getByLabelText('Reason')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Reason')).toHaveAccessibleDescription('Too short');
  });
});

describe('Select', () => {
  it('labels the select, lists options and reports changes', async () => {
    const onChange = vi.fn();
    render(<Select label="Printer" onChange={onChange}><option value="epson">Epson L3250 (ready)</option><option value="hp">HP M1136</option></Select>);
    await userEvent.selectOptions(screen.getByLabelText('Printer'), 'hp');
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByLabelText('Printer')).toHaveValue('hp');
  });

  it('describes helper text and error like TextField', () => {
    render(<Select label="City" error="Pick a city"><option>Delhi</option></Select>);
    expect(screen.getByLabelText('City')).toHaveAccessibleDescription('Pick a city');
    expect(screen.getByLabelText('City')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('Switch', () => {
  it('is a labelled switch that toggles by click and by Space, with the hint as description', async () => {
    const onChange = vi.fn();
    render(<Switch label="Sound for new orders" hint="Plays when an order arrives" onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Sound for new orders' });
    expect(sw).toHaveAccessibleDescription('Plays when an order arrives');
    expect(sw).not.toBeChecked();
    await userEvent.click(screen.getByText('Sound for new orders'));
    sw.focus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('reflects the checked state and can be disabled', () => {
    render(<Switch label="Sound" checked readOnly disabled />);
    const sw = screen.getByRole('switch', { name: 'Sound' });
    expect(sw).toBeChecked();
    expect(sw).toBeDisabled();
  });
});

describe('Checkbox', () => {
  it('toggles by click and by Space, with hint as description', async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Sound on" hint="Plays when a job arrives" onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'Sound on' });
    expect(box).toHaveAccessibleDescription('Plays when a job arrives');
    await userEvent.click(box);
    box.focus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('supports the indeterminate state', () => {
    render(<Checkbox label="Select all" indeterminate checked={false} onChange={() => {}} />);
    expect((screen.getByRole('checkbox') as HTMLInputElement).indeterminate).toBe(true);
  });
});

describe('RadioGroup', () => {
  const options = [
    { value: 'asked', label: 'Customer asked to cancel' },
    { value: 'dup', label: 'Duplicate job' },
    { value: 'both', label: 'Use both printers', description: 'Available on Pro.', tag: 'Pro', locked: true }
  ];
  function Demo({ variant = 'list' }: { variant?: 'list' | 'card' }) {
    const [v, setV] = useState<string | null>('asked');
    return <RadioGroup legend="Reason" options={options} value={v} onChange={setV} variant={variant} />;
  }

  it('is a fieldset with a legend and native radios', () => {
    render(<Demo />);
    expect(screen.getByRole('group', { name: 'Reason' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Customer asked to cancel' })).toBeChecked();
  });

  it('moves the selection with arrow keys and click', async () => {
    render(<Demo />);
    screen.getByRole('radio', { name: 'Customer asked to cancel' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Duplicate job' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Customer asked to cancel' }));
    expect(screen.getByRole('radio', { name: 'Customer asked to cancel' })).toBeChecked();
  });

  it('locked options are disabled, announced as locked and never selectable', async () => {
    render(<Demo variant="card" />);
    const locked = screen.getByRole('radio', { name: /Use both printers/ });
    expect(locked).toBeDisabled();
    expect(screen.getByText('(locked)')).toBeInTheDocument();
    await userEvent.click(locked);
    expect(locked).not.toBeChecked();
  });

  it('describes the group with its error', () => {
    render(<RadioGroup legend="Reason" options={options} value={null} onChange={() => {}} error="Choose a reason" />);
    expect(screen.getByRole('group', { name: 'Reason' })).toHaveAccessibleDescription('Choose a reason');
  });
});
