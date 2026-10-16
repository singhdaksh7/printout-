import { useRef, useState, type ReactNode } from 'react';
import {
  AppShell, Badge, Banner, BarChart, BottomNav, Button, Card, CardHeader, Checkbox, Chip, DataTable, Drawer, EmptyState, FileDeletedLine,
  HBarList, HeartbeatStrip, Icon, IconButton, JOB_STATUS, JobCode, JobStatusChip, KeyValueList, LoadMore, Modal, ORDER_STATUS_DISPLAY, OrderStatusChip,
  PRESENCE, PresenceChip, ProgressBar, RadioGroup, RetentionNotice, SHOP_STATUS, SegmentedBar, SegmentedControl, Select, ShopStatusChip, Sidebar,
  Skeleton, Spinner, StatTile, TextArea, TextField, Timeline, ToastRegion, TopBar, buttonClass, ICON_NAMES,
  type Column, type HeartbeatState, type JobStatusKind, type LegacyOrderStatus, type NavItem, type PresenceKind
} from '..';
import './showcase.css';

/**
 * Component showcase: every component, variant and state in one page. DEVELOPMENT ONLY: App.tsx mounts it under
 * `import.meta.env.DEV`, so it is not part of production bundles (asserted by src/ui/__tests__/showcase.test.tsx
 * and scripts in docs/UI_COMPONENT_SYSTEM.md). All data below is placeholder sample data, never live.
 */

const TOKENS: Array<[string, string, string]> = [
  ['--pb-navy', '#14213D', 'Text, structure, sidebar'], ['--pb-orange', '#E8772E', 'Primary button, brand tile'], ['--pb-orange-ink', '#B04E17', 'Orange text on light'],
  ['--pb-orange-soft', '#FCEBDD', 'Printing chip, highlights'], ['--pb-paper', '#FBFBF8', 'App background'],
  ['--pb-n50', '#F6F7F9', 'Dashboard canvas'], ['--pb-n100', '#EDEFF3', 'Disabled, segmented track'], ['--pb-n200', '#DADFE7', 'Card borders'],
  ['--pb-n300', '#B9C1CE', 'Input borders'], ['--pb-n500', '#6A7487', 'Secondary text'], ['--pb-n700', '#3B4558', 'Labels'],
  ['--pb-ok', '#1F7A4D', 'Printed, online, deleted'], ['--pb-warn', '#9A6200', 'Degraded, pilot ending'], ['--pb-err', '#B42318', 'Failed, offline, rejected'], ['--pb-info', '#2456C9', 'Queued, focus ring'],
  ['--pb-ok-soft', '#E3F3EA', 'DERIVED tint'], ['--pb-warn-soft', '#FDF3DF', 'DERIVED tint'], ['--pb-err-soft', '#FDE8E6', 'DERIVED tint'], ['--pb-info-soft', '#E5ECFB', 'DERIVED tint']
];

function Section({ id, title, note, children }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="sc-section">
      <h2 id={`${id}-h`} className="pb-h1">{title}</h2>
      {note && <p className="pb-muted sc-note">{note}</p>}
      {children}
    </section>
  );
}

function Demo({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="sc-demo">
      <h3 className="pb-label sc-demo__title">{title}</h3>
      <div className="sc-demo__body">{children}</div>
    </div>
  );
}

interface JobRow { id: string; code: string; file: string; received: string; pages: string; settings: string; status: JobStatusKind; progress?: number; deleted?: string }
const JOBS: JobRow[] = [
  { id: '1', code: '4823', file: 'Project_report.docx', received: '11:42', pages: '38 pg × 1', settings: 'B/W · Double-sided · A4', status: 'queued' },
  { id: '2', code: '4822', file: 'Aadhaar_front.jpg', received: '11:36', pages: '1 pg × 1', settings: 'Colour · Single-sided · A4', status: 'printing', progress: 60 },
  { id: '3', code: '4821', file: 'Marksheet_2026.pdf', received: '11:31', pages: '4 pg × 2', settings: 'B/W · Single-sided · A4', status: 'queued' },
  { id: '4', code: '4819', file: 'Notes_Unit3.pdf', received: '11:12', pages: '12 pg × 1', settings: 'B/W · Single-sided · A4', status: 'printed', deleted: '11:31:20' },
  { id: '5', code: '4817', file: 'Resume.pdf', received: '10:24', pages: '2 pg × 3', settings: 'B/W · Single-sided · A4', status: 'expired', deleted: '11:24:00' }
];

