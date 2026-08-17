import React, { useState, useEffect, useRef } from 'react';
import { SessionState, Settings, DayScore, MessageType, AgentStatus, HISTORY_KEY, localDateKey, weekdayName } from '../../types';
import { Plus, X, Check, Copy, ClipboardPaste, Users, Trophy, ChevronLeft, ChevronRight, Flag, Loader2, UserPlus, UserCheck, Clock, Monitor } from 'lucide-react';
import { SUMMARY_KEY, TEAMS_KEY, FLAG_KEY, DOMAIN_FLAGS_KEY, PROGRAM_FLAGS_KEY } from '../server/config';
// Pure predicates — the same two the background applies, so the list the popup
// writes and the list the poll reads can never disagree about what a browser is.
import { isBrowserProgram, normaliseProgram } from '../agent';
// Type-only: erased at compile time, so the popup bundle does not pull in sync.ts
// (and through it auth.ts and the whole fetch path) just to name a shape.
import type { ServerSummary, ServerDay, MemberScore, TeamBoard, CompetitionTeam, CompetitionBoard, MemberProfile, FlagResult, ProgramFlagResult, FriendsBoard, UserHit, FriendStatus, AvgSummary, GroupHistory as GroupHistoryPayload } from '../server/sync';

// ─────────────────────────────────────────────────────────────────────────────
//  Everything the popup and the dashboard page BOTH render
// ─────────────────────────────────────────────────────────────────────────────
//  Two surfaces now show the same data: the 320px popup and the full-tab dashboard.
//  They differ in layout — a popup shows one section at a time behind a pill row, a
//  dashboard shows a sidebar and several panels at once — but not in what a team
//  board is, how a day series is fetched, or when a request goes out.
//
//  So the layout lives in each surface and everything else lives here. That is what
//  keeps the DATA rules single-sourced: the 60-second board refresh, the fetch-once
//  day series, profiles only on click. If these components were copied, the second
//  copy would quietly drift into fetching more often than the first.
//
//  This module must never import either surface — the popup and the dashboard each
//  call createRoot at their top level, and importing one would mount it.
// ─────────────────────────────────────────────────────────────────────────────


