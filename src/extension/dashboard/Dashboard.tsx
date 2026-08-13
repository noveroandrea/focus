// ─────────────────────────────────────────────────────────────────────────────
//  The dashboard — the same data, in a tab that has room for it
// ─────────────────────────────────────────────────────────────────────────────
//  A competition with eight teams and three metrics is a dashboard, not a popup.
//  At 320px it has to be a stack of one-at-a-time sections behind a pill row; given
//  a tab it can be a sidebar, a KPI row and several panels side by side.
//
//  ── IT IS A SECOND VIEW, NOT A SECOND CLIENT ────────────────────────────────
//  Every component here comes from ui/shared.tsx, the same module the popup renders,
//  and every request goes through the background exactly as the popup's do. So the
//  data rules hold by construction rather than by discipline:
//
//    boards          fetched when a section opens, refreshed every 60 s (useBoard)
//    day series      fetched ONCE per open — a completed day changes once a day
//    profiles        only when a member is clicked
//    everything else read from the chrome.storage caches the background writes
//
//  The wide-only charts (donut, calendar, weekday profile) add NO requests. Each is
//  a second reading of a response another component on the same screen already
//  asked for — which is why DailyHistory reports its rows upward rather than the
//  calendar fetching its own.
//
//  ── WHY NOT A HOSTED PAGE ───────────────────────────────────────────────────
//  The background already holds the Supabase session (obtained through
//  launchWebAuthFlow with an extension redirect URI). An extension page inherits it
//  and every RLS policy keeps working untouched. A hosted page would be a second
//  client with its own session, its own OAuth redirect and its own way to get
//  authorization wrong, against a schema where get_member_profile hands out other
//  people's browsing data.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  SessionState, Settings, DayScore, ServerStatus, ServerActionResult, MessageType,
  DEFAULT_SETTINGS, localDateKey,
} from '../../types';
import {
  Activity, User, UserPlus, Users, Trophy, Plus, LogOut, Loader2, ExternalLink,
} from 'lucide-react';
import { SUMMARY_KEY } from '../server/config';
import type { ServerSummary, TeamBoard, FriendsBoard, MemberScore } from '../server/sync';
import {
  FOCUS_COLOR, DISTRACTED_COLOR, Metric, MetricTabs, BarBoard, BarLegend, memberRow,
  BoardFooter, BoardLoading, useBoard, useMemberships, useWeeklyFlag, FlagBadge,
  DailyHistory, AllowedPages, CompetitionSection, MemberProfileView, NameForm,
  FriendSearch, useGroupHistory, GroupHistoryLoading, GroupHistoryUnavailable,
  GroupAverageNote, DayList,
  ScoreChart, ScoreTrend, ScoreLegend,
} from '../ui/shared';
import { CompositionDonut, CalendarHeatmap, WeekdayProfile, StatTile, DualStatTile } from '../ui/wide';
import '../../index.css';

// ── Small pieces ──────────────────────────────────────────────────────────────

const Panel = ({ title, right, children, className }: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => (
  <section className={`rounded-xl border border-slate-200 bg-white p-4 ${className ?? ''}`}>
    {(title || right) && (
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{title}</h3>
        {right}
      </div>
    )}
    {children}
  </section>
);

/** The metric a board is ranked by, applied to one member row. The donut charts
 *  focus only, so this picks the focus half of whichever metric is on screen —
 *  switching to 7-day repaints the composition too, rather than leaving a live-score
 *  donut above a 7-day board. */
function focusFor(m: MemberScore, metric: Metric): number {
  return Number(metric === 'avg7' ? m.avg7_focus : metric === 'avg30' ? m.avg30_focus : m.live_focus) || 0;
}

// ── Personal ──────────────────────────────────────────────────────────────────

const PersonalPanel = ({ state, settings, onSettingsChange }: {
  state: SessionState;
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
}) => {
  const [summary, setSummary] = useState<ServerSummary | null>(null);
  // The days DailyHistory loaded, reused by the two wide charts. See its onRows.
  const [days, setDays] = useState<DayScore[]>([]);

  useEffect(() => {
    const load = () => chrome.storage.local.get([SUMMARY_KEY], (r) => {
      setSummary((r[SUMMARY_KEY] as ServerSummary) ?? null);
    });
    load();
    const listener = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && changes[SUMMARY_KEY]) load();
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Focus today" value={state.focusScore ?? 0} color={FOCUS_COLOR}
                  hint={state.isHeartbeatActive ? 'active right now' : 'idle'} />
        <StatTile label="Distracted today" value={state.distractedScore ?? 0} color={DISTRACTED_COLOR}
                  hint="−10 per idle lapse" />
        <DualStatTile label="7-day average"
                      focus={Number(summary?.avg7_focus) || 0}
                      distracted={Number(summary?.avg7_distracted) || 0}
                      hint="mean of complete days" />
        <DualStatTile label="30-day average"
                      focus={Number(summary?.avg30_focus) || 0}
                      distracted={Number(summary?.avg30_distracted) || 0}
                      hint="mean of complete days" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* No Panel title: DailyHistory carries its own header and its clipboard
            buttons, and two titles for one thing is one too many. */}
        <Panel>
          <DailyHistory state={state} onRows={setDays} />
        </Panel>

        <div className="space-y-4">
          <CalendarHeatmap rows={days} />
          <WeekdayProfile rows={days} />
        </div>
      </div>

      <Panel>
        <AllowedPages settings={settings} onChange={onSettingsChange} />
      </Panel>
    </div>
  );
};

