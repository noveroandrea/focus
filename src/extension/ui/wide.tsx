// ─────────────────────────────────────────────────────────────────────────────
//  Charts that only work when there is room — the dashboard's own forms
// ─────────────────────────────────────────────────────────────────────────────
//  Deliberately NOT in shared.tsx. The popup imports shared.tsx, so anything put
//  there ships in the popup bundle whether or not 320px can draw it — and none of
//  these can be drawn at 320px. A donut needs its labels beside it, a year of days
//  needs ~700px of week columns, and a weekday profile needs seven readable ticks.
//
//  Every one of them is fed by data the dashboard already fetched for something
//  else. That is the rule the whole payload design rests on: a new chart is a new
//  READING of an existing response, never a new request. The donut re-reads the
//  board the standings list is drawn from; the heatmap and the weekday profile
//  re-read the day series the trend line is drawn from.
// ─────────────────────────────────────────────────────────────────────────────
import React from 'react';
import { DayScore, WEEKDAYS } from '../../types';
import { FOCUS_COLOR, DISTRACTED_COLOR, MONTHS } from './shared';

// ── Categorical palette ───────────────────────────────────────────────────────
// Exactly three hues, because a donut is an all-pairs form: you match every slice
// against every legend row, not just its neighbours. Validated with the dataviz
// validator at --pairs all on the light surface —
//
//   lightness band  PASS · chroma floor PASS
//   CVD separation  PASS  worst pair aqua↔orange ΔE 9.2 deutan (target ≥ 8)
//   normal vision   PASS  worst pair aqua↔blue   ΔE 24.0 (floor ≥ 15)
//   contrast        WARN  aqua 2.74:1 → relief required, which is why every slice
//                         carries a visible label and the legend states the value
//
// A FOURTH hue is not available: adding the next categorical slot puts yellow beside
// orange, which fails all-pairs. So the fourth slice is not a category at all — it is
// "Other", drawn in plain chrome grey and always last. Grey was measured too (it
// collides with aqua at ΔE 8.0 deutan as a *category*); as a labelled remainder that
// is never compared against a name, it is chrome rather than a series.
const SLICE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
const OTHER_COLOR = '#cbd5e1';   // slate-300 — the remainder, not a series

/** Composition: who a group's focus actually came from.
 *
 *  A pie is the right form here and almost nowhere else — the parts sum to a
 *  meaningful whole (the team's total focus) and there are at most four of them.
 *  Ranking is what the bar board above does; this answers the different question of
 *  whether the total is one person or all of them.
 *
 *  Only FOCUS is charted. Distraction is stored negative, and a negative slice has
 *  no meaning in a part-to-whole — the diverging bars are where that side is read. */
