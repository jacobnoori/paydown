'use strict';
/* Paydown — all money is stored as integer cents to avoid floating-point drift.
   Dates are stored as local "YYYY-MM-DD" strings. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// kind: 'debt' accounts are money owed (balance = amount owed); 'cash' accounts hold money (balance = amount held).
const TYPES = {
  credit_card:   { label: 'Credit Card',   plural: 'Credit Cards',      color: '#6366f1', kind: 'debt' },
  personal_loan: { label: 'Personal Loan', plural: 'Personal Loans',    color: '#0ea5e9', kind: 'debt' },
  auto_loan:     { label: 'Auto Loan',     plural: 'Auto Loans',        color: '#f59e0b', kind: 'debt' },
  mortgage:      { label: 'Mortgage',      plural: 'Mortgages',         color: '#10b981', kind: 'debt' },
  checking:      { label: 'Checking',      plural: 'Checking Accounts', color: '#64748b', kind: 'cash' },
  savings:       { label: 'Savings',       plural: 'Savings Accounts',  color: '#d946ef', kind: 'cash' },
};
const TX_LABEL = { purchase: 'Purchase', payment: 'Payment', interest: 'Interest charge', fee: 'Fee', refund: 'Refund / credit', adjustment: 'Adjustment', deposit: 'Deposit', withdrawal: 'Withdrawal', transfer_out: 'Transfer out', transfer_in: 'Transfer in', debt_payment: 'Debt payment' };
// Linked pairs share a transferId and each side records the other account in counterAccountId:
//  - a transfer between cash accounts: transfer_out on the source, transfer_in on the destination;
//  - a debt paid from a cash account: debt_payment on the cash account, a normal payment on the debt account.
const isTransfer = t => t.type === 'transfer_out' || t.type === 'transfer_in';
const transferPair = t => state.transactions.find(x => x.transferId && x.transferId === t.transferId && x.id !== t.id);
const counterName = t => getAcc(t.counterAccountId)?.name || 'a deleted account';
// Description shown in lists: linked entries name the other account.
const txDesc = (t, accType) => t.counterAccountId ? `${t.type === 'transfer_out' || t.type === 'debt_payment' ? 'To' : 'From'} ${counterName(t)}${t.memo ? ' · ' + t.memo : ''}` : (t.memo || txLabel(t.type, accType));
const isCard = t => t === 'credit_card';
const isCash = t => TYPES[t].kind === 'cash';
const isLoan = t => !isCard(t) && !isCash(t);
const hasRate = t => t === 'mortgage' || t === 'auto_loan';     // separate note rate in addition to APR
const isDebtAcc = a => !isCash(a.type);
const txTypesFor = t => isCard(t) ? ['purchase', 'payment', 'interest', 'fee', 'refund', 'adjustment']
  : t === 'checking' ? ['withdrawal', 'deposit', 'fee', 'interest', 'adjustment']
  : t === 'savings' ? ['deposit', 'withdrawal', 'interest', 'fee', 'adjustment']
  : ['payment', 'fee', 'adjustment'];
// Labels that read differently on cash accounts.
const txLabel = (type, accType) => (isCash(accType) && { interest: 'Interest earned', withdrawal: accType === 'checking' ? 'Purchase / withdrawal' : 'Withdrawal' }[type]) || TX_LABEL[type];
// Monthly interest earned at an APY (APY already includes compounding).
const apyMonthly = (bal, apy) => Math.round(Math.max(bal, 0) * (Math.pow(1 + (apy || 0) / 100, 1 / 12) - 1));
// Rate actually used to accrue interest: note rate for mortgage/auto, APR otherwise.
const rateFor = a => hasRate(a.type) && a.interestRate != null ? a.interestRate : (a.apr || 0);

/* ---------- utilities ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = c => USD.format((c || 0) / 100);
const moneyShort = c => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format((c || 0) / 100);
const pct = (n, d = 2) => n == null || isNaN(n) ? '—' : `${Number(n).toFixed(d)}%`;

// Exact string → cents parsing (no float multiplication), half-up rounding on the 3rd decimal.
function toCents(v) {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const frac = (f + '000').slice(0, 3);
  let c = Number(i || 0) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) c += 1;
  return neg ? -c : c;
}
const toNum = v => { const s = String(v ?? '').trim(); return s === '' ? NaN : Number(s); };
const centsIn = c => c == null || isNaN(c) ? '' : (c / 100).toFixed(2);

const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;                // m is 0-based
const todayISO = () => { const d = new Date(); return ymd(d.getFullYear(), d.getMonth(), d.getDate()); };
const parts = iso => iso.split('-').map(Number);
const dayNum = iso => { const [y, m, d] = parts(iso); return Date.UTC(y, m - 1, d) / 864e5; };
const daysBetween = (a, b) => dayNum(b) - dayNum(a);
const addDays = (iso, n) => { const [y, m, d] = parts(iso); const t = new Date(Date.UTC(y, m - 1, d + n)); return ymd(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()); };
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const fmtDate = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => { const [y, m, d] = parts(iso); return new Date(y, m - 1, d).toLocaleDateString('en-US', opts); };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/* ---------- state & storage ----------
   Data lives on the server (data.json). Every record carries updatedAt and deletions leave a
   tombstone in `deleted`, so if two devices save around the same time the server rejects the
   stale write (409) and the client merges record-by-record before retrying. */
const THEME_KEY = 'paydown:theme';
const ui = { calY: null, calM: null, calSel: null, txFilter: 'all' };
const store = { etag: null, dirty: false, saving: false, error: '', timer: null };

const emptyData = () => ({ version: 2, accounts: [], transactions: [], documents: [], deleted: {} });
function normalize(s) {
  if (!s || !Array.isArray(s.accounts)) return emptyData();
  const arr = x => Array.isArray(x) ? x : [];
  return { version: 2, accounts: s.accounts, transactions: arr(s.transactions), documents: arr(s.documents), deleted: s.deleted && typeof s.deleted === 'object' ? s.deleted : {} };
}
let state = emptyData();

const touch = o => { o.updatedAt = Date.now(); return o; };
const tombstone = id => { state.deleted[id] = Date.now(); };

// Record-level merge: newest updatedAt wins; a tombstone newer than the record deletes it.
function merge(a, b) {
  const deleted = { ...a.deleted };
  for (const [k, v] of Object.entries(b.deleted || {})) deleted[k] = Math.max(deleted[k] || 0, v);
  const pick = (xs, ys) => {
    const m = new Map();
    for (const x of [...xs, ...ys]) { const c = m.get(x.id); if (!c || (x.updatedAt || 0) > (c.updatedAt || 0)) m.set(x.id, x); }
    return [...m.values()].filter(x => !((deleted[x.id] || 0) >= (x.updatedAt || 0)));
  };
  const accounts = pick(a.accounts, b.accounts);
  const ids = new Set(accounts.map(x => x.id));
  const transactions = pick(a.transactions, b.transactions).filter(t => ids.has(t.accountId));
  const documents = pick(a.documents || [], b.documents || []).filter(d => ids.has(d.accountId));
  const cutoff = Date.now() - 365 * 864e5;   // keep the file small
  for (const k of Object.keys(deleted)) if (deleted[k] < cutoff) delete deleted[k];
  return { version: 2, accounts, transactions, documents, deleted };
}

// fetch wrapper: a 401 means the session expired -> back to the login page.
async function api(path, opts = {}) {
  const r = await fetch(path, { cache: 'no-store', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401 && path !== 'api/password') { location.href = 'login'; throw new Error('login required'); }
  return r;
}

function save() {
  store.dirty = true; setSync();
  clearTimeout(store.timer); store.timer = setTimeout(flush, 250);
}
async function flush() {
  if (store.saving || !store.dirty) return;
  store.saving = true; store.dirty = false; setSync();
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await api('api/data', { method: 'PUT', body: JSON.stringify({ data: state, ifMatch: store.etag }) });
      const j = await r.json();
      if (r.ok) { store.etag = j.etag; store.error = ''; break; }
      if (r.status === 409) {            // another device saved first: merge and retry
        store.etag = j.etag;
        if (j.data) { state = merge(normalize(j.data), state); rerenderSafe(); }
        if (attempt === 4) throw new Error('conflict');
        continue;
      }
      throw new Error(j.error || r.statusText);
    }
  } catch (e) {
    store.dirty = true; store.error = 'Not saved — retrying…';
    setTimeout(flush, 3000);
  } finally {
    store.saving = false; setSync();
    if (store.dirty && !store.error) flush();
  }
}
// Pick up changes saved from other devices.
async function poll() {
  if (store.saving || store.dirty || document.hidden) return;
  try {
    const v = await (await api('api/version')).json();
    if (store.error) { store.error = ''; setSync(); }
    if (v.etag === store.etag || modal.open) return;   // don't swap data under an open form
    await pull();
  } catch { if (!store.error) { store.error = 'Server unreachable'; setSync(); } }
}
async function pull() {
  const j = await (await api('api/data')).json();
  if (j.error) throw new Error(j.error);
  store.etag = j.etag;
  const data = j.exists ? normalize(j.data) : emptyData();
  const changed = JSON.stringify(data) !== JSON.stringify(state);
  state = data;
  if (changed) rerenderSafe();
}
async function initStorage() {
  try { await pull(); }
  catch (e) { store.error = 'Could not load data'; }
  setInterval(poll, 4000);
  window.addEventListener('focus', poll);
  document.addEventListener('visibilitychange', poll);
  window.addEventListener('beforeunload', e => { if (store.dirty || store.saving) { flush(); e.preventDefault(); } });
}
function setSync() {
  const el = $('#syncStatus'); if (!el) return;
  let cls = 'ok', text = 'All changes saved';
  if (store.error) { cls = 'bad'; text = store.error; }
  else if (store.dirty || store.saving) { cls = 'busy'; text = 'Saving…'; }
  el.className = 'sync ' + cls; el.textContent = text;
}
const getAcc = id => state.accounts.find(a => a.id === id);

/* ---------- ledger math ---------- */
const cmpTx = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt;
const txsFor = (accId, excludeId) => state.transactions.filter(t => t.accountId === accId && t.id !== excludeId).sort(cmpTx);

// Effect on the account's balance. Debt accounts: balance owed (loan payments reduce it only by their
// principal portion). Cash accounts: balance held (deposits and interest add, withdrawals and fees subtract).
function effect(t, accType) {
  switch (t.type) {
    case 'purchase': case 'interest': return t.amount;
    case 'fee': return isCash(accType) ? -t.amount : t.amount;
    case 'refund': case 'withdrawal': return -t.amount;
    case 'deposit': case 'transfer_in': return t.amount;
    case 'transfer_out': case 'debt_payment': return -t.amount;
    case 'adjustment': return t.amount;               // signed
    case 'payment': return -(t.amount - (t.interest || 0) - (t.escrow || 0));
  }
  return 0;
}
// CSS class for a balance change: green when it's good for you (debt down, cash up), red otherwise.
const changeCls = (e, accType) => !e ? '' : (isCash(accType) ? e > 0 : e < 0) ? 'neg' : 'pos';
function ledger(acc, excludeId) {
  let bal = acc.startBalance;
  return txsFor(acc.id, excludeId).map(t => { const e = effect(t, acc.type); bal += e; return { ...t, effect: e, balanceAfter: bal }; });
}
// Balance at end of `date` (after every transaction dated on or before it).
function balanceOn(acc, date, excludeId) {
  let bal = acc.startBalance;
  for (const t of ledger(acc, excludeId)) { if (t.date <= date) bal = t.balanceAfter; else break; }
  return bal;
}
const currentBalance = acc => { const L = ledger(acc); return L.length ? L[L.length - 1].balanceAfter : acc.startBalance; };

