export type SetupStepKey = 'details' | 'rates' | 'paper' | 'payments' | 'finish';
export const SETUP_STEPS: { key: SetupStepKey; label: string }[] = [
  { key: 'details', label: 'Owner & shop details' },
  { key: 'rates', label: 'Printing rates' },
  { key: 'paper', label: 'Paper' },
  { key: 'payments', label: 'Payments' },
  { key: 'finish', label: 'Finish' }
];

/** Section names the setup-status endpoint reports -> the step that fixes them. */
export const STEP_OF_SECTION = { profile: 'details', rates: 'rates', paper: 'paper', payments: 'payments' } as const;

export function StepIndicator({ current }: { current: SetupStepKey }) {
  const at = SETUP_STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="pb-muted" aria-label="Setup steps" data-testid="setup-steps" style={{ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: '0.25rem 0.75rem', padding: 0, margin: '0.5rem 0 0', fontSize: '0.875rem' }}>
      {SETUP_STEPS.map((s, i) => (
        <li key={s.key} aria-current={i === at ? 'step' : undefined} style={{ fontWeight: i === at ? 600 : 400 }}>
          {i + 1}. {s.label}
        </li>
      ))}
    </ol>
  );
}
