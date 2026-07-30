import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionState, Settings, DayScore, ServerStatus, HISTORY_KEY, localDateKey, weekdayName, DEFAULT_SETTINGS, clampIconChangeHeartbeats, ICON_CHANGE_MIN, ICON_CHANGE_MAX, clampCryBeepVolume, CRY_BEEP_MIN, CRY_BEEP_MAX, clampCryBeepDuration, CRY_BEEP_DURATION_MIN, CRY_BEEP_DURATION_MAX, clampIdleTime, IDLE_TIME_MIN, IDLE_TIME_MAX, CRY_BEEP_STYLES, clampCryBeepStyle } from '../../types';
import { FileText, Activity, Settings2, Plus, X, Zap, ZapOff, Check, Copy, ClipboardPaste, Volume2, VolumeX, Info, LogIn, LogOut } from 'lucide-react';
import '../../index.css';


// Diverging pair for both charts: focus green, distraction red, matched at the
// 700 step. As a *colour pair* these are indistinguishable to a red/green
// colourblind reader (deutan ΔE 4.2 — same lightness, and CVD collapses the hue
// axis that separates them). That's acceptable ONLY because neither chart asks
// colour to carry identity: focusScore is always ≥ 0 and distractedScore always
// ≤ 0, so focus is always the mark ABOVE the zero baseline and distraction always
// the one below — position tells them apart, and the lines can never cross.
// If a series ever gains a sign, this pair must be re-validated.
const FOCUS_COLOR = '#15803d';      // green-700
const DISTRACTED_COLOR = '#b91c1c'; // red-700
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Visible build marker. Bump it whenever you need to confirm at a glance that the
// extension Brave has loaded is the one you just built — a stale service worker or an
// extension loaded from a different directory is otherwise indistinguishable from a
// code bug. Rendered at the top of the Main tab, deliberately OUTSIDE ServerAccount
// so "marker present, account section missing" and "nothing at all" mean different
// things. Delete both this and the line that renders it once syncing is verified.
const BUILD_TAG = 'server-sync build 1';

/** Mean of each score over the `days` complete days ENDING YESTERDAY. Today is
 *  excluded on purpose: it's still accumulating, so folding a half-finished day
 *  into the average would drag it down all morning and make the bar meaningless.
 *  Counts only days that were actually recorded — a day the PC never came on
 *  shouldn't read as a day of zero focus. */
function windowAvg(rows: DayScore[], days: number, todayKey: string) {
  const end = new Date(`${todayKey}T00:00:00`).getTime() - DAY_MS; // yesterday
  const start = end - (days - 1) * DAY_MS;
  const win = rows.filter((r) => {
    const t = new Date(`${r.date}T00:00:00`).getTime();
    return t >= start && t <= end;
  });
  if (win.length === 0) return { focusScore: 0, distractedScore: 0 };
  return {
    focusScore: win.reduce((s, r) => s + r.focusScore, 0) / win.length,
    distractedScore: win.reduce((s, r) => s + r.distractedScore, 0) / win.length,
  };
}

/** Diverging bar chart: one column per period, green growing up from the zero
 *  baseline and red growing down. Both series share ONE magnitude scale so the
 *  two halves stay comparable. Exact numbers live in the list above, so the bars
 *  carry hover tooltips instead of a label on every mark. */