// ── A group's own Personal view ───────────────────────────────────────────────

/** Everything the Personal panel shows, over a team or your friends instead of one
 *  person: the four figures, the diverging period bars, the trend, the day table,
 *  the calendar and the weekday profile.
 *
 *  ── IT COSTS ONE REQUEST, THE ONE THAT WAS ALREADY BEING MADE ───────────────
 *  get_team_days / get_friends_days already return BOTH halves — the group's mean
 *  live/7d/30d figures and its 30 completed days. The charts that were missing here
 *  needed no new endpoint, only a second reading of that payload: the tiles are the
 *  summary, and the calendar, weekday profile and table are the same `rows` array
 *  the trend line is drawn from. Still one call, still once per open.
 *
 *  ── EVERY TITLE SAYS "AVERAGE" ──────────────────────────────────────────────
 *  A team's chart is pixel-identical to your own, and a mean of five people read as
 *  one person's day would be badly wrong — five members averaging 30 is not the same
 *  claim as one member scoring 150. So the word is in the panel label, in every tile,
 *  in both chart titles, and in the note under the charts. */
const GroupAverages = ({ kind, team, nonce, label }: {
  kind: 'team' | 'friends';
  team?: string;
  nonce: number;
  label: string;
}) => {
  const { data, loading, rows, todayKey } = useGroupHistory(
    kind === 'team'
      ? { type: 'SERVER_TEAM_DAYS', team: team ?? '' }
      : { type: 'SERVER_FRIENDS_DAYS' },
    `${kind}-days:${team ?? ''}:${nonce}`,
  );

  if (loading && !data) return <Panel><GroupHistoryLoading /></Panel>;
  if (!data) return <Panel title={`${label} — history`}><GroupHistoryUnavailable /></Panel>;

  const noun = kind === 'team' ? 'member' : 'friend';
  const per = `across ${data.member_count} ${noun}${data.member_count === 1 ? '' : 's'}`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Avg focus today" value={Number(data.summary.live_focus) || 0}
                  color={FOCUS_COLOR} hint={per} />
        <StatTile label="Avg distracted today" value={Number(data.summary.live_distracted) || 0}
                  color={DISTRACTED_COLOR} hint={per} />
        <DualStatTile label="Avg 7-day"
                      focus={Number(data.summary.avg7_focus) || 0}
                      distracted={Number(data.summary.avg7_distracted) || 0}
                      hint={`complete days, ${per}`} />
        <DualStatTile label="Avg 30-day"
                      focus={Number(data.summary.avg30_focus) || 0}
                      distracted={Number(data.summary.avg30_distracted) || 0}
                      hint={`complete days, ${per}`} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title={`${label} — daily history`}>
          <div className="space-y-1">
            <ScoreChart rows={rows} todayKey={todayKey} summary={data.summary} />
            <ScoreTrend rows={rows} />
            <ScoreLegend />
            <GroupAverageNote count={data.member_count} noun={noun} />
            <DayList rows={rows} />
          </div>
        </Panel>

        <div className="space-y-4">
          <CalendarHeatmap rows={rows} title={`${label} — focus calendar`} />
          <WeekdayProfile rows={rows} title={`${label} — by weekday`} />
        </div>
      </div>
    </div>
  );
};

// ── A group: one team, or your friends ────────────────────────────────────────
// One panel for both, because they are the same shape of thing — a ranked list of
// people plus a history averaged over them. The popup has two components for this
// only because their headers and their actions differ.

