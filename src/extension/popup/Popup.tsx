import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionState, Settings, ServerStatus, ServerActionResult, MessageType, localDateKey, DEFAULT_SETTINGS, clampIconChangeHeartbeats, ICON_CHANGE_MIN, ICON_CHANGE_MAX, clampCryBeepVolume, CRY_BEEP_MIN, CRY_BEEP_MAX, clampCryBeepDuration, CRY_BEEP_DURATION_MIN, CRY_BEEP_DURATION_MAX, clampIdleTime, IDLE_TIME_MIN, IDLE_TIME_MAX, CRY_BEEP_STYLES, clampCryBeepStyle } from '../../types';
import { FileText, Activity, Maximize2, Settings2, Plus, Zap, ZapOff, Volume2, VolumeX, Info, LogOut, Users, Trophy, UserPlus } from 'lucide-react';
import '../../index.css';
// The sections themselves — shared verbatim with the dashboard page, which composes
// the same components into a wide layout. See src/extension/ui/shared.tsx.
import { CompetitionSection, FlagBadge, FriendsSection, NameForm, PersonalSection, TeamSection, useMemberships, useWeeklyFlag } from '../ui/shared';

// ── Main tab ──────────────────────────────────────────────────────────────────
const MainTab = ({ state, settings, currentTabDomain, currentTabUrl, onWhitelistToggle, onSettingsChange }: {
  state: SessionState;
  settings: Settings;
  currentTabDomain: string;
  currentTabUrl: string;
  onWhitelistToggle: () => void;
  onSettingsChange: (s: Settings) => void;
}) => {
  const memberships = useMemberships();
  const flagAvailable = useWeeklyFlag();
  // Sections are one-at-a-time rather than stacked. Personal alone is roughly a
  // popup's height, and every team and competition adds several boards behind it;
  // stacked, a user in one competition would scroll past everything to reach
  // anything. The pills keep all of them one tap away.
  const [section, setSection] = useState('personal');
  const [joinOpen, setJoinOpen] = useState(false);
  const [joinCompOpen, setJoinCompOpen] = useState(false);
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

  const teamSection = memberships.teams.find((t) => `team:${t}` === section);
  // A competition pill is `comp:<name>` for your own entry and `comp:<name>:<team>`
  // for a team's. Both open the same board; the suffix says which entry you arrived
  // through, which decides what you can withdraw from here.
  const compMatch = section.startsWith('comp:') ? section.slice(5).split(':') : null;
  const compName = compMatch?.[0] ?? '';
  const compTeam = compMatch?.[1];
  const compSection =
    (compTeam
      ? memberships.teamCompetitions.some((tc) => tc.competition === compName && tc.team === compTeam)
      : memberships.competitions.includes(compName))
      ? compName : undefined;
  // Leaving the team you were looking at removes its pill; fall back rather than
  // rendering a section that no longer exists.
  const active = section === 'friends' || teamSection || compSection ? section : 'personal';

  const pill = (key: string, label: string, icon?: React.ReactNode, badge = 0) => (
    <button
      key={key}
      onClick={() => { setSection(key); setError(''); }}
      className={`flex max-w-[120px] flex-shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-colors ${
        active === key ? 'bg-slate-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
      {/* Someone is waiting on you. On the pill rather than inside the section,
          because the whole point is to be seen without opening it. */}
      {badge > 0 && (
        <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-1 text-[8px] font-bold text-white">
          {badge}
        </span>
      )}
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
          {pill('friends', 'Friends', <UserPlus size={10} />, memberships.friendRequests)}
          {memberships.teams.map((t) => pill(`team:${t}`, t, <Users size={10} />))}
          {/* Two entries into one competition are two pills, because they are two
              things you are doing: your own score against other individuals, and
              your team's total against other teams. */}
          {memberships.competitions.map((c) => pill(`comp:${c}`, c, <Trophy size={10} />))}
          {memberships.teamCompetitions.map((tc) =>
            pill(`comp:${tc.competition}:${tc.team}`, `${tc.competition} · ${tc.team}`,
                 <Trophy size={10} />))}
          <button
            onClick={() => { setJoinOpen((v) => !v); setJoinCompOpen(false); setError(''); }}
            title="Create a team, or join one that exists"
            className={`flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-colors ${
              joinOpen ? 'bg-blue-500 text-white' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
            }`}
          >
            <Plus size={11} /> Team
          </button>
          <button
            onClick={() => { setJoinCompOpen((v) => !v); setJoinOpen(false); setError(''); }}
            title="Enter a competition as yourself — separate from any team entry"
            className={`flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold transition-colors ${
              joinCompOpen ? 'bg-amber-500 text-white' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
            }`}
          >
            <Plus size={11} /> Competition
          </button>
        </div>
        <FlagBadge available={flagAvailable} />
      </div>
      {joinCompOpen && (
        <NameForm
          placeholder="competition name"
          hint="Creating makes an INDIVIDUAL competition — people enter themselves, teams are refused."
          withPassword
          passwordPlaceholder="competition password (min 4)"
          busy={busy}
          error={error}
          onSubmit={(name, create, password) =>
            act({ type: 'SERVER_JOIN_COMPETITION', competition: name, create, password }, () => {
              setJoinCompOpen(false);
              setSection(`comp:${name}`);
            })
          }
        />
      )}
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

    {active === 'friends' ? (
      <FriendsSection />
    ) : teamSection && active !== 'personal' ? (
      <TeamSection
        team={teamSection}
        busy={busy}
        error={error}
        onEnroll={(competition, create, password) =>
          act({ type: 'SERVER_ENROLL_TEAM', team: teamSection, competition, create, password },
              () => setSection(`comp:${competition}`))
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
        onLeaveTeam={(team) =>
          act({ type: 'SERVER_LEAVE_COMPETITION', team, competition: compSection },
              () => setSection('personal'))
        }
        onLeaveSolo={() =>
          act({ type: 'SERVER_LEAVE_COMPETITION_SOLO', competition: compSection },
              () => setSection('personal'))
        }
      />
    ) : (
      <PersonalSection
        state={state}
        settings={settings}
        currentTabDomain={currentTabDomain}
        isWhitelisted={isWhitelisted}
        onWhitelistToggle={onWhitelistToggle}
        onSettingsChange={onSettingsChange}
      />
    )}
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
  const [companionInfoOpen, setCompanionInfoOpen] = useState(false);

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

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
                <strong>Linux / GNOME</strong> — <strong>automatic</strong>, if you installed the
                companion bridge (<code className="rounded bg-slate-200 px-1">desktop/gnome-extension/install.sh</code>).
                It runs inside the compositor, which is the only thing that can raise a window
                on Wayland, and it pins this one for you.
              </li>
              <li>
                <strong>Windows</strong> — <strong>automatic</strong> while the desktop agent is
                running; it pins the window for you. Without the agent, install <a href="https://learn.microsoft.com/windows/powertoys/" target="_blank" rel="noreferrer" className="text-blue-600 underline">PowerToys</a>,
                focus the window and press <code className="rounded bg-slate-200 px-1">Win+Ctrl+T</code>.
              </li>
              <li>
                <strong>macOS</strong> — manual: no app may raise another app's window, so use a
                helper such as <a href="https://rectangleapp.com/" target="_blank" rel="noreferrer" className="text-blue-600 underline">Rectangle</a> (enable
                <em> Always on Top</em>) or Amethyst, and grant it Accessibility.
              </li>
              <li>
                <strong>Linux / GNOME, without the bridge</strong> — run once:<br />
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
    // The canvas scales with the window, so it survives being shrunk further. The
    // height covers the two whitelist bars under the canvas without squeezing it;
    // they collapse when they have nothing to say, and the window is resizable.
    { url, type: 'popup', width: 300, height: 260 },
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
          {/* The same data with room to breathe. A tab rather than a wider popup:
              a popup is capped at 800×600 and cannot be resized by the user, and
              the competition views are the ones that need more than that. */}
          <button
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}
            title="Open the full dashboard in a tab"
            aria-label="Open dashboard"
            className="flex flex-shrink-0 cursor-pointer items-center justify-center rounded-full bg-slate-100 p-1.5 text-slate-500 transition-colors hover:bg-slate-200"
          >
            <Maximize2 size={13} />
          </button>
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
            onSettingsChange={saveSettings}
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

