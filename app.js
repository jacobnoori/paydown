'use strict';
/* Paydown — all money is stored as integer cents to avoid floating-point drift.
   Dates are stored as local "YYYY-MM-DD" strings. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const TYPES = {
  credit_card:   { label: 'Credit Card',   color: '#6366f1' },
  personal_loan: { label: 'Personal Loan', color: '#0ea5e9' },
  auto_loan:     { label: 'Auto Loan',     color: '#f59e0b' },
  mortgage:      { label: 'Mortgage',      color: '#10b981' },
};
const TX_LABEL = { purchase: 'Purchase', payment: 'Payment', interest: 'Interest charge', fee: 'Fee', refund: 'Refund / credit', adjustment: 'Adjustment' };
const isCard = t => t === 'credit_card';
const hasRate = t => t === 'mortgage' || t === 'auto_loan';     // separate note rate in addition to APR
const txTypesFor = t => isCard(t) ? ['purchase', 'payment', 'interest', 'fee', 'refund', 'adjustment'] : ['payment', 'fee', 'adjustment'];
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

const emptyData = () => ({ version: 2, accounts: [], transactions: [], deleted: {} });
function normalize(s) {
  if (!s || !Array.isArray(s.accounts)) return emptyData();
  return { version: 2, accounts: s.accounts, transactions: Array.isArray(s.transactions) ? s.transactions : [], deleted: s.deleted && typeof s.deleted === 'object' ? s.deleted : {} };
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
  const cutoff = Date.now() - 365 * 864e5;   // keep the file small
  for (const k of Object.keys(deleted)) if (deleted[k] < cutoff) delete deleted[k];
  return { version: 2, accounts, transactions, deleted };
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

// Effect on the outstanding balance. Loan payments only reduce balance by their principal portion.
function effect(t) {
  switch (t.type) {
    case 'purchase': case 'interest': case 'fee': return t.amount;
    case 'refund': return -t.amount;
    case 'adjustment': return t.amount;               // signed
    case 'payment': return -(t.amount - (t.interest || 0) - (t.escrow || 0));
  }
  return 0;
}
function ledger(acc, excludeId) {
  let bal = acc.startBalance;
  return txsFor(acc.id, excludeId).map(t => { const e = effect(t); bal += e; return { ...t, effect: e, balanceAfter: bal }; });
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
    if (others.some(t => t.type === 'payment' && t.date.slice(0, 7) === ym && t.date <= date && (t.interest || 0) > 0)) return { cents: 0, why: 'Interest already applied this month — extra payment goes to principal.' };
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
  if (!acc.dueDay) return null;
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
    <p>Add a credit card, personal loan, auto loan, or mortgage to start tracking balances, payments, and due dates.</p>
    <div class="actions" style="justify-content:center">
      <button class="btn primary" data-action="add-account">+ Add account</button>
      <button class="btn" data-action="sample">Load sample data</button>
    </div></div>`;
}

function renderDashboard() {
  const head = `<div class="page-head"><div><h1>Dashboard</h1><p>${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p></div>
    <div class="actions"><button class="btn primary" data-action="add-account">+ Add account</button></div></div>`;
  if (!state.accounts.length) return head + emptyState();

  const rows = state.accounts.map(a => ({ a, bal: currentBalance(a) }));
  const total = rows.reduce((s, r) => s + Math.max(r.bal, 0), 0);
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
    <div class="card stat"><div class="label">Total debt</div><div class="value">${money(total)}</div><div class="sub">${state.accounts.length} account${state.accounts.length === 1 ? '' : 's'}</div></div>
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
        <div class="stack">${byType.map(x => `<span title="${TYPES[x.t].label}: ${money(x.v)}" style="width:${x.v / total * 100}%;background:${TYPES[x.t].color}"></span>`).join('')}</div>
        <div class="legend">${byType.map(x => `<div><span class="dot" style="background:${TYPES[x.t].color}"></span>${TYPES[x.t].label} <b class="num">${money(x.v)}</b> <span class="muted">${(x.v / total * 100).toFixed(1)}%</span></div>`).join('')}</div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Accounts</h2><a class="btn ghost sm" href="#/accounts">View all</a></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Account</th><th class="num">Balance</th><th class="num">APR</th><th class="num">Payment</th><th class="num">Payoff</th></tr></thead>
          <tbody>${rows.sort((x, y) => y.bal - x.bal).map(({ a, bal }) => { const p = payoff(a); return `
            <tr class="clickable" data-action="open-account" data-id="${a.id}">
              <td><div class="acct"><span class="dot" style="background:${accColor(a)}"></span><div>${esc(a.name)}<div class="muted small" style="font-weight:450">${TYPES[a.type].label}</div></div></div></td>
              <td class="num"><b>${money(bal)}</b></td><td class="num">${pct(a.apr)}</td>
              <td class="num">${a.payment ? money(a.payment) : '—'}</td>
              <td class="num">${payoffText(p)}<div class="muted small">${payoffDate(p)}</div></td></tr>`; }).join('')}
          </tbody></table></div>
      </div>
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
            <div class="grow"><b>${esc(t.memo || TX_LABEL[t.type])}</b><span class="muted small">${esc(a.name)} · ${fmtDate(t.date)}</span></div>
            <div class="right ${t.type === 'payment' || t.type === 'refund' ? 'neg' : ''}">${t.type === 'payment' || t.type === 'refund' ? '−' : t.type === 'adjustment' && t.amount < 0 ? '−' : '+'}${money(Math.abs(t.amount))}</div>
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
  const head = `<div class="page-head"><div><h1>Accounts</h1><p>Credit cards and loans you're tracking.</p></div>
    <div class="actions"><button class="btn primary" data-action="add-account">+ Add account</button></div></div>`;
  if (!state.accounts.length) return head + emptyState();
  const groups = Object.keys(TYPES).map(t => ({ t, list: state.accounts.filter(a => a.type === t) })).filter(g => g.list.length);
  return head + groups.map(g => `
    <h3 class="muted" style="margin:6px 0 10px">${TYPES[g.t].label}${g.list.length > 1 ? 's' : ''}</h3>
    <div class="grid acct-grid" style="margin-bottom:22px">${g.list.map(acctCard).join('')}</div>`).join('');
}
function acctCard(a) {
  const bal = currentBalance(a), nd = nextDue(a);
  const util = isCard(a.type) && a.creditLimit ? bal / a.creditLimit * 100 : null;
  return `<a class="card acct-card" href="#/account/${a.id}" style="--c:${accColor(a)};color:inherit">
    <div class="top"><div><div class="name">${esc(a.name)}</div><div class="muted small">${esc(a.lender || TYPES[a.type].label)}</div></div>${typeChip(a.type)}</div>
    <div><div class="muted small">Current balance</div><div class="bal">${money(bal)}</div></div>
    ${util != null ? `<div><div class="meter ${util >= 50 ? 'bad' : util >= 30 ? 'warn' : ''}"><span style="width:${Math.min(Math.max(util, 0), 100)}%"></span></div><div class="muted small" style="margin-top:4px">${pct(util, 1)} of ${money(a.creditLimit)} limit</div></div>` : ''}
    <div class="kv">
      <div><span>APR</span><b>${pct(a.apr)}</b></div>
      ${hasRate(a.type) ? `<div><span>Interest rate</span><b>${pct(a.interestRate, 3)}</b></div>` : `<div><span>${isCard(a.type) ? 'Min. payment' : 'Payment'}</span><b>${a.payment ? money(a.payment) : '—'}</b></div>`}
      <div><span>Next due</span><b>${nd ? fmtDate(nd.date, { month: 'short', day: 'numeric' }) : '—'}</b></div>
    </div></a>`;
}

function renderAccount(a) {
  const L = ledger(a), bal = currentBalance(a), p = payoff(a), nd = nextDue(a);
  const loan = !isCard(a.type);
  const totals = L.reduce((s, t) => {
    if (t.type === 'payment') { s.paid += t.amount; s.int += t.interest || 0; }
    if (t.type === 'interest') s.int += t.amount;
    if (t.type === 'purchase') s.purch += t.amount;
    return s;
  }, { paid: 0, int: 0, purch: 0 });
  const util = isCard(a.type) && a.creditLimit ? bal / a.creditLimit * 100 : null;
  const filters = ['all', ...txTypesFor(a.type)].filter(f => f === 'all' || L.some(t => t.type === f));
  if (!filters.includes(ui.txFilter)) ui.txFilter = 'all';
  const shown = [...L].reverse().filter(t => ui.txFilter === 'all' || t.type === ui.txFilter);

  return `<a class="back" href="#/accounts">← Accounts</a>
  <div class="page-head">
    <div class="detail-head" style="--c:${accColor(a)}"><div class="swatch">${esc(a.name.trim()[0] || '?').toUpperCase()}</div>
      <div><h1>${esc(a.name)}</h1><p>${typeChip(a.type)} ${a.lender ? `<span style="margin-left:6px">${esc(a.lender)}</span>` : ''}</p></div></div>
    <div class="actions">
      ${isCard(a.type) ? `<button class="btn" data-action="add-tx" data-id="${a.id}" data-type="purchase">+ Purchase</button>` : ''}
      <button class="btn primary" data-action="add-tx" data-id="${a.id}" data-type="payment">+ Payment</button>
      <button class="btn" data-action="add-tx" data-id="${a.id}" data-type="${isCard(a.type) ? 'interest' : 'fee'}">More…</button>
      <button class="btn ghost" data-action="edit-account" data-id="${a.id}">Edit</button>
      <button class="btn ghost" data-action="delete-account" data-id="${a.id}">Delete</button>
    </div>
  </div>
  <div class="grid stats">
    <div class="card stat"><div class="label">Current balance</div><div class="value">${money(bal)}</div><div class="sub">Opening ${money(a.startBalance)} on ${fmtDate(a.startDate)}</div></div>
    <div class="card stat"><div class="label">${hasRate(a.type) ? 'APR / interest rate' : 'APR'}</div><div class="value">${pct(a.apr)}</div><div class="sub">${hasRate(a.type) ? `Note rate ${pct(a.interestRate, 3)} · ` : ''}≈ ${money(Math.round(Math.max(bal, 0) * rateFor(a) / 1200))}/mo interest</div></div>
    ${util != null ? `<div class="card stat"><div class="label">Utilization</div><div class="value">${pct(util, 1)}</div><div class="meter ${util >= 50 ? 'bad' : util >= 30 ? 'warn' : ''}" style="margin-top:8px"><span style="width:${Math.min(Math.max(util, 0), 100)}%"></span></div><div class="sub">${money(Math.max(a.creditLimit - bal, 0))} available</div></div>` : ''}
    <div class="card stat"><div class="label">${isCard(a.type) ? 'Minimum payment' : 'Monthly payment'}</div><div class="value">${a.payment ? money(a.payment) : '—'}</div><div class="sub">${nd ? `Next due ${fmtDate(nd.date, { month: 'short', day: 'numeric' })} · <span class="status ${nd.status}">${STATUS_LABEL[nd.status]}</span>` : a.dueDay ? `Due on day ${a.dueDay}` : 'No due day set'}</div></div>
    <div class="card stat"><div class="label">Payoff at this payment</div><div class="value">${payoffText(p)}</div><div class="sub">${p && !p.never && p.months ? `${payoffDate(p)} · ${money(p.interest)} interest` : a.type === 'mortgage' && a.escrow ? 'Excludes escrow' : '&nbsp;'}</div></div>
  </div>
  <div class="grid two-col" style="margin-bottom:16px">
    <div class="card card-pad" style="--c:${accColor(a)}"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Balance history</h2><span class="muted small">After each transaction</span></div>${balanceChart(a, L)}</div>
    <div class="card card-pad"><h2>Totals logged</h2>
      <div class="preview" style="margin-top:12px">
        <div><span>Payments</span><b>${money(totals.paid)}</b></div>
        <div><span>Interest</span><b>${money(totals.int)}</b></div>
        ${isCard(a.type) ? `<div><span>Purchases</span><b>${money(totals.purch)}</b></div>` : `<div><span>Principal paid</span><b>${money(L.filter(t => t.type === 'payment').reduce((s, t) => s - t.effect, 0))}</b></div>`}
        ${a.type === 'mortgage' ? `<div><span>Escrow</span><b>${money(L.reduce((s, t) => s + (t.escrow || 0), 0))}</b></div>` : ''}
      </div>
      ${a.notes ? `<p class="muted small" style="margin:14px 0 0;white-space:pre-wrap">${esc(a.notes)}</p>` : ''}
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h2>Transactions</h2>
      <div class="filters">${filters.map(f => `<button data-action="filter" data-type="${f}" class="${ui.txFilter === f ? 'on' : ''}">${f === 'all' ? 'All' : TX_LABEL[f]}</button>`).join('')}</div></div>
    <div class="table-wrap" style="margin-top:10px"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Description</th><th class="num">Amount</th>
        ${loan ? `<th class="num">Interest</th>${a.type === 'mortgage' ? '<th class="num">Escrow</th>' : ''}<th class="num">Principal</th>` : '<th class="num">Change</th>'}
        <th class="num">Balance after</th><th></th></tr></thead>
      <tbody>
        ${shown.map(t => `<tr>
          <td class="num" style="text-align:left">${fmtDate(t.date)}</td>
          <td><span class="chip">${TX_LABEL[t.type]}</span></td>
          <td>${esc(t.memo) || '<span class="muted">—</span>'}</td>
          <td class="num">${money(t.type === 'adjustment' ? t.amount : t.amount)}</td>
          ${loan ? `<td class="num">${t.type === 'payment' ? money(t.interest || 0) : '—'}</td>${a.type === 'mortgage' ? `<td class="num">${t.type === 'payment' ? money(t.escrow || 0) : '—'}</td>` : ''}` : ''}
          <td class="num ${t.effect > 0 ? 'pos' : t.effect < 0 ? 'neg' : ''}">${t.effect > 0 ? '+' : t.effect < 0 ? '−' : ''}${money(Math.abs(t.effect))}</td>
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
      ${txs.length ? `<h3 class="muted" style="padding:10px 20px 0">Logged</h3><ul class="list">${txs.map(tx => { const a = getAcc(tx.accountId); return `<li data-action="open-account" data-id="${a.id}" style="cursor:pointer"><span class="dot" style="background:${accColor(a)}"></span><div class="grow"><b>${TX_LABEL[tx.type]}${tx.memo ? ' · ' + esc(tx.memo) : ''}</b><span class="muted small">${esc(a.name)}</span></div><div class="right">${money(tx.amount)}</div></li>`; }).join('')}</ul>` : ''}
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
            ${txs.length ? `<span class="pdots">${txs.slice(0, 8).map(tx => `<i class="${tx.type === 'payment' ? '' : 'purchase'}" title="${TX_LABEL[tx.type]} ${money(tx.amount)}"></i>`).join('')}</span>` : ''}
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

/* ---------- account form ---------- */
function openAccountDialog(acc) {
  const editing = !!acc;
  const a = acc || { type: 'credit_card', name: '', lender: '', startBalance: null, startDate: todayISO(), apr: null, interestRate: null, creditLimit: null, payment: null, dueDay: null, originalAmount: null, termMonths: null, escrow: null, color: '', notes: '' };
  const hasTx = editing && state.transactions.some(t => t.accountId === a.id);
  openModal(`<form class="modal-body" id="accForm" novalidate>
    <header><h2>${editing ? 'Edit account' : 'Add account'}</h2><p>${editing ? esc(a.name) : 'Choose the type of debt and enter its details.'}</p></header>
    <div class="type-tiles">${Object.entries(TYPES).map(([k, v]) => `<label><input type="radio" name="type" value="${k}" ${a.type === k ? 'checked' : ''}><span class="tile" style="--c:${v.color}"><i></i>${v.label}</span></label>`).join('')}</div>
    <div class="form-grid">
      <label class="f full">Account name<input name="name" required maxlength="60" value="${esc(a.name)}" placeholder="e.g. Rewards Visa"></label>
      <label class="f full">Lender / issuer <span class="hint">Optional</span><input name="lender" maxlength="60" value="${esc(a.lender)}"></label>
      <label class="f">${hasTx ? 'Opening balance' : 'Current balance'}${moneyField('startBalance', centsIn(a.startBalance), 'required')}</label>
      <label class="f">Balance as of<input type="date" name="startDate" required value="${a.startDate}"></label>
      <label class="f">APR${pctField('apr', a.apr, 'required')}</label>
      <label class="f" data-types="mortgage auto_loan">Interest rate <span class="hint">Note rate used to compute interest</span>${pctField('interestRate', a.interestRate)}</label>
      <label class="f" data-types="credit_card">Credit limit <span class="hint">Optional</span>${moneyField('creditLimit', centsIn(a.creditLimit))}</label>
      <label class="f" data-types="personal_loan auto_loan mortgage">Original amount <span class="hint">Optional</span>${moneyField('originalAmount', centsIn(a.originalAmount))}</label>
      <label class="f" data-types="personal_loan auto_loan mortgage">Term (months) <span class="hint">Optional</span><input name="termMonths" inputmode="numeric" value="${a.termMonths ?? ''}"></label>
      <label class="f" data-types="mortgage">Escrow per payment <span class="hint">Taxes &amp; insurance</span>${moneyField('escrow', centsIn(a.escrow))}</label>
      <label class="f"><span id="payLabel">Minimum payment</span>
        <div class="inline">${moneyField('payment', centsIn(a.payment))}<button type="button" class="btn sm" id="calcPay" data-types="personal_loan auto_loan mortgage" title="Compute from original amount, rate and term">Calc</button></div></label>
      <label class="f">Due day of month <span class="hint">1–31 (shortened in shorter months)</span><input name="dueDay" type="number" min="1" max="31" value="${a.dueDay ?? ''}"></label>
      <label class="f">Color<input type="color" name="color" value="${a.color || TYPES[a.type].color}" style="height:38px;padding:4px"></label>
      <label class="f full">Notes <span class="hint">Optional</span><textarea name="notes" maxlength="500">${esc(a.notes)}</textarea></label>
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
  f.onsubmit = e => {
    e.preventDefault();
    const type = f.type.value, err = m => { $('#accErr').textContent = m; };
    const d = {
      type, name: f.name.value.trim(), lender: f.lender.value.trim(),
      startBalance: toCents(f.startBalance.value), startDate: f.startDate.value,
      apr: toNum(f.apr.value), interestRate: hasRate(type) ? toNum(f.interestRate.value) : null,
      creditLimit: type === 'credit_card' && f.creditLimit.value.trim() ? toCents(f.creditLimit.value) : null,
      originalAmount: type !== 'credit_card' && f.originalAmount.value.trim() ? toCents(f.originalAmount.value) : null,
      termMonths: type !== 'credit_card' && f.termMonths.value.trim() ? parseInt(f.termMonths.value, 10) : null,
      escrow: type === 'mortgage' && f.escrow.value.trim() ? toCents(f.escrow.value) : null,
      payment: f.payment.value.trim() ? toCents(f.payment.value) : null,
      dueDay: f.dueDay.value.trim() ? parseInt(f.dueDay.value, 10) : null,
      color: colorTouched ? f.color.value : '', notes: f.notes.value.trim(),
    };
    if (!d.name) return err('Enter an account name.');
    if (isNaN(d.startBalance)) return err('Enter a valid balance.');
    if (!d.startDate) return err('Enter the date the balance is as of.');
    if (isNaN(d.apr) || d.apr < 0 || d.apr > 100) return err('APR must be between 0 and 100.');
    if (hasRate(type) && (isNaN(d.interestRate) || d.interestRate < 0 || d.interestRate > 100)) return err('Interest rate is required for mortgages and auto loans (0–100).');
    for (const k of ['creditLimit', 'originalAmount', 'escrow', 'payment']) if (d[k] != null && (isNaN(d[k]) || d[k] < 0)) return err('Check the dollar amounts — they must be valid, non-negative numbers.');
    if (d.termMonths != null && !(d.termMonths > 0)) return err('Term must be a positive number of months.');
    if (d.dueDay != null && !(d.dueDay >= 1 && d.dueDay <= 31)) return err('Due day must be between 1 and 31.');
    if (editing) {
      const early = state.transactions.find(t => t.accountId === a.id && t.date < d.startDate);
      if (early) return err(`A transaction is dated ${fmtDate(early.date)}, before the new balance date. Move the date earlier.`);
      if (a.type !== type) {
        const bad = state.transactions.find(t => t.accountId === a.id && !txTypesFor(type).includes(t.type));
        if (bad) return err(`This account has ${TX_LABEL[bad.type].toLowerCase()} entries that a ${TYPES[type].label.toLowerCase()} can't hold.`);
      }
      touch(Object.assign(acc, d));
    } else {
      state.accounts.push({ id: uid(), createdAt: Date.now(), updatedAt: Date.now(), ...d });
    }
    save(); closeModal(); toast(editing ? 'Account updated' : 'Account added');
    if (!editing) location.hash = `#/account/${state.accounts[state.accounts.length - 1].id}`; else rerender();
  };
}

