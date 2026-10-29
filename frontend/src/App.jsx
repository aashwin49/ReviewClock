import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, ChevronDown, Clock3, FileText, GitPullRequest, LayoutDashboard, List, Menu, Moon, Plus, Search, Settings, ShieldCheck, Sun, X } from 'lucide-react';
import { api, mockDeliveries, mockPRs } from '../lib/dashboardApi.js';

const STATES = ['draft', 'awaiting_review', 'changes_requested', 'approved', 'merged'];
const LABELS = { draft: 'Draft', awaiting_review: 'Awaiting review', changes_requested: 'Changes requested', approved: 'Approved', merged: 'Done' };
const EVENT_LABELS = { opened: 'Opened PR', ready_for_review: 'Marked ready for review', review_requested: 'Review requested', review_submitted: 'Review submitted', review_dismissed: 'Review dismissed', approved: 'Approved', changes_requested: 'Requested changes', synchronize: 'New commits pushed', closed: 'Closed', merged: 'Merged' };
const MOCK = window.REVIEWCLOCK_MOCK === true || new URLSearchParams(location.search).get('mock') === '1';
const login = 'aashwin49';
const WAIT_HINT_MS = 60000;
const glyph = { clock: Clock3, grid: LayoutDashboard, list: List, settings: Settings, doc: BookOpen, search: Search, moon: Moon, sun: Sun, plus: Plus, shield: ShieldCheck, menu: Menu, close: X, pr: GitPullRequest, file: FileText, chevron: ChevronDown };
function Icon({ name, size = 16, ...props }) { const Component = glyph[name] || FileText; return <Component size={size} strokeWidth={1.8} aria-hidden="true" {...props} />; }
const initial = name => (name || '?').split(/[\s.-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();
const age = date => date ? Math.max(0, (Date.now() - new Date(date).getTime()) / 3600000) : 0;
const esc = value => String(value ?? '');
const getRoute = () => location.pathname.replace(/\/$/, '') || '/dashboard';

function useRoute() {
  const [route, setRoute] = useState(getRoute);
  useEffect(() => { const change = () => setRoute(getRoute()); addEventListener('popstate', change); return () => removeEventListener('popstate', change); }, []);
  const navigate = useCallback(path => { history.pushState({ reviewClockRoute: true }, '', path); setRoute(path); }, []);
  const back = useCallback(() => { if (history.state?.reviewClockRoute) history.back(); else { history.pushState({ reviewClockRoute: true }, '', '/dashboard'); setRoute('/dashboard'); } }, []);
  return [route, navigate, back];
}

function Avatar({ name, tiny = false }) { return <span className={`avatar${tiny ? ' tiny' : ''}`}>{initial(name)}</span>; }
function Button({ children, primary = false, small = false, ...props }) { return <button className={`button${primary ? ' primary' : ''}${small ? ' small' : ''}`} {...props}>{children}</button>; }
function StatusChip({ children, status = '' }) { return <span className={`chip ${status}`}>{children}</span>; }

function AgeChip({ pr }) {
  if (pr.state === 'approved') return <StatusChip status="green">Approved</StatusChip>;
  if (pr.state === 'merged') return <StatusChip status="blue">Done</StatusChip>;
  const elapsed = Math.floor(age(pr.waitingSince));
  if (pr.stalled) return <StatusChip status="orange">{elapsed}h · Stalled</StatusChip>;
  if (elapsed < 8) return <StatusChip status="green">{elapsed}h · Fresh</StatusChip>;
  if (elapsed < 24) return <StatusChip status="amber">{elapsed}h · Aging</StatusChip>;
  return <StatusChip status="rose">{elapsed}h waiting</StatusChip>;
}

function durationLabel(start, end) {
  if (!start || !end) return null;
  const totalMinutes = Math.max(0, Math.floor((new Date(end).getTime() - new Date(start).getTime()) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`].filter(Boolean).join(' ');
}

function PRCard({ pr, navigate }) {
  const author = pr.author?.login || 'Unknown author';
  const waiting = pr.state === 'changes_requested' ? 'Waiting on author' : pr.waitingOn ? `Waiting on @${pr.waitingOn}` : pr.state === 'draft' ? 'Draft' : 'Waiting on reviewer';
  return <a className={`pr-card${pr.stalled ? ' stalled' : ''}`} href={`/dashboard/prs/${pr.number}`} onClick={event => { event.preventDefault(); window.reviewClockOrigin = event.currentTarget; navigate(`/dashboard/prs/${pr.number}`); }}>
    <div className="card-top"><span className="pr-number">#{pr.number}</span><AgeChip pr={pr} /></div>
    <h3>{esc(pr.title)}</h3>{pr.summary && <p className="pr-summary">{esc(pr.summary)}</p>}
    <div className="card-footer"><span className="author"><Avatar name={author} tiny />{author}</span><span className="waiting">{waiting}</span></div>
    {pr.state === 'merged' && pr.firstReviewAt && <div className="first-review">First review in <b>{durationLabel(pr.readyAt || pr.createdAt, pr.firstReviewAt) || '—'}</b></div>}
  </a>;
}

function Sidebar({ active, deliveries, navigate, mobile = false }) {
  const processed = deliveries.filter(row => row.status === 'processed').length;
  const failed = deliveries.filter(row => row.status === 'failed').length;
  const health = deliveries.length ? `${Math.round(processed / deliveries.length * 100)}% processed, ${failed} failed` : 'Waiting for delivery data';
  return <aside className={`sidebar${mobile ? ' mobile-open' : ''}`}>
    <a className="brand" href="/dashboard" onClick={event => { event.preventDefault(); navigate('/dashboard'); }}><span className="brand-mark"><Icon name="clock" size={19} /></span><span>ReviewClock</span><span className="chev"><Icon name="chevron" size={14} /></span></a>
    <div className="side-label">Section</div><nav aria-label="Primary navigation">
      <a className={`nav-link${active === 'board' ? ' selected' : ''}`} href="/dashboard" onClick={event => { event.preventDefault(); navigate('/dashboard'); }}><span><Icon name="grid" /></span>Live Board</a>
      <a className={`nav-link${active === 'deliveries' ? ' selected' : ''}`} href="/dashboard/deliveries" onClick={event => { event.preventDefault(); navigate('/dashboard/deliveries'); }}><span><Icon name="list" /></span>Deliveries Log</a>
      <button className="nav-link disabled" aria-disabled="true"><span><Icon name="settings" /></span>Team Settings</button>
    </nav><div className="side-label help-label">Help</div><button className="nav-link disabled" aria-disabled="true"><span><Icon name="doc" /></span>Documentation / API</button>
    <section className="health-card"><div className="health-icon"><Icon name="shield" size={22} /></div><strong>Webhook health</strong><span>{health}</span><button className="health-button" onClick={() => navigate('/dashboard/deliveries')}>View deliveries</button></section>
  </aside>;
}

function ThemeSwitch() {
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('reviewclock-theme');
    return saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  });
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <button className="icon-button" aria-label="Switch theme" onClick={() => setTheme(value => { const next = value === 'dark' ? 'light' : 'dark'; localStorage.setItem('reviewclock-theme', next); return next; })}><Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} /></button>;
}

function TopBar({ navigate, search, setSearch, repoName, liveStatus }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return <header className="topbar"><button className="icon-button mobile-menu" aria-label="Open navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(v => !v)}><Icon name="menu" size={16} /></button>
    <div className="mobile-brand"><span className="brand-mark"><Icon name="clock" size={18} /></span><b>ReviewClock</b></div>
    <div className="identity"><Avatar name="A"/><span><b>{login}</b><small>{repoName || 'No repository connected'}</small></span><span className="chev">⌄</span></div>
    <label className="search"><span><Icon name="search" size={16} /></span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search PRs, authors, delivery IDs…" aria-label="Search pull requests, authors, delivery IDs" /></label>
    <div className={`connection ${liveStatus}`} aria-live="polite"><i></i><b>{liveStatus === 'live' ? 'Live' : liveStatus === 'reconnecting' ? 'Reconnecting' : 'Offline'}</b><span>{liveStatus === 'live' ? 'Updates enabled' : 'Waiting for connection'}</span></div><ThemeSwitch /><span className="user-avatar">A</span>
    {menuOpen && <div className="mobile-nav"><Sidebar active={getRoute() === '/dashboard/deliveries' ? 'deliveries' : 'board'} deliveries={[]} navigate={path => { setMenuOpen(false); navigate(path); }} /></div>}
  </header>;
}

function AppShell({ children, active, deliveries, navigate, search, setSearch, repoName, liveStatus }) {
  return <div className="ambient"><div className="frame"><Sidebar active={active} deliveries={deliveries} navigate={navigate} /><div className="workspace"><TopBar navigate={navigate} search={search} setSearch={setSearch} repoName={repoName} liveStatus={liveStatus} /><main className="main">{children}</main></div></div></div>;
}

function PageHeader({ kicker, title, summary, action }) { return <div className="page-header"><div><div className="eyebrow">{kicker}</div><h1>{title}</h1><p className="subtitle">{summary}</p></div>{action}</div>; }
function SkeletonBoard() { return <div className="board-scroll"><div className="board-columns">{STATES.map(state => <section className="column" key={state}><header className="column-heading"><span className={`dot dot-${state}`} /><b>{LABELS[state]}</b><span className="count">—</span></header><div className="skeleton"/><div className="skeleton"/></section>)}</div></div>; }

function Board({ prs, loading, error, onRetry, view, setView, navigate, search, sources, selectedSourceId, onSelectSource, onThresholdChange }) {
  const selectedSource = sources.find(source => source.id === selectedSourceId);
  const [threshold, setThreshold] = useState(selectedSource?.stalledThresholdMinutes || 1440);
  useEffect(() => setThreshold(selectedSource?.stalledThresholdMinutes || 1440), [selectedSourceId, selectedSource?.stalledThresholdMinutes]);
  const filtered = (view === 'mine' ? prs.filter(pr => pr.author?.login?.toLowerCase().includes(login.toLowerCase()) || pr.waitingOn === login) : prs).filter(pr => !search || `${pr.number} ${pr.title} ${pr.summary} ${pr.author?.login} ${pr.waitingOn || ''}`.toLowerCase().includes(search.toLowerCase()));
  const open = filtered.filter(pr => pr.state !== 'merged').length;
  const awaiting = filtered.filter(pr => pr.state === 'awaiting_review');
  const average = awaiting.length ? awaiting.reduce((sum, pr) => sum + age(pr.waitingSince), 0) / awaiting.length : 0;
  const summary = `${open} Open PRs · Avg. time to review ${Math.floor(average)}h ${Math.round((average % 1) * 60)}m · ${filtered.filter(pr => pr.stalled).length} Stalled`;
  return <>
    <PageHeader kicker="Live board" title="Pull Requests" summary={summary} action={<Button primary onClick={() => navigate('/dashboard/connect')}><Icon name="plus" /> Connect Repository</Button>} />
    {sources.length > 0 && <div className="threshold-settings"><label htmlFor="threshold-source">Stalled after</label><select id="threshold-source" value={selectedSourceId || sources[0].id} onChange={event => onSelectSource(event.target.value)}>{sources.map(source => <option key={source.id} value={source.id}>{source.repo}</option>)}</select><input aria-label="Stalled threshold in minutes" type="number" min="1" max="43200" value={threshold} onChange={event => setThreshold(event.target.value)} onBlur={() => onThresholdChange(selectedSourceId || sources[0].id, Number(threshold))} /><span>minutes</span></div>}
    <div className="board-toolbar"><div className="segmented"><button className={view === 'mine' ? 'active' : ''} onClick={() => setView('mine')}>My PRs</button><button className={view === 'waiting' ? 'active' : ''} onClick={() => setView('waiting')}>Waiting on me</button></div><span className="data-note">{filtered.length} pull requests</span></div>
    {loading ? <SkeletonBoard /> : error ? <div className="empty"><h2>Could not load the board</h2><p>{error}</p><Button onClick={onRetry}>Retry</Button></div> : !prs.length ? <div className="empty"><span className="empty-icon"><Icon name="pr" size={28} /></span><h2>No pull requests yet</h2><p>Connect a GitHub repository to see review activity here.</p><Button primary onClick={() => navigate('/dashboard/connect')}><Icon name="plus" /> Connect Repository</Button></div> : !filtered.length ? <div className="empty"><h2>No matching pull requests</h2><p>Try a different search or board view.</p></div> : <div className="board-scroll" tabIndex="0" aria-label="Pull request workflow board"><div className="board-columns">{STATES.map(state => <BoardColumn key={state} state={state} prs={filtered.filter(pr => pr.state === state)} navigate={navigate} />)}</div></div>}
  </>;
}

function BoardColumn({ state, prs, navigate }) {
  const [expanded, setExpanded] = useState(false);
  return <section className={`column${expanded ? ' expanded' : ''}`}><button className="column-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span className={`dot dot-${state}`} /><b>{LABELS[state]}</b><span className="count">{prs.length}</span></button><div className="cards">{prs.map(pr => <PRCard key={pr.number} pr={pr} navigate={navigate} />)}</div></section>;
}

function AuthDialog({ onClose, onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.authenticate(mode, email.trim(), password); onAuthenticated(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div className="drawer-backdrop auth-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="panel auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-heading"><div className="eyebrow">ReviewClock account</div><h2 id="auth-heading">{mode === 'login' ? 'Sign in' : 'Create your account'}</h2><p className="subtle">Sign in to connect repositories and load your dashboard data.</p><form onSubmit={submit}><label htmlFor="auth-email">Email</label><input id="auth-email" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'register' ? 12 : undefined} required value={password} onChange={event => setPassword(event.target.value)} /><span className="form-error" role="alert">{error}</span><Button primary disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</Button></form><button className="auth-mode" onClick={() => { setMode(value => value === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'New to ReviewClock? Create an account' : 'Already registered? Sign in'}</button></section></div>;
}

function ConnectPage({ source, setSource, setRepoName, onBoardOpen, onUnauthorized, authEpoch, navigate }) {

  const [repo, setRepo] = useState(''); const [error, setError] = useState(''); const [submitting, setSubmitting] = useState(false); const [revealed, setRevealed] = useState(false); const [copied, setCopied] = useState(''); const [showWaitingHint, setShowWaitingHint] = useState(false);
  useEffect(() => {
    if (!source?.id || source.status === 'connected') return;
    const timer = setInterval(async () => { try { const updated = await api.source(source.id); setSource(current => ({ ...current, ...updated, webhookUrl: current?.webhookUrl, secret: current?.secret })); } catch {} }, 4000);
    const hintTimer = setTimeout(() => setShowWaitingHint(true), WAIT_HINT_MS);
    return () => { clearInterval(timer); clearTimeout(hintTimer); setShowWaitingHint(false); };
  }, [source?.id, source?.status, setSource]);
  const [pendingRepo, setPendingRepo] = useState('');
  const connectRepo = async value => {
    setSubmitting(true); setError('');
    try { const connected = await api.connect(value); setRepoName(connected.repo); setSource({ ...connected, revealed: false }); setPendingRepo(''); }
    catch (e) { if (e.status === 401) { setPendingRepo(value); setError('Sign in to connect this repository.'); onUnauthorized(); } else setError(e.status === 409 ? 'This repository is already connected.' : e.message); }
    finally { setSubmitting(false); }
  };
  useEffect(() => { if (authEpoch > 0 && pendingRepo && !source) connectRepo(pendingRepo); }, [authEpoch]);
  const submit = async event => {
    event.preventDefault(); setError('');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.trim())) { setError('Use the format owner/repository.'); return; }
    await connectRepo(repo.trim());
  };
  const copy = async (key, value) => { try { await navigator.clipboard.writeText(value); setCopied(key); setTimeout(() => setCopied(''), 1400); } catch { setError('Could not copy to clipboard.'); } };
  const content = source ? <section className="panel credentials"><div className="success-mark">✓</div><h2>Webhook credentials</h2><p className="subtle">Your webhook is ready. The secret is shown once.</p>
    <div className="credential-row"><label>Payload URL</label><div><code>{source.webhookUrl}</code><button className="copy" onClick={() => copy('url', source.webhookUrl)}>{copied === 'url' ? 'Copied' : 'Copy'}</button></div></div>
    <div className="credential-row"><label>Secret</label><div><code>{revealed ? source.secret : '•'.repeat(24)}</code><button className="copy" onClick={() => setRevealed(value => !value)}>{revealed ? 'Hide' : 'Reveal'}</button><button className="copy" onClick={() => copy('secret', source.secret)}>{copied === 'secret' ? 'Copied' : 'Copy'}</button></div></div>
    <ol className="steps"><li>Open repository <b>Settings → Webhooks → Add webhook</b>.</li><li>Paste the Payload URL and set Content type to <code>application/json</code>.</li><li>Paste the Secret. Select <b>Pull requests</b> and <b>Pull request reviews</b>.</li><li>Save the webhook and wait for GitHub’s ping.</li></ol>
    <p className="connection-state" aria-live="polite"><i className={source.status === 'connected' ? 'connected' : ''} />{source.status === 'connected' ? 'Connected' : 'Waiting for first ping'}</p>
    {source.status === 'connected' ? <Button primary onClick={() => { onBoardOpen(); navigate('/dashboard'); }}>Open board</Button> : showWaitingHint && <p className="subtle">Still waiting? Check Recent Deliveries in your GitHub webhook settings.</p>}
  </section> : <section className="panel connect-form"><div className="form-icon"><Icon name="plus" /></div><h2>Connect a repository</h2><p className="subtle">Enter the repository you want ReviewClock to monitor.</p><form onSubmit={submit}><label htmlFor="repo">Repository</label><input id="repo" value={repo} onChange={event => setRepo(event.target.value)} placeholder="aashwin49/ReviewClock" autoComplete="off" required /><span className="form-error" role="alert">{error}</span><Button primary disabled={submitting}>{submitting ? 'Connecting…' : 'Connect'}</Button></form><p className="subtle auth-hint">Authorization uses the current ReviewClock session.</p></section>;
  return <div className="connect-layout"><PageHeader kicker="GitHub integration" title="Connect repository" summary="Add a repository to start tracking pull request reviews." />{content}</div>;
}

function DeliveryRow({ row, onReprocess }) {
  const [copied, setCopied] = useState(false); const [retrying, setRetrying] = useState(false); const [retryMessage, setRetryMessage] = useState('');
  const copy = async () => { await navigator.clipboard.writeText(row.deliveryId || ''); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  const retry = async () => { setRetrying(true); try { await onReprocess(row.id); setRetryMessage('Queued'); } catch (error) { setRetryMessage('Unavailable'); } finally { setRetrying(false); } };
  const timestamp = row.receivedAt ? `${new Date(row.receivedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—';
  return <tr><td><div className="delivery-id" title={row.deliveryId}><code>{row.deliveryId || '—'}</code>{row.signatureVerified && <span className="verified" title="Signature verified">✓</span>}<button className="copy-id" onClick={copy} aria-label="Copy delivery ID">{copied ? '✓' : '⧉'}</button></div></td><td>{row.event || '—'}</td><td><StatusChip status={row.status}>{row.status}</StatusChip></td><td className="timestamp">{timestamp}</td><td>{row.status === 'failed' ? <Button small disabled={retrying} onClick={retry}>{retrying ? 'Retrying…' : retryMessage || 'Reprocess'}</Button> : '—'}</td></tr>;
}

function DeliveriesPage({ deliveries, search, onReprocess }) {
  const [filter, setFilter] = useState('all');
  const [rows, setRows] = useState(deliveries);
  useEffect(() => setRows(deliveries), [deliveries]);
  const filtered = rows.filter(row => (filter === 'all' || row.status === filter) && (!search || `${row.deliveryId} ${row.event} ${row.status}`.toLowerCase().includes(search.toLowerCase())));
  const processed = rows.filter(row => row.status === 'processed').length;
  const failed = rows.filter(row => row.status === 'failed').length;
  const summary = `${rows.length.toLocaleString()} received · ${rows.length ? Math.round(processed / rows.length * 100) : 0}% processed · ${failed} failed`;
  const reprocess = async id => { await api.reprocess(id); await onReprocess(); };
  return <><PageHeader kicker="Webhooks" title="Deliveries Log" summary={summary} /><div className="delivery-toolbar"><div className="segmented">{['all', 'received', 'processing', 'processed', 'failed'].map(value => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><span className="data-note">Times shown in UTC</span></div>
    <div className="table-wrap">{filtered.length ? <table><thead><tr><th>Delivery ID</th><th>Event</th><th>Status</th><th>Timestamp</th><th>Action</th></tr></thead><tbody>{filtered.map(row => <DeliveryRow key={row.id} row={row} onReprocess={reprocess} />)}</tbody></table> : <div className="empty compact"><span className="empty-icon"><Icon name="list" size={28} /></span><h2>{rows.length ? 'No matching deliveries' : 'No deliveries yet'}</h2><p>{rows.length ? 'Try another status filter.' : 'Webhook deliveries will appear here after GitHub sends events.'}</p></div>}</div>
  </>;
}

function DetailDrawer({ number, navigate, back }) {
  const [detail, setDetail] = useState(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(''); api.pr(number, controller.signal).then(setDetail).catch(e => setError(e.message)).finally(() => setLoading(false)); return () => controller.abort(); }, [number]);
  useEffect(() => { const onKey = event => { if (event.key === 'Escape') back(); }; addEventListener('keydown', onKey); return () => removeEventListener('keydown', onKey); }, [back]);
  const close = event => { if (event.target === event.currentTarget) back(); };
  return <div className="drawer-backdrop" onMouseDown={close}><aside className="drawer" role="dialog" aria-modal="true" aria-label="Pull request details" tabIndex={-1}><button className="icon-button close" onClick={back} aria-label="Close details">×</button>
    {loading ? <><div className="eyebrow">Pull request</div><div className="skeleton" /><div className="skeleton" /></> : error || !detail ? <div className="empty"><h2>{error.includes('404') || !detail ? 'Pull request not found' : 'Could not load pull request'}</h2><p>{error || 'This pull request may have been removed.'}</p><Button onClick={back}>Back to board</Button></div> : <><div className="eyebrow">Pull request #{detail.pr.number}</div><h2>{detail.pr.title}</h2><div className="detail-author"><Avatar name={detail.pr.author?.login} /><span>{detail.pr.author?.login || 'Unknown author'}</span><StatusChip status={detail.pr.state}>{LABELS[detail.pr.state] || detail.pr.state}</StatusChip><AgeChip pr={detail.pr} /></div><p className="subtle">Waiting on {detail.pr.state === 'changes_requested' ? 'author' : detail.pr.waitingOn ? `@${detail.pr.waitingOn}` : 'reviewer'}</p>
      <section className="detail-section"><h3>Verdicts</h3>{detail.verdicts.length ? detail.verdicts.map(verdict => <div className="verdict-row" key={verdict.reviewer}><Avatar name={verdict.reviewer} tiny /><span>{verdict.state === 'changes_requested' ? 'Changes requested by' : verdict.state === 'dismissed' ? 'Review dismissed by' : verdict.state === 'commented' ? 'Commented by' : 'Approved by'} <b>@{verdict.reviewer}</b></span><span className="timestamp">{verdict.submittedAt ? new Date(verdict.submittedAt).toLocaleString() : ''}</span></div>) : <p className="subtle">No reviews yet</p>}</section>
      <section className="detail-section"><h3>Timeline</h3>{detail.events.length ? <ol className="timeline">{detail.events.map(event => <li key={event.id}><span className="timeline-dot">·</span><div><b>{EVENT_LABELS[event.type] || 'Pull request updated'}</b><p>{event.actor || 'GitHub'}{event.detail ? ` · ${event.detail}` : ''}</p><time>{event.occurredAt ? `${new Date(event.occurredAt).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—'}</time></div></li>)}</ol> : <p className="subtle">No timeline events yet</p>}</section></>}
  </aside></div>;
}

export default function App() {
  const [route, navigate, back] = useRoute();
  const [prs, setPrs] = useState(MOCK ? mockPRs : []); const [deliveries, setDeliveries] = useState(MOCK ? mockDeliveries : []); const [repoName, setRepoName] = useState(MOCK ? 'aashwin49/ReviewClock' : '');
  const [loading, setLoading] = useState(!MOCK); const [error, setError] = useState(''); const [view, setView] = useState('mine'); const [source, setSource] = useState(null); const [search, setSearch] = useState(''); const [authOpen, setAuthOpen] = useState(false); const [authEpoch, setAuthEpoch] = useState(0);
  const [sources, setSources] = useState([]); const [selectedSourceId, setSelectedSourceId] = useState(''); const [liveStatus, setLiveStatus] = useState(MOCK ? 'offline' : 'reconnecting');
  const load = useCallback(async () => { setLoading(true); setError(''); try { setPrs(await api.prs()); } catch (e) { setError(e.message); if (e.status === 401) setAuthOpen(true); } try { setDeliveries(await api.deliveries()); } catch { setDeliveries([]); } try { const connectedSources = await api.sources(); setSources(connectedSources); setSelectedSourceId(current => connectedSources.some(item => item.id === current) ? current : connectedSources[0]?.id || ''); setRepoName(connectedSources[0]?.repo || ''); } catch {} finally { setLoading(false); } }, []);
  useEffect(() => { if (!MOCK) load(); }, [load]);
  useEffect(() => {
    if (MOCK) return;
    let active = true;
    let stream;
    let lastSequence = 0;
    const start = async () => {
      try {
        const { ticket } = await api.streamTicket();
        if (!active) return;
        stream = new EventSource(api.streamUrl(ticket), { withCredentials: true });
        stream.onopen = () => setLiveStatus('live');
        stream.onerror = () => setLiveStatus('reconnecting');
        stream.addEventListener('resync', event => {
          lastSequence = Number(event.lastEventId || 0);
          api.prs().then(setPrs).catch(() => {});
        });
        stream.addEventListener('activity', event => {
          try {
            const activity = JSON.parse(event.data);
            const sequence = Number(event.lastEventId || activity.sequence);
            if (sequence > lastSequence + 1) api.prs().then(setPrs).catch(() => {});
            lastSequence = Math.max(lastSequence, sequence || 0);
            if (!activity.pullRequest) return;
            const state = activity.pullRequest.state;
            const stateKey = ({ Draft: 'draft', 'Awaiting review': 'awaiting_review', 'Changes requested': 'changes_requested', Approved: 'approved', Merged: 'merged' })[state];
            if (state === 'Closed') {
              setPrs(current => current.filter(pr => !(pr.sourceId === activity.sourceId && pr.number === activity.pullRequest.number)));
              return;
            }
            const incoming = { ...activity.pullRequest, state: stateKey || state, author: typeof activity.pullRequest.author === 'string' ? { login: activity.pullRequest.author } : activity.pullRequest.author, sourceId: activity.sourceId };
            setPrs(current => {
              const mapped = incoming.id ? incoming : { ...incoming, id: `${incoming.sourceId}:${incoming.number}` };
              const index = current.findIndex(pr => pr.id === mapped.id || (pr.number === mapped.number && pr.sourceId === mapped.sourceId));
              if (index < 0) return [mapped, ...current];
              const next = [...current]; next[index] = { ...next[index], ...mapped }; return next;
            });
          } catch {}
        });
      } catch (e) {
        if (active) setLiveStatus('reconnecting');
        if (active) setTimeout(start, 5000);
      }
    };
    start();
    return () => { active = false; stream?.close(); };
  }, []);
  const saveThreshold = useCallback(async (sourceId, minutes) => {
    if (!sourceId || !Number.isInteger(minutes) || minutes < 1 || minutes > 43200) return;
    try {
      const updated = await api.updateSource(sourceId, minutes);
      setSources(current => current.map(item => item.id === sourceId ? { ...item, ...updated } : item));
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { if (route !== '/dashboard/connect') setSource(null); }, [route]);
  useEffect(() => { if (route === '/dashboard' && window.reviewClockOrigin?.isConnected) window.reviewClockOrigin.focus(); }, [route]);
  const active = route === '/dashboard/deliveries' ? 'deliveries' : route === '/dashboard/connect' || route.startsWith('/dashboard/prs/') ? '' : 'board';
  const children = route === '/dashboard/connect' ? <ConnectPage source={source} setSource={setSource} setRepoName={setRepoName} onBoardOpen={load} onUnauthorized={() => setAuthOpen(true)} authEpoch={authEpoch} navigate={navigate} /> : route === '/dashboard/deliveries' ? <DeliveriesPage deliveries={deliveries} search={search} onReprocess={async () => setDeliveries(await api.deliveries())} /> : <Board prs={prs} loading={loading} error={error} onRetry={load} view={view} setView={setView} navigate={navigate} search={search} sources={sources} selectedSourceId={selectedSourceId} onSelectSource={setSelectedSourceId} onThresholdChange={saveThreshold} />;
  const number = route.match(/^\/dashboard\/prs\/(\d+)$/)?.[1];
  return <AppShell active={active} deliveries={deliveries} navigate={navigate} search={search} setSearch={setSearch} repoName={repoName} liveStatus={liveStatus}>{children}{number && <DetailDrawer number={number} navigate={navigate} back={back} />}{authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onAuthenticated={() => { setAuthOpen(false); setAuthEpoch(value => value + 1); load(); }} />}</AppShell>;
}