const GroupPanel = ({ kind, team, busy, error, onEnroll, onLeave, onChanged }: {
  kind: 'team' | 'friends';
  team?: string;
  busy: boolean;
  error: string;
  onEnroll?: (competition: string, create: boolean, password: string) => void;
  onLeave?: () => void;
  onChanged?: () => void;
}) => {
  const [metric, setMetric] = useState<Metric>('live');
  const [selected, setSelected] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [nonce, setNonce] = useState(0);

  const message: MessageType = kind === 'team'
    ? { type: 'SERVER_TEAM_BOARD', team: team ?? '', metric }
    : { type: 'SERVER_FRIENDS_BOARD', metric };
  const { board, loading } = useBoard<TeamBoard | FriendsBoard>(
    message, `${kind}:${team ?? ''}:${metric}:${nonce}`);

  if (selected) return <MemberProfileView userId={selected} onBack={() => setSelected(null)} />;

  const members = board?.members ?? [];
  const requests = (board as FriendsBoard | null)?.requests ?? [];

  const respond = (requester: string, accept: boolean) => {
    chrome.runtime.sendMessage({ type: 'SERVER_FRIEND_RESPOND', requester, accept }, () => {
      void chrome.runtime.lastError;
      setNonce((n) => n + 1);
      onChanged?.();
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <MetricTabs value={metric} onChange={setMetric} />
        {kind === 'team' ? (
          <div className="flex flex-shrink-0 gap-2">
            <button
              onClick={() => setAddOpen((v) => !v)}
              className={`cursor-pointer rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
                addOpen ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <Plus size={11} className="mr-1 inline" />Competition
            </button>
            <button
              onClick={onLeave}
              disabled={busy}
              className="cursor-pointer rounded-lg border border-slate-200 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-40"
            >
              Leave {team}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAddOpen((v) => !v)}
            className={`flex-shrink-0 cursor-pointer rounded-lg px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${
              addOpen ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Plus size={11} className="mr-1 inline" />Friend
          </button>
        )}
      </div>

      {addOpen && kind === 'team' && onEnroll && (
        <Panel>
          <NameForm
            placeholder="competition name"
            hint="Creating makes a TEAM competition — teams enter, individuals are refused."
            withPassword
            passwordPlaceholder="competition password (min 4)"
            busy={busy}
            error={error}
            onSubmit={onEnroll}
          />
        </Panel>
      )}
      {addOpen && kind === 'friends' && (
        <Panel><FriendSearch onAdded={() => { setNonce((n) => n + 1); onChanged?.(); }} /></Panel>
      )}

      {loading && !board ? <BoardLoading /> : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Panel title={kind === 'team' ? `${team} standings` : 'Friends standings'}>
            <BarLegend />
            <BarBoard
              rows={members.map((x) => memberRow(x, metric, false))}
              empty={board
                ? (kind === 'team' ? 'No members yet.' : 'No friends yet — add someone above.')
                : "Couldn't load this board."}
              onSelect={setSelected}
            />
            <BoardFooter board={board} noun={kind === 'team' ? 'member' : 'friend'} />
          </Panel>

          {/* No extra request: the same board rows the list above is drawn from. */}
          <CompositionDonut
            title="Share of focus"
            rows={members.map((m) => ({ label: m.display_name, value: focusFor(m, metric) }))}
          />
        </div>
      )}

      {requests.length > 0 && (
        <Panel title="Friend requests">
          <div className="divide-y divide-slate-100">
            {requests.map((r) => (
              <div key={r.user_id} className="flex items-center gap-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-700">{r.display_name}</span>
                <button
                  onClick={() => respond(r.user_id, true)}
                  className="cursor-pointer rounded-lg bg-green-500 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white hover:bg-green-600"
                >
                  Accept
                </button>
                <button
                  onClick={() => respond(r.user_id, false)}
                  title="Decline — they can ask again later"
                  className="cursor-pointer rounded-lg bg-slate-100 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-500 hover:bg-slate-200"
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <GroupAverages
        kind={kind}
        team={team}
        nonce={nonce}
        label={kind === 'team' ? `${team} average` : 'Friends average'}
      />
    </div>
  );
};

// ── Root ──────────────────────────────────────────────────────────────────────

const Dashboard = () => {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [section, setSection] = useState('personal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [joinOpen, setJoinOpen] = useState<'team' | 'competition' | null>(null);
  const memberships = useMemberships();
  const flagAvailable = useWeeklyFlag();

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'SERVER_STATUS' }, (res?: ServerStatus) => {
      void chrome.runtime.lastError;
      if (res) setStatus(res);
    });

    const empty: SessionState = {
      isHeartbeatActive: false, lastHeartbeat: 0, activeWindowId: null, enabled: true,
      currentIconId: 0, heartbeatCount: 0, iconChangeAt: 0, focusScore: 0, distractedScore: 0,
      scoreDate: localDateKey(), penaltyAt: 0, penaltyAmount: 0,
      nextPenaltyAt: 0, nextPenaltyAmount: 0, osHeld: false,
    };
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res?: SessionState) => {
      setState(chrome.runtime.lastError ? empty : (res ?? empty));
    });

    chrome.storage.local.get(['focusFlowSettings'], (r) => {
      if (r.focusFlowSettings) setSettings({ ...DEFAULT_SETTINGS, ...(r.focusFlowSettings as Settings) });
    });

    // Live updates, exactly as the popup receives them — the background broadcasts
    // to every extension surface, so an open dashboard tracks the sprite in real time.
    const listener = (msg: { type?: string; state?: SessionState }) => {
      if (msg.type === 'STATE_UPDATE' && msg.state) setState(msg.state);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const saveSettings = (s: Settings) => {
    setSettings(s);
    chrome.storage.local.set({ focusFlowSettings: s });
  };

  const act = (msg: MessageType, onDone?: () => void) => {
    setBusy(true);
    setError('');
    chrome.runtime.sendMessage(msg, (res?: ServerActionResult) => {
      void chrome.runtime.lastError;
      setBusy(false);
      if (!res?.ok) { setError(res?.error ?? 'Could not reach the server.'); return; }
      onDone?.();
    });
  };

  // Same scope keys as the popup, so the two surfaces can't disagree about what
  // "comp:uni_cup:math_students" means.
  const teamSection = memberships.teams.find((t) => `team:${t}` === section);
  const compMatch = section.startsWith('comp:') ? section.slice(5).split(':') : null;
  const compName = compMatch?.[0] ?? '';
  const compTeam = compMatch?.[1];
  const compSection =
    (compTeam
      ? memberships.teamCompetitions.some((tc) => tc.competition === compName && tc.team === compTeam)
      : memberships.competitions.includes(compName))
      ? compName : undefined;
  const active = section === 'friends' || teamSection || compSection ? section : 'personal';

  if (!status) {
    return (
      <div className="flex h-screen items-center justify-center gap-2 text-sm text-slate-400">
        <Loader2 size={16} className="animate-spin" /> Loading…
      </div>
    );
  }

  if (status.configured && !status.signedIn) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 text-sm text-slate-500">
        <Activity size={28} className="text-slate-300" />
        <p>Sign in from the Focus popup to open the dashboard.</p>
      </div>
    );
  }

  const navItem = (key: string, label: string, icon: React.ReactNode, sub?: string, badge = 0) => (
    <button
      key={key}
      onClick={() => { setSection(key); setError(''); setJoinOpen(null); }}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
        active === key ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      <span className={active === key ? 'text-blue-500' : 'text-slate-400'}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-bold leading-tight">{label}</span>
        {sub && <span className="block truncate text-[9px] leading-tight text-slate-400">{sub}</span>}
      </span>
      {badge > 0 && (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
          {badge}
        </span>
      )}
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1280px] items-center gap-3 px-6 py-3">
          <h1 className="flex items-center gap-2 text-base font-bold">
            <Activity className="text-green-500" size={20} />
            Focus
            <span className="text-slate-300">/</span>
            <span className="font-medium text-slate-500">Dashboard</span>
          </h1>
          <div className="flex-1" />
          <FlagBadge available={flagAvailable} />
          {status.signedIn && (
            <>
              <span className="max-w-[220px] truncate text-[11px] text-slate-400" title={status.email}>
                {status.email}
              </span>
              <button
                onClick={() => chrome.runtime.sendMessage({ type: 'SERVER_SIGN_OUT' }, () => {
                  void chrome.runtime.lastError;
                  window.close();
                })}
                title="Sign out — stops syncing to the study server"
                aria-label="Sign out"
                className="cursor-pointer rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-500"
              >
                <LogOut size={14} />
              </button>
            </>
          )}
        </div>
      </header>

      <div className="mx-auto flex max-w-[1280px] gap-6 px-6 py-6">
        {/* Sidebar. The popup's pills, given a column — which is the whole reason a
            wrapping pill row was tolerable there and unnecessary here. */}
        <nav className="w-[210px] flex-shrink-0 space-y-1">
          <p className="px-2.5 pb-1 text-[9px] font-bold uppercase tracking-widest text-slate-400">You</p>
          {navItem('personal', 'Personal', <User size={14} />, 'your scores and pages')}
          {navItem('friends', 'Friends', <UserPlus size={14} />, 'people who accepted you',
                   memberships.friendRequests)}

          {memberships.teams.length > 0 && (
            <p className="px-2.5 pb-1 pt-3 text-[9px] font-bold uppercase tracking-widest text-slate-400">Teams</p>
          )}
          {memberships.teams.map((t) => navItem(`team:${t}`, t, <Users size={14} />))}

          {(memberships.competitions.length > 0 || memberships.teamCompetitions.length > 0) && (
            <p className="px-2.5 pb-1 pt-3 text-[9px] font-bold uppercase tracking-widest text-slate-400">
              Competitions
            </p>
          )}
          {memberships.competitions.map((c) =>
            navItem(`comp:${c}`, c, <Trophy size={14} />, 'you, individually'))}
          {memberships.teamCompetitions.map((tc) =>
            navItem(`comp:${tc.competition}:${tc.team}`, tc.competition, <Trophy size={14} />,
                    `with ${tc.team}`))}

          <div className="space-y-1 pt-4">
            <button
              onClick={() => { setJoinOpen((v) => (v === 'team' ? null : 'team')); setError(''); }}
              className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg bg-white px-2 py-1.5 text-[10px] font-bold text-blue-600 ring-1 ring-slate-200 hover:bg-blue-50"
            >
              <Plus size={11} /> Team
            </button>
            <button
              onClick={() => { setJoinOpen((v) => (v === 'competition' ? null : 'competition')); setError(''); }}
              className="flex w-full cursor-pointer items-center justify-center gap-1 rounded-lg bg-white px-2 py-1.5 text-[10px] font-bold text-amber-700 ring-1 ring-slate-200 hover:bg-amber-50"
            >
              <Plus size={11} /> Competition
            </button>
          </div>
        </nav>

        <main className="min-w-0 flex-1 space-y-4">
          {joinOpen === 'team' && (
            <Panel title="Join or create a team">
              <NameForm
                placeholder="team name"
                hint="Share the name and password with your team — both are needed to join."
                withPassword
                busy={busy}
                error={error}
                onSubmit={(name, create, password) =>
                  act({ type: 'SERVER_JOIN_TEAM', team: name, create, password }, () => {
                    setJoinOpen(null);
                    setSection(`team:${name}`);
                  })
                }
              />
            </Panel>
          )}
          {joinOpen === 'competition' && (
            <Panel title="Join or create a competition">
              <NameForm
                placeholder="competition name"
                hint="Creating makes an INDIVIDUAL competition — people enter themselves, teams are refused."
                withPassword
                passwordPlaceholder="competition password (min 4)"
                busy={busy}
                error={error}
                onSubmit={(name, create, password) =>
                  act({ type: 'SERVER_JOIN_COMPETITION', competition: name, create, password }, () => {
                    setJoinOpen(null);
                    setSection(`comp:${name}`);
                  })
                }
              />
            </Panel>
          )}

          {!state ? (
            <BoardLoading />
          ) : active === 'friends' ? (
            <GroupPanel kind="friends" busy={busy} error={error} />
          ) : teamSection && active !== 'personal' ? (
            <GroupPanel
              kind="team"
              team={teamSection}
              busy={busy}
              error={error}
              onEnroll={(competition, create, password) =>
                act({ type: 'SERVER_ENROLL_TEAM', team: teamSection, competition, create, password },
                    () => setSection(`comp:${competition}:${teamSection}`))
              }
              onLeave={() =>
                act({ type: 'SERVER_LEAVE_TEAM', team: teamSection }, () => setSection('personal'))
              }
            />
          ) : compSection && active !== 'personal' ? (
            <CompetitionSection
              competition={compSection}
              viaTeam={compTeam}
              busy={busy}
              onLeaveTeam={(t) =>
                act({ type: 'SERVER_LEAVE_COMPETITION', team: t, competition: compSection },
                    () => setSection('personal'))
              }
              onLeaveSolo={() =>
                act({ type: 'SERVER_LEAVE_COMPETITION_SOLO', competition: compSection },
                    () => setSection('personal'))
              }
            />
          ) : (
            <PersonalPanel state={state} settings={settings} onSettingsChange={saveSettings} />
          )}

          {error && <p className="text-[11px] font-medium text-red-500">{error}</p>}
        </main>
      </div>

      <footer className="mx-auto max-w-[1280px] px-6 pb-8 text-[10px] text-slate-400">
        <span className="inline-flex items-center gap-1">
          <ExternalLink size={10} />
          Scores, whitelist and history live on the study server; this page reads the same
          cached copies the popup does.
        </span>
      </footer>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<Dashboard />);