/* ---------- transaction form ---------- */
function openTxDialog(acc, tx, presetType) {
  const editing = !!tx;
  const types = txTypesFor(acc.type);
  const loan = !isCard(acc.type);
  const t = tx || { type: types.includes(presetType) ? presetType : 'payment', date: todayISO(), amount: null, interest: null, escrow: acc.type === 'mortgage' ? acc.escrow : null, memo: '' };
  openModal(`<form class="modal-body" id="txForm" novalidate>
    <header><h2>${editing ? 'Edit transaction' : 'Log transaction'}</h2><p>${esc(acc.name)} · ${TYPES[acc.type].label}</p></header>
    <div class="seg">${types.map(k => `<label><input type="radio" name="type" value="${k}" ${t.type === k ? 'checked' : ''}><span>${TX_LABEL[k]}</span></label>`).join('')}</div>
    <div class="form-grid">
      <label class="f">Date<input type="date" name="date" required min="${acc.startDate}" value="${t.date}"></label>
      <label class="f"><span id="amtLabel">Amount</span><div class="inline">${moneyField('amount', centsIn(t.amount == null ? null : Math.abs(t.amount)), 'required')}<button type="button" class="btn sm" id="fillPay" title="Use the account's payment amount">${acc.payment ? 'Use ' + money(acc.payment) : ''}</button></div></label>
      <label class="f" data-when="adjustment">Direction<select name="dir"><option value="1">Increase balance</option><option value="-1" ${t.type === 'adjustment' && t.amount < 0 ? 'selected' : ''}>Decrease balance</option></select></label>
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
    $('#amtLabel').textContent = type === 'interest' ? 'Interest charged' : type === 'payment' && loan ? 'Total payment' : 'Amount';
    if (type === 'payment' && loan && !intTouched) autoInterest();
    else if (type === 'interest' && f.date.value) {
      const s = estimateCardInterest(acc, f.date.value, exId);
      $('#txNote').innerHTML = `Estimate: <b>${money(s.cents)}</b> — ${esc(s.why)}. <button type="button" class="btn xs" id="useEst">Use estimate</button> Use the exact figure from your statement when you have it.`;
      $('#useEst').onclick = () => { f.amount.value = centsIn(s.cents); update(); };
    } else if (!(type === 'payment' && loan)) $('#txNote').textContent = '';
    const o = read(), prev = $('#txPrev');
    if (!o.date || isNaN(o.amount)) { prev.innerHTML = `<div><span>Balance before</span><b>${o.date ? money(balanceOn(acc, o.date, exId)) : '—'}</b></div>`; return; }
    const before = balanceOn(acc, o.date, exId), eff = effect(o), after = before + eff;
    const later = txsFor(acc.id, exId).some(x => x.date > o.date);
    prev.innerHTML = `<div><span>Balance before</span><b>${money(before)}</b></div>
      ${type === 'payment' && loan ? `<div><span>Principal</span><b class="${-eff < 0 ? 'pos' : ''}">${money(-eff)}</b></div>` : ''}
      <div><span>Balance after</span><b>${money(after)}</b></div>
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
    if (!o.date) return err('Choose a date.');
    if (o.date < acc.startDate) return err(`Date can't be before the account's balance date (${fmtDate(acc.startDate)}).`);
    if (isNaN(o.amount) || o.amount === 0 || (o.type !== 'adjustment' && o.amount < 0)) return err('Enter an amount greater than zero.');
    if (isNaN(o.interest) || o.interest < 0 || isNaN(o.escrow) || o.escrow < 0) return err('Interest and escrow must be zero or more.');
    if (o.interest + o.escrow > o.amount) return err('Interest + escrow can\'t exceed the total payment.');
    const rec = { ...o, memo: f.memo.value.trim() };
    if (!(o.type === 'payment' && loan)) { delete rec.interest; delete rec.escrow; }
    if (editing) { delete tx.interest; delete tx.escrow; touch(Object.assign(tx, rec)); }
    else state.transactions.push({ id: uid(), accountId: acc.id, createdAt: Date.now(), updatedAt: Date.now(), ...rec });
    save(); closeModal(); toast(editing ? 'Transaction updated' : `${TX_LABEL[o.type]} logged`); rerender();
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
      if (await confirmBox('Delete account?', `“${esc(a.name)}” and its ${n} transaction${n === 1 ? '' : 's'} will be permanently removed.`)) {
        tombstone(id);
        state.transactions.filter(t => t.accountId === id).forEach(t => tombstone(t.id));
        state.accounts = state.accounts.filter(x => x.id !== id);
        state.transactions = state.transactions.filter(t => t.accountId !== id);
        save(); toast('Account deleted'); location.hash = '#/accounts';
      }
      break;
    }
    case 'add-tx': openTxDialog(getAcc(id), null, type); break;
    case 'edit-tx': { const t = state.transactions.find(x => x.id === id); openTxDialog(getAcc(t.accountId), t); break; }
    case 'delete-tx': {
      const t = state.transactions.find(x => x.id === id);
      if (await confirmBox('Delete transaction?', `${TX_LABEL[t.type]} of ${money(Math.abs(t.amount))} on ${fmtDate(t.date)}. Balances after it will be recalculated.`)) {
        tombstone(id); state.transactions = state.transactions.filter(x => x.id !== id); save(); toast('Transaction deleted'); rerender();
      }
      break;
    }
    case 'filter': ui.txFilter = type; rerender(); break;
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
    case 'export': {
      const blob = new Blob([JSON.stringify({ app: 'paydown', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `paydown-${todayISO()}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); break;
    }
    case 'import': $('#importFile').click(); break;
    case 'logout': {
      if (store.dirty || store.saving) await flush();
      await fetch('api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      location.href = 'login'; break;
    }
    case 'password': openPasswordDialog(); break;
  }
});
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.accounts) || !Array.isArray(data.transactions)) throw new Error('bad');
    if (state.accounts.length && !(await confirmBox('Replace current data?', `This will replace your ${state.accounts.length} account(s) with ${data.accounts.length} from the file.`, 'Replace'))) return;
    // Replace: tombstone current records so the replacement also wins on other synced machines.
    const now = Date.now();
    [...state.accounts, ...state.transactions].forEach(x => tombstone(x.id));
    const imp = normalize(data);
    imp.accounts.forEach(a => { a.updatedAt = now + 1; delete state.deleted[a.id]; });
    imp.transactions.forEach(t => { t.updatedAt = now + 1; delete state.deleted[t.id]; });
    state = { version: 2, accounts: imp.accounts, transactions: imp.transactions, deleted: state.deleted };
    save(); toast('Data imported'); rerender();
  } catch { toast('That file is not a valid Paydown export'); }
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