const jobColumns: Column<JobRow>[] = [
  { key: 'code', header: 'Code', cell: (r) => <JobCode code={r.code} /> },
  { key: 'file', header: 'File', cell: (r) => <><strong>{r.file}</strong><br /><span className="pb-caption">Received {r.received}</span></> },
  { key: 'pages', header: 'Pages × copies', cell: (r) => r.pages },
  { key: 'settings', header: 'Settings', cell: (r) => r.settings },
  {
    key: 'status', header: 'Status', cell: (r) => (
      <div className="sc-stack">
        <JobStatusChip kind={r.status} />
        {r.progress !== undefined && <ProgressBar value={r.progress} label={`Printing ${r.code}`} size="sm" />}
        {r.deleted && <FileDeletedLine time={r.deleted} />}
      </div>
    )
  },
  { key: 'act', header: 'Action', srOnlyHeader: true, align: 'end', cell: (r) => (r.status === 'queued' ? <Button size="sm" variant="dark">Print</Button> : <Button size="sm" variant="ghost">View</Button>) }
];

const NAV: NavItem[] = [
  { to: '/ui-showcase', label: 'Print queue', icon: 'list-ordered', end: true, count: 3 },
  { to: '/ui-showcase/history', label: 'History', icon: 'clock' },
  { to: '/ui-showcase/printers', label: 'Printers', icon: 'printer' },
  { to: '/ui-showcase/rates', label: 'Rate card', icon: 'indian-rupee' },
  { to: '/ui-showcase/staff', label: 'Staff', icon: 'users', tag: 'Pro', comingSoon: true },
  { to: '/ui-showcase/billing', label: 'Billing', icon: 'credit-card', alert: 'Due' }
];

const HOURS = [['09', 1], ['10', 3], ['11', 5], ['12', 4], ['1', 2], ['2', 3], ['3', 6], ['4', 7], ['5', 4], ['6', 3], ['7', 2], ['8', 1]] as const;
const HEART: HeartbeatState[] = [...Array<HeartbeatState>(26).fill('online'), 'degraded', ...Array<HeartbeatState>(10).fill('online'), ...Array<HeartbeatState>(6).fill('off-hours'), ...Array<HeartbeatState>(4).fill('offline')];