// Σ(daily ending balance) over days [from, to) — in cent-days. Basis for daily simple interest
// and the credit-card average-daily-balance method.
function balanceDaySum(acc, from, to, excludeId) {
  if (to <= from) return 0;
  const L = ledger(acc, excludeId);
  let bal = acc.startBalance, i = 0, cur = from, sum = 0;
  while (i < L.length && L[i].date <= from) bal = L[i++].balanceAfter;
  while (i < L.length && L[i].date < to) {
    const d = L[i].date;
    sum += Math.max(bal, 0) * daysBetween(cur, d);
    cur = d;
    while (i < L.length && L[i].date === d) bal = L[i++].balanceAfter;
  }
  return sum + Math.max(bal, 0) * daysBetween(cur, to);
}

// Suggested interest portion of a loan payment made on `date`.
function suggestLoanInterest(acc, date, excludeId) {
  const r = rateFor(acc) / 100;
  const others = txsFor(acc.id, excludeId);
  if (acc.type === 'mortgage') {
    // Mortgages accrue monthly: balance × rate / 12, charged once per month.
    const ym = date.slice(0, 7);
    if (others.some(t => t.type === 'payment' && t.date.slice(0, 7) === ym && t.date <= date && (t.interest || 0) > 0)) return { cents: 0, why: 'Interest already applied this month — extra payment goes to principal' };
    const bal = Math.max(balanceOn(acc, date, excludeId), 0);
    return { cents: Math.round(bal * r / 12), why: `${money(bal)} × ${pct(rateFor(acc), 3)} ÷ 12` };
  }
  // Auto / personal loans: daily simple interest since the previous payment.
  const prev = others.filter(t => t.type === 'payment' && t.date <= date).pop();
  const from = prev ? prev.date : acc.startDate;
  const days = Math.max(daysBetween(from, date), 0);
  const sum = balanceDaySum(acc, from, date, excludeId);
  return { cents: Math.round(sum * r / 365), why: `${days} day${days === 1 ? '' : 's'} × ${pct(rateFor(acc), 3)} ÷ 365 on avg. ${money(days ? Math.round(sum / days) : 0)}` };
}
// Savings interest estimate: daily balance since the last interest credit × the daily rate implied by the APY.
function estimateSavingsInterest(acc, date, excludeId) {
  const prev = txsFor(acc.id, excludeId).filter(t => t.type === 'interest' && t.date < date).pop();
  const from = prev ? prev.date : acc.startDate;
  const days = Math.max(daysBetween(from, date), 0);
  const sum = balanceDaySum(acc, from, date, excludeId);
  const daily = Math.pow(1 + (acc.apy || 0) / 100, 1 / 365) - 1;
  return { cents: Math.round(sum * daily), why: `Avg. daily balance ${money(days ? Math.round(sum / days) : 0)} at ${pct(acc.apy)} APY × ${days} days` };
}
// Credit-card interest estimate: average daily balance since the last interest charge × APR/365 × days.
function estimateCardInterest(acc, date, excludeId) {
  const prev = txsFor(acc.id, excludeId).filter(t => t.type === 'interest' && t.date < date).pop();
  const from = prev ? prev.date : acc.startDate;
  const days = Math.max(daysBetween(from, date), 0);
  const sum = balanceDaySum(acc, from, date, excludeId);
  const adb = days ? Math.round(sum / days) : 0;
  return { cents: Math.round(sum * (acc.apr / 100) / 365), why: `Avg. daily balance ${money(adb)} × ${pct(acc.apr)} ÷ 365 × ${days} days` };
}

function amortPayment(principal, ratePct, n) {
  const r = ratePct / 100 / 12;
  if (!(principal > 0) || !(n > 0)) return NaN;
  return r === 0 ? Math.round(principal / n) : Math.round(principal * r / (1 - Math.pow(1 + r, -n)));
}
// Month-by-month payoff simulation at a fixed payment.
function payoff(acc) {
  if (isCash(acc.type)) return null;
  const bal = currentBalance(acc);
  if (bal <= 0) return { months: 0, interest: 0 };
  const pay = (acc.payment || 0) - (acc.type === 'mortgage' ? (acc.escrow || 0) : 0);
  if (pay <= 0) return null;
  const r = rateFor(acc) / 100 / 12;
  let b = bal, m = 0, interest = 0;
  while (b > 0 && m < 1200) {
    const i = Math.round(b * r);
    if (pay <= i) return { never: true };
    interest += i; b = b + i - pay; m++;
  }
  return { months: m, interest };
}
const payoffText = p => !p ? '—' : p.never ? 'Never at this payment' : p.months === 0 ? 'Paid off' : `${Math.floor(p.months / 12) ? Math.floor(p.months / 12) + 'y ' : ''}${p.months % 12}m`;
function payoffDate(p) {
  if (!p || p.never || !p.months) return '';
  const d = new Date(); d.setMonth(d.getMonth() + p.months);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/* ---------- due dates ---------- */
const dueDateFor = (acc, y, m) => ymd(y, m, Math.min(acc.dueDay, daysInMonth(y, m)));
// One due-date entry for an account in a given month, with payment status for that cycle.
function dueEntry(acc, y, m, today = todayISO()) {
  if (!acc.dueDay || isCash(acc.type)) return null;
  const date = dueDateFor(acc, y, m);
  if (date <= acc.startDate) return null;
  const pm = m === 0 ? [y - 1, 11] : [y, m - 1];
  const prevDue = dueDateFor(acc, pm[0], pm[1]);
  const owed = Math.max(balanceOn(acc, prevDue), 0);
  const paid = state.transactions.filter(t => t.accountId === acc.id && t.type === 'payment' && t.date > prevDue && t.date <= date).reduce((s, t) => s + t.amount, 0);
  if (owed <= 0 && paid === 0 && Math.max(balanceOn(acc, date), 0) === 0) return null;
  const required = acc.payment > 0 ? Math.min(acc.payment, Math.max(owed, 0) || acc.payment) : 1;
  let status;
  if (paid >= required) status = 'paid';
  else if (date < today) status = 'overdue';
  else if (paid > 0) status = 'partial';
  else status = daysBetween(today, date) <= 7 ? 'soon' : 'upcoming';
  return { acc, date, paid, required: acc.payment || 0, status };
}
const STATUS_LABEL = { paid: 'Paid', partial: 'Partial', overdue: 'Overdue', soon: 'Due soon', upcoming: 'Upcoming' };
function nextDue(acc) {
  const t = new Date(); let y = t.getFullYear(), m = t.getMonth();
  for (let k = 0; k < 3; k++) {
    const e = dueEntry(acc, y, m);
    if (e && e.date >= todayISO()) return e;
    m++; if (m > 11) { m = 0; y++; }
  }
  return null;
}

/* ---------- rendering ---------- */
const view = $('#view');
function route() {
  const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [page, id] = h.split('/');
  $$('nav a').forEach(a => a.classList.toggle('active', a.dataset.nav === (page === 'account' ? 'accounts' : page)));
  if (page === 'accounts') view.innerHTML = renderAccounts();
  else if (page === 'account' && getAcc(id)) view.innerHTML = renderAccount(getAcc(id));
  else if (page === 'calendar') view.innerHTML = renderCalendar();
  else view.innerHTML = renderDashboard();
}
const rerender = () => { const y = window.scrollY; route(); window.scrollTo(0, y); };
const rerenderSafe = () => { if (!modal.open) rerender(); };

const typeChip = t => `<span class="chip"><span class="dot" style="background:${TYPES[t].color}"></span>${TYPES[t].label}</span>`;
const accColor = a => a.color || TYPES[a.type].color;

function emptyState() {
  return `<div class="card empty">
    <div class="art"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/></svg></div>
    <h2>No accounts yet</h2>
    <p>Add a credit card, loan, or mortgage to track balances, payments, and due dates — and checking or savings accounts to track your cash.</p>
    <div class="actions" style="justify-content:center">
      <button class="btn primary" data-action="add-account">+ Add account</button>
      <button class="btn" data-action="sample">Load sample data</button>
    </div></div>`;
}

function renderDashboard() {
  const head = `<div class="page-head"><div><h1>Dashboard</h1><p>${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p></div>
    <div class="actions"><button class="btn primary" data-action="add-account">+ Add account</button></div></div>`;
  if (!state.accounts.length) return head + emptyState();

  const all = state.accounts.map(a => ({ a, bal: currentBalance(a) }));
  const rows = all.filter(r => isDebtAcc(r.a)), cashRows = all.filter(r => !isDebtAcc(r.a));
  const total = rows.reduce((s, r) => s + Math.max(r.bal, 0), 0);
  const cashTotal = cashRows.reduce((s, r) => s + r.bal, 0);
  const cashInt = cashRows.reduce((s, r) => s + (r.a.type === 'savings' ? apyMonthly(r.bal, r.a.apy) : 0), 0);
  const cards = rows.filter(r => isCard(r.a.type));
  const limit = cards.reduce((s, r) => s + (r.a.creditLimit || 0), 0);
  const cardBal = cards.reduce((s, r) => s + Math.max(r.bal, 0), 0);
  const util = limit ? cardBal / limit * 100 : null;
  const monthlyInt = rows.reduce((s, r) => s + Math.round(Math.max(r.bal, 0) * rateFor(r.a) / 100 / 12), 0);
  const monthlyPay = rows.reduce((s, r) => s + (r.bal > 0 ? (r.a.payment || 0) : 0), 0);
  const wApr = total ? rows.reduce((s, r) => s + Math.max(r.bal, 0) * (r.a.apr || 0), 0) / total : 0;

  const byType = Object.keys(TYPES).map(t => ({ t, v: rows.filter(r => r.a.type === t).reduce((s, r) => s + Math.max(r.bal, 0), 0) })).filter(x => x.v > 0);

  // Upcoming & overdue due dates: last month through next month
  const now = new Date(); const dues = [];
  for (let k = -1; k <= 1; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    state.accounts.forEach(a => { const e = dueEntry(a, d.getFullYear(), d.getMonth()); if (e) dues.push(e); });
  }
  const today = todayISO();
  const upcoming = dues.filter(e => e.status === 'overdue' || (e.date >= today && e.status !== 'paid') || (e.date >= today && e.status === 'paid' && daysBetween(today, e.date) <= 31))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 7);

  const recent = [...state.transactions].sort((a, b) => cmpTx(b, a)).slice(0, 8);
  const utilCls = util == null ? '' : util >= 50 ? 'bad' : util >= 30 ? 'warn' : '';

  return head + `
  <div class="grid stats">
    <div class="card stat"><div class="label">Total debt</div><div class="value">${money(total)}</div><div class="sub">${rows.length} account${rows.length === 1 ? '' : 's'}</div></div>
    ${cashRows.length ? `<div class="card stat"><div class="label">Cash &amp; savings</div><div class="value">${money(cashTotal)}</div><div class="sub">${cashInt ? `≈ ${money(cashInt)}/mo interest earned` : `${cashRows.length} account${cashRows.length === 1 ? '' : 's'}`}</div></div>` : ''}
    <div class="card stat"><div class="label">Est. interest / month</div><div class="value">${money(monthlyInt)}</div><div class="sub">≈ ${money(monthlyInt * 12)} per year</div></div>
    <div class="card stat"><div class="label">Monthly payments</div><div class="value">${money(monthlyPay)}</div><div class="sub">Minimum / scheduled</div></div>
    <div class="card stat"><div class="label">Weighted APR</div><div class="value">${pct(wApr)}</div><div class="sub">By balance</div></div>
    <div class="card stat"><div class="label">Card utilization</div><div class="value">${util == null ? '—' : pct(util, 1)}</div>
      ${util == null ? '<div class="sub">No credit limits set</div>' : `<div class="meter ${utilCls}" style="margin-top:8px"><span style="width:${Math.min(util, 100)}%"></span></div><div class="sub">${money(cardBal)} of ${money(limit)}</div>`}</div>
  </div>
  <div class="grid two-col">
    <div class="grid">
      <div class="card card-pad">
        <h2>Debt composition</h2>
        ${total ? '' : '<p class="muted" style="margin:10px 0 0">No debt balances.</p>'}
        <div class="stack"${total ? '' : ' hidden'}>${byType.map(x => `<span title="${TYPES[x.t].label}: ${money(x.v)}" style="width:${x.v / total * 100}%;background:${TYPES[x.t].color}"></span>`).join('')}</div>
        <div class="legend">${byType.map(x => `<div><span class="dot" style="background:${TYPES[x.t].color}"></span>${TYPES[x.t].label} <b class="num">${money(x.v)}</b> <span class="muted">${(x.v / total * 100).toFixed(1)}%</span></div>`).join('')}</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Debts</h2><a class="btn ghost sm" href="#/accounts">View all</a></div>
        ${rows.length ? '' : '<div class="empty-line">No debt accounts.</div>'}
        <div class="table-wrap"${rows.length ? '' : ' hidden'}><table>
          <thead><tr><th>Account</th><th class="num">Balance</th><th class="num">APR</th><th class="num">Payment</th><th class="num">Payoff</th></tr></thead>
          <tbody>${rows.sort((x, y) => y.bal - x.bal).map(({ a, bal }) => { const p = payoff(a); return `
            <tr class="clickable" data-action="open-account" data-id="${a.id}">
              <td><div class="acct"><span class="dot" style="background:${accColor(a)}"></span><div>${esc(a.name)}<div class="muted small" style="font-weight:450">${TYPES[a.type].label}</div></div></div></td>
              <td class="num"><b>${money(bal)}</b></td><td class="num">${pct(a.apr)}</td>
              <td class="num">${a.payment ? money(a.payment) : '—'}</td>
              <td class="num">${payoffText(p)}<div class="muted small">${payoffDate(p)}</div></td></tr>`; }).join('')}
          </tbody></table></div>
      </div>
      ${cashRows.length ? `<div class="card">
        <div class="card-head"><h2>Cash accounts</h2></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Account</th><th class="num">Balance</th><th class="num">APY</th><th class="num">Interest / mo</th></tr></thead>
          <tbody>${cashRows.sort((x, y) => y.bal - x.bal).map(({ a, bal }) => `
            <tr class="clickable" data-action="open-account" data-id="${a.id}">
              <td><div class="acct"><span class="dot" style="background:${accColor(a)}"></span><div>${esc(a.name)}<div class="muted small" style="font-weight:450">${TYPES[a.type].label}</div></div></div></td>
              <td class="num"><b>${money(bal)}</b></td>
              <td class="num">${a.type === 'savings' ? pct(a.apy) : '—'}</td>
              <td class="num">${a.type === 'savings' ? money(apyMonthly(bal, a.apy)) : '—'}</td></tr>`).join('')}
          </tbody></table></div>
      </div>` : ''}
    </div>
    <div class="grid">
      <div class="card">
        <div class="card-head"><h2>Payment due dates</h2><a class="btn ghost sm" href="#/calendar">Calendar</a></div>
        ${upcoming.length ? `<ul class="list">${upcoming.map(dueItem).join('')}</ul>` : '<div class="empty-line">No upcoming due dates.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><h2>Recent activity</h2></div>
        ${recent.length ? `<ul class="list">${recent.map(t => { const a = getAcc(t.accountId); return a ? `
          <li class="clickable" data-action="open-account" data-id="${a.id}" style="cursor:pointer">
            <span class="dot" style="background:${accColor(a)}"></span>
            <div class="grow"><b>${esc(txDesc(t, a.type))}</b><span class="muted small">${esc(a.name)} · ${fmtDate(t.date)}</span></div>
            ${(() => { const e = effect(t, a.type); return `<div class="right ${changeCls(e, a.type)}">${e < 0 ? '−' : e > 0 ? '+' : ''}${money(Math.abs(t.amount))}</div>`; })()}
          </li>` : ''; }).join('')}</ul>` : '<div class="empty-line">No transactions logged yet.</div>'}
      </div>
    </div>
  </div>`;
}
const dueItem = e => `<li data-action="open-account" data-id="${e.acc.id}" style="cursor:pointer">
  <span class="dot" style="background:${accColor(e.acc)}"></span>
  <div class="grow"><b>${esc(e.acc.name)}</b><span class="muted small">${fmtDate(e.date, { weekday: 'short', month: 'short', day: 'numeric' })}${e.paid ? ` · paid ${money(e.paid)}` : ''}</span></div>
  <div class="right"><div>${e.required ? money(e.required) : ''}</div><span class="status ${e.status}">${STATUS_LABEL[e.status]}</span></div></li>`;

