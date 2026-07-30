import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionState, Settings, DayScore, ServerStatus, ServerActionResult, MessageType, HISTORY_KEY, localDateKey, weekdayName, DEFAULT_SETTINGS, clampIconChangeHeartbeats, ICON_CHANGE_MIN, ICON_CHANGE_MAX, clampCryBeepVolume, CRY_BEEP_MIN, CRY_BEEP_MAX, clampCryBeepDuration, CRY_BEEP_DURATION_MIN, CRY_BEEP_DURATION_MAX, clampIdleTime, IDLE_TIME_MIN, IDLE_TIME_MAX, CRY_BEEP_STYLES, clampCryBeepStyle } from '../../types';
import { FileText, Activity, Settings2, Plus, X, Zap, ZapOff, Check, Copy, ClipboardPaste, Volume2, VolumeX, Info, LogOut, Users, Trophy, ChevronLeft, Flag } from 'lucide-react';
import { SUMMARY_KEY, TEAMS_KEY, FLAG_KEY } from '../server/config';
// Type-only: erased at compile time, so the popup bundle does not pull in sync.ts
// (and through it auth.ts and the whole fetch path) just to name a shape.
import type {
  ServerSummary, MemberScore, TeamBoard, CompetitionTeam, CompetitionBoard,
  MemberProfile, FlagResult,
} from '../server/sync';
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
const ScoreChart = ({ rows, todayKey, summary }: {
  rows: DayScore[];
  todayKey: string;
  summary: ServerSummary | null;
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
  const [summary, setSummary] = useState<ServerSummary | null>(null);
  const [importMsg, setImportMsg] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  useEffect(() => {
    const load = () => chrome.storage.local.get([HISTORY_KEY, SUMMARY_KEY], (r) => {
      setHistory(Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : []);
      setSummary((r[SUMMARY_KEY] as ServerSummary) ?? null);
    });
    load();
    // Both keys, because applyState() rewrites both on every reply: HISTORY_KEY holds
    // the banked days and SUMMARY_KEY the 7/30-day means. Watching them is how the
    // charts reconcile after a post, the same way onServerScores() reconciles the live
    // score — storage is the channel, so an open popup repaints without polling.
    // Also still covers a rollover landing while the popup happens to be open.
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


// ── Leaderboards ──────────────────────────────────────────────────────────────
// Every board is the same shape — a ranked list of {name, focus, distracted} — so
// members, teams-within-a-competition and the combined field all render through one
// component, differing only in what gets mapped into it.

type Metric = 'live' | 'avg7' | 'avg30';

const METRICS: { id: Metric; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'avg7', label: '7-day' },
  { id: 'avg30', label: '30-day' },
];

interface BoardRow {
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
const BOARD_ROWS_VISIBLE = 5;
const BOARD_MAX_HEIGHT_PX = BOARD_ROWS_VISIBLE * 32 + 16;
/** Day rows are a single line, so more of them fit in the same idea of "five". */
const DAY_MAX_HEIGHT_PX = BOARD_ROWS_VISIBLE * 24 + 8;

/** The ranking number, and the one piece of arithmetic worth stating outright:
 *  `distracted` is stored NEGATIVE, so focus + distracted IS "focus minus
 *  distraction". Writing the subtraction literally would rank a distracted user
 *  ABOVE a clean one (50 focus, −30 distracted scoring 80 instead of 20). The SQL
 *  orders by the same expression. */
const netOf = (r: { focus: number; distracted: number }) => r.focus + r.distracted;

function metricPair(src: Record<string, unknown>, metric: Metric) {
  const key = metric === 'live' ? 'live' : metric;
  return {
    focus: Number(src[`${key}_focus`]) || 0,
    distracted: Number(src[`${key}_distracted`]) || 0,
  };
}

function memberRow(m: MemberScore, metric: Metric, withTeam: boolean): BoardRow {
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

function teamRow(t: CompetitionTeam, metric: Metric): BoardRow {
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
const BarBoard = ({ title, rows, empty, onSelect }: {
  title: string;
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
const BarLegend = () => (
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
const MetricTabs = ({ value, onChange }: { value: Metric; onChange: (m: Metric) => void }) => (
  <div className="flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
    {METRICS.map((m) => (
      <button
        key={m.id}
        onClick={() => onChange(m.id)}
        className={`flex-1 cursor-pointer rounded-md px-1 py-1 text-[10px] font-bold transition-colors ${
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
const ProfileStat = ({ label, focus, distracted }: {
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
const MAX_FLAGS_PER_DOMAIN = 3;

const MemberProfileView = ({ userId, onBack }: { userId: string; onBack: () => void }) => {
  const [profile, setProfile] = useState<MemberProfile | null>(null);
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
    });
  }, [userId]);

  // Flagging returns the domain's new global tally, so only that one row is patched
  // rather than refetching the whole profile. The badge updates independently: the
  // background writes FLAG_KEY, which useWeeklyFlag is watching.
  const flag = (domain: string) => {
    setFlagging(domain);
    chrome.runtime.sendMessage({ type: 'SERVER_FLAG_DOMAIN', domain }, (res?: FlagResult | null) => {
      void chrome.runtime.lastError;
      setFlagging('');
      if (!res) {
        setFlagError('Could not spend the flag — you may have already used it this week.');
        return;
      }
      setFlagError('');
      setProfile((p) => p && {
        ...p,
        // my_flags comes back from the server rather than being incremented locally,
        // so the ceiling is judged on the server's count, not this view's guess.
        domains: p.domains.map((d) => (d.domain === res.domain
          ? { ...d, flag_count: res.flag_count, my_flags: res.my_flags }
          : d)),
      });
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
        <span className={`min-w-0 truncate text-sm font-bold ${profile.is_self ? 'text-blue-700' : 'text-slate-700'}`}>
          {profile.display_name}
        </span>
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

      <div className="space-y-1">
        <h4 className="flex items-baseline justify-between text-[9px] font-bold uppercase tracking-widest text-slate-400">
          <span>Whitelisted domains</span>
          <FlagBadge available={flagAvailable} small />
        </h4>
        {profile.domains.length === 0 ? (
          <p className="text-[10px] text-slate-400">No domains recorded.</p>
        ) : (
          <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
            {profile.domains.map((d) => {
              // Two independent gates, and they need different explanations: the week
              // runs out for every domain at once, the ceiling only for this one.
              const capped = d.my_flags >= MAX_FLAGS_PER_DOMAIN;
              const canFlag = flagAvailable && !capped;
              return (
                <div key={d.domain} className="flex items-center gap-2 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate text-[10px] text-slate-600">
                    {d.domain}
                    {/* Your own contribution, as a fraction of your ceiling. Shown only
                        once you have spent something on this domain — "0/3" on every
                        untouched row would read as a target to fill. */}
                    {d.my_flags > 0 && (
                      <span className={capped ? 'text-red-400' : 'text-slate-400'}>
                        {' '}· {d.my_flags}/{MAX_FLAGS_PER_DOMAIN} from you
                      </span>
                    )}
                  </span>
                  {/* Tally inside the button: the count and the act of flagging are one
                      affordance. A permanent, unrevocable action should not look
                      available when it isn't. */}
                  <button
                    onClick={() => flag(d.domain)}
                    disabled={!canFlag || flagging === d.domain}
                    title={
                      capped
                        ? `You've used all ${MAX_FLAGS_PER_DOMAIN} of your flags on ${d.domain}. Others can still flag it.`
                        : flagAvailable
                          ? `Spend this week's red flag on ${d.domain} — this cannot be undone`
                          : 'Weekly red flag already spent. You get another on Monday at 01:00.'
                    }
                    className={`flex flex-shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[10px] font-bold tabular-nums transition-colors ${
                      canFlag
                        ? 'cursor-pointer bg-slate-100 text-slate-500 hover:bg-red-100 hover:text-red-600'
                        : 'cursor-not-allowed bg-slate-50 text-slate-300'
                    }`}
                  >
                    <Flag size={10} fill={d.flag_count > 0 ? 'currentColor' : 'none'} />
                    {d.flag_count}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {flagError && <p className="text-[9px] font-medium text-red-500">{flagError}</p>}
        <p className="text-[9px] text-slate-400">
          One red flag per week, granted each Monday at 01:00, and at most{' '}
          {MAX_FLAGS_PER_DOMAIN} from you on any one domain. Flags are permanent, and
          the count shown is everyone's together.
        </p>
      </div>
    </div>
  );
};

/** Create-or-join, one field and two verbs. They are separate buttons because they
 *  are separate intents, and the server enforces the difference: create refuses a
 *  name that exists, join refuses one that doesn't. A typo can neither found a
 *  one-person team nor drop you into a stranger's. */
const NameForm = ({ placeholder, hint, busy, error, withPassword, passwordPlaceholder, onSubmit }: {
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

/** One of the caller's own teams: everyone in it ranked against them. */
const TeamSection = ({ board, busy, error, onEnroll, onLeave }: {
  board: TeamBoard;
  busy: boolean;
  error: string;
  onEnroll: (competition: string, create: boolean, password: string) => void;
  onLeave: () => void;
}) => {
  const [metric, setMetric] = useState<Metric>('live');
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
          <span className="truncate">{board.team}</span>
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
          hint="Name and password both needed — sharing a competition is what lets rival teams see each other."
          withPassword
          passwordPlaceholder="competition password (min 4)"
          busy={busy}
          error={error}
          onSubmit={onEnroll}
        />
      )}

      <MetricTabs value={metric} onChange={setMetric} />
      <BarLegend />
      <BarBoard
        title="Team standings"
        rows={board.members.map((x) => memberRow(x, metric, false))}
        empty="No members yet."
        onSelect={setSelected}
      />

      <button
        onClick={onLeave}
        disabled={busy}
        className="w-full cursor-pointer rounded-lg border border-slate-100 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
      >
        Leave {board.team}
      </button>
    </div>
  );
};

/** A competition: teams against teams, then everyone against everyone, then each
 *  team's own list. All three are derived from one payload — the per-team lists are
 *  the combined list grouped by the `team` each row carries. */
const CompetitionSection = ({ board, busy, onLeave }: {
  board: CompetitionBoard;
  busy: boolean;
  onLeave: (team: string) => void;
}) => {
  const [metric, setMetric] = useState<Metric>('live');
  const [selected, setSelected] = useState<string | null>(null);

  const byTeam = new Map<string, MemberScore[]>();
  for (const m of board.members) {
    const t = m.team ?? '—';
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t)!.push(m);
  }
  // Follow the server's team order, so the leading team's roster comes first.
  const teamOrder = board.teams.map((t) => t.team).filter((t) => byTeam.has(t));
  // Withdrawing is per-team, since you can have more than one team in a competition.
  const myTeams = board.teams.filter((t) => t.is_mine).map((t) => t.team);

  if (selected) return <MemberProfileView userId={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="space-y-3">
      <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-bold text-slate-700">
        <Trophy size={14} className="flex-shrink-0 text-amber-500" />
        <span className="truncate">{board.competition}</span>
      </h3>

      <MetricTabs value={metric} onChange={setMetric} />
      <BarLegend />

      {/* The chosen metric, drawn three ways: teams against teams, then the whole
          field, then each team's own roster. */}
      <BarBoard
        title="Teams"
        rows={board.teams.map((t) => teamRow(t, metric))}
        empty="No teams entered yet."
      />
      <BarBoard
        title="Everyone"
        rows={board.members.map((x) => memberRow(x, metric, true))}
        empty="No participants yet."
        onSelect={setSelected}
      />
      {teamOrder.map((t) => (
        <BarBoard
          key={t}
          title={t}
          rows={(byTeam.get(t) ?? []).map((x) => memberRow(x, metric, false))}
          onSelect={setSelected}
        />
      ))}

      {myTeams.map((t) => (
        <button
          key={t}
          onClick={() => onLeave(t)}
          disabled={busy}
          className="w-full cursor-pointer rounded-lg border border-slate-100 py-1 text-[9px] font-bold uppercase tracking-wider text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
        >
          Withdraw {t} from {board.competition}
        </button>
      ))}
    </div>
  );
};

/** Whether this week's red flag is still in hand. Read from storage, which both the
 *  server replies and a successful flag write — so the badge and the flag buttons on
 *  a profile stay in step without either owning the other's state. */
function useWeeklyFlag(): boolean {
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
const FlagBadge = ({ available, small }: { available: boolean; small?: boolean }) => (
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

/** The boards, read from the cache the server overwrites on every reply. Watching
 *  storage rather than asking means a membership change or the 1-minute post floor
 *  repaints an open popup with no request of its own. */
function useBoards() {
  const [boards, setBoards] = useState<{ teams: TeamBoard[]; competitions: CompetitionBoard[] }>(
    { teams: [], competitions: [] },
  );
  useEffect(() => {
    const load = () => chrome.storage.local.get([TEAMS_KEY], (r) => {
      const b = r[TEAMS_KEY] as { teams?: TeamBoard[]; competitions?: CompetitionBoard[] } | undefined;
      setBoards({ teams: b?.teams ?? [], competitions: b?.competitions ?? [] });
    });
    load();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes[TEAMS_KEY]) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);
  return boards;
}

// ── Main tab ──────────────────────────────────────────────────────────────────
const MainTab = ({ state, settings, currentTabDomain, currentTabUrl, onWhitelistToggle }: {
  state: SessionState;
  settings: Settings;   // read-only here: the whitelist check. Edits live in SettingsTab.
  currentTabDomain: string;
  currentTabUrl: string;
  onWhitelistToggle: () => void;
}) => {
  const boards = useBoards();
  const flagAvailable = useWeeklyFlag();
  // Sections are one-at-a-time rather than stacked. Personal alone is roughly a
  // popup's height, and every team and competition adds several boards behind it;
  // stacked, a user in one competition would scroll past everything to reach
  // anything. The pills keep all of them one tap away.
  const [section, setSection] = useState('personal');
  const [joinOpen, setJoinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Every team action returns the full state, which the background writes into the
  // storage the boards watch — so a successful call repaints by itself and there is
  // nothing to refetch here.
  const act = (msg: MessageType, onDone?: () => void) => {
    setBusy(true);
    setError('');
    chrome.runtime.sendMessage(msg, (res?: ServerActionResult) => {
      void chrome.runtime.lastError;
      setBusy(false);
      if (!res?.ok) { setError(res?.error ?? 'Could not reach the server.'); return; }
      setError('');
      onDone?.();
    });
  };

  const isWhitelisted = currentTabUrl.length > 0 &&
    settings.allowedDomains.some(d => d.trim() !== '' && currentTabUrl.includes(d.trim()));

  const teamSection = boards.teams.find((t) => `team:${t.team}` === section);
  const compSection = boards.competitions.find((c) => `comp:${c.competition}` === section);
  // Leaving the team you were looking at removes its pill; fall back rather than
  // rendering a section that no longer exists.
  const active = teamSection || compSection ? section : 'personal';

  const pill = (key: string, label: string, icon?: React.ReactNode) => (
    <button
      key={key}
      onClick={() => { setSection(key); setError(''); }}
      className={`flex max-w-[120px] flex-shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-colors ${
        active === key ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );

  return (
  <div className="space-y-4">

    {/* Section switcher, above everything it switches between. The trailing + is
        how you get your first team, so it is present even with no teams at all. */}
    <div className="space-y-2">
      {/* The badge sits OUTSIDE the wrapping group, pinned right, so it keeps its
          corner however many team and competition pills wrap onto new lines. */}
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {pill('personal', 'Personal')}
          {boards.teams.map((t) => pill(`team:${t.team}`, t.team, <Users size={10} />))}
          {boards.competitions.map((c) => pill(`comp:${c.competition}`, c.competition, <Trophy size={10} />))}
          <button
            onClick={() => { setJoinOpen((v) => !v); setError(''); }}
            title="Create a team, or join one that exists"
            className={`flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-colors ${
              joinOpen ? 'bg-blue-500 text-white' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
            }`}
          >
            <Plus size={11} /> Team
          </button>
        </div>
        <FlagBadge available={flagAvailable} />
      </div>
      {joinOpen && (
        <NameForm
          placeholder="team name"
          hint="Share the name and password with your team — both are needed to join."
          withPassword
          busy={busy}
          error={error}
          onSubmit={(name, create, password) =>
            act({ type: 'SERVER_JOIN_TEAM', team: name, create, password }, () => {
              setJoinOpen(false);
              setSection(`team:${name}`);
            })
          }
        />
      )}
    </div>

    {teamSection && active !== 'personal' ? (
      <TeamSection
        board={teamSection}
        busy={busy}
        error={error}
        onEnroll={(competition, create, password) =>
          act({ type: 'SERVER_ENROLL_TEAM', team: teamSection.team, competition, create, password },
              () => setSection(`comp:${competition}`))
        }
        onLeave={() =>
          act({ type: 'SERVER_LEAVE_TEAM', team: teamSection.team }, () => setSection('personal'))
        }
      />
    ) : compSection && active !== 'personal' ? (
      <CompetitionSection
        board={compSection}
        busy={busy}
        onLeave={(team) =>
          act({ type: 'SERVER_LEAVE_COMPETITION', team, competition: compSection.competition },
              () => setSection('personal'))
        }
      />
    ) : (
      <PersonalSection
        state={state}
        currentTabDomain={currentTabDomain}
        isWhitelisted={isWhitelisted}
        onWhitelistToggle={onWhitelistToggle}
      />
    )}
  </div>
  );
};

/** Everything the Main tab showed before teams existed, unchanged and now one
 *  section among several. */
const PersonalSection = ({ state, currentTabDomain, isWhitelisted, onWhitelistToggle }: {
  state: SessionState;
  currentTabDomain: string;
  isWhitelisted: boolean;
  onWhitelistToggle: () => void;
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

  </div>
  );
};

// ── Account ───────────────────────────────────────────────────────────────────
// Sign-in is dispatched to the BACKGROUND, not run here: launchWebAuthFlow opens a
// window, which closes the popup, which would kill the flow before Google
// redirects back. The background survives that, so the popup only ever asks.
//
// The status lives in the ROOT rather than in a component inside a tab, because it
// now GATES the entire popup: signed out, the only thing rendered is the sign-in
// button. Anything that needs it must therefore be above the tab bar.

/** Google's four-colour "G". Not in lucide — it dropped brand marks — and a
 *  generic key/login glyph would leave the button looking like it signs you into
 *  something else. Inline SVG so it survives with no network and no asset step. */
const GoogleIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="flex-shrink-0">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

function useServerAccount() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const ask = (type: 'SERVER_STATUS' | 'SERVER_SIGN_IN' | 'SERVER_SIGN_OUT') => {
    setBusy(type !== 'SERVER_STATUS');
    chrome.runtime.sendMessage({ type }, (res?: ServerStatus) => {
      void chrome.runtime.lastError;
      setBusy(false);
      if (res) setStatus(res);
      // A sign-in that comes back still signed out failed somewhere in the OAuth
      // round trip. ServerStatus carries no error channel, so infer it here —
      // otherwise the button simply goes quiet and reads as broken.
      setFailed(type === 'SERVER_SIGN_IN' && !!res && !res.signedIn);
    });
  };

  useEffect(() => { ask('SERVER_STATUS'); }, []);

  return { status, busy, failed, ask };
}

/** The whole popup when signed out: nothing but the button. No Working toggle, no
 *  tabs, no scores — an account is a precondition, not a feature, so offering the
 *  controls would imply the extension is already doing something. */
const SignInScreen = ({ busy, failed, onSignIn }: {
  busy: boolean;
  failed: boolean;
  onSignIn: () => void;
}) => (
  <div className="w-[320px] bg-white text-slate-900 font-sans">
    <header className="border-b border-slate-100 px-4 pt-4 pb-3">
      <h1 className="flex items-center gap-2 text-lg font-bold">
        <Activity className="text-slate-300" size={20} />
        Focus
      </h1>
    </header>
    <div className="space-y-3 p-4">
      <button
        onClick={onSignIn}
        disabled={busy}
        className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
      >
        <GoogleIcon size={16} />
        {busy ? 'Signing in…' : 'Sign in with Google'}
      </button>
      {failed && (
        <p className="text-[10px] font-medium text-red-500">
          Sign-in didn't complete — try again.
        </p>
      )}
      <p className="text-[10px] leading-snug text-slate-400">
        Focus keeps your scores, averages and whitelisted pages on the study server, so sign in
        before you start. Your data follows your account across devices and reinstalls.
      </p>
    </div>
  </div>
);

/** Signed-in state, condensed to one line above the tab bar: who you are and how
 *  to leave. Everything else the server knows is already on the Main tab. */
const AccountRow = ({ email, busy, onSignOut }: {
  email: string;
  busy: boolean;
  onSignOut: () => void;
}) => (
  <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-1.5">
    <GoogleIcon size={13} />
    <span className="min-w-0 flex-1 truncate text-[10px] text-slate-500" title={email}>
      {email}
    </span>
    <button
      onClick={onSignOut}
      disabled={busy}
      title="Sign out — stops syncing to the study server"
      className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-white px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-200 disabled:opacity-40"
    >
      <LogOut size={10} /> Sign out
    </button>
  </div>
);

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
  const { status, busy: accountBusy, failed: signInFailed, ask } = useServerAccount();

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

  // Account first: signed out, nothing else renders. Waiting for the status before
  // deciding avoids flashing the sign-in screen at an already-signed-in user on
  // every open.
  //
  // Gated ONLY when a server is actually configured. A build with an empty
  // config.ts (a fresh clone) has no sign-in to complete, and locking it behind a
  // button that can only fail would brick the offline extension.
  if (!status) return <div className="p-4 text-sm text-slate-500">Loading…</div>;
  if (status.configured && !status.signedIn) {
    return (
      <SignInScreen
        busy={accountBusy}
        failed={signInFailed}
        onSignIn={() => ask('SERVER_SIGN_IN')}
      />
    );
  }

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

      {status.signedIn && (
        <AccountRow
          email={status.email}
          busy={accountBusy}
          onSignOut={() => ask('SERVER_SIGN_OUT')}
        />
      )}

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