const ScoreChart = ({ rows, todayKey }: { rows: DayScore[]; todayKey: string }) => {
  // Left→right runs from the widest lookback to the most recent: the 30- and
  // 7-day averages, then the 3 previous days, then today at the far right.
  const last4 = rows.slice(0, 4).reverse(); // rows arrive newest-first; today ends up last
  const bars = [
    { key: 'm', label: '30 d', isAvg: true, ...windowAvg(rows, 30, todayKey) },
    { key: 'w', label: '7 d', isAvg: true, ...windowAvg(rows, 7, todayKey) },
    ...last4.map((d) => ({ key: d.date, label: d.weekday.slice(0, 3), isAvg: false, ...d })),
  ];

  const H = 39; // px per half — the chart is 2H tall plus the baseline
  const max = Math.max(1, ...bars.map((b) => Math.max(Math.abs(b.focusScore), Math.abs(b.distractedScore))));
  const px = (v: number) => Math.round((Math.min(Math.abs(v), max) / max) * H);

  return (
    <div className="rounded-xl border border-slate-100 px-2 pt-2 pb-1">
      <div className="flex items-start justify-between gap-[2px]">
        {bars.map((b) => (
          <div
            key={b.key}
            className="flex flex-1 flex-col items-center"
            title={`${b.label}: focus ${Math.round(b.focusScore)}, distracted ${Math.round(b.distractedScore)}`}
          >
            <div className="flex w-full flex-col justify-end" style={{ height: H }}>
              <div
                className="mx-auto w-2/3"
                style={{ height: px(b.focusScore), background: FOCUS_COLOR, borderRadius: '4px 4px 0 0' }}
              />
            </div>
            <div className="h-px w-full bg-slate-200" />
            <div className="w-full" style={{ height: H }}>
              <div
                className="mx-auto w-2/3"
                style={{ height: px(b.distractedScore), background: DISTRACTED_COLOR, borderRadius: '0 0 4px 4px' }}
              />
            </div>
            <span className={`mt-0.5 whitespace-nowrap text-[8px] ${b.isAvg ? 'font-bold text-slate-500' : 'text-slate-400'}`}>
              {b.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Two series → a legend is always present, so identity never rests on colour
 *  alone. Shared by both charts, which use the same pair. */
const ScoreLegend = () => (
  <div className="flex justify-center gap-3 text-[8px] text-slate-400">
    <span className="flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-sm" style={{ background: FOCUS_COLOR }} /> Focus (above 0)
    </span>
    <span className="flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-sm" style={{ background: DISTRACTED_COLOR }} /> Distracted (below 0)
    </span>
  </div>
);

/** Whole-history trend: every banked day plus today's live score as the final
 *  point. Days sit on a real time scale, so gaps (days the PC was off) show as
 *  gaps rather than being squashed out. At this width individual days are only a
 *  few px apart and can't be labelled, so the x axis carries month names only. */
const ScoreTrend = ({ rows }: { rows: DayScore[] }) => {
  const pts = [...rows].reverse(); // rows are newest-first; a trend reads oldest→newest
  if (pts.length < 2) return null; // one point is not a line — the bars already show it

  const W = 250, H = 73, PAD = 3, LABEL_H = 10;
  const ms = (d: string) => new Date(`${d}T00:00:00`).getTime();
  const t0 = ms(pts[0].date);
  const tN = ms(pts[pts.length - 1].date);
  const span = Math.max(1, tN - t0); // guard: all points on one day
  const max = Math.max(1, ...pts.map((p) => Math.max(Math.abs(p.focusScore), Math.abs(p.distractedScore))));
  const x = (d: string) => ((ms(d) - t0) / span) * W;
  const y = (v: number) => H / 2 - (v / max) * (H / 2 - PAD); // zero centred, one shared scale
  const path = (get: (p: DayScore) => number) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(get(p)).toFixed(1)}`).join(' ');

  // A tick at each month boundary inside the range, plus the first point's month
  // so a range shorter than a month is still labelled.
  const ticks: { x: number; label: string }[] = [{ x: 0, label: MONTHS[new Date(t0).getMonth()] }];
  const cursor = new Date(t0);
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() + 1);
  while (cursor.getTime() <= tN) {
    ticks.push({ x: ((cursor.getTime() - t0) / span) * W, label: MONTHS[cursor.getMonth()] });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return (
    <svg viewBox={`0 0 ${W} ${H + LABEL_H}`} className="w-full" style={{ height: H + LABEL_H }}>
      <line x1="0" y1={y(0)} x2={W} y2={y(0)} stroke="#e2e8f0" strokeWidth="1" />
      {ticks.map((t) => (
        <g key={t.label + t.x}>
          <line x1={t.x} y1="0" x2={t.x} y2={H} stroke="#f1f5f9" strokeWidth="1" />
          <text
            x={Math.min(Math.max(t.x, 8), W - 8)}
            y={H + LABEL_H - 1}
            textAnchor="middle"
            fontSize="8"
            fill="#94a3b8"
          >
            {t.label}
          </text>
        </g>
      ))}
      <path d={path((p) => p.focusScore)} fill="none" stroke={FOCUS_COLOR} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
      <path d={path((p) => p.distractedScore)} fill="none" stroke={DISTRACTED_COLOR} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" />
      {/* Today is the point that matters most — mark where the lines end. */}
      <circle cx={x(pts[pts.length - 1].date)} cy={y(pts[pts.length - 1].focusScore)} r="2.5" fill={FOCUS_COLOR} />
      <circle cx={x(pts[pts.length - 1].date)} cy={y(pts[pts.length - 1].distractedScore)} r="2.5" fill={DISTRACTED_COLOR} />
    </svg>
  );
};

// ── Daily history ─────────────────────────────────────────────────────────────
// Past days are banked into storage by the background at rollover. Today is NOT in
// there yet — it's still live in SessionState — so we append it here to get one
// complete row per day.
/** Copy to clipboard, with a fallback for when the async Clipboard API is
 *  unavailable or denied. Deliberately NOT a file download: on Wayland, a native
 *  save/open dialog parented to the extension popup — a transient surface that is
 *  destroyed the moment focus leaves it — is a protocol violation that gets the
 *  whole browser killed by the compositor (SIGTRAP, "WL: error in client
 *  communication"). Nothing here may open a native dialog. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      Object.assign(ta.style, { position: 'fixed', opacity: '0' });
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Parse a pasted CSV back into history. The date drives everything: rows whose
 *  first cell isn't a YYYY-MM-DD date are skipped, which conveniently also skips
 *  the header. The weekday column is re-derived rather than trusted, so a
 *  hand-edited file can't display a day that contradicts its own date. */
function parseCsv(text: string): DayScore[] {
  const rows: DayScore[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const cells = raw.split(',').map((c) => c.trim());
    const date = cells[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const focusScore = Number(cells[2]);
    const distractedScore = Number(cells[3]);
    if (!Number.isFinite(focusScore) || !Number.isFinite(distractedScore)) continue;
    rows.push({ date, weekday: weekdayName(date), focusScore, distractedScore });
  }
  // Last row wins on a duplicate date; store oldest-first like the background does.
  return [...new Map(rows.map((r) => [r.date, r])).values()]
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Stand-in days used ONLY when nothing has been banked yet, so the charts have
 *  something to draw on day one (the trend needs ≥2 points, the bars want 4).
 *  Never written to storage and never exported — see `realRows` below. */
const SAMPLE_FOCUS = 50;
const SAMPLE_DISTRACTED = -20;
function sampleDays(todayKey: string): DayScore[] {
  return [1, 2, 3, 4].map((i) => {
    const d = new Date(`${todayKey}T00:00:00`);
    d.setDate(d.getDate() - i);
    const date = localDateKey(d);
    return { date, weekday: weekdayName(date), focusScore: SAMPLE_FOCUS, distractedScore: SAMPLE_DISTRACTED };
  });
}

const DailyHistory = ({ state }: { state: SessionState }) => {
  const [history, setHistory] = useState<DayScore[]>([]);
  const [importMsg, setImportMsg] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  useEffect(() => {
    const load = () => chrome.storage.local.get([HISTORY_KEY], (r) => {
      setHistory(Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : []);
    });
    load();
    // Repaint if a rollover banks a day while the popup happens to be open.
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes[HISTORY_KEY]) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const date = state.scoreDate || localDateKey();
  const today: DayScore = {
    date,
    weekday: weekdayName(date),
    focusScore: state.focusScore ?? 0,
    distractedScore: state.distractedScore ?? 0,
  };
  // Newest first for display. Filter today out of history first: the live value
  // wins if a stale row for the same date somehow exists.
  const realRows = [...history.filter((d) => d.date !== today.date), today]
    .sort((a, b) => b.date.localeCompare(a.date));

  // Nothing banked yet → pad with sample days so the charts render. The moment a
  // single real day exists the samples vanish for good. They stay out of realRows,
  // which is what the CSV exports, so demo numbers can never leak into your data.
  const isSample = history.length === 0;
  const rows = isSample
    ? [...realRows, ...sampleDays(today.date)].sort((a, b) => b.date.localeCompare(a.date))
    : realRows;

  const copyCsv = async () => {
    const header = 'date,weekday,focus,distracted';
    // Oldest first — it reads like a log and charts without sorting.
    const body = [...realRows].reverse()
      .map((d) => `${d.date},${d.weekday},${Math.round(d.focusScore)},${Math.round(d.distractedScore)}`);
    const ok = await copyText([header, ...body].join('\n') + '\n');
    setImportMsg(ok
      ? `Copied ${realRows.length} day${realRows.length === 1 ? '' : 's'} — paste into a file to keep`
      : 'Copy failed — clipboard unavailable');
  };

  const applyPaste = () => {
    const parsed = parseCsv(pasteText);
    if (parsed.length === 0) {
      setImportMsg('No valid rows found — expected date,weekday,focus,distracted');
      return;
    }
    // Replaces the stored history outright, as intended. Today is untouched:
    // it lives in SessionState, not here, and still wins on display.
    chrome.storage.local.set({ [HISTORY_KEY]: parsed }, () => {
      setHistory(parsed);
      setPasteOpen(false);
      setPasteText('');
      setImportMsg(`Replaced history with ${parsed.length} day${parsed.length === 1 ? '' : 's'}`);
    });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-500 font-medium">Daily history</span>
        <div className="flex gap-1">
          <button
            onClick={copyCsv}
            title="Copy every recorded day as CSV to the clipboard"
            className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-200 cursor-pointer"
          >
            <Copy size={11} /> Copy
          </button>
          <button
            onClick={() => { setPasteOpen((v) => !v); setImportMsg(''); }}
            title="Paste CSV — REPLACES all stored past days"
            className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-200 cursor-pointer"
          >
            <ClipboardPaste size={11} /> Paste
          </button>
        </div>
      </div>
      {pasteOpen && (
        <div className="space-y-1 rounded-xl bg-slate-50 p-2">
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={'date,weekday,focus,distracted\n2026-07-14,Tuesday,12,-30'}
            rows={4}
            className="w-full resize-none rounded-lg border border-slate-200 p-1.5 font-mono text-[9px] text-slate-700 focus:border-slate-400 focus:outline-none"
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={() => { setPasteOpen(false); setPasteText(''); }}
              className="rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-200 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={applyPaste}
              disabled={!pasteText.trim()}
              className="rounded-lg bg-slate-700 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              Replace history
            </button>
          </div>
        </div>
      )}
      {isSample && (
        <p className="text-[9px] font-medium text-amber-600">
          Sample days shown — no history banked yet
        </p>
      )}
      {importMsg && <p className="text-[9px] text-slate-500">{importMsg}</p>}
      <ScoreChart rows={rows} todayKey={today.date} />
      <ScoreTrend rows={rows} />
      <ScoreLegend />
      {/* Per-day detail last: the charts answer "how am I doing", this answers
          "what exactly did I score on Tuesday". It doubles as the table view the
          charts lean on for exact values. */}
      <div className="max-h-28 overflow-y-auto rounded-xl border border-slate-100 divide-y divide-slate-100">
        {rows.map((d) => (
          <div key={d.date} className="flex items-center justify-between px-3 py-1.5 text-xs">
            <span>
              <span className="font-medium text-slate-600">{d.weekday.slice(0, 3)}</span>{' '}
              <span className="text-slate-400">{d.date}</span>
            </span>
            <span className="font-bold tabular-nums">
              <span className="text-green-600">{Math.round(d.focusScore)}</span>
              <span className="text-slate-300"> / </span>
              <span className="text-red-600">{Math.round(d.distractedScore)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};


// ── Main tab ──────────────────────────────────────────────────────────────────
const MainTab = ({ state, settings, currentTabDomain, currentTabUrl, onWhitelistToggle }: {
  state: SessionState;
  settings: Settings;   // read-only here: the whitelist check. Edits live in SettingsTab.
  currentTabDomain: string;
  currentTabUrl: string;
  onWhitelistToggle: () => void;
}) => {
  const isWhitelisted = currentTabUrl.length > 0 &&
    settings.allowedDomains.some(d => d.trim() !== '' && currentTabUrl.includes(d.trim()));

  return (
  <div className="space-y-4">
    {/* Temporary: see BUILD_TAG. */}
    <div className="rounded-lg bg-indigo-50 px-2 py-1 text-center text-[10px] font-bold text-indigo-600">
      {BUILD_TAG}
    </div>

    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-500 font-medium">Status</span>
      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
        state.isHeartbeatActive ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600'
      }`}>
        {state.isHeartbeatActive ? 'Active' : 'Idle'}
      </span>
    </div>

    {currentTabDomain && (
      <div className="space-y-1">
        <button
          onClick={onWhitelistToggle}
          className={`w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-sm font-bold shadow-sm transition-colors cursor-pointer ${
            isWhitelisted
              ? 'bg-green-500 text-white hover:bg-green-600'
              : 'bg-amber-400 text-amber-950 hover:bg-amber-500'
          }`}
          title={isWhitelisted ? 'Click to remove this page from the whitelist' : 'Click to add this page to the whitelist'}
        >
          {isWhitelisted ? <Check size={16} /> : <Plus size={16} />}
          {isWhitelisted ? (
            <span className="flex flex-col items-center leading-tight">
              Page is in whitelist
              <span className="text-[9px] font-medium opacity-80">click to remove</span>
            </span>
          ) : (
            'Whitelist this page'
          )}
        </button>
        <p className="text-[9px] text-slate-400 truncate text-center">{currentTabDomain}</p>
      </div>
    )}

    <div className="grid grid-cols-2 gap-2">
      <div className="flex items-center justify-between rounded-xl bg-green-50 px-3 py-2">
        <span className="text-sm text-green-600 font-medium">Focus</span>
        <span className="text-lg font-extrabold tabular-nums text-green-700">
          {Math.round(state.focusScore ?? 0)}
        </span>
      </div>
      <div className="flex items-center justify-between rounded-xl bg-red-50 px-3 py-2">
        <span className="text-sm text-red-600 font-medium">Distracted</span>
        <span className="text-lg font-extrabold tabular-nums text-red-700">
          {Math.round(state.distractedScore ?? 0)}
        </span>
      </div>
    </div>

    {/* Directly under the scores it syncs, and above the history it feeds. Sits on
        the main page rather than in Settings: signing in is a first-run action that
        has to be findable, not a preference buried behind a tab. */}
    <ServerAccount />

    <DailyHistory state={state} />

  </div>
  );
};

// ── Account & data sync ───────────────────────────────────────────────────────
// Sign-in is dispatched to the BACKGROUND, not run here: launchWebAuthFlow opens a
// window, which closes the popup, which would kill the flow before Google
// redirects back. The background survives that, so the popup only ever asks.
const ServerAccount = () => {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = (type: 'SERVER_STATUS' | 'SERVER_SIGN_IN' | 'SERVER_SIGN_OUT') => {
    setBusy(type !== 'SERVER_STATUS');
    chrome.runtime.sendMessage({ type }, (res?: ServerStatus) => {
      void chrome.runtime.lastError;
      setBusy(false);
      if (res) setStatus(res);
    });
  };

  useEffect(() => { ask('SERVER_STATUS'); }, []);

  // An unconfigured build has no server at all — say so plainly rather than
  // offering a sign-in button that can only fail.
  if (status && !status.configured) {
    return (
      <section className="space-y-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Data sync</h3>
        <p className="text-[9px] text-slate-400">
          Not configured in this build. Fill in <code>src/extension/server/config.ts</code> and
          rebuild to enable syncing — see <code>supabase/README.md</code>.
        </p>
      </section>
    );
  }

  const summary = status?.summary as {
    live_focus?: number; live_distracted?: number;
    avg7_focus?: number; avg30_focus?: number;
  } | null;

  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
        Data sync — sign in
      </h3>

      {status?.signedIn ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 text-[11px] leading-tight text-slate-600">
              Signed in
              <br />
              <span className="block truncate text-[10px] text-slate-400">{status.email}</span>
            </span>
            <button
              onClick={() => ask('SERVER_SIGN_OUT')}
              disabled={busy}
              className="flex-shrink-0 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-200 disabled:opacity-40 cursor-pointer"
            >
              <LogOut size={11} className="inline" /> Sign out
            </button>
          </div>
          {summary && (
            <div className="rounded-xl bg-slate-50 p-2 text-[10px] text-slate-500">
              <div className="flex justify-between">
                <span>Server live score</span>
                <span className="font-bold tabular-nums text-slate-700">
                  {Math.round(summary.live_focus ?? 0)} / {Math.round(summary.live_distracted ?? 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>7-day average (focus)</span>
                <span className="font-bold tabular-nums text-slate-700">{Math.round(summary.avg7_focus ?? 0)}</span>
              </div>
              <div className="flex justify-between">
                <span>30-day average (focus)</span>
                <span className="font-bold tabular-nums text-slate-700">{Math.round(summary.avg30_focus ?? 0)}</span>
              </div>
            </div>
          )}
          <p className="text-[9px] text-slate-400">
            Scores and your whitelist are saved to the study server. Days roll over at 01:00 local time.
          </p>
        </>
      ) : (
        <>
          <button
            onClick={() => ask('SERVER_SIGN_IN')}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-700 px-3 py-2 text-sm font-bold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
          >
            <LogIn size={14} /> {busy ? 'Signing in…' : 'Sign in with Google'}
          </button>
          <p className="text-[9px] text-slate-400">
            Optional. Signing in saves your daily scores, averages and whitelisted domains to the
            study server so they survive a reinstall and sync across devices. The extension works
            fully without it.
          </p>
        </>
      )}
    </section>
  );
};

// ── Settings tab ──────────────────────────────────────────────────────────────
const SettingsTab = ({ settings, onChange }: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) => {
  const [newDomain, setNewDomain] = useState('');
  const [domainPasteOpen, setDomainPasteOpen] = useState(false);
  const [domainPasteText, setDomainPasteText] = useState('');
  const [domainMsg, setDomainMsg] = useState('');
  const [companionInfoOpen, setCompanionInfoOpen] = useState(false);

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  const addDomain = () => {
    const d = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!d || settings.allowedDomains.includes(d)) return;
    set({ allowedDomains: [...settings.allowedDomains, d] });
    setNewDomain('');
  };

  const removeDomain = (d: string) =>
    set({ allowedDomains: settings.allowedDomains.filter(x => x !== d) });

  // Copy the whitelist to the clipboard, one domain per line.
  const copyDomains = async () => {
    const ok = await copyText(settings.allowedDomains.join('\n') + '\n');
    setDomainMsg(ok
      ? `Copied ${settings.allowedDomains.length} domain${settings.allowedDomains.length === 1 ? '' : 's'} to clipboard`
      : 'Copy failed — clipboard unavailable');
  };

  // Overwrite the whitelist with the pasted list (one domain per line). Same
  // normalisation as addDomain; blanks and duplicates are dropped.
  const applyDomainPaste = () => {
    const seen = new Set<string>();
    const domains: string[] = [];
    for (const line of domainPasteText.split(/[\n,]/)) {
      const d = line.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!d || seen.has(d)) continue;
      seen.add(d);
      domains.push(d);
    }
    set({ allowedDomains: domains });
    setDomainPasteOpen(false);
    setDomainPasteText('');
    setDomainMsg(`Replaced whitelist with ${domains.length} domain${domains.length === 1 ? '' : 's'}`);
  };

  return (
    <div className="space-y-5 text-sm">

      {/* Feature toggles. Sound lives in the header next to Working — it's a
          one-click mute, not a setting you come in here to change. */}
      <section className="space-y-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Features</h3>

        {/* Floating companion */}
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-[11px] text-slate-600 leading-tight">
            Floating companion
            <button
              onClick={() => setCompanionInfoOpen(v => !v)}
              title="How to keep the companion window on top"
              aria-label="Floating companion info"
              className={`flex-shrink-0 transition-colors cursor-pointer ${companionInfoOpen ? 'text-blue-500' : 'text-slate-300 hover:text-slate-500'}`}
            >
              <Info size={12} />
            </button>
            <span className="text-[10px] text-slate-400">— pop-out window mirroring the sprite while you work elsewhere</span>
          </span>
          <div
            onClick={() => set({ companionEnabled: !settings.companionEnabled })}
            className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${settings.companionEnabled ? 'bg-blue-500' : 'bg-slate-300'}`}
          >
            <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${settings.companionEnabled ? 'translate-x-5' : ''}`} />
          </div>
        </div>
        {companionInfoOpen && (
          <div className="rounded-xl bg-slate-50 p-2.5 text-[10px] leading-snug text-slate-600 space-y-1.5">
            <p>
              This window is meant to float <strong>above all your other apps</strong> so you can
              keep an eye on the sprite while working elsewhere. Browsers can't pin their own
              windows on top, so it's set per machine — here's how:
            </p>
            <ul className="space-y-1">
              <li>
                <strong>Windows</strong> — install <a href="https://learn.microsoft.com/windows/powertoys/" target="_blank" rel="noreferrer" className="text-blue-600 underline">PowerToys</a>,
                focus the window and press <code className="rounded bg-slate-200 px-1">Win+Ctrl+T</code>.
              </li>
              <li>
                <strong>macOS</strong> — no built-in option; use a helper such as <a href="https://rectangleapp.com/" target="_blank" rel="noreferrer" className="text-blue-600 underline">Rectangle</a> or Amethyst to pin it.
              </li>
              <li>
                <strong>Linux / GNOME</strong> — run once:<br />
                <code className="mt-0.5 inline-block break-all rounded bg-slate-200 px-1">gsettings set org.gnome.desktop.wm.keybindings toggle-above "['&lt;Primary&gt;backslash']"</code><br />
                then focus the window and press <code className="rounded bg-slate-200 px-1">Ctrl+\</code>.
              </li>
              <li>
                <strong>Linux / KDE</strong> — right-click the title bar → <em>More Actions → Keep Above Others</em>.
              </li>
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-[11px] text-slate-600">AI request</span>
          <div
            onClick={() => set({ aiRequestEnabled: !settings.aiRequestEnabled })}
            className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${settings.aiRequestEnabled ? 'bg-blue-500' : 'bg-slate-300'}`}
          >
            <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${settings.aiRequestEnabled ? 'translate-x-5' : ''}`} />
          </div>
        </div>
      </section>

      {/* Timers */}
      <section className="space-y-3">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Timers</h3>

        {/* Idle time */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-600 leading-tight">
              Idle time<br />
              <span className="text-[10px] text-slate-400">seconds of no activity before going idle</span>
            </span>
            <span className="text-[12px] font-bold text-blue-600 tabular-nums w-16 text-right">
              {clampIdleTime(settings.idleTime)} s
            </span>
          </div>
          <input
            type="range"
            min={IDLE_TIME_MIN} max={IDLE_TIME_MAX} step={1}
            value={clampIdleTime(settings.idleTime)}
            onChange={e => set({ idleTime: clampIdleTime(Number(e.target.value)) })}
            className="w-full accent-blue-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-slate-400">
            <span>{IDLE_TIME_MIN} s</span>
            <span>{IDLE_TIME_MAX} s</span>
          </div>
        </div>

        {/* Icon-change heartbeats */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-600 leading-tight">
              Change character every<br />
              <span className="text-[10px] text-slate-400">heartbeats of focused work before a new icon</span>
            </span>
            <span className="text-[12px] font-bold text-blue-600 tabular-nums w-16 text-right">
              {clampIconChangeHeartbeats(settings.iconChangeHeartbeats)} hb
            </span>
          </div>
          <input
            type="range"
            min={ICON_CHANGE_MIN} max={ICON_CHANGE_MAX} step={1}
            value={clampIconChangeHeartbeats(settings.iconChangeHeartbeats)}
            onChange={e => set({ iconChangeHeartbeats: clampIconChangeHeartbeats(Number(e.target.value)) })}
            className="w-full accent-blue-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-slate-400">
            <span>{ICON_CHANGE_MIN} hb</span>
            <span>{ICON_CHANGE_MAX} hb</span>
          </div>
        </div>

        {/* Idle beep volume */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-600 leading-tight">
              Idle beep volume<br />
              <span className="text-[10px] text-slate-400">high tone that fades in while crying (0 = off)</span>
            </span>
            <span className="text-[12px] font-bold text-blue-600 tabular-nums w-16 text-right">
              {clampCryBeepVolume(settings.cryBeepVolume)} %
            </span>
          </div>
          <input
            type="range"
            min={CRY_BEEP_MIN} max={CRY_BEEP_MAX} step={1}
            value={clampCryBeepVolume(settings.cryBeepVolume)}
            onChange={e => set({ cryBeepVolume: clampCryBeepVolume(Number(e.target.value)) })}
            className="w-full accent-blue-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-slate-400">
            <span>{CRY_BEEP_MIN} %</span>
            <span>{CRY_BEEP_MAX} %</span>
          </div>
        </div>

        {/* Idle beep style */}
        <div className="space-y-1.5">
          <span className="text-[11px] text-slate-600">Beep style</span>
          <div className="grid grid-cols-3 gap-1">
            {CRY_BEEP_STYLES.map(s => {
              const active = clampCryBeepStyle(settings.cryBeepStyle) === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => set({ cryBeepStyle: s.id })}
                  title={s.hint}
                  className={`text-[10px] font-semibold rounded-lg px-1 py-1.5 border transition-colors ${
                    active
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <p className="text-[9px] text-slate-400 leading-snug">
            {CRY_BEEP_STYLES.find(s => s.id === clampCryBeepStyle(settings.cryBeepStyle))?.hint}
          </p>
        </div>

        {/* Idle beep duration */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-600 leading-tight">
              Idle beep duration<br />
              <span className="text-[10px] text-slate-400">how long the beep lasts before stopping</span>
            </span>
            <span className="text-[12px] font-bold text-blue-600 tabular-nums w-16 text-right">
              {clampCryBeepDuration(settings.cryBeepDuration)} s
            </span>
          </div>
          <input
            type="range"
            min={CRY_BEEP_DURATION_MIN} max={CRY_BEEP_DURATION_MAX} step={5}
            value={clampCryBeepDuration(settings.cryBeepDuration)}
            onChange={e => set({ cryBeepDuration: clampCryBeepDuration(Number(e.target.value)) })}
            className="w-full accent-blue-500 cursor-pointer"
          />
          <div className="flex justify-between text-[9px] text-slate-400">
            <span>{CRY_BEEP_DURATION_MIN} s</span>
            <span>{CRY_BEEP_DURATION_MAX} s</span>
          </div>
        </div>
      </section>

      {/* AI auto-classify */}
      <section className="space-y-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">AI Auto-classify</h3>
        <p className="text-[9px] text-slate-400">
          Optional. Points at an Ollama-compatible AI backend to auto-whitelist study pages.
          <strong> Local:</strong> put just the address+port and leave the key empty
          (run <code>OLLAMA_ORIGINS="*" ollama serve</code>). <strong>Remote:</strong> put the
          server's base URL and its API key. Without a reachable backend the extension still
          works — unknown pages just stay inactive and you add them manually.
        </p>

        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-600 leading-tight">
            AI address<br />
            <span className="text-[10px] text-slate-400">local: host:port · remote: base URL</span>
          </span>
          <input
            type="text"
            value={settings.classifyUrl ?? ''}
            onChange={e => set({ classifyUrl: e.target.value })}
            className="w-40 text-right text-[12px] border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-300"
            placeholder="http://localhost:11434"
          />
        </label>

        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-600 leading-tight">
            API key<br />
            <span className="text-[10px] text-slate-400">leave empty for a local model</span>
          </span>
          <input
            type="password"
            value={settings.classifyApiKey ?? ''}
            onChange={e => set({ classifyApiKey: e.target.value })}
            className="w-40 text-right text-[12px] border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-300"
            placeholder="(none — local)"
          />
        </label>

        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-600 leading-tight">
            Model name<br />
            <span className="text-[10px] text-slate-400">required · must reply YES / NO</span>
          </span>
          <input
            type="text"
            value={settings.classifyModel ?? ''}
            onChange={e => set({ classifyModel: e.target.value })}
            className="w-40 text-right text-[12px] border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-300"
            placeholder="qwen-yesno"
          />
        </label>

        <p className="text-[9px] text-slate-400">
          Speaks Ollama's API by default. For a non-Ollama backend (Gemini / OpenAI / Claude),
          edit <code>classifyPage()</code> in <code>src/extension/background.ts</code> — see the
          README for ready-to-paste examples.
        </p>

        <label className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-600 leading-tight">
            CPU threads cap<br />
            <span className="text-[10px] text-slate-400">limits load per request (0 = Ollama default)</span>
          </span>
          <input
            type="number" min={0} max={64}
            value={settings.classifyNumThreads}
            onChange={e => set({ classifyNumThreads: Math.max(0, Math.min(64, Number(e.target.value))) })}
            className="w-16 text-right text-[12px] border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </label>

        <textarea
          rows={4}
          value={settings.classifyPrompt ?? ''}
          onChange={e => set({ classifyPrompt: e.target.value })}
          className="w-full text-[11px] border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-y leading-snug"
          placeholder="Prompt sent to the model…"
        />
        <p className="text-[9px] text-slate-400">
          URL and title are appended to the prompt automatically.
        </p>
      </section>

      {/* Allowed pages */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Allowed Pages</h3>
          <div className="flex gap-1">
            <button
              onClick={copyDomains}
              title="Copy the whitelist to the clipboard, one domain per line"
              className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-200 cursor-pointer"
            >
              <Copy size={11} /> Copy
            </button>
            <button
              onClick={() => { setDomainPasteOpen(v => !v); setDomainMsg(''); }}
              title="Paste a list — REPLACES the whole whitelist"
              className="flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-200 cursor-pointer"
            >
              <ClipboardPaste size={11} /> Paste
            </button>
          </div>
        </div>

        {domainPasteOpen && (
          <div className="space-y-1 rounded-xl bg-slate-50 p-2">
            <textarea
              value={domainPasteText}
              onChange={e => setDomainPasteText(e.target.value)}
              placeholder={'overleaf.com\narxiv.org\nwikipedia.org'}
              rows={4}
              className="w-full resize-none rounded-lg border border-slate-200 p-1.5 font-mono text-[9px] text-slate-700 focus:border-slate-400 focus:outline-none"
            />
            <div className="flex justify-end gap-1">
              <button
                onClick={() => { setDomainPasteOpen(false); setDomainPasteText(''); }}
                className="rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={applyDomainPaste}
                disabled={!domainPasteText.trim()}
                className="rounded-lg bg-slate-700 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
              >
                Replace whitelist
              </button>
            </div>
          </div>
        )}
        {domainMsg && <p className="text-[9px] text-slate-500">{domainMsg}</p>}

        <div className="rounded-xl border border-slate-100 bg-white p-2 space-y-0.5 max-h-48 overflow-y-auto">
          {settings.allowedDomains.length === 0 && (
            <p className="text-[10px] text-slate-400 text-center py-2">No domains — add one below.</p>
          )}
          {settings.allowedDomains.map(d => (
            <div key={d} className="flex items-center justify-between px-2 py-1 rounded-lg hover:bg-slate-50">
              <span className="text-[11px] text-slate-700">{d}</span>
              <button
                onClick={() => removeDomain(d)}
                className="text-slate-300 hover:text-red-500 transition-colors ml-2 flex-shrink-0"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>

        {/* Add domain */}
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="e.g. github.com"
            value={newDomain}
            onChange={e => setNewDomain(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addDomain()}
            className="flex-1 text-[11px] border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
          <button
            onClick={addDomain}
            className="flex items-center gap-1 text-[11px] bg-blue-500 text-white px-3 py-1.5 rounded-lg hover:bg-blue-600 transition-colors"
          >
            <Plus size={12} /> Add
          </button>
        </div>
        <p className="text-[9px] text-slate-400">
          Newly added pages require a tab reload to activate.
        </p>
      </section>
    </div>
  );
};

// Open (or focus) the floating-companion helper window — a small extension window
// that mirrors the sprite while you work in another app. Deduped via a stored
// window id so a repeat click focuses the existing window instead of stacking a
// new one. Keep it above other apps with your window manager (see the README
// "Floating companion" section).
function openCompanionWindow() {
  const url = chrome.runtime.getURL('pip.html');
  const create = () => chrome.windows.create(
    // Deliberately small — this sits in a screen corner while you work elsewhere.
    // The canvas scales with the window, so it survives being shrunk further.
    { url, type: 'popup', width: 300, height: 210 },
    (w) => { if (w?.id != null) chrome.storage.local.set({ pipWindowId: w.id }); },
  );
  chrome.storage.local.get(['pipWindowId'], ({ pipWindowId }) => {
    if (typeof pipWindowId === 'number') {
      chrome.windows.update(pipWindowId, { focused: true, drawAttention: true }, () => {
        if (chrome.runtime.lastError) create(); // stored window gone → make a new one
      });
    } else {
      create();
    }
  });
}

// ── Root ──────────────────────────────────────────────────────────────────────
const Popup = () => {
  const [activeTab, setActiveTab] = useState<'main' | 'settings'>('main');
  const [state, setState] = useState<SessionState | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [currentTabUrl, setCurrentTabUrl] = useState('');
  const [currentTabDomain, setCurrentTabDomain] = useState('');
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);

  useEffect(() => {
    // Load session state
    const fetchState = () => {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
        const empty: SessionState = {
          isHeartbeatActive: false, lastHeartbeat: 0, activeWindowId: null, enabled: true,
          currentIconId: 0, heartbeatCount: 0, iconChangeAt: 0, focusScore: 0, distractedScore: 0,
          scoreDate: localDateKey(), penaltyAt: 0, osHeld: false,
        };
        if (chrome.runtime.lastError) { setState(empty); return; }
        setState(res ?? empty);
      });
    };
    fetchState();
    const retry = setTimeout(() => { if (!state) fetchState(); }, 500);

    // Load settings
    chrome.storage.local.get(['focusFlowSettings'], (result) => {
      if (result.focusFlowSettings) {
        setSettings({ ...DEFAULT_SETTINGS, ...(result.focusFlowSettings as Settings) });
      }
    });

    // Live state updates
    const listener = (msg: any) => {
      if (msg.type === 'STATE_UPDATE') setState(msg.state);
    };
    chrome.runtime.onMessage.addListener(listener);

    // Current tab URL (for whitelist toggle)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (tab?.url) {
        setCurrentTabUrl(tab.url);
        if (tab.id) setCurrentTabId(tab.id);
        try {
          const hostname = new URL(tab.url).hostname.replace(/^www\./, '');
          setCurrentTabDomain(hostname);
        } catch { /* non-parseable URL, leave blank */ }
      }
    });

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(retry);
    };
  }, []);

  const saveSettings = (s: Settings) => {
    setSettings(s);
    chrome.storage.local.set({ focusFlowSettings: s });
  };

  const handleWhitelistToggle = () => {
    if (!currentTabDomain) return;
    const isWhitelisted = currentTabUrl.length > 0 &&
      settings.allowedDomains.some(d => d.trim() !== '' && currentTabUrl.includes(d.trim()));

    const reload = () => { if (currentTabId) chrome.tabs.reload(currentTabId); };

    if (isWhitelisted) {
      chrome.runtime.sendMessage({ type: 'REMOVE_DOMAIN', domain: currentTabDomain }, () => {
        void chrome.runtime.lastError;
        reload();
      });
      setSettings(prev => ({
        ...prev,
        allowedDomains: prev.allowedDomains.filter(d => !currentTabUrl.includes(d.trim())),
      }));
    } else {
      saveSettings({ ...settings, allowedDomains: [...settings.allowedDomains, currentTabDomain] });
      reload();
    }
  };

  if (!state) return <div className="p-4 text-sm text-slate-500">Loading…</div>;

  return (
    <div className="w-[320px] bg-white text-slate-900 font-sans">

      {/* Header */}
      <header className="px-4 pt-4 pb-3 border-b border-slate-100">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold flex items-center gap-2">
            <Activity className={settings.forceActive ? 'text-slate-300' : 'text-green-500'} size={20} />
            Focus
          </h1>
          <div className="flex items-center gap-1.5">
          <button
            onClick={() => saveSettings({ ...settings, soundEnabled: !settings.soundEnabled })}
            className={`flex flex-shrink-0 items-center justify-center rounded-full p-1.5 transition-colors cursor-pointer ${
              settings.soundEnabled
                ? 'bg-blue-500 text-white hover:bg-blue-600'
                : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
            }`}
            title={settings.soundEnabled ? 'Sound on — click to mute the idle beep' : 'Sound off — click to unmute the idle beep'}
            aria-label={settings.soundEnabled ? 'Sound on' : 'Sound off'}
          >
            {settings.soundEnabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
          </button>
          <button
            onClick={() => {
              // Toggle "Working" (forceActive === false) ↔ "Not working".
              const next = { ...settings, forceActive: !settings.forceActive };
              setSettings(next);
              // Persist FIRST, then open the companion from the write callback.
              // Opening it steals focus and closes this popup, and doing that before
              // the write commits used to lose the toggle — hence the "took two
              // clicks to turn green" bug. Only open it when RESUMING work, never
              // when pausing.
              chrome.storage.local.set({ focusFlowSettings: next }, () => {
                void chrome.runtime.lastError;
                if (!next.forceActive && next.companionEnabled) openCompanionWindow();
              });
            }}
            className={`flex items-center gap-1.5 flex-shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors cursor-pointer ${
              settings.forceActive
                ? 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                : 'bg-green-500 text-white hover:bg-green-600'
            }`}
            title={settings.forceActive
              ? (settings.companionEnabled
                  ? 'Not working — click to resume (and open the companion window)'
                  : 'Not working — click to resume')
              : 'Working — click to pause'}
          >
            {settings.forceActive ? <ZapOff size={13} /> : <Zap size={13} />}
            {settings.forceActive ? 'Not working' : 'Working'}
          </button>
          </div>
        </div>
      </header>

      {/* Tab bar */}
      <div className="flex border-b border-slate-100">
        {(['main', 'settings'] as const).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-semibold transition-colors ${
              activeTab === t
                ? 'text-blue-600 border-b-2 border-blue-500'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            {t === 'main' ? <FileText size={13} /> : <Settings2 size={13} />}
            {t === 'main' ? 'Main' : 'Settings'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4">
        {activeTab === 'main' ? (
          <MainTab
            state={state}
            settings={settings}
            currentTabDomain={currentTabDomain}
            currentTabUrl={currentTabUrl}
            onWhitelistToggle={handleWhitelistToggle}
          />
        ) : (
          <SettingsTab settings={settings} onChange={saveSettings} />
        )}
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<Popup />);