export const CompositionDonut = ({ rows, title }: {
  rows: { label: string; value: number }[];
  title: string;
}) => {
  const ranked = [...rows].filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const total = ranked.reduce((s, r) => s + r.value, 0);

  if (total <= 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{title}</h4>
        <p className="py-10 text-center text-xs text-slate-400">No focus banked yet.</p>
      </div>
    );
  }

  const named = ranked.slice(0, SLICE_COLORS.length);
  const rest = ranked.slice(SLICE_COLORS.length);
  const slices = [
    ...named.map((r, i) => ({ ...r, color: SLICE_COLORS[i], other: false })),
    ...(rest.length
      ? [{
          label: `Other (${rest.length})`,
          value: rest.reduce((s, r) => s + r.value, 0),
          color: OTHER_COLOR,
          other: true,
        }]
      : []),
  ];

  // Geometry. A donut rather than a pie: the hole carries the total, which is the
  // number people actually want, and it keeps the eye on arc length instead of
  // inviting angle-at-the-centre comparisons.
  const R = 78, INNER = 48, CX = 90, CY = 90;
  const GAP = 0.012;   // radians of surface showing between slices — the 2px spacer
  let angle = -Math.PI / 2;   // start at 12 o'clock

  const arc = (from: number, to: number) => {
    const big = to - from > Math.PI ? 1 : 0;
    const p = (r: number, a: number) => `${(CX + r * Math.cos(a)).toFixed(2)},${(CY + r * Math.sin(a)).toFixed(2)}`;
    return `M ${p(R, from)} A ${R} ${R} 0 ${big} 1 ${p(R, to)} L ${p(INNER, to)} A ${INNER} ${INNER} 0 ${big} 0 ${p(INNER, from)} Z`;
  };

  const drawn = slices.map((s) => {
    const span = (s.value / total) * Math.PI * 2;
    const from = angle + GAP / 2;
    const to = angle + span - GAP / 2;
    angle += span;
    return { ...s, d: arc(from, Math.max(from + 0.001, to)), pct: (s.value / total) * 100 };
  });

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{title}</h4>
      <div className="mt-2 flex items-center gap-4">
        <svg viewBox="0 0 180 180" className="h-[150px] w-[150px] flex-shrink-0">
          {drawn.map((s) => (
            <path key={s.label} d={s.d} fill={s.color}>
              <title>{`${s.label}: ${Math.round(s.value)} focus (${s.pct.toFixed(1)}%)`}</title>
            </path>
          ))}
          <text x={CX} y={CY - 4} textAnchor="middle" fontSize="22" fontWeight="800" fill="#334155">
            {Math.round(total)}
          </text>
          <text x={CX} y={CY + 12} textAnchor="middle" fontSize="9" fill="#94a3b8">
            total focus
          </text>
        </svg>

        {/* The legend IS the relief the contrast check asks for: every slice named,
            with its own number, so nothing depends on telling two hues apart. */}
        <ul className="min-w-0 flex-1 space-y-1">
          {drawn.map((s) => (
            <li key={s.label} className="flex items-center gap-2 text-[11px]">
              <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className={`min-w-0 flex-1 truncate ${s.other ? 'text-slate-400' : 'text-slate-600'}`}>
                {s.label}
              </span>
              <span className="flex-shrink-0 font-bold tabular-nums text-slate-700">
                {Math.round(s.value)}
              </span>
              <span className="w-10 flex-shrink-0 text-right tabular-nums text-slate-400">
                {s.pct.toFixed(0)}%
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

// ── Calendar heatmap ──────────────────────────────────────────────────────────
// Sequential, so ONE hue light→dark and nothing else — a rainbow here would imply
// the categories a calendar does not have. Monotonic in lightness, which is what
// makes it survive greyscale and CVD: the reading is "darker = more".
const HEAT_STEPS = ['#dcfce7', '#bbf7d0', '#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d'];
const HEAT_EMPTY = '#f1f5f9';   // no row for that day — not the same as a zero

// Rows run Monday→Sunday, matching the column build below.
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Every day as one cell, weeks as columns. The form the trend line cannot give you:
 *  a trend answers "am I improving", this answers "which days do I actually work".
 *  Gaps read as gaps — a day with no row is grey, not a zero-height point. */
export const CalendarHeatmap = ({ rows, weeks = 26, title = 'Focus calendar' }: {
  rows: DayScore[];
  weeks?: number;
  /** Overridden on the group panels, where the title has to say "average" — the
   *  cells look identical whether they are one person's day or five people's mean. */
  title?: string;
}) => {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const max = Math.max(1, ...rows.map((r) => r.focusScore));

  // Columns run Monday→Sunday so a week is one column, ending with today's week.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(today);
  endOfWeek.setDate(today.getDate() + ((7 - today.getDay()) % 7));   // this week's Sunday

  const cols: { key: string; days: (Date | null)[]; monday: Date }[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const days: (Date | null)[] = [];
    let monday = today;
    for (let d = 6; d >= 0; d--) {
      const day = new Date(endOfWeek);
      day.setDate(endOfWeek.getDate() - (w * 7 + d));
      if (d === 6) monday = day;             // the column's first row, whatever it holds
      days.push(day > today ? null : day);   // the rest of this week hasn't happened
    }
    cols.push({ key: `w${w}`, days, monday });
  }

  // X axis. A column spans seven different dates, so the label that means anything is
  // its Monday: the month name where the month turns over, and the date every fourth
  // column so the reader can place a cell without counting back from today.
  const axis = cols.map((c, i) => {
    const prev = cols[i - 1]?.monday;
    return {
      month: !prev || prev.getMonth() !== c.monday.getMonth() ? MONTHS[c.monday.getMonth()] : '',
      date: i % 4 === 0 ? String(c.monday.getDate()) : '',
    };
  });

  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const fill = (d: Date | null) => {
    if (!d) return 'transparent';
    const row = byDate.get(key(d));
    if (!row) return HEAT_EMPTY;
    const i = Math.min(HEAT_STEPS.length - 1,
                       Math.floor((row.focusScore / max) * (HEAT_STEPS.length - 1) + 0.5));
    return HEAT_STEPS[Math.max(0, i)];
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
          {title}
        </h4>
        <span className="text-[9px] text-slate-400">last {weeks} weeks</span>
      </div>

      <div className="mt-2 flex gap-1 overflow-x-auto pb-1">
        {/* Y axis. Seven letters rather than the usual Mon/Wed/Fri: at 11px cells
            there is room, and a full column is easier to count down than a sparse
            one. The two T's and two S's are unavoidable and unambiguous in order. */}
        <div className="flex flex-shrink-0 flex-col gap-[3px] pt-[13px]">
          {DAY_LETTERS.map((l, i) => (
            <span key={i} className="h-[11px] w-[9px] text-[8px] leading-[11px] text-slate-400">
              {l}
            </span>
          ))}
        </div>

        <div className="min-w-0">
          {/* Month row. Labels overflow their 11px column deliberately — a month name
              is wider than a week, and clipping it to fit would leave "A". */}
          <div className="flex h-[13px] gap-[3px]">
            {axis.map((a, i) => (
              <span key={i} className="w-[11px] flex-shrink-0 whitespace-nowrap text-[8px] font-bold text-slate-500">
                {a.month}
              </span>
            ))}
          </div>

          <div className="flex gap-[3px]">
            {cols.map((c) => (
              <div key={c.key} className="flex flex-shrink-0 flex-col gap-[3px]">
                {c.days.map((d, i) => (
                  <span
                    key={i}
                    title={d ? `${key(d)} — ${byDate.has(key(d))
                      ? `${Math.round(byDate.get(key(d))!.focusScore)} focus`
                      : 'no record'}` : ''}
                    className="h-[11px] w-[11px] rounded-[2px]"
                    style={{ background: fill(d) }}
                  />
                ))}
              </div>
            ))}
          </div>

          {/* Day of the month, on the same Monday the column starts from. */}
          <div className="mt-[3px] flex h-[11px] gap-[3px]">
            {axis.map((a, i) => (
              <span key={i} className="w-[11px] flex-shrink-0 whitespace-nowrap text-[8px] text-slate-400">
                {a.date}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-1 flex items-center justify-end gap-1 text-[9px] text-slate-400">
        <span className="h-[9px] w-[9px] rounded-[2px]" style={{ background: HEAT_EMPTY }} />
        <span className="mr-1">none</span>
        {HEAT_STEPS.map((c) => (
          <span key={c} className="h-[9px] w-[9px] rounded-[2px]" style={{ background: c }} />
        ))}
        <span className="ml-1">more focus</span>
      </div>
    </div>
  );
};

/** Mean focus and distraction by day of the week.
 *
 *  Same diverging pair and same "position, not hue, carries identity" argument as
 *  every other chart here: focus is always above the baseline, distraction always
 *  below, so the two can never be confused even when the hues are.
 *
 *  Averaged over the days actually recorded for each weekday — three Mondays and
 *  eleven Fridays would otherwise make Friday look like the productive one. */
export const WeekdayProfile = ({ rows, title = 'By weekday' }: {
  rows: DayScore[];
  title?: string;
}) => {
  const buckets = WEEKDAYS.map(() => ({ f: 0, d: 0, n: 0 }));
  for (const r of rows) {
    const i = WEEKDAYS.indexOf(r.weekday);
    if (i < 0) continue;
    buckets[i].f += r.focusScore;
    buckets[i].d += r.distractedScore;
    buckets[i].n += 1;
  }
  // Monday first: a work week does not start on Sunday.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const bars = order.map((i) => ({
    label: WEEKDAYS[i].slice(0, 3),
    n: buckets[i].n,
    focus: buckets[i].n ? buckets[i].f / buckets[i].n : 0,
    distracted: buckets[i].n ? buckets[i].d / buckets[i].n : 0,
  }));

  const H = 52;
  const max = Math.max(1, ...bars.map((b) => Math.max(b.focus, Math.abs(b.distracted))));
  const px = (v: number) => Math.round((Math.min(Math.abs(v), max) / max) * H);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <h4 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
        {title}
      </h4>
      <div className="mt-2 flex items-start justify-between gap-1">
        {bars.map((b) => (
          <div
            key={b.label}
            className="flex flex-1 flex-col items-center"
            title={b.n
              ? `${b.label}: focus ${Math.round(b.focus)}, distracted ${Math.round(b.distracted)} (mean of ${b.n} day${b.n === 1 ? '' : 's'})`
              : `${b.label}: nothing recorded`}
          >
            <div className="flex w-full flex-col justify-end" style={{ height: H }}>
              <div className="mx-auto w-3/5" style={{ height: px(b.focus), background: FOCUS_COLOR, borderRadius: '4px 4px 0 0' }} />
            </div>
            <div className="h-px w-full bg-slate-200" />
            <div className="w-full" style={{ height: H }}>
              <div className="mx-auto w-3/5" style={{ height: px(b.distracted), background: DISTRACTED_COLOR, borderRadius: '0 0 4px 4px' }} />
            </div>
            <span className={`mt-1 text-[9px] ${b.n ? 'text-slate-500' : 'text-slate-300'}`}>{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Both halves of a period average in one tile.
 *
 *  A "7-day focus" figure on its own is half the story — a week averaging 35 focus
 *  against −5 distraction is a different week from 35 against −60, and the tile
 *  showing only the first made them look identical. The two numbers are the same
 *  pair every chart on the page uses.
 *
 *  Each number is captioned rather than left to its colour: this is a KPI tile with
 *  no baseline to sit above or below, so unlike the charts it has no position cue to
 *  fall back on, and green/red alone is exactly the pair a red-green colourblind
 *  reader cannot separate. */
export const DualStatTile = ({ label, focus, distracted, hint }: {
  label: string;
  focus: number;
  distracted: number;
  hint?: string;
}) => (
  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
    <div className="mt-1 flex items-baseline gap-2.5">
      <span>
        <span className="text-2xl font-extrabold leading-none" style={{ color: FOCUS_COLOR }}>
          {Math.round(focus)}
        </span>
        <span className="ml-1 text-[9px] text-slate-400">focus</span>
      </span>
      <span className="text-slate-200">|</span>
      <span>
        <span className="text-2xl font-extrabold leading-none" style={{ color: DISTRACTED_COLOR }}>
          {Math.round(distracted)}
        </span>
        <span className="ml-1 text-[9px] text-slate-400">distr.</span>
      </span>
    </div>
    {hint && <p className="mt-1 text-[9px] text-slate-400">{hint}</p>}
  </div>
);

/** One number with its name. The dashboard's KPI row — no plot, so no tooltip, and
 *  proportional figures rather than tabular: these are display values, not a column
 *  that has to line up. */
export const StatTile = ({ label, value, hint, color }: {
  label: string;
  value: number;
  hint?: string;
  color?: string;
}) => (
  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</p>
    <p className="mt-1 text-2xl font-extrabold leading-none" style={{ color: color ?? '#334155' }}>
      {Math.round(value)}
    </p>
    {hint && <p className="mt-1 text-[9px] text-slate-400">{hint}</p>}
  </div>
);