// Diverging pair for both charts: focus green, distraction red, matched at the
// 700 step. As a *colour pair* these are indistinguishable to a red/green
// colourblind reader (deutan ΔE 4.2 — same lightness, and CVD collapses the hue
// axis that separates them). That's acceptable ONLY because neither chart asks
// colour to carry identity: focusScore is always ≥ 0 and distractedScore always
// ≤ 0, so focus is always the mark ABOVE the zero baseline and distraction always
// the one below — position tells them apart, and the lines can never cross.
// If a series ever gains a sign, this pair must be re-validated.
export const FOCUS_COLOR = '#15803d';      // green-700
export const DISTRACTED_COLOR = '#b91c1c'; // red-700
export const DAY_MS = 86_400_000;
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The product's mark, for the popup and dashboard headers — replacing lucide's
 *  heartbeat glyph, which was a generic "activity" pictogram and not this product.
 *
 *  It is the ring and dot of `desktop/icon.svg`, WITHOUT that file's slate tile: a
 *  toolbar icon and a launcher icon have to carry their own ground, and there the
 *  ring lost to it (which is why the toolbar's version is a solid disc) — but a
 *  header sits on white, so the ring keeps its contrast and reads as a mark rather
 *  than a blob at the 20 px these headers use.
 *
 *  Drawn in `currentColor`, so the callers' existing `text-green-500` /
 *  `text-slate-300` classes keep colouring it exactly as they coloured the glyph. */
export const FocusMark = ({ size = 20, className = '' }: {
  size?: number; className?: string;
}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
       className={`flex-shrink-0 ${className}`}>
    <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="2.4" />
    <circle cx="12" cy="12" r="3.4" fill="currentColor" />
  </svg>
);

/** Mean of each score over the `days` complete days ENDING YESTERDAY. Today is
 *  excluded on purpose: it's still accumulating, so folding a half-finished day
 *  into the average would drag it down all morning and make the bar meaningless.
 *  Counts only days that were actually recorded — a day the PC never came on
 *  shouldn't read as a day of zero focus.
 *
 *  FALLBACK ONLY once a server is in play. `refresh_rollup` in the SQL computes the
 *  same means to the same definition, and that is the figure to show, because it
 *  has seen every device's days — this function can only average what this browser
 *  happens to have cached. Used when there is no summary at all: an unconfigured
 *  build, or before the first reply lands. */
export function windowAvg(rows: DayScore[], days: number, todayKey: string) {
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
export const ScoreChart = ({ rows, todayKey, summary }: {
  rows: DayScore[];
  todayKey: string;
  /** Only the two averages are read, so a group's means satisfy this exactly as a
   *  person's ServerSummary does — which is how the team and friends sections draw
   *  the identical chart over several people. */
  summary: AvgSummary | null;
}) => {
  // The averages come from the SERVER whenever one has answered — the same
  // reconciliation the live score gets, applied to the two average bars. Both sides
  // implement one definition (complete days ending yesterday, recorded days only),
  // so this is a change of source and not of meaning; the server's is simply the
  // copy that has seen every device.
  const avg = (days: 7 | 30) => {
    if (!summary) return windowAvg(rows, days, todayKey);
    return days === 7
      ? { focusScore: Number(summary.avg7_focus) || 0, distractedScore: Number(summary.avg7_distracted) || 0 }
      : { focusScore: Number(summary.avg30_focus) || 0, distractedScore: Number(summary.avg30_distracted) || 0 };
  };

  // Left→right runs from the widest lookback to the most recent: the 30- and
  // 7-day averages, then the 3 previous days, then today at the far right.
  const last4 = rows.slice(0, 4).reverse(); // rows arrive newest-first; today ends up last
  const bars = [
    { key: 'm', label: '30 d', isAvg: true, ...avg(30) },
    { key: 'w', label: '7 d', isAvg: true, ...avg(7) },
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

/** The exact numbers behind whichever chart is above it. Tabular figures here and
 *  nowhere else: this is a column that has to line up, unlike the standalone display
 *  values on the stat tiles.
 *
 *  Shared by the Personal history and by the group panels, so a team's day list reads
 *  identically to your own — the numbers just happen to be means. */
export const DayList = ({ rows, maxHeight = 112 }: {
  rows: DayScore[];
  maxHeight?: number;
}) => (
  <div
    className="overflow-y-auto rounded-xl border border-slate-100 divide-y divide-slate-100"
    style={{ maxHeight }}
  >
    {rows.length === 0 && (
      <p className="py-3 text-center text-[10px] text-slate-400">No days recorded yet.</p>
    )}
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
);

/** Two series → a legend is always present, so identity never rests on colour
 *  alone. Shared by both charts, which use the same pair. */
export const ScoreLegend = () => (
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
export const ScoreTrend = ({ rows }: { rows: DayScore[] }) => {
  const [width, setWidth] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);

  // Remeasure on resize: the dashboard's columns change width at its breakpoints,
  // and a chart drawn once at the wrong width would stay wrong until remount.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} className="w-full">
      {width > 0 && <ScoreTrendSvg rows={rows} width={width} />}
    </div>
  );
};

const ScoreTrendSvg = ({ rows, width }: { rows: DayScore[]; width: number }) => {
  const pts = [...rows].reverse(); // rows are newest-first; a trend reads oldest→newest
  if (pts.length < 2) return null; // one point is not a line — the bars already show it

  // The viewBox used to be a fixed 250 wide with the default (uniform) scaling, so
  // in any container wider than its 250:83 aspect the drawing was scaled to FIT and
  // centred — a ~250px plot floating in the middle of a 470px box, narrower than the
  // bar chart directly above it. Measuring the container and drawing 1:1 fixes the
  // width without the two alternatives' costs: preserveAspectRatio="none" would
  // stretch the month labels horizontally, and dropping the fixed height would let
  // the chart's height follow the container's width.
  const W = width, H = 110, PAD = 3, LABEL_H = 10;
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
    <svg width={W} height={H + LABEL_H} viewBox={`0 0 ${W} ${H + LABEL_H}`} className="block">
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
export async function copyText(text: string): Promise<boolean> {
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
export function parseCsv(text: string): DayScore[] {
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
export const SAMPLE_FOCUS = 50;
export const SAMPLE_DISTRACTED = -20;
export function sampleDays(todayKey: string): DayScore[] {
  return [1, 2, 3, 4].map((i) => {
    const d = new Date(`${todayKey}T00:00:00`);
    d.setDate(d.getDate() - i);
    const date = localDateKey(d);
    return { date, weekday: weekdayName(date), focusScore: SAMPLE_FOCUS, distractedScore: SAMPLE_DISTRACTED };
  });
}

export const DailyHistory = ({ state, onRows }: {
  state: SessionState;
  /** Reports the day rows this component loaded.
   *
   *  Exists so the dashboard can draw its calendar and weekday charts from the SAME
   *  response instead of asking for the 30 days a second time. A second `useBoard`
   *  or a second hook would be a second request — the thing the on-demand split was
   *  built to stop. Whoever displays the history owns the fetch; everyone else reads
   *  what it got. */
  onRows?: (rows: DayScore[]) => void;
}) => {
  const [history, setHistory] = useState<DayScore[]>([]);
  const [summary, setSummary] = useState<ServerSummary | null>(null);
  const [importMsg, setImportMsg] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  useEffect(() => {
    // Paint from the cache first, so opening the popup never shows an empty chart
    // waiting on a round trip — and so this still works offline.
    const load = () => chrome.storage.local.get([HISTORY_KEY, SUMMARY_KEY], (r) => {
      setHistory(Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : []);
      setSummary((r[SUMMARY_KEY] as ServerSummary) ?? null);
    });
    load();

    // Then refresh the days from the server. They no longer ride along on every
    // check-in — 30 completed days were two thirds of that payload and change once a
    // day — so this is the one place that asks for them, when they are on screen.
    // No spinner: the cache is already drawn, and swapping it for a loading state
    // would be a downgrade.
    chrome.runtime.sendMessage({ type: 'SERVER_MY_DAYS' }, (res?: ServerDay[] | null) => {
      void chrome.runtime.lastError;
      if (!Array.isArray(res)) return;   // offline or signed out — the cache stands
      const rows: DayScore[] = res
        .map((d) => ({
          date: d.day,
          weekday: weekdayName(d.day),
          focusScore: Number(d.focus_score) || 0,
          distractedScore: Number(d.distracted_score) || 0,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
      setHistory(rows);
      chrome.storage.local.set({ [HISTORY_KEY]: rows });
    });

    // SUMMARY_KEY still arrives with every reply, so keep watching it: the 7/30-day
    // averages reconcile without this component asking again.
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && (changes[HISTORY_KEY] || changes[SUMMARY_KEY])) load();
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
  //
  // Suppressed once the server has answered: its averages are then real (a genuine
  // zero on day one), and padding the bars with invented days beside them would put
  // two different stories in one chart. An empty chart is the honest reading.
  const isSample = history.length === 0 && !summary;
  const rows = isSample
    ? [...realRows, ...sampleDays(today.date)].sort((a, b) => b.date.localeCompare(a.date))
    : realRows;

  // Hand the loaded days up. Keyed on a cheap digest rather than the array, which is
  // rebuilt on every render and would otherwise fire this on every keystroke.
  const rowsKey = `${rows.length}:${rows[0]?.date ?? ''}:${rows[0]?.focusScore ?? 0}:${isSample}`;
  useEffect(() => { onRows?.(rows); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey]);

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
      <ScoreChart rows={rows} todayKey={today.date} summary={summary} />
      <ScoreTrend rows={rows} />
      <ScoreLegend />
      {/* Per-day detail last: the charts answer "how am I doing", this answers
          "what exactly did I score on Tuesday". It doubles as the table view the
          charts lean on for exact values. */}
      <DayList rows={rows} />
    </div>
  );
};


// ── Leaderboards ──────────────────────────────────────────────────────────────
// Every board is the same shape — a ranked list of {name, focus, distracted} — so
// members, teams-within-a-competition and the combined field all render through one
// component, differing only in what gets mapped into it.

export type Metric = 'live' | 'avg7' | 'avg30';

export const METRICS: { id: Metric; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'avg7', label: '7-day' },
  { id: 'avg30', label: '30-day' },
];

export interface BoardRow {
  key: string;
  label: string;
  sub?: string;
  mine: boolean;      // the caller, or a team they're in — highlighted, never re-ranked
  userId?: string;    // present on people, absent on teams — what makes a row tappable
  focus: number;
  distracted: number;
}

/** Five rows before a list starts scrolling, everywhere one appears. The pixel
 *  height is derived from it rather than the other way round: a scroll container has
 *  to be told its size before it knows how many children it received. One bar row is
 *  a 10px label line + a 10px bar + the 6px gap under it. */
export const BOARD_ROWS_VISIBLE = 5;
export const BOARD_MAX_HEIGHT_PX = BOARD_ROWS_VISIBLE * 32 + 16;
/** Day rows are a single line, so more of them fit in the same idea of "five". */
export const DAY_MAX_HEIGHT_PX = BOARD_ROWS_VISIBLE * 24 + 8;

/** The ranking number, and the one piece of arithmetic worth stating outright:
 *  `distracted` is stored NEGATIVE, so focus + distracted IS "focus minus
 *  distraction". Writing the subtraction literally would rank a distracted user
 *  ABOVE a clean one (50 focus, −30 distracted scoring 80 instead of 20). The SQL
 *  orders by the same expression. */
export const netOf = (r: { focus: number; distracted: number }) => r.focus + r.distracted;

export function metricPair(src: Record<string, unknown>, metric: Metric) {
  const key = metric === 'live' ? 'live' : metric;
  return {
    focus: Number(src[`${key}_focus`]) || 0,
    distracted: Number(src[`${key}_distracted`]) || 0,
  };
}

export function memberRow(m: MemberScore, metric: Metric, withTeam: boolean): BoardRow {
  return {
    // A user can be in two teams of one competition, so the team is part of the key.
    key: `${m.team ?? ''}:${m.user_id}`,
    label: m.display_name,
    sub: withTeam ? m.team : undefined,
    mine: m.is_self,
    userId: m.user_id,
    ...metricPair(m as unknown as Record<string, unknown>, metric),
  };
}

export function teamRow(t: CompetitionTeam, metric: Metric): BoardRow {
  return {
    key: t.team,
    label: t.team,
    // Team scores are SUMS, so size is part of reading them honestly.
    sub: `${t.member_count} member${t.member_count === 1 ? '' : 's'}`,
    mine: t.is_mine,
    ...metricPair(t as unknown as Record<string, unknown>, metric),
  };
}

/** Ranked diverging bar chart, highest net first — the horizontal twin of the
 *  personal ScoreChart. Focus grows RIGHT of the zero line, distraction LEFT.
 *
 *  That mirroring is not decoration. FOCUS_COLOR and DISTRACTED_COLOR are ΔE 4.2
 *  apart under deuteranopia — as a colour pair they are indistinguishable to a
 *  red/green colourblind reader. It is safe here for the same reason it is safe in
 *  the vertical chart: the two series can never cross the midpoint, so SIDE carries
 *  identity and colour merely reinforces it. Anything that lets a bar appear on the
 *  wrong side of zero breaks that and must be re-validated.
 *
 *  Both series share ONE magnitude scale so the halves stay comparable, and the
 *  scale is per-chart: each metric has its own range, and normalising 30-day
 *  averages against live scores would flatten them to nothing.
 *
 *  Sorting happens here, not on the server: one payload is drawn under three
 *  metrics and each needs its own order. */
export const BarBoard = ({ title, rows, empty, onSelect }: {
  /** Omitted when something above the chart already names it — an expanded team
   *  panel, whose button carries the team name. The scroll marker still shows. */
  title?: string;
  rows: BoardRow[];
  empty?: string;
  /** Supplied when the rows stand for people, making each one a button that opens
   *  their profile. Team rows have no profile, so they render as plain divs and the
   *  chart is inert — an element that looks tappable but isn't is worse than one
   *  that doesn't. */
  onSelect?: (userId: string) => void;
}) => {
  const sorted = [...rows].sort((a, b) => netOf(b) - netOf(a));
  const max = Math.max(1, ...sorted.map((r) => Math.max(Math.abs(r.focus), Math.abs(r.distracted))));
  // 49% rather than 50% per side: the fills start 1px off centre (that inset is the
  // 2px gap that keeps them from fusing into one shape across the midpoint), so a
  // full-scale bar at 50% would overhang the track by that same pixel.
  const pct = (v: number) => `${(Math.min(Math.abs(v), max) / max) * 49}%`;

  return (
    <div className="space-y-1.5">
      {(title || sorted.length > BOARD_ROWS_VISIBLE) && (
        <h4 className="flex items-baseline justify-between text-[9px] font-bold uppercase tracking-widest text-slate-400">
          <span>{title}</span>
          {/* Say so when there is more below the fold: a scroll container with no
              visible cue reads as a chart that is simply missing people. */}
          {sorted.length > BOARD_ROWS_VISIBLE && (
            <span className="font-medium normal-case tracking-normal text-slate-300">
              {sorted.length} · scroll
            </span>
          )}
        </h4>
      )}
      {sorted.length === 0 ? (
        <p className="py-1 text-[10px] text-slate-400">{empty ?? 'Nobody here yet.'}</p>
      ) : (
        <div
          className="space-y-1.5 overflow-y-auto pr-0.5"
          style={sorted.length > BOARD_ROWS_VISIBLE ? { maxHeight: BOARD_MAX_HEIGHT_PX } : undefined}
        >
          {sorted.map((r, i) => {
            const clickable = !!onSelect && !!r.userId;
            const body = (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-[10px] leading-tight">
                    <span className="text-slate-400">{i + 1}. </span>
                    <span className={r.mine ? 'font-bold text-blue-700' : 'text-slate-600'}>{r.label}</span>
                    {r.sub && <span className="text-slate-400"> · {r.sub}</span>}
                  </span>
                  {/* The net is direct-labelled on every row because it is the value
                      the ranking uses — without it the order looks arbitrary whenever
                      two bars are close. The component focus/distracted figures are
                      not labelled; the bars carry those. */}
                  <span className="flex-shrink-0 text-[10px] font-extrabold tabular-nums text-slate-700">
                    {Math.round(netOf(r))}
                  </span>
                </div>
                <div className="relative h-2.5 w-full">
                  <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-200" />
                  <div
                    className="absolute inset-y-0"
                    style={{
                      right: 'calc(50% + 1px)',
                      width: pct(r.distracted),
                      background: DISTRACTED_COLOR,
                      borderRadius: '4px 0 0 4px',
                    }}
                  />
                  <div
                    className="absolute inset-y-0"
                    style={{
                      left: 'calc(50% + 1px)',
                      width: pct(r.focus),
                      background: FOCUS_COLOR,
                      borderRadius: '0 4px 4px 0',
                    }}
                  />
                </div>
              </>
            );
            const shell = `-mx-1 block w-full rounded-lg px-1 py-0.5 text-left ${
              r.mine ? 'bg-blue-50' : ''
            } ${clickable ? 'cursor-pointer hover:bg-slate-100' : ''}`;

            return clickable ? (
              <button key={r.key} onClick={() => onSelect!(r.userId!)} title={`Open ${r.label}'s stats`} className={shell}>
                {body}
              </button>
            ) : (
              <div key={r.key} className={shell}>{body}</div>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Legend for the horizontal charts. Two series, so a legend is always present —
 *  identity never rests on the colour pair alone. */
export const BarLegend = () => (
  <div className="flex justify-center gap-3 text-[8px] text-slate-400">
    <span className="flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-sm" style={{ background: DISTRACTED_COLOR }} /> Distracted (left)
    </span>
    <span className="flex items-center gap-1">
      <span className="h-1.5 w-1.5 rounded-sm" style={{ background: FOCUS_COLOR }} /> Focus (right)
    </span>
  </div>
);

/** Live / 7-day / 30-day, as a switcher: one metric is on show and its charts fill
 *  the section. A competition holds a team chart, a combined chart and one chart per
 *  team, so drawing all three metrics at once would run past a thousand pixels and
 *  bury the comparison you opened the section to make. Switching re-ranks every
 *  chart under the chosen metric. */
export const MetricTabs = ({ value, onChange }: { value: Metric; onChange: (m: Metric) => void }) => (
  <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
    {METRICS.map((m) => (
      <button
        key={m.id}
        onClick={() => onChange(m.id)}
        // nowrap: in the popup the row is full-width and "30-day" fits, but the
        // dashboard sizes this control to its content, where it wrapped to two lines.
        className={`flex-1 cursor-pointer whitespace-nowrap rounded-md px-2 py-1 text-[10px] font-bold transition-colors ${
          value === m.id ? 'bg-white text-slate-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
        }`}
      >
        {m.label}
      </button>
    ))}
  </div>
);

// ── Member profile ────────────────────────────────────────────────────────────
// Opened by tapping someone on a leaderboard. Fetched on demand and held only in
// this component's state: it is another participant's data, including their
// whitelisted domains, and caching it would leave that on disk long after the popup
// asking for it had closed.
//
// The server refuses anyone the caller cannot already see, so a null response covers
// both "not allowed" and "offline" — deliberately indistinguishable here, since
// telling the two apart would confirm that a given user id exists.

/** One metric of a profile, as a labelled focus/distracted pair. Not a bar chart:
 *  three values for one person is a reading, not a comparison, and bars would imply
 *  a ranking that isn't there. */
export const ProfileStat = ({ label, focus, distracted }: {
  label: string; focus: number; distracted: number;
}) => (
  <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[10px]">
    <span className="font-bold uppercase tracking-widest text-slate-400">{label}</span>
    <span className="flex-shrink-0 tabular-nums">
      <span className="font-extrabold text-slate-700">{Math.round(focus + distracted)}</span>
      <span className="text-slate-300"> · </span>
      <span className="text-green-600">{Math.round(focus)}</span>
      <span className="text-slate-300"> / </span>
      <span className="text-red-600">{Math.round(distracted)}</span>
    </span>
  </div>
);

/** How many flags one person may put on one domain, ever — on top of the weekly
 *  budget. The SERVER enforces this (flag_domain raises 23514); this copy exists only
 *  to grey the button before the click, so the two must be changed together. */
export const MAX_FLAGS_PER_DOMAIN = 3;

/** The same ceiling, counted separately for programs. Three on `youtube.com` and
 *  three on `steam` are six objections to six different things — which is the
 *  reading the tally exists to collect. Mirrors flag_program()'s own constant. */
export const MAX_FLAGS_PER_PROGRAM = 3;

/** The friend control on a profile. Four states, four different sentences — a single
 *  "Add friend" that silently did nothing on the other three would be worse than no
 *  button. Never shown for yourself. */
export const FriendButton = ({ status, busy, onSend, onAccept }: {
  status: FriendStatus;
  busy: boolean;
  onSend: () => void;
  onAccept: () => void;
}) => {
  if (status === 'self') return null;

  const base = 'flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors disabled:opacity-40';

  if (status === 'friends') {
    return (
      <span title="You are friends — you can see each other's scores" className={`${base} bg-green-100 text-green-700`}>
        <UserCheck size={10} /> Friends
      </span>
    );
  }
  if (status === 'sent') {
    return (
      <span title="Request sent — you'll see their scores once they accept" className={`${base} bg-slate-100 text-slate-400`}>
        <Clock size={10} /> Sent
      </span>
    );
  }
  if (status === 'received') {
    return (
      <button onClick={onAccept} disabled={busy} title="They asked to be friends — accept" className={`${base} cursor-pointer bg-green-500 text-white hover:bg-green-600`}>
        <UserCheck size={10} /> Accept
      </button>
    );
  }
  return (
    <button onClick={onSend} disabled={busy} title="Send a friend request" className={`${base} cursor-pointer bg-blue-500 text-white hover:bg-blue-600`}>
      <UserPlus size={10} /> Add
    </button>
  );
};

export const MemberProfileView = ({ userId, onBack }: { userId: string; onBack: () => void }) => {
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  // Held separately from `profile` so a friend action repaints the button without
  // refetching the whole profile — the scores and domains have not changed.
  const [friendStatus, setFriendStatus] = useState<FriendStatus>('none');
  const [friendBusy, setFriendBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [flagging, setFlagging] = useState('');
  const [flagError, setFlagError] = useState('');
  const flagAvailable = useWeeklyFlag();

  useEffect(() => {
    setLoading(true);
    chrome.runtime.sendMessage({ type: 'SERVER_MEMBER_PROFILE', userId }, (res?: MemberProfile | null) => {
      void chrome.runtime.lastError;
      setLoading(false);
      setProfile(res ?? null);
      setFriendStatus(res?.friend_status ?? 'none');
    });
  }, [userId]);

  const friendAct = (msg: MessageType) => {
    setFriendBusy(true);
    chrome.runtime.sendMessage(msg, (res?: { status: FriendStatus } | null) => {
      void chrome.runtime.lastError;
      setFriendBusy(false);
      if (res?.status) setFriendStatus(res.status);
    });
  };

  // Flagging returns the domain's new global tally, so only that one row is patched
  // rather than refetching the whole profile. The badge updates independently: the
  // background writes FLAG_KEY, which useWeeklyFlag is watching.
  // One weekly flag, two things it can be spent on. The kind picks the message and
  // therefore the registry; everything after it — the ceiling, the error, the badge
  // going grey — is identical, which is why the two lists render through one
  // component and patch through one handler.
  const flag = (kind: 'domain' | 'program', target: string) => {
    setFlagging(target);
    const msg: MessageType = kind === 'domain'
      ? { type: 'SERVER_FLAG_DOMAIN', domain: target }
      : { type: 'SERVER_FLAG_PROGRAM', program: target };
    chrome.runtime.sendMessage(msg, (res?: FlagResult | ProgramFlagResult | null) => {
      void chrome.runtime.lastError;
      setFlagging('');
      if (!res) {
        setFlagError('Could not spend the flag — you may have already used it this week.');
        return;
      }
      setFlagError('');
      // my_flags comes back from the server rather than being incremented locally, so
      // the ceiling is judged on the server's count and not on this view's guess.
      setProfile((p) => p && (kind === 'domain'
        ? {
            ...p,
            domains: p.domains.map((d) => (d.domain === (res as FlagResult).domain
              ? { ...d, flag_count: res.flag_count, my_flags: res.my_flags }
              : d)),
          }
        : {
            ...p,
            programs: (p.programs ?? []).map((x) => (x.program === (res as ProgramFlagResult).program
              ? { ...x, flag_count: res.flag_count, my_flags: res.my_flags }
              : x)),
          }));
    });
  };

  const back = (
    <button
      onClick={onBack}
      className="flex cursor-pointer items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-600"
    >
      <ChevronLeft size={12} /> Back
    </button>
  );

  if (loading) return <div className="space-y-3">{back}<p className="text-[11px] text-slate-400">Loading…</p></div>;
  if (!profile) {
    return (
      <div className="space-y-3">
        {back}
        <p className="text-[11px] text-slate-400">
          Couldn't load this participant — they may have left your teams, or you're offline.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        {back}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 truncate text-sm font-bold ${profile.is_self ? 'text-blue-700' : 'text-slate-700'}`}>
            {profile.display_name}
          </span>
          <FriendButton
            status={friendStatus}
            busy={friendBusy}
            onSend={() => friendAct({ type: 'SERVER_FRIEND_REQUEST', userId })}
            onAccept={() => friendAct({ type: 'SERVER_FRIEND_RESPOND', requester: userId, accept: true })}
          />
        </div>
      </div>

      <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
        <ProfileStat label="Live" focus={profile.live_focus} distracted={profile.live_distracted} />
        <ProfileStat label="7-day" focus={profile.avg7_focus} distracted={profile.avg7_distracted} />
        <ProfileStat label="30-day" focus={profile.avg30_focus} distracted={profile.avg30_distracted} />
      </div>

      <div className="space-y-1">
        <h4 className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Daily history</h4>
        {profile.days.length === 0 ? (
          <p className="text-[10px] text-slate-400">No completed days yet.</p>
        ) : (
          <div
            className="divide-y divide-slate-100 overflow-y-auto rounded-xl border border-slate-100"
            style={{ maxHeight: DAY_MAX_HEIGHT_PX }}
          >
            {profile.days.map((d) => (
              <div key={d.day} className="flex items-center justify-between px-2 py-1 text-[10px]">
                <span>
                  <span className="font-medium text-slate-600">{weekdayName(d.day).slice(0, 3)}</span>{' '}
                  <span className="text-slate-400">{d.day}</span>
                </span>
                <span className="font-bold tabular-nums">
                  <span className="text-green-600">{Math.round(d.focus_score)}</span>
                  <span className="text-slate-300"> / </span>
                  <span className="text-red-600">{Math.round(d.distracted_score)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <FlagList
        title="Whitelisted domains"
        noun="domain"
        max={MAX_FLAGS_PER_DOMAIN}
        empty="No domains recorded."
        items={profile.domains.map((d) => ({ key: d.domain, label: d.domain, flag_count: d.flag_count, my_flags: d.my_flags }))}
        available={flagAvailable}
        busyKey={flagging}
        onFlag={(target) => flag('domain', target)}
      />

      {/* Only when the server sent them. A backend that has not run the
          program-flags migration sends nothing here, and an empty "Whitelisted
          programs" heading would read as "this person works only in a browser"
          rather than "this server does not know about programs yet". */}
      {!!profile.programs?.length && (
        <FlagList
          title="Whitelisted programs"
          noun="program"
          max={MAX_FLAGS_PER_PROGRAM}
          empty="No programs recorded."
          items={profile.programs.map((p) => ({ key: p.program, label: p.program, flag_count: p.flag_count, my_flags: p.my_flags }))}
          available={flagAvailable}
          busyKey={flagging}
          onFlag={(target) => flag('program', target)}
        />
      )}

      {flagError && <p className="text-[9px] font-medium text-red-500">{flagError}</p>}
      <p className="text-[9px] text-slate-400">
        One red flag per week, granted each Monday at 01:00 — spend it on a domain or a
        program, whichever you think is the problem. At most {MAX_FLAGS_PER_DOMAIN} from
        you on any one of them. Flags are permanent, and the count shown is everyone's
        together.
      </p>
    </div>
  );
};

/** One flaggable list: a participant's whitelisted domains, or their whitelisted
 *  programs. Built once for both because they are the same control over two
 *  registries, and a second copy is where the ceiling, the disabled states and the
 *  wording would quietly drift apart.
 *
 *  Two independent gates decide whether a row can be flagged, and they need
 *  different explanations: the WEEK runs out for every target at once, the CEILING
 *  only for this one. */
const FlagList = ({ title, noun, max, items, empty, available, busyKey, onFlag }: {
  title: string;
  noun: 'domain' | 'program';
  max: number;
  items: { key: string; label: string; flag_count: number; my_flags: number }[];
  empty: string;
  available: boolean;
  busyKey: string;
  onFlag: (target: string) => void;
}) => (
  <div className="space-y-1">
    <h4 className="flex items-baseline justify-between text-[9px] font-bold uppercase tracking-widest text-slate-400">
      <span>{title}</span>
      <FlagBadge available={available} small />
    </h4>
    {items.length === 0 ? (
      <p className="text-[10px] text-slate-400">{empty}</p>
    ) : (
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
        {items.map((it) => {
          const capped = it.my_flags >= max;
          const canFlag = available && !capped;
          return (
            <div key={it.key} className="flex items-center gap-2 px-2 py-1">
              <span className={`min-w-0 flex-1 truncate text-[10px] text-slate-600 ${noun === 'program' ? 'font-mono' : ''}`}>
                {it.label}
                {/* Your own contribution as a fraction of your ceiling, shown only once
                    you have spent something here — "0/3" on every untouched row would
                    read as a target to fill. */}
                {it.my_flags > 0 && (
                  <span className={capped ? 'text-red-400' : 'text-slate-400'}>
                    {' '}· {it.my_flags}/{max} from you
                  </span>
                )}
              </span>
              {/* Tally inside the button: the count and the act of flagging are one
                  affordance. A permanent, unrevocable action should not look available
                  when it isn't. */}
              <button
                onClick={() => onFlag(it.key)}
                disabled={!canFlag || busyKey === it.key}
                title={
                  capped
                    ? `You've used all ${max} of your flags on ${it.label}. Others can still flag it.`
                    : available
                      ? `Spend this week's red flag on ${it.label} — this cannot be undone`
                      : 'Weekly red flag already spent. You get another on Monday at 01:00.'
                }
                className={`flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition-colors ${
                  canFlag
                    ? 'cursor-pointer bg-slate-100 text-slate-500 hover:bg-red-100 hover:text-red-600'
                    : 'cursor-not-allowed bg-slate-50 text-slate-300'
                }`}
              >
                <Flag size={10} fill={it.flag_count > 0 ? 'currentColor' : 'none'} />
                {it.flag_count}
              </button>
            </div>
          );
        })}
      </div>
    )}
  </div>
);

/** Create-or-join, one field and two verbs. They are separate buttons because they
 *  are separate intents, and the server enforces the difference: create refuses a
 *  name that exists, join refuses one that doesn't. A typo can neither found a
 *  one-person team nor drop you into a stranger's. */
export const NameForm = ({ placeholder, hint, busy, error, withPassword, passwordPlaceholder, onSubmit }: {
  placeholder: string;
  hint: string;
  busy: boolean;
  error: string;
  withPassword?: boolean;
  passwordPlaceholder?: string;
  onSubmit: (name: string, create: boolean, password: string) => void;
}) => {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const clean = name.trim().toLowerCase();
  const valid = clean.length >= 2 && clean.length <= 40 && (!withPassword || password.length >= 4);
  const go = (create: boolean) => onSubmit(clean, create, password);

  return (
    <div className="space-y-1.5 rounded-xl bg-slate-50 p-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) go(false); }}
        placeholder={placeholder}
        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-[11px] focus:border-slate-400 focus:outline-none"
      />
      {withPassword && (
        // The shared secret for a team or a competition. Creating sets it; joining
        // must match it. The server stores only a bcrypt hash and lets no client read
        // it back, so this field is the one and only place it exists in the clear.
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && valid && !busy) go(false); }}
          placeholder={passwordPlaceholder ?? 'password (min 4)'}
          className="w-full rounded-lg border border-slate-200 px-2 py-1 text-[11px] focus:border-slate-400 focus:outline-none"
        />
      )}
      <div className="flex gap-1">
        <button
          onClick={() => go(false)}
          disabled={!valid || busy}
          className="flex-1 cursor-pointer rounded-lg bg-blue-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-blue-600 disabled:opacity-40"
        >
          Join existing
        </button>
        <button
          onClick={() => go(true)}
          disabled={!valid || busy}
          className="flex-1 cursor-pointer rounded-lg bg-slate-700 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-slate-800 disabled:opacity-40"
        >
          Create new
        </button>
      </div>
      {error
        ? <p className="text-[9px] font-medium text-red-500">{error}</p>
        : <p className="text-[9px] text-slate-400">{hint}</p>}
    </div>
  );
};

// ── Friends ───────────────────────────────────────────────────────────────────
// The same board a team gets, over people who have each agreed individually. A
// PENDING request shows nothing — the server's can_see_user() requires 'accepted',
// so asking to see someone is never permission to.

/** How long to wait after the last keystroke before searching. Long enough to cover
 *  a whole name typed at normal speed, so spelling "andrea" costs one request rather
 *  than eight — and eight racing replies can't land out of order and leave the
 *  answer to the third letter on screen. The cost is that results feel deliberate
 *  rather than instant, which is the right trade for a search that reads other
 *  participants' names out of the database. */
export const FRIEND_SEARCH_DEBOUNCE_MS = 1000;

/** Type-ahead search. Debounced, because a keystroke is not a question. */
export const FriendSearch = ({ onAdded }: { onAdded: () => void }) => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState('');

  const clean = query.trim().toLowerCase();
  const tooShort = clean.length > 0 && clean.length < 3;

  useEffect(() => {
    if (clean.length < 3) { setHits([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'SERVER_SEARCH_USERS', query: clean }, (res?: UserHit[] | null) => {
        void chrome.runtime.lastError;
        setSearching(false);
        setHits(Array.isArray(res) ? res : []);
      });
    }, FRIEND_SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(t); setSearching(false); };
  }, [clean]);

  const add = (h: UserHit) => {
    setBusy(h.user_id);
    chrome.runtime.sendMessage({ type: 'SERVER_FRIEND_REQUEST', userId: h.user_id }, (res?: { status: FriendStatus } | null) => {
      void chrome.runtime.lastError;
      setBusy('');
      if (!res) return;
      setHits((prev) => prev.map((x) => (x.user_id === h.user_id ? { ...x, status: res.status } : x)));
      onAdded();
    });
  };

  const label: Record<FriendStatus, string> = {
    none: 'Add', sent: 'Sent', received: 'Accept', friends: 'Friends', self: 'You',
  };

  return (
    <div className="space-y-1.5 rounded-xl bg-slate-50 p-2">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search by name or email…"
        className="w-full rounded-lg border border-slate-200 px-2 py-1 text-[11px] focus:border-slate-400 focus:outline-none"
      />
      {tooShort && <p className="text-[9px] text-slate-400">Keep typing — at least 3 characters.</p>}
      {searching && clean.length >= 3 && (
        <p className="flex items-center gap-1 text-[9px] text-slate-400">
          <Loader2 size={9} className="animate-spin" /> Searching…
        </p>
      )}
      {!searching && clean.length >= 3 && hits.length === 0 && (
        <p className="text-[9px] text-slate-400">Nobody found.</p>
      )}
      {hits.length > 0 && (
        <div className="divide-y divide-slate-200 overflow-y-auto rounded-lg bg-white" style={{ maxHeight: DAY_MAX_HEIGHT_PX }}>
          {hits.map((h) => (
            <div key={h.user_id} className="flex items-center gap-2 px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">{h.display_name}</span>
              <button
                onClick={() => add(h)}
                disabled={busy === h.user_id || h.status === 'sent' || h.status === 'friends' || h.status === 'self'}
                className={`flex-shrink-0 rounded-lg px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider transition-colors ${
                  h.status === 'none' || h.status === 'received'
                    ? 'cursor-pointer bg-blue-500 text-white hover:bg-blue-600'
                    : 'cursor-not-allowed bg-slate-100 text-slate-400'
                }`}
              >
                {label[h.status]}
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[9px] text-slate-400">
        They see your scores only once they accept — and you see theirs.
      </p>
    </div>
  );
};

export const FriendsSection = () => {
  const [metric, setMetric] = useState<Metric>('live');
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);   // bumped by any change, to refetch
  const [busy, setBusy] = useState('');
  const { board, loading } = useBoard<FriendsBoard>(
    { type: 'SERVER_FRIENDS_BOARD', metric }, `friends:${metric}:${nonce}`);

  if (selected) return <MemberProfileView userId={selected} onBack={() => setSelected(null)} />;

  const respond = (requester: string, accept: boolean) => {
    setBusy(requester);
    chrome.runtime.sendMessage({ type: 'SERVER_FRIEND_RESPOND', requester, accept }, () => {
      void chrome.runtime.lastError;
      setBusy('');
      setNonce((n) => n + 1);
    });
  };

  const requests = board?.requests ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-bold text-slate-700">
          <UserPlus size={14} className="flex-shrink-0 text-slate-400" />
          <span className="truncate">Friends</span>
        </h3>
        <button
          onClick={() => setAddOpen((v) => !v)}
          title="Find someone to add"
          className={`flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
            addOpen ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          <Plus size={11} /> Friend
        </button>
      </div>

      {addOpen && <FriendSearch onAdded={() => setNonce((n) => n + 1)} />}

      {loading && !board ? <BoardLoading /> : (
        <>
          <MetricTabs value={metric} onChange={setMetric} />
          <BarLegend />
          <BarBoard
            title="Friends standings"
            rows={(board?.members ?? []).map((x) => memberRow(x, metric, false))}
            empty={board ? 'No friends yet — add someone above.' : "Couldn't load your friends."}
            onSelect={setSelected}
          />
          <BoardFooter board={board} noun="friend" />
        </>
      )}

      {/* The same two charts the Personal section draws, over you and everyone who
          has accepted you. Below the board: the board is the live standing, this is
          how the group has been doing. */}
      <GroupHistory
        message={{ type: 'SERVER_FRIENDS_DAYS' }}
        cacheKey={`friends-days:${nonce}`}
        noun="friend"
      />

      {/* Requests below the board, not above it: the board is what you came for, and
          a pending request is somebody else's business with you. */}
      {requests.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[9px] font-bold uppercase tracking-widest text-slate-400">
            Friend requests
          </h4>
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
            {requests.map((r) => (
              <div key={r.user_id} className="flex items-center gap-2 px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">
                  {r.display_name}
                </span>
                <button
                  onClick={() => respond(r.user_id, true)}
                  disabled={busy === r.user_id}
                  className="flex-shrink-0 cursor-pointer rounded-lg bg-green-500 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-green-600 disabled:opacity-40"
                >
                  Accept
                </button>
                <button
                  onClick={() => respond(r.user_id, false)}
                  disabled={busy === r.user_id}
                  title="Decline — they can ask again later"
                  className="flex-shrink-0 cursor-pointer rounded-lg bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-200 disabled:opacity-40"
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

/** The two Personal charts — the diverging period bars and the trend line — drawn
 *  over a GROUP rather than one person.
 *
 *  Identical components, identical scales, identical legend: the point of a team
 *  chart is that you can put it beside your own and read them the same way. Only
 *  the source differs, and the server does the averaging (see the group_day_series
 *  migration for the two conventions it uses and why they differ).
 *
 *  Fetched ONCE per mount, with no refresh interval — unlike the board above it,
 *  which repolls every minute. A completed day changes once a day at the 01:00
 *  rollover, so a second request inside one sitting could only ever return the same
 *  30 rows. The board is live standings; this is history. */
export function useGroupHistory(message: MessageType, cacheKey: string) {
  const [data, setData] = useState<GroupHistoryPayload | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    chrome.runtime.sendMessage(message, (res?: GroupHistoryPayload | null) => {
      void chrome.runtime.lastError;
      if (!live) return;
      setLoading(false);
      setData(res ?? null);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Today is the group's mean LIVE score, which no completed day carries yet. Same
  // construction the Personal chart uses, where today comes from SessionState.
  const todayKey = localDateKey();
  const rows: DayScore[] = data
    ? [
        {
          date: todayKey,
          weekday: weekdayName(todayKey),
          focusScore: Number(data.summary.live_focus) || 0,
          distractedScore: Number(data.summary.live_distracted) || 0,
        },
        ...data.days
          .filter((d) => d.day !== todayKey)
          .map((d) => ({
            date: d.day,
            weekday: weekdayName(d.day),
            focusScore: Number(d.focus_score) || 0,
            distractedScore: Number(d.distracted_score) || 0,
          })),
      ].sort((a, b) => b.date.localeCompare(a.date))
    : [];

  return { data, loading, rows, todayKey };
}

export const GroupHistoryLoading = () => (
  <div className="flex items-center justify-center gap-2 py-6 text-[10px] text-slate-400">
    <Loader2 size={13} className="animate-spin" />
    Loading history…
  </div>
);

/** Shown when the group series comes back null.
 *
 *  It used to render nothing at all, which made a missing series indistinguishable
 *  from a design decision — the charts were simply absent. One quiet line instead:
 *  the diagnosis belongs in the service worker console, where readRpc already logs
 *  the status, not in front of a participant who can do nothing with it. */
export const GroupHistoryUnavailable = () => (
  <p className="py-4 text-center text-[10px] text-slate-400">
    Couldn't load the averaged history.
  </p>
);

/** How the average was computed, in one line. Shown wherever a group figure is, so
 *  no chart is ever mistaken for one person's. */
export const GroupAverageNote = ({ count, noun }: { count: number; noun: string }) => (
  <p className="text-[9px] text-slate-400">
    Mean per person across {count} {noun}{count === 1 ? '' : 's'} —
    a day nobody recorded is absent, not zero.
  </p>
);

export const GroupHistory = ({ message, cacheKey, noun }: {
  message: MessageType;
  /** Refetch when this changes; deliberately NOT the metric — the series is the same
   *  whichever metric the board above is ranked by. */
  cacheKey: string;
  /** What one member is called, for the "average across N —" line. */
  noun: string;
}) => {
  const { data, loading, rows, todayKey } = useGroupHistory(message, cacheKey);

  if (loading && !data) return <GroupHistoryLoading />;
  if (!data) return <GroupHistoryUnavailable />;

  return (
    <div className="space-y-1">
      <span className="text-sm font-medium text-slate-500">Average history</span>
      <ScoreChart rows={rows} todayKey={todayKey} summary={data.summary} />
      <ScoreTrend rows={rows} />
      <ScoreLegend />
      <GroupAverageNote count={data.member_count} noun={noun} />
    </div>
  );
};

/** One of the caller's own teams: everyone in it ranked against them. */
export const TeamSection = ({ team, busy, error, onEnroll, onLeave }: {
  team: string;
  busy: boolean;
  error: string;
  onEnroll: (competition: string, create: boolean, password: string) => void;
  onLeave: () => void;
}) => {
  // Metric first: boards are TOPPED server-side, so the top 20 by live score is a
  // different set of people from the top 20 by 30-day average. Switching tabs is a
  // new question, not a re-sort of the same answer.
  const [metric, setMetric] = useState<Metric>('live');
  const { board, loading } = useBoard<TeamBoard>(
    { type: 'SERVER_TEAM_BOARD', team, metric }, `${team}:${metric}`);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // A profile takes over the section rather than opening beside it — at 320px there
  // is no beside, and returning to the board is one tap.
  if (selected) return <MemberProfileView userId={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-bold text-slate-700">
          <Users size={14} className="flex-shrink-0 text-slate-400" />
          <span className="truncate">{team}</span>
        </h3>
        <button
          onClick={() => setAddOpen((v) => !v)}
          title="Enter this team into a competition"
          className={`flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
            addOpen ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
        >
          <Plus size={11} /> Competition
        </button>
      </div>

      {addOpen && (
        <NameForm
          placeholder="competition name"
          hint="Creating makes a TEAM competition — teams enter, individuals are refused."
          withPassword
          passwordPlaceholder="competition password (min 4)"
          busy={busy}
          error={error}
          onSubmit={onEnroll}
        />
      )}

      {loading && !board ? <BoardLoading /> : (
        <>
          <MetricTabs value={metric} onChange={setMetric} />
          <BarLegend />
          <BarBoard
            title="Team standings"
            rows={(board?.members ?? []).map((x) => memberRow(x, metric, false))}
            empty={board ? 'No members yet.' : "Couldn't load this team."}
            onSelect={setSelected}
          />
          <BoardFooter board={board} noun="member" />
        </>
      )}

      {/* The same two charts the Personal section draws, averaged over the team. */}
      <GroupHistory
        message={{ type: 'SERVER_TEAM_DAYS', team }}
        cacheKey={`team-days:${team}`}
        noun="member"
      />

      <button
        onClick={onLeave}
        disabled={busy}
        className="w-full cursor-pointer rounded-lg border border-slate-100 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
      >
        Leave {team}
      </button>
    </div>
  );
};

/** A competition: teams against teams, then everyone against everyone, then each
 *  team's own list. All three are derived from one payload — the per-team lists are
 *  the combined list grouped by the `team` each row carries. */
export const CompetitionSection = ({ competition, viaTeam, busy, onLeaveTeam, onLeaveSolo }: {
  competition: string;
  /** Set when this pill is a TEAM's entry; absent when it is your own. Only changes
   *  what you can withdraw from here — the board itself is the same competition. */
  viaTeam?: string;
  busy: boolean;
  onLeaveTeam: (team: string) => void;
  onLeaveSolo: () => void;
}) => {
  const [metric, setMetric] = useState<Metric>('live');
  const { board, loading } = useBoard<CompetitionBoard>(
    { type: 'SERVER_COMPETITION_BOARD', competition, metric }, `${competition}:${metric}`);
  const [selected, setSelected] = useState<string | null>(null);
  // A Set, so teams open and close independently: comparing two rosters side by side
  // is the whole reason to expand one, and an accordion would forbid it.
  const [openTeams, setOpenTeams] = useState<Set<string>>(new Set());

  const toggleTeam = (t: string) => setOpenTeams((prev) => {
    const next = new Set(prev);
    if (next.has(t)) next.delete(t); else next.add(t);
    return next;
  });

  // Alphabetical, NOT by rank. These are navigation controls, so their job is to be
  // findable: a list that reorders itself as scores move means hunting for the same
  // team in a different place every time you open the popup. The Teams chart above
  // is where rank is expressed.
  //
  // Taken from board.teams rather than by grouping board.members: that list is only
  // the top N of the whole field now, so grouping it would silently show partial
  // rosters. Each panel fetches its own team instead.
  const teamNames = (board?.teams ?? []).map((t) => t.team).sort((a, b) => a.localeCompare(b));
  // Withdrawing is per-team, since you can have more than one team in a competition.
  const myTeams = (board?.teams ?? []).filter((t) => t.is_mine).map((t) => t.team);

  if (selected) return <MemberProfileView userId={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="space-y-3">
      <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-bold text-slate-700">
        <Trophy size={14} className="flex-shrink-0 text-amber-500" />
        <span className="truncate">{competition}</span>
        <span className="flex-shrink-0 text-[9px] font-medium uppercase tracking-wider text-slate-400">
          {viaTeam ? `as ${viaTeam}` : 'as yourself'}
        </span>
      </h3>

      {loading && !board ? <BoardLoading /> : !board ? (
        <p className="py-6 text-center text-[10px] text-slate-400">
          Couldn't load this competition.
        </p>
      ) : (
      <>
      <MetricTabs value={metric} onChange={setMetric} />
      <BarLegend />

      {/* The chosen metric, drawn three ways: teams against teams, then the whole
          field, then each team's own roster. */}
      {/* An individual competition has no teams, so it gets no team board and no
          per-team panels — an empty "Teams" chart would imply teams could enter. */}
      {board.kind === 'team' && (
        <BarBoard
          title="Teams"
          rows={board.teams.map((t) => teamRow(t, metric))}
          empty="No teams entered yet."
        />
      )}
      <BarBoard
        title={board.kind === 'team' ? 'Everyone' : 'Standings'}
        rows={board.members.map((x) => memberRow(x, metric, board.kind === 'team'))}
        empty="No participants yet."
        onSelect={setSelected}
      />
      <BoardFooter board={board} noun="participant" />
      {board.kind === 'team' && (
      <>
      {/* One collapsed button per team rather than every roster at once. A
          competition with eight teams would otherwise be eight charts deep before
          you reached anything, three times over. Expansion state is held here and
          not per-metric, so a team you opened stays open when you switch to 7-day. */}
      <div className="space-y-1">
        <h4 className="text-[9px] font-bold uppercase tracking-widest text-slate-400">By team</h4>
        {teamNames.map((t) => {
          const open = openTeams.has(t);
          const size = board.teams.find((x) => x.team === t)?.member_count ?? 0;
          const mine = myTeams.includes(t);
          return (
            <div key={t} className="space-y-1.5">
              <button
                onClick={() => toggleTeam(t)}
                title={open ? `Hide ${t}` : `Show the ${t} roster`}
                className={`flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[10px] font-bold transition-colors ${
                  open
                    ? 'bg-slate-700 text-white'
                    : mine
                      ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <ChevronRight
                  size={11}
                  className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <span className="min-w-0 flex-1 truncate">{t}</span>
                <span className={`flex-shrink-0 font-medium tabular-nums ${open ? 'text-slate-300' : 'text-slate-400'}`}>
                  {size}
                </span>
              </button>
              {open && (
                // Its own fetch, mounted only while expanded. No title: the button
                // above is the heading, and repeating the name is noise.
                <div className="pl-2">
                  <TeamPanel team={t} metric={metric} onSelect={setSelected} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      </>
      )}
      </>
      )}

      {/* Only the entry you arrived through. Offering both here would let a team
          pill withdraw your personal entry, which is a different membership and
          rarely what the click meant. */}
      {viaTeam ? (
        <button
          onClick={() => onLeaveTeam(viaTeam)}
          disabled={busy}
          className="w-full cursor-pointer rounded-lg border border-slate-100 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
        >
          Withdraw {viaTeam} from {competition}
        </button>
      ) : (
        <button
          onClick={onLeaveSolo}
          disabled={busy}
          className="w-full cursor-pointer rounded-lg border border-slate-100 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
        >
          Withdraw yourself from {competition}
        </button>
      )}
    </div>
  );
};

/** Red-flag tallies for the user's own whitelisted domains, as `{domain: count}`.
 *  Refreshed by every server reply — so, via the 1-minute post floor, at least once
 *  a minute while the popup is open. */
export function useDomainFlags(): Record<string, number> {
  const [flags, setFlags] = useState<Record<string, number>>({});
  useEffect(() => {
    const load = () => chrome.storage.local.get([DOMAIN_FLAGS_KEY], (r) => {
      const f = r[DOMAIN_FLAGS_KEY];
      setFlags(f && typeof f === 'object' ? (f as Record<string, number>) : {});
    });
    load();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes[DOMAIN_FLAGS_KEY]) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return flags;
}

/** Red-flag tallies for the user's own whitelisted PROGRAMS, as `{program: count}`.
 *  The twin of useDomainFlags, reading the other registry's cache. */
export function useProgramFlags(): Record<string, number> {
  const [flags, setFlags] = useState<Record<string, number>>({});
  useEffect(() => {
    const load = () => chrome.storage.local.get([PROGRAM_FLAGS_KEY], (r) => {
      const f = r[PROGRAM_FLAGS_KEY];
      setFlags(f && typeof f === 'object' ? (f as Record<string, number>) : {});
    });
    load();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes[PROGRAM_FLAGS_KEY]) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return flags;
}

/** Whether this week's red flag is still in hand. Read from storage, which both the
 *  server replies and a successful flag write — so the badge and the flag buttons on
 *  a profile stay in step without either owning the other's state. */
export function useWeeklyFlag(): boolean {
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    const load = () => chrome.storage.local.get([FLAG_KEY], (r) => {
      const f = r[FLAG_KEY] as { available?: boolean } | undefined;
      // Default to available, matching build_state's own coalesce: someone who has
      // never spent a flag holds one.
      setAvailable(f?.available !== false);
    });
    load();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes[FLAG_KEY]) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return available;
}

/** The weekly budget, as one glanceable badge. Red flag on light green while it is
 *  unspent, flat grey once used — the colour says "you have something to spend", so
 *  it is deliberately the loudest thing in the row when true and the quietest when
 *  false. */
export const FlagBadge = ({ available, small }: { available: boolean; small?: boolean }) => (
  <span
    title={available
      ? "You have this week's red flag — spend it on a domain from someone's profile"
      : 'Weekly red flag already spent. You get another on Monday at 01:00.'}
    className={`flex flex-shrink-0 items-center justify-center rounded-full ${
      small ? 'h-5 w-5' : 'h-8 w-8 ring-1'
    } ${available ? 'bg-green-100 ring-green-200' : 'bg-slate-100 ring-slate-200'}`}
  >
    <Flag
      size={small ? 11 : 16}
      className={available ? 'text-red-600' : 'text-slate-300'}
      fill={available ? 'currentColor' : 'none'}
    />
  </span>
);

/** Which sections to offer, read from the cache the server overwrites on every
 *  reply. NAMES ONLY — the boards themselves are fetched when a section is opened,
 *  so the once-a-minute check-in no longer carries every visible member's scores. */
export function useMemberships() {
  const [m, setM] = useState<{
    teams: string[];
    competitions: string[];
    teamCompetitions: { competition: string; team: string }[];
    friendRequests: number;
  }>({ teams: [], competitions: [], teamCompetitions: [], friendRequests: 0 });
  useEffect(() => {
    const load = () => chrome.storage.local.get([TEAMS_KEY], (r) => {
      const b = r[TEAMS_KEY] as {
        teams?: string[];
        competitions?: string[];
        teamCompetitions?: { competition: string; team: string }[];
        friendRequests?: number;
      } | undefined;
      setM({
        teams: b?.teams ?? [],
        competitions: b?.competitions ?? [],
        teamCompetitions: b?.teamCompetitions ?? [],
        friendRequests: b?.friendRequests ?? 0,
      });
    });
    load();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes[TEAMS_KEY]) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return m;
}

/** Fetch a board when its section opens, and keep it fresh while you are looking.
 *
 *  The refresh interval is the whole point of the split: a board costs a request
 *  only while someone is actually watching it, instead of riding along on every
 *  check-in from every user whether or not any popup is open. */
export const BOARD_REFRESH_MS = 60_000;

export function useBoard<T>(message: MessageType, key: string): { board: T | null; loading: boolean } {
  const [board, setBoard] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    // Only the FIRST load shows the spinner. A refresh that blanked the board every
    // minute would be worse than a number a few seconds stale.
    const get = (first: boolean) => {
      if (first) setLoading(true);
      chrome.runtime.sendMessage(message, (res?: T | null) => {
        void chrome.runtime.lastError;
        if (!live) return;
        setLoading(false);
        if (res) setBoard(res);
        else if (first) setBoard(null);
      });
    };
    get(true);
    const timer = setInterval(() => get(false), BOARD_REFRESH_MS);
    return () => { live = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { board, loading };
}

/** Shown while a board is on its way. Deliberately the same height as a short
 *  board, so opening a section does not jump the page as it lands. */
export const BoardLoading = () => (
  <div className="flex items-center justify-center gap-2 py-8 text-[10px] text-slate-400">
    <Loader2 size={13} className="animate-spin" />
    Loading standings…
  </div>
);

/** Says what the board above is a slice OF. Boards are topped server-side, so
 *  without this the leader of a 10,000-person competition and the leader of a
 *  three-person team look identical — and someone in 487th place, whose row is
 *  always included, would appear to be one of only a handful of participants. */
export const BoardFooter = ({ board, noun }: {
  board: { member_count?: number; my_rank?: number | null; members: unknown[] } | null;
  noun: string;
}) => {
  if (!board) return null;
  const total = board.member_count ?? board.members.length;
  const shown = board.members.length;
  if (total <= shown) return null;   // the whole field is on screen; nothing to explain
  return (
    <p className="text-[9px] text-slate-400">
      Top {shown - (board.my_rank && board.my_rank > shown ? 1 : 0)} of {total.toLocaleString()} {noun}
      {total === 1 ? '' : 's'}
      {board.my_rank ? ` · you are #${board.my_rank.toLocaleString()}` : ''}
    </p>
  );
};

/** One team's roster inside a competition, fetched on expand.
 *
 *  A separate component precisely so the hook mounts with the panel: the competition
 *  board no longer carries every member, so a roster has to be asked for, and asking
 *  for all of them up front is the cost this whole design avoids. */
export const TeamPanel = ({ team, metric, onSelect }: {
  team: string;
  metric: Metric;
  onSelect: (userId: string) => void;
}) => {
  const { board, loading } = useBoard<TeamBoard>(
    { type: 'SERVER_TEAM_BOARD', team, metric }, `${team}:${metric}`);
  if (loading && !board) return <BoardLoading />;
  return (
    <>
      <BarBoard
        rows={(board?.members ?? []).map((x) => memberRow(x, metric, false))}
        empty={board ? 'No members yet.' : "Couldn't load this team."}
        onSelect={onSelect}
      />
      <BoardFooter board={board} noun="member" />
    </>
  );
};


/** The focus whitelist: the list, clipboard import/export, and the add field.
 *
 *  On the Main tab rather than in Settings because it is not a preference — it is
 *  what decides whether the extension does anything at all on the page you are
 *  looking at, and it gets edited far more often than any slider is touched.
 *
 *  On this branch the list is a CACHE of the server's copy: an edit here goes out
 *  through apply_score_delta and the reply overwrites it. It still works offline,
 *  because heartbeat.ts reads the same local key. */
/** The PROGRAM whitelist — the desktop agent's half of "am I working?".
 *
 *  Sits directly under Allowed pages because it is the same question asked about
 *  the other half of the machine, but it is a genuinely separate list: a domain is
 *  matched by substring against a URL, a program by an exact platform identifier.
 *
 *  The whole section is inert without the agent running, which is why it leads with
 *  the agent's status rather than a bare text box: an empty list and no explanation
 *  would look broken. When the agent IS running it offers the program you are using
 *  right now, because typing `gnome-terminal-` from memory is nobody's idea of
 *  configuration. */
export const AllowedPrograms = ({ settings, onChange }: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) => {
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [newProgram, setNewProgram] = useState('');
  const [rejected, setRejected] = useState('');
  const flags = useProgramFlags();

  // Polled while the popup is open: the point of the panel is to show what is in
  // front of you *now*, and the answer changes as you alt-tab.
  useEffect(() => {
    let alive = true;
    const ask = () => {
      chrome.runtime.sendMessage({ type: 'AGENT_STATUS' }, (res?: AgentStatus) => {
        if (chrome.runtime.lastError || !alive) return;
        if (res) setAgent(res);
      });
    };
    ask();
    const t = setInterval(ask, 1000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });
  const programs = settings.allowedPrograms ?? [];
  const names = agent?.names ?? {};

  const add = (raw: string) => {
    const p = normaliseProgram(raw);
    if (!p || programs.includes(p)) return;
    // Typed by hand, a browser would otherwise slip past the rule the offered
    // button already respects — and counting one as work counts every distraction
    // site as work. Refused with a reason rather than silently dropped.
    if (isBrowserProgram(p)) { setRejected(p); return; }
    setRejected('');
    set({ allowedPrograms: [...programs, p] });
    setNewProgram('');
  };

  const remove = (p: string) =>
    set({ allowedPrograms: programs.filter((x) => x !== p) });

  // The last NON-browser program, never the live reading: the popup is part of the
  // browser, so while it is open the live answer is always "a browser is in front".
  const current = agent?.recent ?? null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">Allowed programs</span>
        <span
          title={agent?.running
            ? 'The desktop agent is running and reporting the foreground program'
            : 'Start the desktop agent (see desktop/) to track programs outside the browser'}
          className={`flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider ${
            agent?.running ? 'text-green-600' : 'text-slate-400'
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${agent?.running ? 'bg-green-500' : 'bg-slate-300'}`} />
          {agent?.running ? 'agent on' : 'agent off'}
        </span>
      </div>

      {!agent?.running && (
        <p className="rounded-lg bg-slate-50 px-2 py-1.5 text-[9px] leading-relaxed text-slate-500">
          Without the desktop agent this list does nothing — the extension cannot see
          outside the browser. Click the <span className="font-medium">Focus agent</span> icon
          to start it (install it once with{' '}
          <span className="font-mono">desktop/install-icon.sh</span>).
        </p>
      )}
      {agent?.running && agent.note && (
        <p className="rounded-lg bg-amber-50 px-2 py-1.5 text-[9px] leading-relaxed text-amber-700">
          {agent.note}
        </p>
      )}

      {/* The one-click path. Far more usable than asking someone to recall that
          GNOME truncates process names to 15 characters. */}
      {current && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-white px-2 py-1.5">
          <Monitor size={12} className="flex-shrink-0 text-slate-400" />
          <span className="min-w-0 flex-1 truncate">
            <span className="text-[11px] text-slate-700">{current.name}</span>
            <span className="ml-1 font-mono text-[9px] text-slate-400">{current.id}</span>
          </span>
          {agent?.recentAllowed ? (
            <span className="flex-shrink-0 text-[9px] font-bold uppercase tracking-wider text-green-600">
              on the list
            </span>
          ) : (
            <button
              onClick={() => add(current.id)}
              className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-blue-500 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-blue-600"
            >
              <Plus size={10} /> This is work
            </button>
          )}
        </div>
      )}

      <div
        className="space-y-0.5 overflow-y-auto rounded-xl border border-slate-100 bg-white p-1"
        style={{ maxHeight: DAY_MAX_HEIGHT_PX }}
      >
        {programs.length === 0 && (
          <p className="py-2 text-center text-[10px] text-slate-400">
            No programs — nothing outside the browser counts as work.
          </p>
        )}
        {/* Named where a name is known, identifier alongside it in fine print — the
            identifier is what actually matches, so it stays visible, but `code` on
            its own tells nobody they whitelisted Visual Studio Code. */}
        {programs.map((p) => {
          // Undefined means the server has not reported this program yet — just added,
          // signed out, or a backend without the program-flags migration. Nobody has
          // flagged it either way, so 0 is the honest reading.
          const count = flags[p] ?? 0;
          return (
          <div key={p} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
            <span className="min-w-0 flex-1 truncate">
              {names[p] ? (
                <>
                  <span className="text-[11px] text-slate-700">{names[p]}</span>
                  <span className="ml-1 font-mono text-[9px] text-slate-400">{p}</span>
                </>
              ) : (
                <span className="font-mono text-[11px] text-slate-700">{p}</span>
              )}
            </span>
            {/* Same badge the page list carries, reading the other registry. Grey at 0
                keeps an unobjectionable list quiet; red once anyone has flagged it. */}
            <span
              title={count === 0
                ? `No red flags on ${p}`
                : `${count} red flag${count === 1 ? '' : 's'} raised against ${p} by participants`}
              className={`flex flex-shrink-0 items-center gap-0.5 text-[10px] font-bold tabular-nums ${
                count > 0 ? 'text-red-500' : 'text-slate-300'
              }`}
            >
              <Flag size={9} fill={count > 0 ? 'currentColor' : 'none'} />
              {count}
            </span>
            <button
              onClick={() => remove(p)}
              title={`Stop counting ${names[p] ?? p} as work`}
              className="flex-shrink-0 cursor-pointer text-slate-300 transition-colors hover:text-red-500"
            >
              <X size={12} />
            </button>
          </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          placeholder="e.g. code, winword, com.apple.preview"
          value={newProgram}
          onChange={(e) => setNewProgram(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add(newProgram)}
          className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <button
          onClick={() => add(newProgram)}
          className="flex cursor-pointer items-center gap-1 rounded-lg bg-blue-500 px-3 py-1.5 text-[11px] text-white transition-colors hover:bg-blue-600"
        >
          <Plus size={12} /> Add
        </button>
      </div>
      {rejected && (
        <p className="text-[9px] text-red-500">
          <span className="font-mono">{rejected}</span> is a browser — the page whitelist
          above decides those.
        </p>
      )}
      <p className="text-[9px] text-slate-400">
        Browsers are ignored on purpose — the page whitelist above already decides those.
      </p>
    </div>
  );
};

export const AllowedPages = ({ settings, onChange }: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) => {
  const flags = useDomainFlags();
  const [newDomain, setNewDomain] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [msg, setMsg] = useState('');

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  /** One normalisation for both entry paths, so a domain typed by hand and the same
   *  domain pasted in can never end up stored differently. Lower case matters more
   *  than it used to: the server keys its domain registry on it. */
  const normalise = (raw: string) =>
    raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

  const addDomain = () => {
    const d = normalise(newDomain);
    if (!d || settings.allowedDomains.includes(d)) return;
    set({ allowedDomains: [...settings.allowedDomains, d] });
    setNewDomain('');
  };

  const removeDomain = (d: string) =>
    set({ allowedDomains: settings.allowedDomains.filter((x) => x !== d) });

  const copyDomains = async () => {
    const n = settings.allowedDomains.length;
    const ok = await copyText(settings.allowedDomains.join('\n') + '\n');
    setMsg(ok
      ? `Copied ${n} domain${n === 1 ? '' : 's'} to clipboard`
      : 'Copy failed — clipboard unavailable');
  };

  // Overwrite the whitelist with the pasted list. Blanks and duplicates dropped.
  const applyPaste = () => {
    const seen = new Set<string>();
    const domains: string[] = [];
    for (const line of pasteText.split(/[\n,]/)) {
      const d = normalise(line);
      if (!d || seen.has(d)) continue;
      seen.add(d);
      domains.push(d);
    }
    set({ allowedDomains: domains });
    setPasteOpen(false);
    setPasteText('');
    setMsg(`Replaced whitelist with ${domains.length} domain${domains.length === 1 ? '' : 's'}`);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-500">Allowed pages</span>
        <div className="flex gap-1">
          <button
            onClick={copyDomains}
            title="Copy the whitelist to the clipboard, one domain per line"
            className="flex cursor-pointer items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-200"
          >
            <Copy size={11} /> Copy
          </button>
          <button
            onClick={() => { setPasteOpen((v) => !v); setMsg(''); }}
            title="Paste a list — REPLACES the whole whitelist"
            className="flex cursor-pointer items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:bg-slate-200"
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
            placeholder={'overleaf.com\narxiv.org\nwikipedia.org'}
            rows={4}
            className="w-full resize-none rounded-lg border border-slate-200 p-1.5 font-mono text-[9px] text-slate-700 focus:border-slate-400 focus:outline-none"
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={() => { setPasteOpen(false); setPasteText(''); }}
              className="cursor-pointer rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-200"
            >
              Cancel
            </button>
            <button
              onClick={applyPaste}
              disabled={!pasteText.trim()}
              className="cursor-pointer rounded-lg bg-slate-700 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-white hover:bg-slate-800 disabled:opacity-40"
            >
              Replace whitelist
            </button>
          </div>
        </div>
      )}
      {msg && <p className="text-[9px] text-slate-500">{msg}</p>}

      {/* Same five-rows-then-scroll as the day history and the leaderboards above
          it, so the Main tab has one scroll rhythm rather than three. */}
      <div
        className="space-y-0.5 overflow-y-auto rounded-xl border border-slate-100 bg-white p-1"
        style={{ maxHeight: DAY_MAX_HEIGHT_PX }}
      >
        {settings.allowedDomains.length === 0 && (
          <p className="py-2 text-center text-[10px] text-slate-400">No domains — add one below.</p>
        )}
        {settings.allowedDomains.map((d) => {
          // Undefined means the server has not reported this domain yet — just added,
          // or signed out entirely. Nobody has flagged it, so 0 is the honest reading.
          const count = flags[d] ?? 0;
          return (
            <div key={d} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
              <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700">{d}</span>
              {/* Shown on every row, including zeros — an absent number would read as
                  "unknown" rather than "nobody has objected". Grey at 0 keeps a list
                  of clean domains quiet; red once anyone has flagged it. */}
              <span
                title={count === 0
                  ? `No red flags on ${d}`
                  : `${count} red flag${count === 1 ? '' : 's'} raised against ${d} by participants`}
                className={`flex flex-shrink-0 items-center gap-0.5 text-[10px] font-bold tabular-nums ${
                  count > 0 ? 'text-red-500' : 'text-slate-300'
                }`}
              >
                <Flag size={9} fill={count > 0 ? 'currentColor' : 'none'} />
                {count}
              </span>
              <button
                onClick={() => removeDomain(d)}
                title={`Stop tracking ${d}`}
                className="flex-shrink-0 cursor-pointer text-slate-300 transition-colors hover:text-red-500"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          placeholder="e.g. github.com"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addDomain()}
          className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] focus:outline-none focus:ring-2 focus:ring-blue-300"
        />
        <button
          onClick={addDomain}
          className="flex cursor-pointer items-center gap-1 rounded-lg bg-blue-500 px-3 py-1.5 text-[11px] text-white transition-colors hover:bg-blue-600"
        >
          <Plus size={12} /> Add
        </button>
      </div>
      <p className="text-[9px] text-slate-400">
        Newly added pages require a tab reload to activate.
      </p>
    </div>
  );
};

/** Everything the Main tab showed before teams existed, unchanged and now one
 *  section among several. */
export const PersonalSection = ({ state, settings, currentTabDomain, isWhitelisted, onWhitelistToggle, onSettingsChange }: {
  state: SessionState;
  settings: Settings;
  currentTabDomain: string;
  isWhitelisted: boolean;
  onWhitelistToggle: () => void;
  onSettingsChange: (s: Settings) => void;
}) => {
  return (
  <div className="space-y-4">
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

    <DailyHistory state={state} />

    <AllowedPages settings={settings} onChange={onSettingsChange} />

    <AllowedPrograms settings={settings} onChange={onSettingsChange} />

  </div>
  );
};