function renderAccounts() {
  const head = `<div class="page-head"><div><h1>Accounts</h1><p>Debts and cash accounts you're tracking.</p></div>
    <div class="actions"><button class="btn primary" data-action="add-account">+ Add account</button></div></div>`;
  if (!state.accounts.length) return head + emptyState();
  const groups = Object.keys(TYPES).map(t => ({ t, list: state.accounts.filter(a => a.type === t) })).filter(g => g.list.length);
  return head + groups.map(g => `
    <h3 class="muted" style="margin:6px 0 10px">${g.list.length > 1 ? TYPES[g.t].plural : TYPES[g.t].label}</h3>
    <div class="grid acct-grid" style="margin-bottom:22px">${g.list.map(acctCard).join('')}</div>`).join('');
}
function acctCard(a) {
  const bal = currentBalance(a), nd = nextDue(a);
  const util = isCard(a.type) && a.creditLimit ? bal / a.creditLimit * 100 : null;
  return `<a class="card acct-card" href="#/account/${a.id}" style="--c:${accColor(a)};color:inherit">
    <div class="top"><div><div class="name">${esc(a.name)}</div><div class="muted small">${esc(a.lender || TYPES[a.type].label)}</div></div>${typeChip(a.type)}</div>
    <div><div class="muted small">Current balance</div><div class="bal">${money(bal)}</div></div>
    ${util != null ? `<div><div class="meter ${util >= 50 ? 'bad' : util >= 30 ? 'warn' : ''}"><span style="width:${Math.min(Math.max(util, 0), 100)}%"></span></div><div class="muted small" style="margin-top:4px">${pct(util, 1)} of ${money(a.creditLimit)} limit</div></div>` : ''}
    ${isCash(a.type) ? cashKv(a, bal) : `<div class="kv">
      <div><span>APR</span><b>${pct(a.apr)}</b></div>
      ${hasRate(a.type) ? `<div><span>Interest rate</span><b>${pct(a.interestRate, 3)}</b></div>` : `<div><span>${isCard(a.type) ? 'Min. payment' : 'Payment'}</span><b>${a.payment ? money(a.payment) : '—'}</b></div>`}
      <div><span>Next due</span><b>${nd ? fmtDate(nd.date, { month: 'short', day: 'numeric' }) : '—'}</b></div>
    </div>`}</a>`;
}
// Money in / out over the last 30 days (by effect on the balance, so it works for any cash account).
// Transfers between your own accounts aren't income or spending, so they're left out.
function flows30(a) {
  const from = addDays(todayISO(), -30);
  return ledger(a).filter(t => t.date > from && t.date <= todayISO() && !isTransfer(t))
    .reduce((s, t) => { if (t.effect > 0) s.in += t.effect; else s.out -= t.effect; return s; }, { in: 0, out: 0 });
}
function cashKv(a, bal) {
  const f = flows30(a), last = ledger(a).filter(t => t.date <= todayISO()).pop();
  return `<div class="kv">
    ${a.type === 'savings' ? `<div><span>APY</span><b>${pct(a.apy)}</b></div><div><span>Interest / mo</span><b>${money(apyMonthly(bal, a.apy))}</b></div>`
      : `<div><span>In · 30 days</span><b>${money(f.in)}</b></div><div><span>Out · 30 days</span><b>${money(f.out)}</b></div>`}
    <div><span>Last activity</span><b>${last ? fmtDate(last.date, { month: 'short', day: 'numeric' }) : '—'}</b></div>
  </div>`;
}

