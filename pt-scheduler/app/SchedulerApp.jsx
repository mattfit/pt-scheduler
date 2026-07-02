'use client';
import { useState, useMemo, useEffect, useCallback } from 'react';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'pt_scheduler_v1';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];

// Session statuses
const STATUS = {
  scheduled:        { label: 'Scheduled',            short: 'Sched',       color: 'bg-blue-500',   text: 'text-blue-400',   dot: 'bg-blue-400',   billing: 0  },
  scheduled_moved:  { label: 'Scheduled (Moved)',    short: 'Moved',       color: 'bg-blue-400',   text: 'text-blue-300',   dot: 'bg-blue-300',   billing: 0  },
  completed:        { label: 'Completed',             short: 'Done',        color: 'bg-green-500',  text: 'text-green-400',  dot: 'bg-green-400',  billing: 0  },
  rollover_you:     { label: 'Rollover — You',       short: 'Roll(You)',   color: 'bg-amber-500',  text: 'text-amber-400',  dot: 'bg-amber-400',  billing: -1 },
  rollover_client:  { label: 'Rollover — Client',    short: 'Roll(Cli)',   color: 'bg-purple-500', text: 'text-purple-400', dot: 'bg-purple-400', billing: -1 },
  late_cancel:      { label: 'Late Cancel',           short: 'Late Cxl',   color: 'bg-red-500',    text: 'text-red-400',    dot: 'bg-red-400',    billing: 0  },
  resched_rollover: { label: 'Reschedule (Rollover)', short: 'Resched(R)', color: 'bg-emerald-500',text: 'text-emerald-400',dot: 'bg-emerald-400',billing: +1 },
  resched_late:     { label: 'Reschedule (Late Cxl)', short: 'Resched(L)', color: 'bg-indigo-500', text: 'text-indigo-400', dot: 'bg-indigo-400', billing: 0  },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);
const pad2 = n => String(n).padStart(2, '0');
const dateStr = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const todayStr = () => new Date().toISOString().split('T')[0];
const ymKey = (y, m) => `${y}-${pad2(m + 1)}`;

function datesInMonth(year, month, weekday) {
  const total = new Date(year, month + 1, 0).getDate();
  const res = [];
  for (let d = 1; d <= total; d++)
    if (new Date(year, month, d).getDay() === weekday) res.push(d);
  return res;
}

function buildGrid(year, month) {
  const first = new Date(year, month, 1).getDay();
  const total = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

function gcalUrl(session, clientName) {
  const d = new Date(`${session.date}T${session.time}:00`);
  const e = new Date(d.getTime() + 3600000);
  const f = x => x.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return `https://calendar.google.com/calendar/render?${new URLSearchParams({
    action: 'TEMPLATE', text: `PT – ${clientName}`,
    dates: `${f(d)}/${f(e)}`, details: `$${session.rate}/session`,
  })}`;
}

// ─── STORAGE ─────────────────────────────────────────────────────────────────
const load = () => { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; } };
const save = d => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch {} };

