import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionState, Settings, DEFAULT_SETTINGS, clampIconChangeHeartbeats, ICON_CHANGE_MIN, ICON_CHANGE_MAX, clampCryBeepVolume, CRY_BEEP_MIN, CRY_BEEP_MAX, clampCryBeepDuration, CRY_BEEP_DURATION_MIN, CRY_BEEP_DURATION_MAX, clampIdleTime, IDLE_TIME_MIN, IDLE_TIME_MAX, CRY_BEEP_STYLES, clampCryBeepStyle } from '../../types';
import { FileText, Activity, Settings2, Plus, X, Zap, ZapOff, Check } from 'lucide-react';
import '../../index.css';


// ── Main tab ──────────────────────────────────────────────────────────────────
const MainTab = ({ state, settings, currentTabDomain, currentTabUrl, onWhitelistToggle, onChange }: {
  state: SessionState;
  settings: Settings;
  currentTabDomain: string;
  currentTabUrl: string;
  onWhitelistToggle: () => void;
  onChange: (s: Settings) => void;
}) => {
  const isWhitelisted = currentTabUrl.length > 0 &&
    settings.allowedDomains.some(d => d.trim() !== '' && currentTabUrl.includes(d.trim()));

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

    {/* Feature toggles */}
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-600">Sound on</span>
        <div
          onClick={() => onChange({ ...settings, soundEnabled: !settings.soundEnabled })}
          className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${settings.soundEnabled ? 'bg-blue-500' : 'bg-slate-300'}`}
        >
          <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${settings.soundEnabled ? 'translate-x-5' : ''}`} />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-600">AI request</span>
        <div
          onClick={() => onChange({ ...settings, aiRequestEnabled: !settings.aiRequestEnabled })}
          className={`relative flex-shrink-0 w-10 h-5 rounded-full transition-colors cursor-pointer ${settings.aiRequestEnabled ? 'bg-blue-500' : 'bg-slate-300'}`}
        >
          <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${settings.aiRequestEnabled ? 'translate-x-5' : ''}`} />
        </div>
      </div>
    </div>

  </div>
  );
};

// ── Settings tab ──────────────────────────────────────────────────────────────
const SettingsTab = ({ settings, onChange }: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) => {
  const [newDomain, setNewDomain] = useState('');

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  const addDomain = () => {
    const d = newDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!d || settings.allowedDomains.includes(d)) return;
    set({ allowedDomains: [...settings.allowedDomains, d] });
    setNewDomain('');
  };

  const removeDomain = (d: string) =>
    set({ allowedDomains: settings.allowedDomains.filter(x => x !== d) });

  return (
    <div className="space-y-5 text-sm">

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
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Allowed Pages</h3>

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
          currentIconId: 0, heartbeatCount: 0, iconChangeAt: 0,
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
          <button
            onClick={() => saveSettings({ ...settings, forceActive: !settings.forceActive })}
            className={`flex items-center gap-1.5 flex-shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors cursor-pointer ${
              settings.forceActive
                ? 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                : 'bg-green-500 text-white hover:bg-green-600'
            }`}
            title={settings.forceActive
              ? 'Not working — sprite kept active on every page'
              : 'Working — only active on authorized pages with real activity'}
          >
            {settings.forceActive ? <ZapOff size={13} /> : <Zap size={13} />}
            {settings.forceActive ? 'Not working' : 'Working'}
          </button>
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
            onChange={saveSettings}
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