function cashStats(a, bal, totals) {
  const f = flows30(a);
  return `${a.type === 'savings' ? `<div class="card stat"><div class="label">APY</div><div class="value">${pct(a.apy)}</div><div class="sub">≈ ${money(apyMonthly(bal, a.apy))}/mo · ${money(Math.round(Math.max(bal, 0) * (a.apy || 0) / 100))}/yr interest</div></div>` : ''}
    <div class="card stat"><div class="label">Money in · 30 days</div><div class="value">${money(f.in)}</div><div class="sub">Deposits${a.type === 'savings' ? ' and interest' : ''}</div></div>
    <div class="card stat"><div class="label">Money out · 30 days</div><div class="value">${money(f.out)}</div><div class="sub">${a.type === 'checking' ? 'Purchases, withdrawals, fees and card/loan payments' : 'Withdrawals, fees and card/loan payments'}</div></div>
    ${a.type === 'savings' ? `<div class="card stat"><div class="label">Interest earned</div><div class="value">${money(totals.int)}</div><div class="sub">Logged since ${fmtDate(a.startDate)}</div></div>` : ''}`;
}
function renderAccount(a) {
  const L = ledger(a), bal = currentBalance(a), p = payoff(a), nd = nextDue(a);
  const loan = isLoan(a.type), cash = isCash(a.type);
  const totals = L.reduce((s, t) => {
    if (t.type === 'payment') { s.paid += t.amount; s.int += t.interest || 0; }
    if (t.type === 'interest') s.int += t.amount;
    if (t.type === 'purchase') s.purch += t.amount;
    if (t.type === 'deposit') s.dep += t.amount;
    if (t.type === 'withdrawal') s.wd += t.amount;
    if (t.type === 'fee') s.fee += t.amount;
    if (isTransfer(t)) s.xfer += t.type === 'transfer_in' ? t.amount : -t.amount;
    if (t.type === 'debt_payment') s.dpay += t.amount;
    return s;
  }, { paid: 0, int: 0, purch: 0, dep: 0, wd: 0, fee: 0, xfer: 0, dpay: 0 });
  const util = isCard(a.type) && a.creditLimit ? bal / a.creditLimit * 100 : null;
  const filters = ['all', ...txTypesFor(a.type), ...(cash ? ['transfer_out', 'transfer_in', 'debt_payment'] : [])].filter(f => f === 'all' || L.some(t => t.type === f));
  if (!filters.includes(ui.txFilter)) ui.txFilter = 'all';
  const shown = [...L].reverse().filter(t => ui.txFilter === 'all' || t.type === ui.txFilter);

  return `<a class="back" href="#/accounts">← Accounts</a>
  <div class="page-head">
    <div class="detail-head" style="--c:${accColor(a)}"><div class="swatch">${esc(a.name.trim()[0] || '?').toUpperCase()}</div>
      <div><h1>${esc(a.name)}</h1><p>${typeChip(a.type)} ${a.lender ? `<span style="margin-left:6px">${esc(a.lender)}</span>` : ''}</p></div></div>
    <div class="actions">
      ${cash ? `<button class="btn" data-action="add-tx" data-id="${a.id}" data-type="withdrawal">+ ${a.type === 'checking' ? 'Purchase / withdrawal' : 'Withdrawal'}</button>
      <button class="btn primary" data-action="add-tx" data-id="${a.id}" data-type="deposit">+ Deposit</button>
      <button class="btn" data-action="transfer" data-id="${a.id}">⇄ Transfer</button>
      <button class="btn" data-action="pay-debt" data-id="${a.id}">Pay card / loan</button>
      <button class="btn" data-action="add-tx" data-id="${a.id}" data-type="${a.type === 'savings' ? 'interest' : 'fee'}">More…</button>`
      : `${isCard(a.type) ? `<button class="btn" data-action="add-tx" data-id="${a.id}" data-type="purchase">+ Purchase</button>` : ''}
      <button class="btn primary" data-action="add-tx" data-id="${a.id}" data-type="payment">+ Payment</button>
      <button class="btn" data-action="add-tx" data-id="${a.id}" data-type="${isCard(a.type) ? 'interest' : 'fee'}">More…</button>`}
      <button class="btn ghost" data-action="edit-account" data-id="${a.id}">Edit</button>
      <button class="btn ghost" data-action="delete-account" data-id="${a.id}">Delete</button>
    </div>
  </div>
  <div class="grid stats">
    <div class="card stat"><div class="label">Current balance</div><div class="value">${money(bal)}</div><div class="sub">Opening ${money(a.startBalance)} on ${fmtDate(a.startDate)}</div></div>
    ${cash ? cashStats(a, bal, totals) : `<div class="card stat"><div class="label">${hasRate(a.type) ? 'APR / interest rate' : 'APR'}</div><div class="value">${pct(a.apr)}</div><div class="sub">${hasRate(a.type) ? `Note rate ${pct(a.interestRate, 3)} · ` : ''}≈ ${money(Math.round(Math.max(bal, 0) * rateFor(a) / 1200))}/mo interest</div></div>
    ${util != null ? `<div class="card stat"><div class="label">Utilization</div><div class="value">${pct(util, 1)}</div><div class="meter ${util >= 50 ? 'bad' : util >= 30 ? 'warn' : ''}" style="margin-top:8px"><span style="width:${Math.min(Math.max(util, 0), 100)}%"></span></div><div class="sub">${money(Math.max(a.creditLimit - bal, 0))} available</div></div>` : ''}
    <div class="card stat"><div class="label">${isCard(a.type) ? 'Minimum payment' : 'Monthly payment'}</div><div class="value">${a.payment ? money(a.payment) : '—'}</div><div class="sub">${nd ? `Next due ${fmtDate(nd.date, { month: 'short', day: 'numeric' })} · <span class="status ${nd.status}">${STATUS_LABEL[nd.status]}</span>` : a.dueDay ? `Due on day ${a.dueDay}` : 'No due day set'}</div></div>
    <div class="card stat"><div class="label">Payoff at this payment</div><div class="value">${payoffText(p)}</div><div class="sub">${p && !p.never && p.months ? `${payoffDate(p)} · ${money(p.interest)} interest` : a.type === 'mortgage' && a.escrow ? 'Excludes escrow' : '&nbsp;'}</div></div>`}
  </div>
  <div class="grid two-col" style="margin-bottom:16px">
    <div class="card card-pad" style="--c:${accColor(a)}"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Balance history</h2><span class="muted small">After each transaction</span></div>${balanceChart(a, L)}</div>
    <div class="card card-pad"><h2>Totals logged</h2>
      <div class="preview" style="margin-top:12px">${cash ? `
        <div><span>Deposits</span><b>${money(totals.dep)}</b></div>
        <div><span>Withdrawals</span><b>${money(totals.wd)}</b></div>
        <div><span>Interest earned</span><b>${money(totals.int)}</b></div>
        <div><span>Fees</span><b>${money(totals.fee)}</b></div>
        <div><span>Card &amp; loan payments</span><b>${money(totals.dpay)}</b></div>
        <div><span>Transfers (net)</span><b>${totals.xfer < 0 ? '−' : totals.xfer > 0 ? '+' : ''}${money(Math.abs(totals.xfer))}</b></div>` : `
        <div><span>Payments</span><b>${money(totals.paid)}</b></div>
        <div><span>Interest</span><b>${money(totals.int)}</b></div>
        ${isCard(a.type) ? `<div><span>Purchases</span><b>${money(totals.purch)}</b></div>` : `<div><span>Principal paid</span><b>${money(L.filter(t => t.type === 'payment').reduce((s, t) => s - t.effect, 0))}</b></div>`}
        ${a.type === 'mortgage' ? `<div><span>Escrow</span><b>${money(L.reduce((s, t) => s + (t.escrow || 0), 0))}</b></div>` : ''}`}
      </div>
      ${a.notes ? `<p class="muted small" style="margin:14px 0 0;white-space:pre-wrap">${esc(a.notes)}</p>` : ''}
    </div>
  </div>
  ${renderDocuments(a)}
  <div class="card">
    <div class="card-head"><h2>Transactions</h2>
      <div class="filters">${filters.map(f => `<button data-action="filter" data-type="${f}" class="${ui.txFilter === f ? 'on' : ''}">${f === 'all' ? 'All' : txLabel(f, a.type)}</button>`).join('')}</div></div>
    <div class="table-wrap" style="margin-top:10px"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Amount</th>
        ${loan ? `<th class="num">Interest</th>${a.type === 'mortgage' ? '<th class="num">Escrow</th>' : ''}<th class="num">Principal</th>` : '<th class="num">Change</th>'}
        <th class="num">Balance after</th><th></th></tr></thead>
      <tbody>
        ${shown.map(t => `<tr>
          <td class="num" style="text-align:left">${fmtDate(t.date)}</td>
          <td><span class="chip">${txLabel(t.type, a.type)}</span></td>
          <td>${t.counterAccountId ? esc(txDesc(t, a.type)) : esc(t.memo) || '<span class="muted">—</span>'}</td>
          <td class="num">${money(t.amount)}</td>
          ${loan ? `<td class="num">${t.type === 'payment' ? money(t.interest || 0) : '—'}</td>${a.type === 'mortgage' ? `<td class="num">${t.type === 'payment' ? money(t.escrow || 0) : '—'}</td>` : ''}` : ''}
          <td class="num ${changeCls(t.effect, a.type)}">${t.effect > 0 ? '+' : t.effect < 0 ? '−' : ''}${money(Math.abs(t.effect))}</td>
          <td class="num"><b>${money(t.balanceAfter)}</b></td>
          <td class="num"><button class="icon-btn" data-action="edit-tx" data-id="${t.id}">Edit</button><button class="icon-btn del" data-action="delete-tx" data-id="${t.id}">Delete</button></td>
        </tr>`).join('')}
        ${ui.txFilter === 'all' ? `<tr class="opening"><td class="num" style="text-align:left">${fmtDate(a.startDate)}</td><td><span class="chip">Opening</span></td><td>Starting balance</td><td class="num"></td>${loan ? `<td></td>${a.type === 'mortgage' ? '<td></td>' : ''}<td></td>` : '<td></td>'}<td class="num"><b>${money(a.startBalance)}</b></td><td></td></tr>` : ''}
        ${!shown.length && ui.txFilter !== 'all' ? `<tr><td colspan="9" class="muted">No matching transactions.</td></tr>` : ''}
      </tbody></table></div>
  </div>`;
}

function balanceChart(a, L) {
  const pts = [{ date: a.startDate, bal: a.startBalance }, ...L.map(t => ({ date: t.date, bal: t.balanceAfter }))];
  const end = todayISO() > pts[pts.length - 1].date ? todayISO() : pts[pts.length - 1].date;
  pts.push({ date: end, bal: pts[pts.length - 1].bal });
  const W = 600, H = 170, padL = 8, padR = 8, padT = 12, padB = 22;
  const x0 = dayNum(pts[0].date), x1 = Math.max(dayNum(end), x0 + 1);
  const vals = pts.map(p => p.bal);
  // Zoom the y-axis to the data range so small movements on large loans stay visible.
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, Math.abs(hi) * 0.02, 100);
  lo = Math.max(lo - span * 0.25, Math.min(0, lo)); hi = hi + span * 0.1;
  const X = d => padL + (dayNum(d) - x0) / (x1 - x0) * (W - padL - padR);
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  let path = `M${X(pts[0].date)},${Y(pts[0].bal)}`;
  for (let i = 1; i < pts.length; i++) path += ` H${X(pts[i].date)} V${Y(pts[i].bal)}`;   // step line
  const area = `${path} V${Y(lo)} H${X(pts[0].date)} Z`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Balance over time">
    <line class="grid-line" x1="0" x2="${W}" y1="${Y(hi)}" y2="${Y(hi)}"/><line class="grid-line" x1="0" x2="${W}" y1="${Y(lo)}" y2="${Y(lo)}"/>
    <path class="area" d="${area}"/><path class="line" d="${path}" vector-effect="non-scaling-stroke"/>
  </svg><div style="display:flex;justify-content:space-between" class="muted small"><span>${fmtDate(pts[0].date)}</span><span>${moneyShort(Math.min(...vals))} – ${moneyShort(Math.max(...vals))}</span><span>${fmtDate(end)}</span></div>`;
}

function renderCalendar() {
  const t = new Date();
  if (ui.calY == null) { ui.calY = t.getFullYear(); ui.calM = t.getMonth(); }
  const y = ui.calY, m = ui.calM, today = todayISO();
  const first = new Date(y, m, 1).getDay();
  const start = addDays(ymd(y, m, 1), -first);
  const cells = Array.from({ length: Math.ceil((first + daysInMonth(y, m)) / 7) * 7 }, (_, i) => addDays(start, i));

  // Gather due entries for every month the grid touches.
  const months = new Set(cells.map(d => d.slice(0, 7)));
  const dues = {};
  months.forEach(ym => {
    const [yy, mm] = parts(ym + '-01');
    state.accounts.forEach(a => { const e = dueEntry(a, yy, mm - 1, today); if (e) (dues[e.date] ||= []).push(e); });
  });
  const txByDay = {};
  state.transactions.forEach(tx => { if (getAcc(tx.accountId)) (txByDay[tx.date] ||= []).push(tx); });

  const sel = ui.calSel && ui.calSel.slice(0, 7) === `${y}-${pad(m + 1)}` ? ui.calSel : null;
  const monthDues = Object.values(dues).flat().filter(e => e.date.slice(0, 7) === `${y}-${pad(m + 1)}`).sort((a, b) => a.date.localeCompare(b.date));
  const monthTotal = monthDues.reduce((s, e) => s + e.required, 0);

  const side = sel ? (() => {
    const ds = dues[sel] || [], txs = (txByDay[sel] || []).sort(cmpTx);
    return `<div class="card-head"><h2>${fmtDate(sel, { weekday: 'long', month: 'long', day: 'numeric' })}</h2><button class="btn ghost xs" data-action="cal-day" data-date="">Month</button></div>
      ${ds.length ? `<ul class="list">${ds.map(dueItem).join('')}</ul>` : ''}
      ${txs.length ? `<h3 class="muted" style="padding:10px 20px 0">Logged</h3><ul class="list">${txs.map(tx => { const a = getAcc(tx.accountId); return `<li data-action="open-account" data-id="${a.id}" style="cursor:pointer"><span class="dot" style="background:${accColor(a)}"></span><div class="grow"><b>${txLabel(tx.type, a.type)}${tx.memo ? ' · ' + esc(tx.memo) : ''}</b><span class="muted small">${esc(a.name)}</span></div><div class="right">${money(tx.amount)}</div></li>`; }).join('')}</ul>` : ''}
      ${!ds.length && !txs.length ? '<div class="empty-line">Nothing due or logged on this day.</div>' : ''}`;
  })() : `<div class="card-head"><h2>Due in ${MONTHS[m]}</h2><span class="muted small">${money(monthTotal)}</span></div>
      ${monthDues.length ? `<ul class="list">${monthDues.map(dueItem).join('')}</ul>` : '<div class="empty-line">No payments due this month.</div>'}`;

  return `<div class="page-head"><div><h1>Calendar</h1><p>Payment due dates and logged activity for every account.</p></div></div>
  ${state.accounts.length ? '' : emptyState()}
  <div class="grid cal-wrap">
    <div class="card">
      <div class="cal-head">
        <h2>${MONTHS[m]} ${y}</h2>
        <div class="actions"><button class="btn sm" data-action="cal-nav" data-type="-1" aria-label="Previous month">‹</button><button class="btn sm" data-action="cal-nav" data-type="0">Today</button><button class="btn sm" data-action="cal-nav" data-type="1" aria-label="Next month">›</button></div>
      </div>
      <div class="cal">
        ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="dow">${d}</div>`).join('')}
        ${cells.map(d => {
          const ds = dues[d] || [], txs = txByDay[d] || [];
          const cls = ['day', d.slice(0, 7) !== `${y}-${pad(m + 1)}` && 'out', d === today && 'today', d === sel && 'sel'].filter(Boolean).join(' ');
          return `<button class="${cls}" data-action="cal-day" data-date="${d}">
            <span class="dnum">${parts(d)[2]}</span>
            ${ds.map(e => `<span class="ev ${e.status}" style="--c:${accColor(e.acc)}" title="${esc(e.acc.name)} — ${STATUS_LABEL[e.status]}"><span class="t">${esc(e.acc.name)}</span></span>`).join('')}
            ${txs.length ? `<span class="pdots">${txs.slice(0, 8).map(tx => `<i class="${tx.type === 'payment' || tx.type === 'deposit' ? '' : 'purchase'}" title="${txLabel(tx.type, getAcc(tx.accountId).type)} ${money(tx.amount)}"></i>`).join('')}</span>` : ''}
          </button>`; }).join('')}
      </div>
      <div class="cal-legend">
        <span><span class="status upcoming">Upcoming</span></span><span><span class="status soon">Due soon</span></span><span><span class="status paid">Paid</span></span><span><span class="status overdue">Overdue</span></span>
        <span><span class="dot" style="background:var(--ok)"></span>Payment logged</span><span><span class="dot" style="background:var(--muted)"></span>Other transaction</span>
      </div>
    </div>
    <div class="card">${side}</div>
  </div>`;
}