function exportData(clients) {
  const blob = new Blob([JSON.stringify({ version: 1, clients }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pt-scheduler-backup-${todayStr()}.json`;
  a.click();
}

function importData(file, onSuccess) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      if (data.clients) onSuccess(data.clients);
    } catch { alert('Invalid backup file.'); }
  };
  reader.readAsText(file);
}

// ─── BILLING ENGINE ───────────────────────────────────────────────────────────
//
// BILLING RULES (hard law, do not change):
//
// First month: bill = scheduledSessions × rate. Fixed. No adjustments.
//
// Every subsequent month:
//   bill = (sessions this month × rate) + adjustments from PREVIOUS month
//   Adjustments from prev month sessions:
//     rollover_you    → −rate
//     rollover_client → −rate
//     resched_rollover → +rate  (cancels out a rollover, adds back)
//     completed, late_cancel, resched_late, scheduled, scheduled_moved → $0
//
// Rollovers only affect the NEXT month. They do NOT cascade further.
// Current month's actions drive NEXT month's bill — not the current one.

function getSessionsForMonth(client, year, month) {
  return (client.sessions || []).filter(s => {
    const d = new Date(s.date);
    return d.getFullYear() === year && d.getMonth() === month;
  });
}

function isFirstMonth(client, year, month) {
  if (!client.startDate) return false;
  const s = new Date(client.startDate);
  return s.getFullYear() === year && s.getMonth() === month;
}

function countScheduledSessions(client, year, month) {
  // Count auto sessions from schedule + any manually added sessions for this month
  const scheduleSessions = (client.schedule || []).reduce(
    (sum, wd) => sum + datesInMonth(year, month, wd).length, 0
  );
  // Also count extra sessions added manually (source === 'extra')
  const extras = getSessionsForMonth(client, year, month)
    .filter(s => s.source === 'extra').length;
  return scheduleSessions + extras;
}

function computeBilling(client, year, month) {
  if (!client.startDate) return { bill: 0, baseBill: 0, breakdown: [], netAdj: 0, isFirst: false };

  const start = new Date(client.startDate);
  if (year < start.getFullYear() || (year === start.getFullYear() && month < start.getMonth()))
    return { bill: 0, baseBill: 0, breakdown: [], netAdj: 0, isFirst: false };

  const rate = client.rate || 40;
  const isFirst = isFirstMonth(client, year, month);
  const scheduledCount = countScheduledSessions(client, year, month);
  const baseBill = scheduledCount * rate;

  if (isFirst) return { bill: baseBill, baseBill, breakdown: [], netAdj: 0, isFirst: true };

  // Get prev month's sessions to calculate adjustment
  const prev = new Date(year, month - 1, 1);
  const prevY = prev.getFullYear(), prevM = prev.getMonth();
  const prevSessions = getSessionsForMonth(client, prevY, prevM);

  const rollYou    = prevSessions.filter(s => s.status === 'rollover_you');
  const rollClient = prevSessions.filter(s => s.status === 'rollover_client');
  const reschedR   = prevSessions.filter(s => s.status === 'resched_rollover');

  let netAdj = 0;
  const breakdown = [];

  if (rollYou.length) {
    const amt = rollYou.length * rate;
    netAdj -= amt;
    breakdown.push({ label: `${rollYou.length} Rollover (You)`, amt, sign: '−', color: 'text-amber-400' });
  }
  if (rollClient.length) {
    const amt = rollClient.length * rate;
    netAdj -= amt;
    breakdown.push({ label: `${rollClient.length} Rollover (Client)`, amt, sign: '−', color: 'text-purple-400' });
  }
  if (reschedR.length) {
    const amt = reschedR.length * rate;
    netAdj += amt;
    breakdown.push({ label: `${reschedR.length} Reschedule (Rollover)`, amt, sign: '+', color: 'text-emerald-400' });
  }

  const bill = Math.max(0, baseBill + netAdj);
  return { bill, baseBill, breakdown, netAdj, isFirst, prevMonthName: SHORT_MONTHS[prevM] };
}

// Next month preview — driven by THIS month's rollovers
function computeNextMonthPreview(client, year, month) {
  const rate = client.rate || 40;
  const moSessions = getSessionsForMonth(client, year, month);

  const rollYou    = moSessions.filter(s => s.status === 'rollover_you');
  const rollClient = moSessions.filter(s => s.status === 'rollover_client');
  const reschedR   = moSessions.filter(s => s.status === 'resched_rollover');

  let adj = 0;
  const items = [];

  if (rollYou.length)    { const a = rollYou.length * rate;    adj -= a; items.push({ label: `${rollYou.length} Rollover (You)`,       sign: '−', amt: a, color: 'text-amber-400' }); }
  if (rollClient.length) { const a = rollClient.length * rate; adj -= a; items.push({ label: `${rollClient.length} Rollover (Client)`,  sign: '−', amt: a, color: 'text-purple-400' }); }
  if (reschedR.length)   { const a = reschedR.length * rate;   adj += a; items.push({ label: `${reschedR.length} Resched (Rollover)`,   sign: '+', amt: a, color: 'text-emerald-400' }); }

  const nextDate = new Date(year, month + 1, 1);
  const ny = nextDate.getFullYear(), nm = nextDate.getMonth();
  const nextBase = countScheduledSessions(client, ny, nm) * rate;
  const total = Math.max(0, nextBase + adj);

  return { items, adj, nextBase, total, nextMonthName: SHORT_MONTHS[nm] };
}

function getTotalEarned(clients) {
  // Sum all confirmed payments across all clients including archived
  return clients.reduce((sum, c) => {
    return sum + (c.confirmedPayments || []).reduce((s, p) => s + p.amount, 0);
  }, 0);
}

function isMonthLocked(client, year, month) {
  const now = new Date();
  const isPast = year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth());
  if (!isPast) return false;
  return !(client.unlockedMonths || []).includes(ymKey(year, month));
}

// ─── SESSION SYNC ─────────────────────────────────────────────────────────────
// Only syncs current + future months. Never touches past months.
function syncSessions(client, year, month) {
  if (!client.startDate) return client;
  const start = new Date(client.startDate);
  if (year < start.getFullYear() || (year === start.getFullYear() && month < start.getMonth()))
    return client;

  const now = new Date();
  const isPast = year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth());
  if (isPast) return client;

  let sessions = [...(client.sessions || [])];

  // Remove auto sessions whose weekday was removed from schedule
  sessions = sessions.filter(s => {
    if (s.source !== 'auto') return true;
    const d = new Date(s.date);
    if (d.getMonth() !== month || d.getFullYear() !== year) return true;
    return (client.schedule || []).includes(s.wd);
  });

  // Add missing auto sessions
  (client.schedule || []).forEach(wd => {
    datesInMonth(year, month, wd).forEach(day => {
      const ds = dateStr(year, month, day);
      if (ds < client.startDate) return;
      const exists = sessions.some(s => s.date === ds && s.source === 'auto' && s.wd === wd);
      if (!exists) {
        sessions.push({
          id: uid(), date: ds, time: client.defaultTime || '09:00',
          status: 'scheduled', rate: client.rate, source: 'auto', wd,
        });
      }
    });
  });

  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return { ...client, sessions };
}

// ─── DEFAULT DATA ─────────────────────────────────────────────────────────────
const DEFAULT_CLIENTS = [];

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function SchedulerApp() {
  const [clients,    setClients]    = useState(() => load() || DEFAULT_CLIENTS);
  const [activeId,   setActiveId]   = useState(null);
  const [view,       setView]       = useState('calendar'); // calendar | list | schedule | settings
  const [viewMonth,  setViewMonth]  = useState(new Date().getMonth());
  const [viewYear,   setViewYear]   = useState(new Date().getFullYear());
  const [selDay,     setSelDay]     = useState(null);
  const [saveFlash,  setSaveFlash]  = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Modals
  const [modal, setModal] = useState(null); // { type, date?, day? }
  const [mDate, setMDate] = useState('');
  const [mTime, setMTime] = useState('09:00');
  const [mNote, setMNote] = useState('');

  // New client form
  const [showNewClient, setShowNewClient] = useState(false);
  const [ncName,  setNcName]  = useState('');
  const [ncRate,  setNcRate]  = useState(40);
  const [ncStart, setNcStart] = useState('');
  const [ncTime,  setNcTime]  = useState('09:00');

  // Bill breakdown toggle
  const [showBreakdown, setShowBreakdown] = useState(false);

  // Auto-save
  useEffect(() => {
    save(clients);
    setSaveFlash(true);
    const t = setTimeout(() => setSaveFlash(false), 1500);
    return () => clearTimeout(t);
  }, [clients]);

  // Sync sessions on month/year/clients change
  useEffect(() => {
    setClients(cs => cs.map(c => syncSessions(c, viewYear, viewMonth)));
  }, [viewYear, viewMonth]);

  const activeClients   = useMemo(() => clients.filter(c => !c.archived), [clients]);
  const archivedClients = useMemo(() => clients.filter(c => c.archived),  [clients]);
  const cl = useMemo(() => clients.find(c => c.id === activeId), [clients, activeId]);

  // Set first active client on load
  useEffect(() => {
    if (!activeId && activeClients.length > 0) setActiveId(activeClients[0].id);
  }, [activeClients, activeId]);

  const upd = useCallback((id, fn) => setClients(cs => cs.map(c => c.id === id ? fn(c) : c)), []);

  // ── Schedule management ──
  function toggleScheduleDay(wd) {
    upd(activeId, c => {
      const has = (c.schedule || []).includes(wd);
      const schedule = has ? (c.schedule || []).filter(d => d !== wd) : [...(c.schedule || []), wd].sort((a, b) => a - b);
      return syncSessions({ ...c, schedule }, viewYear, viewMonth);
    });
  }

  function setDefaultTime(time) {
    upd(activeId, c => {
      const now = new Date();
      const sessions = (c.sessions || []).map(s => {
        const d = new Date(s.date);
        const isPast = d.getFullYear() < now.getFullYear() || (d.getFullYear() === now.getFullYear() && d.getMonth() < now.getMonth());
        return (!isPast && s.source === 'auto' && s.status === 'scheduled') ? { ...s, time } : s;
      });
      return { ...c, defaultTime: time, sessions };
    });
  }

  // ── Session status ──
  function setStatus(sid, status) {
    upd(activeId, c => ({ ...c, sessions: (c.sessions || []).map(s => s.id === sid ? { ...s, status } : s) }));
  }

  // ── Move session ──
  function moveSession(sid, newDate) {
    upd(activeId, c => ({
      ...c,
      sessions: (c.sessions || []).map(s => {
        if (s.id !== sid) return s;
        return { ...s, date: newDate, status: 'scheduled_moved', movedFrom: s.date };
      }),
    }));
  }

  // ── Add session (manual) ──
  function confirmAddSession() {
    if (!mDate || !cl) return;
    const s = {
      id: uid(), date: mDate, time: mTime, note: mNote,
      status: 'scheduled', rate: cl.rate,
      source: modal.type,
    };
    upd(activeId, c => ({
      ...c,
      sessions: [...(c.sessions || []), s].sort((a, b) => a.date.localeCompare(b.date)),
    }));
    setModal(null); setMDate(''); setMTime('09:00'); setMNote('');
  }

  // ── Delete session ──
  function deleteSession(sid) {
    upd(activeId, c => ({ ...c, sessions: (c.sessions || []).filter(s => s.id !== sid) }));
  }

  // ── Confirm payment ──
  function confirmPayment(amount) {
    if (amount <= 0) return;
    const p = { id: uid(), year: viewYear, month: viewMonth, amount, confirmedAt: new Date().toISOString() };
    upd(activeId, c => {
      const prev = (c.confirmedPayments || []).filter(x => !(x.year === viewYear && x.month === viewMonth));
      return { ...c, confirmedPayments: [...prev, p] };
    });
  }

  // ── Lock/unlock month ──
  function unlockMonth() {
    const key = ymKey(viewYear, viewMonth);
    upd(activeId, c => ({ ...c, unlockedMonths: [...(c.unlockedMonths || []).filter(k => k !== key), key] }));
  }
  function lockMonth() {
    const key = ymKey(viewYear, viewMonth);
    upd(activeId, c => ({ ...c, unlockedMonths: (c.unlockedMonths || []).filter(k => k !== key) }));
  }

  // ── Client management ──
  function addClient() {
    if (!ncName.trim() || !ncStart) return;
    const nc = {
      id: uid(), name: ncName.trim(), rate: ncRate,
      startDate: ncStart, defaultTime: ncTime,
      schedule: [], sessions: [], confirmedPayments: [], unlockedMonths: [],
      archived: false,
    };
    setClients(cs => [...cs, nc]);
    setActiveId(nc.id);
    setNcName(''); setNcRate(40); setNcStart(''); setNcTime('09:00');
    setShowNewClient(false);
    setView('schedule');
  }

  function archiveClient(id) {
    upd(id, c => ({ ...c, archived: true }));
    const remaining = activeClients.filter(c => c.id !== id);
    setActiveId(remaining.length ? remaining[0].id : null);
  }

  function unarchiveClient(id) {
    upd(id, c => ({ ...c, archived: false }));
    setActiveId(id);
    setShowArchived(false);
  }

  // ── Derived data ──
  const moSessions = useMemo(() => {
    if (!cl) return [];
    return (cl.sessions || []).filter(s => {
      const d = new Date(s.date);
      return d.getFullYear() === viewYear && d.getMonth() === viewMonth;
    });
  }, [cl, viewYear, viewMonth]);

  const byDay = useMemo(() => {
    const m = {};
    moSessions.forEach(s => {
      const d = parseInt(s.date.split('-')[2], 10);
      if (!m[d]) m[d] = [];
      m[d].push(s);
    });
    return m;
  }, [moSessions]);

  const billing        = useMemo(() => cl ? computeBilling(cl, viewYear, viewMonth)         : { bill: 0, baseBill: 0, breakdown: [], netAdj: 0, isFirst: false }, [cl, viewYear, viewMonth, clients]);
  const nextPreview    = useMemo(() => cl ? computeNextMonthPreview(cl, viewYear, viewMonth) : { items: [], total: 0, nextBase: 0 }, [cl, viewYear, viewMonth, clients]);
  const totalEarned    = useMemo(() => getTotalEarned(clients), [clients]);
  const locked         = useMemo(() => cl ? isMonthLocked(cl, viewYear, viewMonth) : false,  [cl, viewYear, viewMonth]);
  const payConfirmed   = useMemo(() => (cl?.confirmedPayments || []).some(p => p.year === viewYear && p.month === viewMonth), [cl, viewYear, viewMonth]);
  const confirmedAmt   = useMemo(() => { const p = (cl?.confirmedPayments || []).find(p => p.year === viewYear && p.month === viewMonth); return p ? p.amount : 0; }, [cl, viewYear, viewMonth]);
  const grid           = useMemo(() => buildGrid(viewYear, viewMonth), [viewYear, viewMonth]);
  const selSessions    = useMemo(() => selDay ? (byDay[selDay] || []) : [], [selDay, byDay]);

  const now       = new Date();
  const isToday   = (day) => now.getDate() === day && now.getMonth() === viewMonth && now.getFullYear() === viewYear;
  const isPastMo  = viewYear < now.getFullYear() || (viewYear === now.getFullYear() && viewMonth < now.getMonth());
  const nextDate  = new Date(viewYear, viewMonth + 1, 1);
  const nextMoName = SHORT_MONTHS[nextDate.getMonth()];

  function openModal(type, prefillDate = '') {
    setModal({ type });
    setMDate(prefillDate);
    setMTime(cl?.defaultTime || '09:00');
    setMNote('');
  }

  // ── RENDER ────────────────────────────────────────────────────────────────
  if (!cl && activeClients.length === 0) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-6">
        <div className="text-4xl mb-4">💪</div>
        <h1 className="text-2xl font-bold mb-2">PT Scheduler</h1>
        <p className="text-gray-400 mb-8 text-center">Add your first client to get started.</p>
        <button onClick={() => setShowNewClient(true)} className="bg-blue-600 text-white px-6 py-3 rounded-xl font-bold text-lg active:opacity-80">
          + Add Client
        </button>
        {showNewClient && <NewClientForm {...{ ncName, setNcName, ncRate, setNcRate, ncStart, setNcStart, ncTime, setNcTime, addClient, onCancel: () => setShowNewClient(false) }} />}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col max-w-lg mx-auto">

      {/* ── Modal ── */}
      {modal && (
        <Modal
          title={MODAL_INFO[modal.type]?.title}
          desc={MODAL_INFO[modal.type]?.desc(cl?.rate)}
          onClose={() => setModal(null)}
          onConfirm={confirmAddSession}
        >
          <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Date</label>
          <input type="date" value={mDate} onChange={e => setMDate(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white mb-3 text-sm" />
          <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Time</label>
          <input type="time" value={mTime} onChange={e => setMTime(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white mb-3 text-sm" />
          <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Note (optional)</label>
          <input value={mNote} onChange={e => setMNote(e.target.value)} placeholder="e.g. makeup session" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm" />
        </Modal>
      )}

      {/* ── New Client Form ── */}
      {showNewClient && (
        <NewClientForm {...{ ncName, setNcName, ncRate, setNcRate, ncStart, setNcStart, ncTime, setNcTime, addClient, onCancel: () => setShowNewClient(false) }} />
      )}

      {/* ── Archived clients ── */}
      {showArchived && (
        <Modal title="Archived Clients" onClose={() => setShowArchived(false)}>
          {archivedClients.length === 0
            ? <p className="text-gray-400 text-sm">No archived clients.</p>
            : archivedClients.map(c => (
              <div key={c.id} className="flex items-center justify-between py-2 border-b border-gray-800">
                <div>
                  <p className="font-semibold">{c.name}</p>
                  <p className="text-xs text-gray-400">${c.rate}/session</p>
                </div>
                <button onClick={() => unarchiveClient(c.id)} className="text-xs bg-blue-600 px-3 py-1 rounded-lg">Restore</button>
              </div>
            ))}
        </Modal>
      )}

      {/* ── Header ── */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 pt-12 pb-3 sticky top-0 z-10">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-lg font-bold leading-tight">{cl?.name || 'PT Scheduler'}</h1>
            <p className="text-xs text-gray-400">${cl?.rate}/session{cl?.schedule?.length ? ` · ${cl.schedule.map(d => WEEKDAYS[d]).join(', ')}` : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`text-xs text-green-400 transition-opacity duration-500 ${saveFlash ? 'opacity-100' : 'opacity-0'}`}>✓ Saved</div>
            <button onClick={() => setShowNewClient(true)} className="bg-blue-600 text-white text-xs px-3 py-1.5 rounded-lg font-semibold active:opacity-80">+ Client</button>
          </div>
        </div>

        {/* Client tabs */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {activeClients.map(c => (
            <button key={c.id} onClick={() => { setActiveId(c.id); setSelDay(null); }}
              className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${c.id === activeId ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
              {c.name}
            </button>
          ))}
          {archivedClients.length > 0 && (
            <button onClick={() => setShowArchived(true)} className="flex-shrink-0 px-3 py-1.5 rounded-lg text-xs text-gray-600 bg-gray-800/50">
              Archive ({archivedClients.length})
            </button>
          )}
        </div>
      </div>

      {/* ── Billing Card ── */}
      {cl && (
        <div className="mx-4 mt-4 bg-gray-900 rounded-2xl p-4 border border-green-900/40">
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                {MONTHS[viewMonth]} {viewYear} — Upfront Bill
                {billing.isFirst && <span className="ml-2 text-blue-400">First Month</span>}
                {locked && <span className="ml-2 text-red-400">🔒</span>}
              </p>
              <p className="text-4xl font-bold text-green-400">${billing.bill}</p>

              {/* Net adjustment */}
              {!billing.isFirst && billing.netAdj !== 0 && (
                <button onClick={() => setShowBreakdown(b => !b)} className="mt-1 text-xs text-gray-400 flex items-center gap-1">
                  <span className={billing.netAdj < 0 ? 'text-amber-400' : 'text-emerald-400'}>
                    {billing.netAdj < 0 ? '−' : '+'}${Math.abs(billing.netAdj)} adj from {billing.prevMonthName}
                  </span>
                  <span>{showBreakdown ? '▲' : '▼'}</span>
                </button>
              )}

              {/* Breakdown dropdown */}
              {showBreakdown && billing.breakdown.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  <p className="text-xs text-gray-500">{countScheduledSessions(cl, viewYear, viewMonth)} sessions × ${cl.rate} = ${billing.baseBill}</p>
                  {billing.breakdown.map((b, i) => (
                    <p key={i} className={`text-xs ${b.color}`}>{b.sign} ${b.amt} — {b.label}</p>
                  ))}
                </div>
              )}
            </div>

            <div className="text-right">
              <p className="text-xs text-gray-500 mb-0.5">All-time Earned</p>
              <p className="text-xl font-bold text-green-300">${totalEarned}</p>
            </div>
          </div>

          {/* Confirm payment */}
          {!payConfirmed && billing.bill > 0 && (
            <button onClick={() => confirmPayment(billing.bill)}
              className="w-full bg-green-600 text-white py-2.5 rounded-xl font-bold text-sm active:opacity-80">
              ✓ Confirm Payment — ${billing.bill}
            </button>
          )}
          {payConfirmed && (
            <div className="bg-green-900/30 border border-green-800/50 rounded-xl py-2 text-center text-sm text-green-400">
              ✓ ${confirmedAmt} confirmed for {MONTHS[viewMonth]}
            </div>
          )}
        </div>
      )}

      {/* ── Next Month Preview ── */}
      {cl && nextPreview.items.length > 0 && (
        <div className="mx-4 mt-3 bg-gray-900/60 rounded-xl p-3 border border-gray-800">
          <p className="text-xs text-gray-500 mb-1">{nextMoName} preview: <span className="text-white font-semibold">${nextPreview.total}</span>
            <span className="text-gray-600"> ({nextPreview.nextBase} base</span>
            {nextPreview.adj !== 0 && <span className={nextPreview.adj < 0 ? 'text-amber-400' : 'text-emerald-400'}> {nextPreview.adj < 0 ? '−' : '+'}${Math.abs(nextPreview.adj)}</span>}
            <span className="text-gray-600">)</span>
          </p>
        </div>
      )}

      {/* ── Month nav + lock ── */}
      <div className="flex items-center justify-between px-4 mt-4 mb-2">
        <button onClick={() => { setSelDay(null); if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); } else setViewMonth(m => m - 1); }}
          className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-lg active:opacity-70">‹</button>
        <span className="font-semibold text-sm">{MONTHS[viewMonth]} {viewYear}</span>
        <button onClick={() => { setSelDay(null); if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); } else setViewMonth(m => m + 1); }}
          className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-lg active:opacity-70">›</button>
      </div>

      {/* Lock/unlock */}
      {isPastMo && (
        <div className="px-4 mb-2">
          {locked
            ? <button onClick={unlockMonth} className="w-full py-2 rounded-lg bg-amber-900/40 border border-amber-700/50 text-amber-400 text-xs font-semibold">🔓 Unlock {MONTHS[viewMonth]} to Edit</button>
            : <button onClick={lockMonth}   className="w-full py-2 rounded-lg bg-red-900/20 border border-red-800/30 text-red-400 text-xs font-semibold">🔒 Lock {MONTHS[viewMonth]}</button>
          }
        </div>
      )}

      {/* ── Nav tabs ── */}
      <div className="flex px-4 gap-2 mb-3">
        {['calendar', 'list', 'schedule', 'settings'].map(t => (
          <button key={t} onClick={() => { setView(t); setSelDay(null); }}
            className={`flex-1 py-2 rounded-lg text-xs font-semibold capitalize transition-colors ${view === t ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>
            {t === 'calendar' ? '📅' : t === 'list' ? '☰' : t === 'schedule' ? '⚙' : '⋯'} {t}
          </button>
        ))}
      </div>

      {/* ══ CALENDAR TAB ══ */}
      {view === 'calendar' && cl && (
        <div className="px-4 pb-6">
          {/* Day headers */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAYS.map(d => <div key={d} className="text-center text-xs text-gray-600 py-1">{d[0]}</div>)}
          </div>

          {/* Grid */}
          <div className="grid grid-cols-7 gap-0.5 mb-4">
            {grid.map((day, i) => {
              if (!day) return <div key={`e${i}`} />;
              const ds = byDay[day] || [];
              const isSel = day === selDay;
              const isFirst = day === 1;
              return (
                <button key={day} onClick={() => setSelDay(day === selDay ? null : day)}
                  className={`relative aspect-square rounded-lg flex flex-col items-center justify-start pt-1 transition-colors text-xs
                    ${isSel ? 'bg-blue-600' : isFirst ? 'bg-green-900/30 border border-green-800/30' : ds.length ? 'bg-gray-800' : 'bg-gray-900'}
                    ${locked ? 'opacity-60' : 'active:opacity-70'}`}>
                  <span className={`font-semibold leading-none mb-0.5 ${isToday(day) ? 'text-blue-400' : isSel ? 'text-white' : 'text-gray-300'}`}>
                    {day}
                  </span>
                  {isFirst && <span className="text-green-400 text-[8px] font-bold leading-none">${billing.bill}</span>}
                  <div className="flex flex-wrap gap-0.5 justify-center mt-0.5">
                    {ds.map(s => <span key={s.id} className={`w-1.5 h-1.5 rounded-full ${STATUS[s.status]?.dot || 'bg-gray-500'}`} />)}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Day detail panel */}
          {selDay && (
            <div className="bg-gray-900 rounded-2xl p-4 mb-4 border border-gray-800">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="font-bold">{WEEKDAYS[new Date(viewYear, viewMonth, selDay).getDay()]}, {MONTHS[viewMonth]} {selDay}</p>
                  {selDay === 1 && <p className="text-xs text-green-400">Bill due: ${billing.bill}</p>}
                </div>
                {!locked && (
                  <div className="flex gap-1.5 flex-wrap justify-end">
                    <button onClick={() => openModal('extra', dateStr(viewYear, viewMonth, selDay))} className="text-xs bg-blue-600 px-2.5 py-1.5 rounded-lg font-semibold active:opacity-80">+ Add</button>
                    <button onClick={() => openModal('resched_rollover', dateStr(viewYear, viewMonth, selDay))} className="text-xs bg-emerald-700 px-2.5 py-1.5 rounded-lg font-semibold active:opacity-80">↩ Roll</button>
                    <button onClick={() => openModal('resched_late', dateStr(viewYear, viewMonth, selDay))} className="text-xs bg-indigo-700 px-2.5 py-1.5 rounded-lg font-semibold active:opacity-80">↩ Late</button>
                  </div>
                )}
              </div>

              {selSessions.length === 0
                ? <p className="text-gray-600 text-sm">No sessions. {locked ? 'Month is locked.' : 'Tap a button above to add one.'}</p>
                : selSessions.map(s => (
                  <SessionCard key={s.id} session={s} client={cl} locked={locked}
                    onStatus={status => setStatus(s.id, status)}
                    onDelete={() => deleteSession(s.id)}
                    onMove={newDate => moveSession(s.id, newDate)}
                    nextMoName={nextMoName}
                  />
                ))}
            </div>
          )}

          {/* Legend */}
          <div className="bg-gray-900/60 rounded-xl p-3 border border-gray-800">
            <p className="text-xs text-amber-400 font-semibold mb-1.5">Billing rule</p>
            <p className="text-xs text-gray-400 leading-relaxed">
              This month's actions drive <strong className="text-white">{nextMoName}'s bill</strong>.
              Only Rollovers affect the bill (−$rate). Reschedule Rollover adds it back (+$rate).
              Everything else is tracking only.
            </p>
          </div>
        </div>
      )}

      {/* ══ LIST TAB ══ */}
      {view === 'list' && cl && (
        <div className="px-4 pb-6">
          {!locked && (
            <div className="flex gap-2 mb-4 flex-wrap">
              <button onClick={() => openModal('extra')} className="text-xs bg-blue-600 px-3 py-2 rounded-lg font-semibold active:opacity-80">+ Add Session</button>
              <button onClick={() => openModal('resched_rollover')} className="text-xs bg-emerald-700 px-3 py-2 rounded-lg font-semibold active:opacity-80">↩ Reschedule Rollover</button>
              <button onClick={() => openModal('resched_late')} className="text-xs bg-indigo-700 px-3 py-2 rounded-lg font-semibold active:opacity-80">↩ Reschedule Late Cancel</button>
            </div>
          )}
          {moSessions.length === 0
            ? <p className="text-gray-600 text-center py-8">No sessions for {MONTHS[viewMonth]}.</p>
            : moSessions.map(s => (
              <SessionCard key={s.id} session={s} client={cl} locked={locked}
                onStatus={status => setStatus(s.id, status)}
                onDelete={() => deleteSession(s.id)}
                onMove={newDate => moveSession(s.id, newDate)}
                nextMoName={nextMoName}
              />
            ))}
        </div>
      )}

      {/* ══ SCHEDULE TAB ══ */}
      {view === 'schedule' && cl && (
        <div className="px-4 pb-6">
          <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 mb-4">
            <p className="font-bold mb-1">{cl.name} — Weekly Schedule</p>
            <p className="text-xs text-gray-400 mb-4 leading-relaxed">
              Select default training days. Sessions auto-populate the calendar each month.
              You can move individual sessions to different days without changing this schedule.
            </p>

            {/* Day toggles */}
            <div className="grid grid-cols-7 gap-1.5 mb-4">
              {WEEKDAYS.map((day, wd) => {
                const on = (cl.schedule || []).includes(wd);
                return (
                  <button key={wd} onClick={() => toggleScheduleDay(wd)}
                    className={`py-2 rounded-lg text-xs font-bold transition-colors active:opacity-80 ${on ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-500'}`}>
                    {day[0]}
                  </button>
                );
              })}
            </div>

            {/* Session count this month */}
            <p className="text-xs text-blue-400 mb-4">
              {MONTHS[viewMonth]}: {countScheduledSessions(cl, viewYear, viewMonth)} sessions scheduled
              {cl.schedule?.length ? ` (${cl.schedule.map(d => WEEKDAYS[d]).join(', ')})` : ''}
            </p>

            {/* Default session time */}
            <div className="mb-4">
              <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">Default Session Time</label>
              <input type="time" value={cl.defaultTime || '09:00'} onChange={e => setDefaultTime(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm" />
            </div>

            {/* Rate */}
            <div className="mb-4">
              <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">Session Rate ($)</label>
              <input type="number" min={1} value={cl.rate}
                onChange={e => upd(activeId, c => ({ ...c, rate: Number(e.target.value) }))}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm w-24" />
            </div>

            {/* Start date */}
            <div>
              <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1.5">Client Start Date</label>
              <input type="date" value={cl.startDate || ''}
                onChange={e => upd(activeId, c => syncSessions({ ...c, startDate: e.target.value }, viewYear, viewMonth))}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm" />
            </div>
          </div>

          {/* Archive client */}
          <button onClick={() => archiveClient(activeId)}
            className="w-full py-3 rounded-xl border border-gray-700 text-gray-500 text-sm font-semibold active:opacity-80">
            Archive {cl.name}
          </button>
        </div>
      )}

      {/* ══ SETTINGS TAB ══ */}
      {view === 'settings' && (
        <div className="px-4 pb-6">
          <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800 mb-4">
            <p className="font-bold mb-3">Data</p>
            <button onClick={() => exportData(clients)} className="w-full py-2.5 bg-gray-800 rounded-xl text-sm font-semibold mb-2 active:opacity-80">⬇ Export Backup (JSON)</button>
            <label className="w-full py-2.5 bg-gray-800 rounded-xl text-sm font-semibold flex items-center justify-center cursor-pointer active:opacity-80">
              ⬆ Import Backup (JSON)
              <input type="file" accept=".json" className="hidden" onChange={e => { if (e.target.files[0]) importData(e.target.files[0], d => { setClients(d); setActiveId(d[0]?.id || null); }); }} />
            </label>
          </div>

          <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
            <p className="font-bold mb-1">All-time Income</p>
            <p className="text-3xl font-bold text-green-400">${totalEarned}</p>
            <p className="text-xs text-gray-500 mt-1">All confirmed payments across all clients</p>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── MODAL ────────────────────────────────────────────────────────────────────
function Modal({ title, desc, onClose, onConfirm, children }) {
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="bg-gray-900 rounded-t-2xl w-full max-w-lg p-6 pb-10 border-t border-gray-800" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <p className="font-bold text-lg">{title}</p>
          <button onClick={onClose} className="text-gray-500 text-2xl leading-none">×</button>
        </div>
        {desc && <p className="text-xs text-gray-400 mb-4 leading-relaxed">{desc}</p>}
        {children}
        {onConfirm && (
          <button onClick={onConfirm} className="w-full mt-4 bg-blue-600 text-white py-3 rounded-xl font-bold active:opacity-80">
            Confirm
          </button>
        )}
      </div>
    </div>
  );
}

// ─── SESSION CARD ─────────────────────────────────────────────────────────────
function SessionCard({ session, client, locked, onStatus, onDelete, onMove, nextMoName }) {
  const [showMove, setShowMove] = useState(false);
  const [moveDate, setMoveDate] = useState('');
  const s = session;
  const meta = STATUS[s.status] || STATUS.scheduled;
  const billingEffect = meta.billing;

  return (
    <div className="mb-3 bg-gray-800/60 rounded-xl overflow-hidden border border-gray-700/50">
      {/* Top row */}
      <div className="flex items-center gap-3 p-3">
        <div className={`w-1 self-stretch rounded-full ${meta.color}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{s.time}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full bg-gray-700 ${meta.text}`}>{meta.label}</span>
            {s.note && <span className="text-xs text-gray-500 italic truncate">{s.note}</span>}
          </div>
          {billingEffect !== 0 && (
            <p className={`text-xs mt-0.5 ${billingEffect < 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
              {billingEffect < 0 ? '−' : '+'}${client.rate} → {nextMoName}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-green-400">${s.rate || client.rate}</span>
          <a href={gcalUrl(s, client.name)} target="_blank" rel="noreferrer" className="text-gray-500 text-base active:opacity-70">📅</a>
          {!locked && <button onClick={onDelete} className="text-gray-600 text-sm active:opacity-70">✕</button>}
        </div>
      </div>

      {/* Status buttons */}
      {!locked && (
        <div className="px-3 pb-2 flex flex-wrap gap-1.5">
          {Object.entries(STATUS).map(([k, v]) => (
            <button key={k} onClick={() => onStatus(k)}
              className={`text-xs px-2.5 py-1 rounded-full font-semibold transition-all active:opacity-80 border
                ${s.status === k ? `${v.color} text-white border-transparent` : 'bg-transparent border-gray-700 text-gray-500'}`}>
              {v.short}
            </button>
          ))}
        </div>
      )}

      {/* Move session */}
      {!locked && (
        <div className="px-3 pb-3">
          {!showMove
            ? <button onClick={() => setShowMove(true)} className="text-xs text-gray-600 active:opacity-70">Move to different day →</button>
            : (
              <div className="flex items-center gap-2 mt-1">
                <input type="date" value={moveDate} onChange={e => setMoveDate(e.target.value)}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white text-xs" />
                <button onClick={() => { if (moveDate) { onMove(moveDate); setShowMove(false); setMoveDate(''); } }}
                  className="text-xs bg-blue-600 px-3 py-1 rounded-lg font-semibold active:opacity-80">Move</button>
                <button onClick={() => setShowMove(false)} className="text-xs text-gray-500">Cancel</button>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

// ─── NEW CLIENT FORM ──────────────────────────────────────────────────────────
function NewClientForm({ ncName, setNcName, ncRate, setNcRate, ncStart, setNcStart, ncTime, setNcTime, addClient, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-end justify-center">
      <div className="bg-gray-900 rounded-t-2xl w-full max-w-lg p-6 pb-10 border-t border-gray-800">
        <div className="flex items-center justify-between mb-4">
          <p className="font-bold text-lg">New Client</p>
          <button onClick={onCancel} className="text-gray-500 text-2xl">×</button>
        </div>
        <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Name</label>
        <input value={ncName} onChange={e => setNcName(e.target.value)} placeholder="Client name"
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-3" autoFocus />
        <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Start Date</label>
        <input type="date" value={ncStart} onChange={e => setNcStart(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white mb-3" />
        <div className="flex gap-3 mb-4">
          <div className="flex-1">
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Rate ($/session)</label>
            <input type="number" min={1} value={ncRate} onChange={e => setNcRate(Number(e.target.value))}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white" />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500 uppercase tracking-wider mb-1">Default Time</label>
            <input type="time" value={ncTime} onChange={e => setNcTime(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-white" />
          </div>
        </div>
        <button onClick={addClient} className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold text-lg active:opacity-80">
          Add Client
        </button>
      </div>
    </div>
  );
}

// ─── MODAL INFO ───────────────────────────────────────────────────────────────
const MODAL_INFO = {
  extra:           { title: 'Add Session',               desc: rate => `Added to this month. Does not affect billing — tracking only.` },
  resched_rollover:{ title: 'Reschedule — Rollover',     desc: rate => `Adds +$${rate} back to next month's bill. Cancels out a rollover.` },
  resched_late:    { title: 'Reschedule — Late Cancel',  desc: () => `No billing effect. Tracking only.` },
};