export default function ComponentShowcase() {
  const [seg, setSeg] = useState('active');
  const [days, setDays] = useState('today');
  const [reason, setReason] = useState<string | null>('asked');
  const [printer, setPrinter] = useState<string | null>('epson');
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'default' | 'danger'>(null);
  const [drawer, setDrawer] = useState(false);
  const [selected, setSelected] = useState<string | null>('3');
  const [loading, setLoading] = useState(false);
  const [checkAll, setCheckAll] = useState(false);
  const drawerBtn = useRef<HTMLButtonElement>(null);

  return (
    <div className="pb-theme sc">
      <header className="sc-header">
        <p className="pb-caption">Development only · sample data · docs/UI_COMPONENT_SYSTEM.md</p>
        <h1 className="pb-display">PrintoutBuddy component showcase</h1>
        <nav aria-label="Showcase sections" className="sc-toc">
          {['tokens', 'actions', 'inputs', 'status', 'feedback', 'containers', 'overlays', 'data', 'navigation', 'charts', 'icons'].map((s) => <a key={s} href={`#${s}`} className={buttonClass({ variant: 'ghost', size: 'sm' })}>{s}</a>)}
        </nav>
      </header>

      <main className="sc-main">
        <Section id="tokens" title="Tokens and type" note="Source: docs/design/1.pdf p2. Derived tints are contrast-checked in src/ui/__tests__/foundations.test.tsx.">
          <div className="sc-swatches">
            {TOKENS.map(([n, hex, use]) => (
              <div key={n} className="sc-swatch">
                <span className="sc-swatch__chip" style={{ background: `var(${n})` }} />
                <span className="pb-mono">{n}</span><span className="pb-mono pb-muted">{hex}</span><span className="pb-caption">{use}</span>
              </div>
            ))}
          </div>
          <Card>
            <p className="pb-caption">display / 32 Rubik 700</p><p className="pb-display">4821</p>
            <p className="pb-caption">h1 / 24 Rubik 600</p><p className="pb-h1">Print queue</p>
            <p className="pb-caption">h2 / 18 Rubik 600</p><p className="pb-h2">Choose print settings</p>
            <p className="pb-caption">body / 15 DM Sans 400</p><p className="pb-body">Only Sharma Xerox can see your file. It is deleted after printing.</p>
            <p className="pb-caption">label / 13 DM Sans 600</p><p className="pb-label">Copies</p>
            <p className="pb-caption">caption / 12 DM Sans 400</p><p className="pb-caption">Auto-deletes in 58 min</p>
            <p className="pb-caption">mono / 13 JetBrains Mono 500</p><p className="pb-mono">job_8Fq2 · sha256 3f9a…c21e</p>
            <p className="pb-caption">hindi / system Devanagari, line-height 1.6</p><p lang="hi" className="pb-body">सिर्फ शर्मा ज़ेरॉक्स आपकी फ़ाइल देख सकता है।</p>
          </Card>
        </Section>

        <Section id="actions" title="Actions" note="One orange button per screen. Loading keeps width; disabled has an explanation nearby.">
          <Demo title="Variants × sizes">
            {(['primary', 'dark', 'outline', 'ghost', 'danger'] as const).map((v) => (
              <div key={v} className="sc-row">
                {(['sm', 'md', 'lg'] as const).map((s) => <Button key={s} variant={v} size={s}>{v} {s}</Button>)}
              </div>
            ))}
          </Demo>
          <Demo title="States">
            <div className="sc-row">
              <Button variant="primary">Default</Button>
              <Button variant="primary" disabled>Disabled</Button>
              <Button variant="primary" loading>Saving</Button>
              <Button variant="danger" loading>Cancelling</Button>
              <Button variant="primary" loading={loading} onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1500); }}>Click to load</Button>
            </div>
            <div className="sc-row">
              <Button iconStart="printer" variant="dark">Print</Button>
              <Button iconEnd="chevron-right" variant="outline">Continue</Button>
              <a href="#actions" className={buttonClass({ variant: 'outline' })}>Link styled as button</a>
            </div>
            <Button variant="primary" fullWidth size="lg">Full width · Print on Epson L3250</Button>
            <p className="pb-caption">Print is off while COUNTER-PC is offline. You can still cancel.</p>
          </Demo>
          <Demo title="IconButton">
            <div className="sc-row">
              <IconButton icon="x" label="Close" />
              <IconButton icon="refresh-cw" label="Refresh" variant="outline" />
              <IconButton icon="x" label="Small close" size="sm" />
              <IconButton icon="search" label="Search (disabled)" disabled />
            </div>
          </Demo>
          <Demo title="SegmentedControl">
            <div className="sc-row">
              <SegmentedControl label="Queue filter" value={seg} onChange={setSeg} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All today' }]} size="sm" />
              <SegmentedControl label="Range" value={days} onChange={setDays} options={[{ value: 'today', label: 'Today' }, { value: 'yesterday', label: 'Yesterday' }, { value: '7', label: 'Last 7 days' }]} />
              <SegmentedControl label="Status filter" value="all" onChange={() => {}} options={[{ value: 'all', label: 'All', count: 6 }, { value: 'pilot', label: 'pilot', count: 1 }, { value: 'active', label: 'active', count: 3 }, { value: 'x', label: 'cancelled', count: 0, disabled: true }]} />
            </div>
          </Demo>
        </Section>

        <Section id="inputs" title="Inputs and selections">
          <div className="sc-grid">
            <Demo title="TextField states">
              <TextField label="Pages" placeholder="e.g. 1-4, 7" helperText="Example: 1-4, 7" />
              <TextField label="Pages (invalid)" defaultValue="5-60" error="This file has 38 pages. Enter pages between 1 and 38." />
              <TextField label="Price per page" startAdornment="₹" defaultValue="2.00" inputMode="decimal" />
              <TextField label="Shop ID" mono defaultValue="shp_7Q2K" readOnly />
              <TextField label="Disabled" defaultValue="Locked" disabled />
              <TextField label="Compact" density="compact" defaultValue="Compact density" />
              <TextField label="Search jobs" hideLabel type="search" startAdornment={<Icon name="search" size={18} />} placeholder="Code or file name" />
              <TextField label="Required" required helperText="Required field" />
            </Demo>
            <Demo title="TextArea, Select, Checkbox">
              <TextArea label="Reason (saved to audit log)" helperText="At least 10 characters." />
              <TextArea label="Notes" error="Add at least 10 characters." defaultValue="Short" />
              <Select label="Printer" defaultValue="epson" helperText="Epson L3250 can print this B/W job."><option value="epson">Epson L3250 (ready)</option><option value="hp">HP LaserJet M1136 (paper out)</option></Select>
              <Select label="City" error="Choose a city"><option value="">All cities</option><option>Delhi</option></Select>
              <Checkbox label="Sound on" hint="Plays when a new job arrives" defaultChecked />
              <Checkbox label="Select all agents" indeterminate checked={checkAll} onChange={(e) => setCheckAll(e.target.checked)} />
              <Checkbox label="Disabled option" disabled />
            </Demo>
            <Demo title="RadioGroup · list (cancel reasons)">
              <RadioGroup legend="Reason" value={reason} onChange={setReason} options={[
                { value: 'asked', label: 'Customer asked to cancel' }, { value: 'wrong', label: 'Wrong or unclear file' }, { value: 'dup', label: 'Duplicate job' }, { value: 'other', label: 'Other' }
              ]} />
            </Demo>
            <Demo title="RadioGroup · card (printer choice, locked option)">
              <RadioGroup legend="Printer for PrintoutBuddy jobs" variant="card" value={printer} onChange={setPrinter} options={[
                { value: 'epson', label: 'Epson L3250', description: 'Colour and B/W · ink tank · A4', tag: <PresenceChip kind="ready" /> },
                { value: 'hp', label: 'HP LaserJet M1136', description: 'B/W only · laser · A4', tag: <PresenceChip kind="ready" /> },
                { value: 'both', label: 'Use both printers', description: 'Send B/W to the laser and colour to the Epson. Available on Pro.', tag: <Badge>Pro</Badge>, locked: true }
              ]} />
            </Demo>
          </div>
        </Section>

        <Section id="status" title="Status, chips, badges and progress">
          <Demo title="Job status chips (design vocabulary)">
            <div className="sc-row">{(Object.keys(JOB_STATUS) as JobStatusKind[]).map((k) => <JobStatusChip key={k} kind={k} />)}</div>
            <div className="sc-row">{(Object.keys(JOB_STATUS) as JobStatusKind[]).slice(0, 3).map((k) => <JobStatusChip key={k} kind={k} size="sm" />)}<span className="pb-caption">size sm</span></div>
          </Demo>
          <Demo title="Order status chips (current API values, existing wording)">
            <div className="sc-row">{(Object.keys(ORDER_STATUS_DISPLAY) as LegacyOrderStatus[]).map((k) => <OrderStatusChip key={k} status={k} />)}</div>
          </Demo>
          <Demo title="Shop / subscription and device presence">
            <div className="sc-row">{Object.keys(SHOP_STATUS).map((k) => <ShopStatusChip key={k} status={k} />)}</div>
            <div className="sc-row">{(Object.keys(PRESENCE) as PresenceKind[]).map((k) => <PresenceChip key={k} kind={k} />)}</div>
          </Demo>
          <Demo title="Chip tones and Retention">
            <div className="sc-row">{(['neutral', 'info', 'orange', 'ok', 'warn', 'err'] as const).map((t) => <Chip key={t} tone={t}>{t}</Chip>)}<Chip dot={false}>no dot</Chip></div>
            <div className="sc-row"><RetentionNotice at={new Date(2026, 9, 14, 12, 42)} /><RetentionNotice at={null} /><span className="pb-caption">(nothing renders without a server deadline)</span></div>
          </Demo>
          <Demo title="Badges">
            <div className="sc-row"><Badge tone="orange">3</Badge><Badge tone="err">Due</Badge><Badge>Pro</Badge><Badge tone="warn" caps>Sample</Badge><span className="sc-dark"><Badge onDark>Pro</Badge></span></div>
          </Demo>
          <Demo title="Progress and spinners">
            <ProgressBar value={60} label="Printing 4822" />
            <ProgressBar value={35} label="Pilot day 9 of 14" size="sm" />
            <ProgressBar value={80} label="Warning level" tone="warn" />
            <div className="sc-row"><Spinner /><Spinner size={28} label="Waiting for COUNTER-PC" /></div>
          </Demo>
        </Section>

        <Section id="feedback" title="Feedback">
          <Demo title="Banners (box)">
            <Banner tone="info" title="Printer is offline">You can still send. It prints when the shop is back online.</Banner>
            <Banner tone="ok" title="File deleted">Deleted at 4:12 pm after printing. Receipt DR-20261014-0193.</Banner>
            <Banner tone="warn" title="Pilot ends in 5 days">Choose a plan to keep your queue running.</Banner>
            <Banner tone="err" title="Upload failed">Your internet dropped at 62%. Tap Retry to continue from where it stopped.</Banner>
            <Banner tone="err" icon="monitor" title="Print agent is offline since 11:43 · printing paused" steps={['Check COUNTER-PC is switched on and not asleep.', 'Check the PC has internet.']} actions={<><Button size="sm" variant="dark" iconStart="refresh-cw">Check again</Button><span className="pb-caption">Last checked 11:47:10</span></>}>
              New jobs still arrive and wait here.
            </Banner>
            <Banner tone="info" onDismiss={() => {}}>Dismissible banner without a title.</Banner>
          </Demo>
          <Demo title="Banner (bar, sticky notices)">
            <Banner tone="err" layout="bar" title="Payment of ₹149 failed on 14 Oct." actions={<Button size="sm" variant="dark">Retry payment</Button>}>Printing continues until 21 Oct.</Banner>
          </Demo>
          <Demo title="Toast">
            <Button variant="outline" onClick={() => { setToast('New job 4823 · Project_report.docx'); setTimeout(() => setToast(null), 3500); }}>Show toast</Button>
          </Demo>
          <Demo title="Skeleton">
            <Skeleton label="Loading jobs" lines={4} />
            <div className="sc-row"><Skeleton variant="block" width={120} height={32} /><Skeleton variant="block" width={64} height={28} /></div>
          </Demo>
          <Demo title="EmptyState">
            <Card padding="none"><EmptyState icon="printer" title="No jobs waiting" callout={<Banner tone="warn" icon="qr-code" title="Is the QR standee on the counter?" actions={<Button size="sm" variant="outline">Print standee</Button>}>Customers scan pb.link/sharma-xerox.</Banner>}>New jobs appear here with a sound when a customer taps Send to shop.</EmptyState></Card>
            <Card padding="none"><EmptyState icon="search" title="No shops match “Kota”" action={<><Button variant="outline">Clear search</Button><Button variant="primary">Onboard a shop in Kota</Button></>}>Search covers shop name, city, shop ID and owner phone.</EmptyState></Card>
          </Demo>
        </Section>

        <Section id="containers" title="Cards, stats, key-values and timeline">
          <div className="sc-stats">
            <StatTile label="Jobs waiting" value="3" />
            <StatTile label="Printed today" value="27" />
            <StatTile label="Jobs today" value="173" hint="158 last Wednesday" tag="Sample" />
            <StatTile label="Agents offline > 15 min" value="2" hint="1 in a suspended shop" tag="Sample" accent="warn" />
            <StatTile label="Deletion SLA met" value="99.4%" hint="180 of 181 receipts" tag="Sample" accent="err" />
            <StatTile label="Pages today" value="312" loading />
          </div>
          <div className="sc-grid">
            <Card as="section" aria-labelledby="kv-h"><CardHeader id="kv-h" title="Job details" meta="Page 1 preview only" />
              <KeyValueList items={[{ label: 'Copies', value: '1' }, { label: 'Colour', value: 'B/W' }, { label: 'Pages', value: 'All pages (38)' }, { label: 'Printer', value: 'Epson L3250' }, { label: 'Agent ID', value: 'agt_B4L7', mono: true }]} />
            </Card>
            <Card as="section" aria-labelledby="tl-h"><CardHeader id="tl-h" title="Timeline" meta="Newest first" />
              <Timeline items={[{ time: '18:41', children: 'Job 4823 queued (DOCX → PDF, 38 pages)' }, { time: '14 Oct', tone: 'ok', children: 'Payment 299 received' }, { time: '17:53', tone: 'err', children: 'Last heartbeat. Network dropped.' }]} />
            </Card>
          </div>
        </Section>

        <Section id="overlays" title="Overlays">
          <div className="sc-row">
            <Button variant="outline" onClick={() => setModal('default')}>Open modal</Button>
            <Button variant="danger" onClick={() => setModal('danger')}>Open danger modal</Button>
            <Button ref={drawerBtn} variant="dark" onClick={() => setDrawer(true)}>Open drawer</Button>
          </div>
          {modal && (
            <Modal title={modal === 'danger' ? 'Suspend Sharma Xerox & Cyber?' : 'Job 4821 was already printed'} tone={modal} onClose={() => setModal(null)}
              footer={<><Button variant="outline" onClick={() => setModal(null)}>{modal === 'danger' ? 'Cancel' : 'See in History'}</Button><Button variant={modal === 'danger' ? 'danger' : 'primary'} onClick={() => setModal(null)}>{modal === 'danger' ? 'Suspend shop' : 'Back to queue'}</Button></>}>
              {modal === 'danger'
                ? <><Banner tone="err" icon={false} title="Customers can no longer send files to this shop.">The agent stops pulling jobs.</Banner><TextField label="Type the shop ID shp_7Q2K to confirm" mono /></>
                : <><p>Pooja printed it from another screen at <strong>11:44:05</strong>. The file was deleted at 11:44:09, so it cannot be printed again here.</p><Banner tone="info">Hand the pages to the customer with code 4821.</Banner></>}
            </Modal>
          )}
          {drawer && (
            <Drawer title="Job 4823" header={<div className="sc-row"><div><p className="pb-caption">Job code</p><JobCode code="4823" size="display" /></div><JobStatusChip kind="queued" /></div>} onClose={() => setDrawer(false)}
              footer={<><Button variant="primary">Print</Button><Button variant="outline">Cancel job</Button></>}>
              <div className="sc-row"><RetentionNotice at={new Date(2026, 9, 14, 12, 42)} /></div>
              <KeyValueList items={[{ label: 'Copies', value: '1' }, { label: 'Colour', value: 'B/W' }, { label: 'Sides', value: 'Double-sided' }, { label: 'Estimate', value: '₹57 from your rate card' }]} />
            </Drawer>
          )}
        </Section>

        <Section id="data" title="Data display">
          <Demo title="DataTable (selected row, new row highlight)">
            <DataTable caption="Print queue (sample)" columns={jobColumns} rows={JOBS} getRowKey={(r) => r.id} selectedKey={selected} highlightKeys={['1']} onRowClick={(r) => setSelected(r.id)} renderCard={(r) => (
              <div className="sc-stack"><div className="sc-row"><JobCode code={r.code} /><JobStatusChip kind={r.status} /></div><strong>{r.file}</strong><span className="pb-caption">{r.pages} · {r.settings}</span></div>
            )} />
          </Demo>
          <Demo title="Loading and empty"><DataTable caption="Loading queue" columns={jobColumns} rows={[]} getRowKey={(r) => r.id} loading loadingRows={3} /><DataTable caption="Empty queue" columns={jobColumns} rows={[]} getRowKey={(r) => r.id} empty={<EmptyState icon="printer" title="No jobs waiting">New files appear here the moment a customer sends them.</EmptyState>} /></Demo>
          <Demo title="LoadMore"><LoadMore hasMore summary="Showing 9 of 173 · page 1 of 20" onClick={() => {}} /><LoadMore hasMore={false} onClick={() => {}} /></Demo>
        </Section>

        <Section id="navigation" title="Navigation and shell" note="Framed here; in the app the sidebar is sticky and full height, BottomNav appears below 768px.">
            <div className="sc-frame">
              <AppShell
                sidebar={<Sidebar label="Showcase sections (demo)" brand={<strong>PrintoutBuddy</strong>} items={NAV} footer={<><strong>Pilot · day 9 of 14</strong><ProgressBar value={64} label="Pilot progress" size="sm" onDark /><p>5 days left · Choose a plan</p></>} />}
                topbar={<TopBar start={<><strong>Sharma Xerox &amp; Cyber</strong><br /><span className="pb-caption">Laxmi Nagar, Delhi</span></>} end={<><PresenceChip kind="online" label="COUNTER-PC online" /><Checkbox label="Sound on" defaultChecked /></>} />}
                bottomNav={<div className="sc-bottomnav-demo"><BottomNav label="Phone tabs (demo)" items={NAV.slice(0, 3).map((n) => ({ ...n, comingSoon: false }))} /></div>}
              >
                <h3 className="pb-h1">Print queue</h3>
                <p className="pb-muted">Shell content area (max 1200px).</p>
              </AppShell>
            </div>
        </Section>

        <Section id="charts" title="Charts" note="Hand-built SVG/CSS. Each has a text alternative (hidden table, list text or summary).">
          <div className="sc-grid">
            <Card><CardHeader title="Busy hours" meta="Avg jobs per hour · Sample" />
              <BarChart title="Busy hours" summary="Busiest at 4 pm with 7 jobs" valueName="Jobs" data={HOURS.map(([label, value]) => ({ label, value, ...(value === 7 ? { tone: 'highlight' as const } : {}) }))} yMax={8} yTicks={[0, 2, 4, 6, 8]} />
            </Card>
            <Card><CardHeader title="Jobs per hour, today" meta="Sample" />
              <BarChart title="Jobs per hour, today" valueName="Jobs" yAxisLabel="Jobs per hour" data={[['08', 3], ['09', 9], ['10', 18], ['11', 22], ['12', 19], ['13', 14], ['14', 16], ['15', 21], ['16', 24], ['17', 20]].map(([label, value]) => ({ label: String(label), value: Number(value) })).concat([{ label: '18', value: 7 }]).map((d, i, a) => (i === a.length - 1 ? { ...d, tone: 'muted' as const } : d))} yMax={30} yTicks={[0, 10, 20, 30]} />
            </Card>
            <Card><CardHeader title="Pages per day" meta="Last 7 days · Sample" />
              <HBarList label="Pages per day" max={400} items={[{ label: 'Wed', value: 268 }, { label: 'Thu', value: 301 }, { label: 'Fri', value: 245 }, { label: 'Sat', value: 330 }, { label: 'Sun', value: 120 }, { label: 'Mon', value: 290 }, { label: 'Tue', value: 312 }]} />
            </Card>
            <Card><CardHeader title="Heartbeat, last 24 hours" meta="Each block = 15 min · Sample" />
              <HeartbeatStrip blocks={HEART} summary="Online most of the day, one degraded block, offline for the last hour" axis={['18:45', '06:45', '18:45']} />
            </Card>
            <Card><CardHeader title="Version distribution" meta="Sample" />
              <SegmentedBar summary="3 of 6 agents on latest v1.4.2" caption="Share of 6 agents · 3 of 6 (50%) on latest v1.4.2" segments={[{ label: 'v1.4.2', value: 3, tone: 'ok' }, { label: 'v1.4.1', value: 1, tone: 'warn' }, { label: 'v1.4.0', value: 1, tone: 'warn' }, { label: 'v1.3.9', value: 1, tone: 'err' }]} />
            </Card>
          </div>
        </Section>

        <Section id="icons" title="Icons" note="Lucide (ISC). Only these icons are vendored; add one by regenerating nodes.ts.">
          <div className="sc-icons">{ICON_NAMES.map((n) => <span key={n} className="sc-icon"><Icon name={n} size={22} /><span className="pb-caption pb-mono">{n}</span></span>)}</div>
        </Section>
      </main>
      <ToastRegion message={toast} />
    </div>
  );
}