/* ---------- modal helpers ---------- */
const modal = $('#modal');
function openModal(html) { modal.returnValue = ''; modal.innerHTML = html; modal.showModal(); const f = modal.querySelector('input:not([type=radio]):not([type=hidden]),select'); f && f.focus(); return modal; }
const closeModal = () => modal.close();
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
function confirmBox(title, msg, ok = 'Delete') {
  return new Promise(res => {
    openModal(`<form method="dialog" class="modal-body"><header><h2>${esc(title)}</h2><p>${msg}</p></header>
      <footer><button class="btn" value="cancel">Cancel</button><button class="btn danger" value="ok">${esc(ok)}</button></footer></form>`);
    modal.addEventListener('close', () => res(modal.returnValue === 'ok'), { once: true });
  });
}
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400); }
const moneyField = (name, val, extra = '') => `<div class="affix"><span class="pre">$</span><input class="has-pre" name="${name}" inputmode="decimal" autocomplete="off" value="${esc(val)}" ${extra}></div>`;
const pctField = (name, val, extra = '') => `<div class="affix"><span class="suf">%</span><input class="has-suf" name="${name}" inputmode="decimal" autocomplete="off" value="${val ?? ''}" ${extra}></div>`;

/* ---------- documents (PDFs stored on the server, metadata in data.json) ---------- */
const PDF_MAX = 25 * 1024 * 1024;
const agreementLabel = t => t === 'credit_card' ? 'Cardholder agreement' : t === 'mortgage' ? 'Mortgage note / agreement' : isCash(t) ? 'Account agreement' : 'Loan agreement';
const docsFor = (accId, kind) => state.documents.filter(d => d.accountId === accId && (!kind || d.kind === kind));
const fmtSize = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
const monthLabel = ym => { const [y, m] = parts(ym + '-01'); return `${MONTHS[m - 1]} ${y}`; };
const fileUrl = d => `api/files/${d.id}?name=${encodeURIComponent(d.name)}`;
function pdfProblem(file) {
  if (!file) return '';
  if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) return 'Choose a PDF file.';
  if (file.size > PDF_MAX) return 'PDF must be 25 MB or smaller.';
  return '';
}
async function uploadPdf(file) {
  let r;
  try { r = await api('api/files', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file }); }
  catch { throw new Error('Upload failed — cannot reach the server.'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 413 && !j.error) throw new Error('The file was rejected as too large (check your reverse proxy\'s upload limit).');
  if (!r.ok) throw new Error(j.error || `Upload failed (${r.status}).`);
  return j;
}
function addDocument(accountId, kind, file, uploaded, extra = {}) {
  state.documents.push({ id: uploaded.id, accountId, kind, name: file.name, size: uploaded.size, createdAt: Date.now(), updatedAt: Date.now(), ...extra });
}
const deleteFile = id => api(`api/files/${id}`, { method: 'DELETE' }).catch(() => { /* tidied up on the server later */ });

function renderDocuments(a) {
  const agreements = docsFor(a.id, 'agreement').sort((x, y) => y.createdAt - x.createdAt);
  const statements = docsFor(a.id, 'statement').sort((x, y) => (y.period || '').localeCompare(x.period || '') || y.createdAt - x.createdAt);
  const row = (d, title, sub) => `<li>
    <span class="pdf-ico" aria-hidden="true">PDF</span>
    <div class="grow"><a href="${fileUrl(d)}" target="_blank" rel="noopener"><b>${esc(title)}</b></a><span class="muted small">${sub}</span></div>
    <a class="icon-btn" href="${fileUrl(d)}" target="_blank" rel="noopener">View</a>
    <button class="icon-btn del" data-action="delete-doc" data-id="${d.id}">Delete</button></li>`;
  const meta = d => `${esc(d.name)} · ${fmtSize(d.size)}`;
  const agrTitle = agreementLabel(a.type);
  return `<div class="grid docs" style="margin-bottom:16px">
    <div class="card">
      <div class="card-head"><h2>${agrTitle}</h2><button class="btn sm" data-action="add-doc" data-id="${a.id}" data-type="agreement">+ Upload</button></div>
      ${agreements.length ? `<ul class="list doc-list">${agreements.map(d => row(d, d.note || d.name, `${d.note ? meta(d) : fmtSize(d.size)} · added ${fmtDate(new Date(d.createdAt).toISOString().slice(0, 10))}`)).join('')}</ul>`
        : '<div class="empty-line">No agreement uploaded.</div>'}
    </div>
    <div class="card">
      <div class="card-head"><h2>Monthly statements</h2><button class="btn sm" data-action="add-doc" data-id="${a.id}" data-type="statement">+ Upload</button></div>
      ${statements.length ? `<ul class="list doc-list">${statements.map(d => row(d, d.period ? monthLabel(d.period) : d.name, `${meta(d)}${d.note ? ' · ' + esc(d.note) : ''}`)).join('')}</ul>`
        : '<div class="empty-line">No statements uploaded.</div>'}
    </div>
  </div>`;
}

function openDocDialog(acc, kind) {
  const isStmt = kind === 'statement';
  const t = new Date(); const prev = new Date(t.getFullYear(), t.getMonth() - 1, 1);
  const defMonth = `${prev.getFullYear()}-${pad(prev.getMonth() + 1)}`;
  openModal(`<form class="modal-body" id="docForm" novalidate>
    <header><h2>Upload ${isStmt ? 'monthly statement' : 'agreement'}</h2><p>${esc(acc.name)}</p></header>
    <label class="f">PDF file <span class="hint">Up to 25 MB</span><input type="file" name="file" accept="application/pdf,.pdf" required></label>
    ${isStmt ? `<label class="f">Statement month<input type="month" name="period" required value="${defMonth}"></label>` : ''}
    <label class="f">${isStmt ? 'Note' : 'Title'} <span class="hint">Optional${isStmt ? '' : ' — e.g. Original agreement, Rate modification'}</span><input name="note" maxlength="80"></label>
    <p class="error" id="docErr"></p>
    <footer><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary">Upload</button></footer>
  </form>`);
  const f = $('#docForm');
  f.onsubmit = async e => {
    e.preventDefault();
    const err = m => { $('#docErr').textContent = m; };
    const file = f.file.files[0];
    if (!file) return err('Choose a PDF to upload.');
    const problem = pdfProblem(file); if (problem) return err(problem);
    if (isStmt && !/^\d{4}-\d{2}$/.test(f.period.value)) return err('Choose the statement month.');
    if (isStmt && docsFor(acc.id, 'statement').some(d => d.period === f.period.value) && !f.dataset.dupOk) {
      f.dataset.dupOk = '1'; return err(`A statement for ${monthLabel(f.period.value)} already exists. Click Upload again to add another.`);
    }
    const btn = f.querySelector('footer .primary'); btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const up = await uploadPdf(file);
      addDocument(acc.id, kind, file, up, { ...(isStmt ? { period: f.period.value } : {}), ...(f.note.value.trim() ? { note: f.note.value.trim() } : {}) });
      save(); closeModal(); toast(isStmt ? 'Statement uploaded' : 'Agreement uploaded'); rerender();
    } catch (x) { err(x.message); btn.disabled = false; btn.textContent = 'Upload'; }
  };
}

/* ---------- account form ---------- */
function openAccountDialog(acc) {
  const editing = !!acc;
  const a = acc || { type: 'credit_card', name: '', lender: '', startBalance: null, startDate: todayISO(), apr: null, apy: null, interestRate: null, creditLimit: null, payment: null, dueDay: null, originalAmount: null, termMonths: null, escrow: null, color: '', notes: '' };
  const hasTx = editing && state.transactions.some(t => t.accountId === a.id);
  openModal(`<form class="modal-body" id="accForm" novalidate>
    <header><h2>${editing ? 'Edit account' : 'Add account'}</h2><p>${editing ? esc(a.name) : 'Choose the type of account and enter its details.'}</p></header>
    <div class="type-tiles">${Object.entries(TYPES).map(([k, v]) => `<label><input type="radio" name="type" value="${k}" ${a.type === k ? 'checked' : ''}><span class="tile" style="--c:${v.color}"><i></i>${v.label}</span></label>`).join('')}</div>
    <div class="form-grid">
      <label class="f full">Account name<input name="name" required maxlength="60" value="${esc(a.name)}" placeholder="e.g. Rewards Visa"></label>
      <label class="f full"><span><span id="lenderLabel">Lender / issuer</span> <span class="hint">Optional</span></span><input name="lender" maxlength="60" value="${esc(a.lender)}"></label>
      <label class="f">${hasTx ? 'Opening balance' : 'Current balance'}${moneyField('startBalance', centsIn(a.startBalance), 'required')}</label>
      <label class="f">Balance as of<input type="date" name="startDate" required value="${a.startDate}"></label>
      <label class="f" data-types="credit_card personal_loan auto_loan mortgage">APR${pctField('apr', a.apr)}</label>
      <label class="f" data-types="savings">APY <span class="hint">Annual percentage yield</span>${pctField('apy', a.apy)}</label>
      <label class="f" data-types="mortgage auto_loan">Interest rate <span class="hint">Note rate used to compute interest</span>${pctField('interestRate', a.interestRate)}</label>
      <label class="f" data-types="credit_card">Credit limit <span class="hint">Optional</span>${moneyField('creditLimit', centsIn(a.creditLimit))}</label>
      <label class="f" data-types="personal_loan auto_loan mortgage">Original amount <span class="hint">Optional</span>${moneyField('originalAmount', centsIn(a.originalAmount))}</label>
      <label class="f" data-types="personal_loan auto_loan mortgage">Term (months) <span class="hint">Optional</span><input name="termMonths" inputmode="numeric" value="${a.termMonths ?? ''}"></label>
      <label class="f" data-types="mortgage">Escrow per payment <span class="hint">Taxes &amp; insurance</span>${moneyField('escrow', centsIn(a.escrow))}</label>
      <label class="f" data-types="credit_card personal_loan auto_loan mortgage"><span id="payLabel">Minimum payment</span>
        <div class="inline">${moneyField('payment', centsIn(a.payment))}<button type="button" class="btn sm" id="calcPay" data-types="personal_loan auto_loan mortgage" title="Compute from original amount, rate and term">Calc</button></div></label>
      <label class="f" data-types="credit_card personal_loan auto_loan mortgage">Due day of month <span class="hint">1–31 (shortened in shorter months)</span><input name="dueDay" type="number" min="1" max="31" value="${a.dueDay ?? ''}"></label>
      <label class="f">Color<input type="color" name="color" value="${a.color || TYPES[a.type].color}" style="height:38px;padding:4px"></label>
      <label class="f full">Notes <span class="hint">Optional</span><textarea name="notes" maxlength="500">${esc(a.notes)}</textarea></label>
      <label class="f full"><span><span id="agrLabel">Loan agreement</span> (PDF) <span class="hint">Optional · up to 25 MB${editing && docsFor(a.id, 'agreement').length ? ` · ${docsFor(a.id, 'agreement').length} already uploaded` : ''}</span></span><input type="file" name="agreement" accept="application/pdf,.pdf"></label>
    </div>
    <p class="note" id="calcNote"></p>
    <p class="error" id="accErr"></p>
    <footer><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary">${editing ? 'Save changes' : 'Add account'}</button></footer>
  </form>`);
  const f = $('#accForm');
  let colorTouched = !!a.color;
  const sync = () => {
    const type = f.type.value;
    $$('[data-types]', f).forEach(el => el.hidden = !el.dataset.types.split(' ').includes(type));
    $('#payLabel').textContent = type === 'credit_card' ? 'Minimum payment' : type === 'mortgage' ? 'Monthly payment (incl. escrow)' : 'Monthly payment';
    if (!colorTouched) f.color.value = TYPES[type].color;
    $('#agrLabel').textContent = agreementLabel(type);
    $('#lenderLabel').textContent = isCash(type) ? 'Bank / institution' : 'Lender / issuer';
    f.name.placeholder = type === 'checking' ? 'e.g. Everyday Checking' : type === 'savings' ? 'e.g. High-Yield Savings' : 'e.g. Rewards Visa';
  };
  f.addEventListener('change', e => { if (e.target.name === 'type') sync(); if (e.target.name === 'color') colorTouched = true; });
  sync();
  $('#calcPay').onclick = () => {
    const type = f.type.value;
    const P = toCents(f.originalAmount.value), n = parseInt(f.termMonths.value, 10);
    const rate = hasRate(type) ? toNum(f.interestRate.value) : toNum(f.apr.value);
    const pay = amortPayment(P, rate, n);
    if (isNaN(pay) || isNaN(rate)) { $('#calcNote').textContent = 'Enter the original amount, term, and rate to calculate the payment.'; return; }
    const esc_ = type === 'mortgage' ? (toCents(f.escrow.value) || 0) : 0;
    f.payment.value = centsIn(pay + esc_);
    $('#calcNote').textContent = `Principal & interest: ${money(pay)}${esc_ ? ` + escrow ${money(esc_)}` : ''} (${n} months at ${pct(rate, 3)}).`;
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const type = f.type.value, err = m => { $('#accErr').textContent = m; };
    const file = f.agreement.files[0];
    const d = {
      type, name: f.name.value.trim(), lender: f.lender.value.trim(),
      startBalance: toCents(f.startBalance.value), startDate: f.startDate.value,
      apr: isCash(type) ? null : toNum(f.apr.value), apy: type === 'savings' ? toNum(f.apy.value) : null,
      interestRate: hasRate(type) ? toNum(f.interestRate.value) : null,
      creditLimit: type === 'credit_card' && f.creditLimit.value.trim() ? toCents(f.creditLimit.value) : null,
      originalAmount: isLoan(type) && f.originalAmount.value.trim() ? toCents(f.originalAmount.value) : null,
      termMonths: isLoan(type) && f.termMonths.value.trim() ? parseInt(f.termMonths.value, 10) : null,
      escrow: type === 'mortgage' && f.escrow.value.trim() ? toCents(f.escrow.value) : null,
      payment: !isCash(type) && f.payment.value.trim() ? toCents(f.payment.value) : null,
      dueDay: !isCash(type) && f.dueDay.value.trim() ? parseInt(f.dueDay.value, 10) : null,
      color: colorTouched ? f.color.value : '', notes: f.notes.value.trim(),
    };
    if (!d.name) return err('Enter an account name.');
    if (isNaN(d.startBalance)) return err('Enter a valid balance.');
    if (!d.startDate) return err('Enter the date the balance is as of.');
    if (!isCash(type) && (isNaN(d.apr) || d.apr < 0 || d.apr > 100)) return err('APR must be between 0 and 100.');
    if (type === 'savings' && (isNaN(d.apy) || d.apy < 0 || d.apy > 100)) return err('APY is required for savings accounts (0–100; enter 0 if none).');
    if (hasRate(type) && (isNaN(d.interestRate) || d.interestRate < 0 || d.interestRate > 100)) return err('Interest rate is required for mortgages and auto loans (0–100).');
    for (const k of ['creditLimit', 'originalAmount', 'escrow', 'payment']) if (d[k] != null && (isNaN(d[k]) || d[k] < 0)) return err('Check the dollar amounts — they must be valid, non-negative numbers.');
    if (d.termMonths != null && !(d.termMonths > 0)) return err('Term must be a positive number of months.');
    if (d.dueDay != null && !(d.dueDay >= 1 && d.dueDay <= 31)) return err('Due day must be between 1 and 31.');
    if (editing) {
      const early = state.transactions.find(t => t.accountId === a.id && t.date < d.startDate);
      if (early) return err(`A transaction is dated ${fmtDate(early.date)}, before the new balance date. Move the date earlier.`);
      if (a.type !== type && hasTx && isCash(a.type) !== isCash(type)) return err(`A ${isCash(a.type) ? 'cash' : 'debt'} account with transactions can't become a ${isCash(type) ? 'cash' : 'debt'} account: deposits and payments would change meaning.`);
      if (a.type !== type) {
        const bad = state.transactions.find(t => t.accountId === a.id && !txTypesFor(type).includes(t.type) && !(isCash(type) && (isTransfer(t) || t.type === 'debt_payment')));
        if (bad) return err(`This account has ${txLabel(bad.type, a.type).toLowerCase()} entries that a ${TYPES[type].label.toLowerCase()} account can't hold.`);
      }
    }
    const fileErr = pdfProblem(file); if (fileErr) return err(fileErr);
    const accId = editing ? a.id : uid();
    let doc = null;
    if (file) {
      const btn = f.querySelector('footer .primary'); btn.disabled = true; btn.textContent = 'Uploading…';
      try { doc = await uploadPdf(file); }
      catch (x) { btn.disabled = false; btn.textContent = editing ? 'Save changes' : 'Add account'; return err(x.message); }
    }
    if (editing) touch(Object.assign(acc, d));
    else state.accounts.push({ id: accId, createdAt: Date.now(), updatedAt: Date.now(), ...d });
    if (doc) addDocument(accId, 'agreement', file, doc);
    save(); closeModal(); toast(editing ? 'Account updated' : 'Account added');
    if (!editing) location.hash = `#/account/${accId}`; else rerender();
  };
}

/* ---------- transaction form ---------- */
// opts.payFrom: preselect a cash account to pay a debt from (used by "Pay card / loan" on cash accounts).
function openTxDialog(acc, tx, presetType, opts = {}) {
  const editing = !!tx;
  const types = txTypesFor(acc.type);
  const loan = isLoan(acc.type);
  const t = tx || { type: types.includes(presetType) ? presetType : types.includes('payment') ? 'payment' : types[0], date: todayISO(), amount: null, interest: null, escrow: acc.type === 'mortgage' ? acc.escrow : null, memo: '' };
  // Debt payments can be linked to the cash account they were paid from.
  const linked = tx && tx.transferId ? transferPair(tx) : null;
  const cashAccs = isCash(acc.type) ? [] : state.accounts.filter(a => isCash(a.type));
  const lastFrom = () => { const p = txsFor(acc.id).filter(x => x.type === 'payment' && x.counterAccountId && getAcc(x.counterAccountId)).pop(); return p ? p.counterAccountId : ''; };
  const payFrom0 = editing ? (linked ? linked.accountId : '') : (opts.payFrom || lastFrom());
  openModal(`<form class="modal-body" id="txForm" novalidate>
    <header><h2>${editing ? 'Edit transaction' : 'Log transaction'}</h2><p>${esc(acc.name)} · ${TYPES[acc.type].label}</p></header>
    <div class="seg">${types.map(k => `<label><input type="radio" name="type" value="${k}" ${t.type === k ? 'checked' : ''}><span>${txLabel(k, acc.type)}</span></label>`).join('')}</div>
    <div class="form-grid">
      <label class="f">Date<input type="date" name="date" required min="${acc.startDate}" value="${t.date}"></label>
      <label class="f"><span id="amtLabel">Amount</span><div class="inline">${moneyField('amount', centsIn(t.amount == null ? null : Math.abs(t.amount)), 'required')}<button type="button" class="btn sm" id="fillPay" title="Use the account's payment amount">${acc.payment ? 'Use ' + money(acc.payment) : ''}</button></div></label>
      <label class="f" data-when="adjustment">Direction<select name="dir"><option value="1">Increase balance</option><option value="-1" ${t.type === 'adjustment' && t.amount < 0 ? 'selected' : ''}>Decrease balance</option></select></label>
      ${cashAccs.length ? `<label class="f full" data-when="payment">Paid from <span class="hint">Also records the payment in that account</span><select name="payFrom">
        <option value="">Not tracked in Paydown</option>${cashAccs.map(c => `<option value="${c.id}" ${c.id === payFrom0 ? 'selected' : ''}>${esc(c.name)} · ${money(currentBalance(c))}</option>`).join('')}</select></label>` : ''}
      ${loan ? `<label class="f" data-when="payment">Interest portion
        <div class="inline">${moneyField('interest', centsIn(t.interest))}<button type="button" class="btn sm" id="calcInt">Auto</button></div></label>
        ${acc.type === 'mortgage' ? `<label class="f" data-when="payment">Escrow portion${moneyField('escrow', centsIn(t.escrow))}</label>` : ''}` : ''}
      <label class="f full">Description <span class="hint">Optional</span><input name="memo" maxlength="80" value="${esc(t.memo)}" placeholder="e.g. Groceries, March payment"></label>
    </div>
    <p class="note" id="txNote"></p>
    <div class="preview" id="txPrev"></div>
    <p class="error" id="txErr"></p>
    <footer><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary">${editing ? 'Save changes' : 'Log transaction'}</button></footer>
  </form>`);
  const f = $('#txForm');
  let intTouched = editing && tx.type === 'payment';
  const exId = tx?.id;
  const fill = $('#fillPay'); if (!acc.payment) fill.remove();
  const payFromAcc = () => (f.payFrom && f.type.value === 'payment' && f.payFrom.value) ? getAcc(f.payFrom.value) : null;

  const read = () => {
    const type = f.type.value, amount = toCents(f.amount.value);
    const o = { type, date: f.date.value, amount, interest: 0, escrow: 0 };
    if (type === 'adjustment') o.amount = amount * Number(f.dir.value);
    if (type === 'payment' && loan) { o.interest = f.interest.value.trim() ? toCents(f.interest.value) : 0; if (f.escrow) o.escrow = f.escrow.value.trim() ? toCents(f.escrow.value) : 0; }
    return o;
  };
  const autoInterest = () => {
    if (!(loan && f.type.value === 'payment' && f.date.value)) return;
    const s = suggestLoanInterest(acc, f.date.value, exId);
    f.interest.value = centsIn(s.cents);
    $('#txNote').textContent = `Interest: ${s.why}. Edit to match your statement if it differs.`;
  };
  const update = () => {
    const type = f.type.value;
    $$('[data-when]', f).forEach(el => el.hidden = el.dataset.when !== type);
    if (fill) fill.hidden = type !== 'payment';
    $('#amtLabel').textContent = type === 'interest' ? (isCash(acc.type) ? 'Interest earned' : 'Interest charged') : type === 'payment' && loan ? 'Total payment' : 'Amount';
    if (type === 'payment' && loan && !intTouched) autoInterest();
    else if (type === 'interest' && f.date.value && (isCard(acc.type) || (acc.type === 'savings' && acc.apy > 0))) {
      const s = isCard(acc.type) ? estimateCardInterest(acc, f.date.value, exId) : estimateSavingsInterest(acc, f.date.value, exId);
      $('#txNote').innerHTML = `Estimate: <b>${money(s.cents)}</b> — ${esc(s.why)}. <button type="button" class="btn xs" id="useEst">Use estimate</button> Use the exact figure from your statement when you have it.`;
      $('#useEst').onclick = () => { f.amount.value = centsIn(s.cents); update(); };
    } else if (!(type === 'payment' && loan)) $('#txNote').textContent = '';
    const o = read(), prev = $('#txPrev');
    if (!o.date || isNaN(o.amount)) { prev.innerHTML = `<div><span>Balance before</span><b>${o.date ? money(balanceOn(acc, o.date, exId)) : '—'}</b></div>`; return; }
    const before = balanceOn(acc, o.date, exId), eff = effect(o, acc.type), after = before + eff;
    const later = txsFor(acc.id, exId).some(x => x.date > o.date);
    const from = payFromAcc(), fromBefore = from && balanceOn(from, o.date, linked?.id);
    prev.innerHTML = `<div><span>Balance before</span><b>${money(before)}</b></div>
      ${type === 'payment' && loan ? `<div><span>Principal</span><b class="${-eff < 0 ? 'pos' : ''}">${money(-eff)}</b></div>` : ''}
      <div><span>Balance after</span><b>${money(after)}</b></div>
      ${from ? `<div><span>${esc(from.name)}</span><b>${money(fromBefore)} → ${money(fromBefore - o.amount)}</b></div>` : ''}
      ${later ? '<div><span>&nbsp;</span><b class="muted small" style="font-weight:500">Later entries will be recalculated</b></div>' : ''}`;
  };
  f.addEventListener('input', e => { if (e.target.name === 'interest') intTouched = true; if (e.target.name === 'date' && !editing) intTouched = false; update(); });
  f.addEventListener('change', update);
  if (loan) $('#calcInt').onclick = () => { intTouched = true; autoInterest(); update(); };
  if (fill) fill.onclick = () => { f.amount.value = centsIn(acc.payment); update(); };
  update();
  if (!editing) f.amount.focus();

  f.onsubmit = e => {
    e.preventDefault();
    const o = read(), err = m => { $('#txErr').textContent = m; };
    const from = payFromAcc();
    if (!o.date) return err('Choose a date.');
    if (o.date < acc.startDate) return err(`Date can't be before the account's balance date (${fmtDate(acc.startDate)}).`);
    if (from && o.date < from.startDate) return err(`Date can't be before ${from.name}'s balance date (${fmtDate(from.startDate)}).`);
    if (isNaN(o.amount) || o.amount === 0 || (o.type !== 'adjustment' && o.amount < 0)) return err('Enter an amount greater than zero.');
    if (isNaN(o.interest) || o.interest < 0 || isNaN(o.escrow) || o.escrow < 0) return err('Interest and escrow must be zero or more.');
    if (o.interest + o.escrow > o.amount) return err('Interest + escrow can\'t exceed the total payment.');
    const rec = { ...o, memo: f.memo.value.trim() };
    if (!(o.type === 'payment' && loan)) { delete rec.interest; delete rec.escrow; }
    let main = tx;
    if (editing) { delete tx.interest; delete tx.escrow; touch(Object.assign(tx, rec)); }
    else { main = { id: uid(), accountId: acc.id, createdAt: Date.now(), updatedAt: Date.now(), ...rec }; state.transactions.push(main); }
    // Keep the linked cash-side entry in step: create, update, or remove it.
    if (from) {
      const side = { accountId: from.id, type: 'debt_payment', date: o.date, amount: o.amount, memo: rec.memo, counterAccountId: acc.id };
      if (linked) touch(Object.assign(linked, side));
      else {
        main.transferId = main.transferId || uid();
        state.transactions.push({ id: uid(), createdAt: Date.now(), updatedAt: Date.now(), transferId: main.transferId, ...side });
      }
      touch(Object.assign(main, { counterAccountId: from.id }));
    } else if (linked) {
      tombstone(linked.id); state.transactions = state.transactions.filter(x => x.id !== linked.id);
      delete main.transferId; delete main.counterAccountId; touch(main);
    }
    save(); closeModal();
    toast(editing ? 'Transaction updated' : from ? `Paid ${money(o.amount)} from ${from.name}` : `${txLabel(o.type, acc.type)} logged`); rerender();
  };
}

// From a checking/savings account: pick which card or loan to pay, then open its payment form.
function openPayDebtPicker(cashAcc) {
  const debts = state.accounts.filter(a => !isCash(a.type));
  if (!debts.length) { toast('Add a credit card or loan first.'); return; }
  openModal(`<div class="modal-body">
    <header><h2>Pay a card or loan</h2><p>From ${esc(cashAcc.name)} · ${money(currentBalance(cashAcc))}</p></header>
    <ul class="list pick-list">${debts.map(d => { const nd = nextDue(d); return `<li><button type="button" class="pick" data-action="pay-debt-pick" data-id="${d.id}" data-from="${cashAcc.id}">
      <span class="dot" style="background:${accColor(d)}"></span>
      <span class="grow"><b>${esc(d.name)}</b><span class="muted small">${TYPES[d.type].label} · ${money(currentBalance(d))}${nd ? ` · due ${fmtDate(nd.date, { month: 'short', day: 'numeric' })}` : ''}</span></span>
      <span class="right">${d.payment ? money(d.payment) : ''}</span></button></li>`; }).join('')}</ul>
    <footer><button type="button" class="btn" data-action="close">Cancel</button></footer>
  </div>`);
}

/* ---------- transfers between cash accounts ---------- */
function openTransferDialog(acc, tx) {
  const cash = state.accounts.filter(a => isCash(a.type));
  if (cash.length < 2) { toast('Add another checking or savings account to transfer between them.'); return; }
  const editing = !!tx, pair = tx && transferPair(tx);
  const out = editing ? (tx.type === 'transfer_out' ? tx : pair) : null;
  const inn = editing ? (tx.type === 'transfer_in' ? tx : pair) : null;
  const fromId = out ? out.accountId : acc.id;
  const toId = inn ? inn.accountId : (cash.find(a => a.id !== fromId) || {}).id;
  const opts = sel => cash.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)} · ${money(currentBalance(a))}</option>`).join('');
  openModal(`<form class="modal-body" id="xfForm" novalidate>
    <header><h2>${editing ? 'Edit transfer' : 'Transfer money'}</h2><p>Moves money between your checking and savings accounts.</p></header>
    <div class="form-grid">
      <label class="f">From<select name="from">${opts(fromId)}</select></label>
      <label class="f">To<select name="to">${opts(toId)}</select></label>
      <label class="f">Date<input type="date" name="date" required value="${(out || inn)?.date || todayISO()}"></label>
      <label class="f">Amount${moneyField('amount', centsIn(out?.amount ?? null), 'required')}</label>
      <label class="f full">Description <span class="hint">Optional</span><input name="memo" maxlength="80" value="${esc(out?.memo || '')}" placeholder="e.g. Monthly savings"></label>
    </div>
    <div class="preview" id="xfPrev"></div>
    <p class="error" id="xfErr"></p>
    <footer><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary">${editing ? 'Save changes' : 'Transfer'}</button></footer>
  </form>`);
  const f = $('#xfForm'), err = m => { $('#xfErr').textContent = m; };
  const read = () => ({ from: getAcc(f.from.value), to: getAcc(f.to.value), date: f.date.value, amount: toCents(f.amount.value), memo: f.memo.value.trim() });
  const update = () => {
    const o = read(), ok = o.date && !isNaN(o.amount) && o.amount > 0;
    // balances on the transfer date, leaving out this transfer's existing entries
    const side = (a, sign, exId) => { const before = balanceOn(a, o.date, exId); return `<div><span>${esc(a.name)}</span><b>${money(before)} → ${ok ? money(before + sign * o.amount) : '…'}</b></div>`; };
    $('#xfPrev').innerHTML = o.from.id === o.to.id ? '<div><span>&nbsp;</span><b class="muted small" style="font-weight:500">Choose two different accounts</b></div>'
      : side(o.from, -1, out?.id) + side(o.to, 1, inn?.id);
  };
  f.addEventListener('input', update); f.addEventListener('change', update); update();
  if (!editing) f.amount.focus();
  f.onsubmit = e => {
    e.preventDefault();
    const o = read();
    if (o.from.id === o.to.id) return err('Choose two different accounts.');
    if (!o.date) return err('Choose a date.');
    const earliest = o.from.startDate > o.to.startDate ? o.from : o.to;
    if (o.date < earliest.startDate) return err(`Date can't be before ${earliest.name}'s balance date (${fmtDate(earliest.startDate)}).`);
    if (isNaN(o.amount) || o.amount <= 0) return err('Enter an amount greater than zero.');
    const common = { date: o.date, amount: o.amount, memo: o.memo };
    if (editing) {
      touch(Object.assign(out, common, { accountId: o.from.id, counterAccountId: o.to.id }));
      touch(Object.assign(inn, common, { accountId: o.to.id, counterAccountId: o.from.id }));
    } else {
      const transferId = uid(), now = Date.now();
      state.transactions.push(
        { id: uid(), accountId: o.from.id, type: 'transfer_out', ...common, transferId, counterAccountId: o.to.id, createdAt: now, updatedAt: now },
        { id: uid(), accountId: o.to.id, type: 'transfer_in', ...common, transferId, counterAccountId: o.from.id, createdAt: now, updatedAt: now });
    }
    save(); closeModal(); toast(editing ? 'Transfer updated' : `Transferred ${money(o.amount)} to ${o.to.name}`); rerender();
  };
}

/* ---------- password ---------- */
function openPasswordDialog() {
  openModal(`<form class="modal-body" id="pwForm" novalidate>
    <header><h2>Change password</h2><p>Other signed-in devices will be signed out.</p></header>
    <input type="text" name="username" autocomplete="username" value="paydown" hidden>
    <label class="f">Current password<input type="password" name="current" autocomplete="current-password" required></label>
    <label class="f">New password <span class="hint">At least 8 characters</span><input type="password" name="new" autocomplete="new-password" minlength="8" required></label>
    <label class="f">Repeat new password<input type="password" name="repeat" autocomplete="new-password" required></label>
    <p class="error" id="pwErr"></p>
    <footer><button type="button" class="btn" data-action="close">Cancel</button><button class="btn primary">Change password</button></footer>
  </form>`);
  const f = $('#pwForm');
  f.onsubmit = async e => {
    e.preventDefault();
    const err = m => { $('#pwErr').textContent = m; };
    if (f.new.value.length < 8) return err('New password must be at least 8 characters.');
    if (f.new.value !== f.repeat.value) return err('New passwords do not match.');
    try {
      const r = await api('api/password', { method: 'POST', body: JSON.stringify({ current: f.current.value, new: f.new.value }) });
      if (!r.ok) return err((await r.json()).error || 'Could not change password.');
      closeModal(); toast('Password changed');
    } catch { err('Cannot reach the server.'); }
  };
}

/* ---------- sample data ---------- */
function loadSample() {
  const T = todayISO(), start = addDays(T, -100);
  const mk = (o) => { const a = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), lender: '', creditLimit: null, originalAmount: null, termMonths: null, escrow: null, interestRate: null, color: '', notes: '', startDate: start, ...o }; state.accounts.push(a); return a; };
  let n = 0;
  const tx = (a, o) => state.transactions.push({ id: uid(), accountId: a.id, createdAt: Date.now() + (n++), updatedAt: Date.now(), memo: '', ...o });
  const pay = (a, date, amount, memo) => {
    const i = suggestLoanInterest(a, date).cents;
    tx(a, { type: 'payment', date, amount, interest: i, escrow: a.type === 'mortgage' ? a.escrow : 0, memo });
  };
  const dues = (a) => { const out = []; const [y, m] = parts(start); for (let k = 0; k < 5; k++) { const d = new Date(y, m - 1 + k, 1); const dd = dueDateFor(a, d.getFullYear(), d.getMonth()); if (dd > start && dd <= T) out.push(dd); } return out; };

  const card = mk({ type: 'credit_card', name: 'Everyday Rewards Card', lender: 'Harbor Bank', startBalance: 248015, apr: 24.99, creditLimit: 800000, payment: 7500, dueDay: 12 });
  [['Groceries', 3, 12844], ['Gas', 9, 4812], ['Streaming', 15, 1599], ['Dinner out', 22, 8673], ['Pharmacy', 38, 2310], ['Groceries', 45, 14219], ['Hardware store', 61, 9645], ['Gas', 70, 5103], ['Groceries', 84, 11730]]
    .forEach(([memo, d, c]) => tx(card, { type: 'purchase', date: addDays(start, d), amount: c, memo }));
  tx(card, { type: 'refund', date: addDays(start, 48), amount: 2310, memo: 'Pharmacy return' });
  dues(card).forEach((d, i) => {
    tx(card, { type: 'interest', date: addDays(d, -21), amount: estimateCardInterest(card, addDays(d, -21)).cents, memo: 'Statement interest' });
    tx(card, { type: 'payment', date: addDays(d, -2), amount: i === 1 ? 20000 : 7500, memo: i === 1 ? 'Extra payment' : 'Monthly payment' });
  });

  const pl = mk({ type: 'personal_loan', name: 'Home Improvement Loan', lender: 'Summit Credit Union', startBalance: 985000, apr: 11.49, originalAmount: 1200000, termMonths: 60, dueDay: 3 });
  pl.payment = amortPayment(pl.originalAmount, pl.apr, pl.termMonths);
  dues(pl).forEach(d => pay(pl, addDays(d, -1), pl.payment, 'Autopay'));

  const auto = mk({ type: 'auto_loan', name: 'Hatchback Loan', lender: 'Metro Auto Finance', startBalance: 2134000, apr: 6.89, interestRate: 6.49, originalAmount: 2800000, termMonths: 72, payment: 47100, dueDay: 20 });
  dues(auto).forEach((d, i) => { pay(auto, d, auto.payment, 'Monthly payment'); if (i === 1) pay(auto, addDays(d, 9), 25000, 'Extra principal'); });

  const mort = mk({ type: 'mortgage', name: 'Home Mortgage', lender: 'Keystone Home Lending', startBalance: 28641237, apr: 6.71, interestRate: 6.5, originalAmount: 30000000, termMonths: 360, escrow: 52000, dueDay: 1 });
  mort.payment = amortPayment(mort.originalAmount, mort.interestRate, mort.termMonths) + mort.escrow;
  dues(mort).forEach(d => pay(mort, d, mort.payment, 'Mortgage payment'));

  const chk = mk({ type: 'checking', name: 'Everyday Checking', lender: 'Harbor Bank', startBalance: 324150 });
  for (let d = 4; d <= 100; d += 14) tx(chk, { type: 'deposit', date: addDays(start, d), amount: 268450, memo: 'Paycheck' });
  [['Groceries', 6, 9312], ['Electric bill', 11, 14260], ['Coffee', 13, 645], ['Gas', 19, 5210], ['Internet', 25, 7999], ['Groceries', 34, 10488],
   ['Phone bill', 41, 6500], ['Pharmacy', 52, 2318], ['Groceries', 63, 8774], ['Electric bill', 71, 12895], ['Gas', 80, 4870], ['Groceries', 91, 9926]]
    .forEach(([memo, d, c]) => tx(chk, { type: 'withdrawal', date: addDays(start, d), amount: c, memo }));
  tx(chk, { type: 'fee', date: addDays(start, 30), amount: 300, memo: 'Out-of-network ATM fee' });

  const sav = mk({ type: 'savings', name: 'High-Yield Savings', lender: 'Summit Credit Union', startBalance: 1250000, apy: 4.1 });
  const [sy, sm] = parts(start);
  for (let k = 0; k < 4; k++) {   // monthly transfer from checking
    const transfer = addDays(start, 15 + k * 30);
    if (transfer > T) continue;
    const transferId = uid();
    tx(chk, { type: 'transfer_out', date: transfer, amount: 50000, memo: 'Monthly savings', transferId, counterAccountId: sav.id });
    tx(sav, { type: 'transfer_in', date: transfer, amount: 50000, memo: 'Monthly savings', transferId, counterAccountId: chk.id });
  }
  for (let k = 0; k < 4; k++) {   // interest credited on the last day of each month, in date order
    const d = new Date(sy, sm + k, 0), last = ymd(d.getFullYear(), d.getMonth(), d.getDate());
    if (last > start && last <= T) tx(sav, { type: 'interest', date: last, amount: estimateSavingsInterest(sav, last).cents, memo: 'Monthly interest' });
  }

  // Card and loan payments come out of checking, as linked pairs.
  const debtIds = [card, pl, auto, mort].map(a => a.id);
  state.transactions.filter(t => t.type === 'payment' && debtIds.includes(t.accountId)).forEach(p => {
    p.transferId = uid(); p.counterAccountId = chk.id;
    tx(chk, { type: 'debt_payment', date: p.date, amount: p.amount, memo: p.memo, transferId: p.transferId, counterAccountId: p.accountId });
  });

  save(); toast('Sample data loaded'); rerender();
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]'); if (!el) return;
  const { action, id, type, date } = el.dataset;
  switch (action) {
    case 'close': closeModal(); break;
    case 'add-account': openAccountDialog(); break;
    case 'edit-account': openAccountDialog(getAcc(id)); break;
    case 'open-account': location.hash = `#/account/${id}`; break;
    case 'delete-account': {
      const a = getAcc(id); const n = state.transactions.filter(t => t.accountId === id).length;
      const docs = docsFor(id);
      const xfers = state.transactions.some(t => t.accountId === id && t.transferId && transferPair(t));
      if (await confirmBox('Delete account?', `“${esc(a.name)}”, its ${n} transaction${n === 1 ? '' : 's'}${docs.length ? ` and ${docs.length} document${docs.length === 1 ? '' : 's'}` : ''} will be permanently removed.${xfers ? ' Linked transfers and payments recorded in other accounts stay there, so their balances don\'t change.' : ''}`)) {
        tombstone(id);
        state.transactions.filter(t => t.accountId === id).forEach(t => tombstone(t.id));
        docs.forEach(d => { tombstone(d.id); deleteFile(d.id); });
        state.accounts = state.accounts.filter(x => x.id !== id);
        state.transactions = state.transactions.filter(t => t.accountId !== id);
        state.documents = state.documents.filter(d => d.accountId !== id);
        save(); toast('Account deleted'); location.hash = '#/accounts';
      }
      break;
    }
    case 'add-tx': openTxDialog(getAcc(id), null, type); break;
    case 'transfer': openTransferDialog(getAcc(id)); break;
    case 'pay-debt': openPayDebtPicker(getAcc(id)); break;
    case 'pay-debt-pick': openTxDialog(getAcc(id), null, 'payment', { payFrom: el.dataset.from }); break;
    case 'edit-tx': {
      const t = state.transactions.find(x => x.id === id), pair = t.transferId && transferPair(t);
      if ((isTransfer(t) || t.type === 'debt_payment') && !pair) toast('The other account was deleted — this entry can only be deleted.');
      else if (isTransfer(t)) openTransferDialog(getAcc(t.accountId), t);
      else if (t.type === 'debt_payment') openTxDialog(getAcc(pair.accountId), pair);   // edit from the debt side (keeps the interest split)
      else openTxDialog(getAcc(t.accountId), t);
      break;
    }
    case 'delete-tx': {
      const t = state.transactions.find(x => x.id === id), pair = t.transferId && transferPair(t);
      const out = t.type === 'transfer_out' || t.type === 'debt_payment';
      const msg = pair ? `${isTransfer(t) ? 'Transfer' : 'Payment'} of ${money(t.amount)} ${out ? 'to' : 'from'} ${esc(counterName(t))} on ${fmtDate(t.date)}. It's removed from both accounts and both balances are recalculated.`
        : `${txLabel(t.type, getAcc(t.accountId).type)} of ${money(Math.abs(t.amount))} on ${fmtDate(t.date)}. Balances after it will be recalculated.`;
      if (await confirmBox(pair ? (isTransfer(t) ? 'Delete transfer?' : 'Delete payment?') : 'Delete transaction?', msg)) {
        const ids = pair ? [t.id, pair.id] : [t.id];
        ids.forEach(tombstone); state.transactions = state.transactions.filter(x => !ids.includes(x.id));
        save(); toast(pair ? (isTransfer(t) ? 'Transfer deleted' : 'Payment deleted') : 'Transaction deleted'); rerender();
      }
      break;
    }
    case 'filter': ui.txFilter = type; rerender(); break;
    case 'add-doc': openDocDialog(getAcc(id), type); break;
    case 'delete-doc': {
      const d = state.documents.find(x => x.id === id);
      if (await confirmBox('Delete document?', `“${esc(d.name)}” will be permanently deleted.`)) {
        tombstone(id); state.documents = state.documents.filter(x => x.id !== id);
        deleteFile(id); save(); toast('Document deleted'); rerender();
      }
      break;
    }
    case 'cal-nav': {
      if (type === '0') { const t = new Date(); ui.calY = t.getFullYear(); ui.calM = t.getMonth(); ui.calSel = todayISO(); }
      else { const d = new Date(ui.calY, ui.calM + Number(type), 1); ui.calY = d.getFullYear(); ui.calM = d.getMonth(); ui.calSel = null; }
      rerender(); break;
    }
    case 'cal-day': {
      if (date && date.slice(0, 7) !== `${ui.calY}-${pad(ui.calM + 1)}`) { const [y, m] = parts(date); ui.calY = y; ui.calM = m - 1; }
      ui.calSel = date && ui.calSel !== date ? date : null; rerender(); break;
    }
    case 'sample': loadSample(); break;
    case 'theme': {
      const order = ['system', 'light', 'dark'];
      const cur = (() => { try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; } })();
      try { localStorage.setItem(THEME_KEY, order[(order.indexOf(cur) + 1) % 3]); } catch { /* ignore */ }
      applyTheme(); break;
    }
    case 'logout': {
      if (store.dirty || store.saving) await flush();
      await fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      location.href = 'login'; break;
    }
    case 'password': openPasswordDialog(); break;
  }
});
function applyTheme() {
  let t = 'system'; try { t = localStorage.getItem(THEME_KEY) || 'system'; } catch { /* ignore */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = t;
  $('#themeBtn').textContent = `Theme: ${t[0].toUpperCase() + t.slice(1)}`;
}
window.addEventListener('hashchange', () => { ui.txFilter = 'all'; route(); window.scrollTo(0, 0); });
applyTheme();
view.innerHTML = '<p class="muted">Loading…</p>';
initStorage().then(() => { setSync(); route(); });
