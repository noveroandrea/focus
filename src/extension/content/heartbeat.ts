(function () {
  // Kill any previous instance (extension reload with page open)
  const prev = (window as any).__ffHeartbeatCleanup as (() => void) | undefined;
  if (prev) prev();

  // Fallback list used only if settings haven't been written to storage yet (first run)
  const FALLBACK_DOMAINS = [
    /overleaf/, /arxiv\.org/, /nature\.com/, /ieee/,
    /claude\.ai/, /mail\.google\.com/, /outlook\.live\.com/,
    /outlook\.office\.com/, /scholar\.google/, /wikipedia\.org/, /unipd\.it/,
  ];

  function isContextValid(): boolean {
    try { return !!(chrome.runtime?.id); } catch { return false; }
  }

  let stopped = false;
  let lastSent = 0;
  let focusPingInterval: ReturnType<typeof setInterval> | null = null;

  function stop() {
    stopped = true;
    if (focusPingInterval !== null) { clearInterval(focusPingInterval); focusPingInterval = null; }
    window.removeEventListener('mousemove', throttledHeartbeat);
    window.removeEventListener('scroll',    throttledHeartbeat);
    window.removeEventListener('wheel',     throttledHeartbeat);
    window.removeEventListener('keydown',   throttledHeartbeat);
    window.removeEventListener('mousedown', throttledHeartbeat);
    (window as any).__ffHeartbeatCleanup = undefined;
  }

  (window as any).__ffHeartbeatCleanup = stop;

  function sendHeartbeat() {
    if (stopped || !isContextValid()) { stop(); return; }
    try {
      chrome.runtime.sendMessage({ type: 'HEARTBEAT' }, () => {
        try {
          void chrome.runtime.lastError;
          if (!isContextValid()) stop();
        } catch { stop(); }
      });
    } catch { stop(); }
  }

  function throttledHeartbeat() {
    const now = Date.now();
    if (now - lastSent >= 1000) { lastSent = now; sendHeartbeat(); }
  }

  function startFocusPing() {
    if (focusPingInterval !== null) return;
    focusPingInterval = setInterval(() => {
      if (stopped || !isContextValid()) { stop(); return; }
      if (!document.hasFocus()) return;
      try {
        chrome.runtime.sendMessage({ type: 'FOCUS_PING' }, () => {
          try { void chrome.runtime.lastError; } catch { /* ignore */ }
        });
      } catch { /* ignore */ }
    }, 1000);
  }

  function activate() {
    const indicator = document.createElement('div');
    Object.assign(indicator.style, {
      position: 'fixed', bottom: '10px', right: '10px',
      padding: '4px 10px', background: '#22c55e', color: 'white',
      fontSize: '11px', fontWeight: 'bold', borderRadius: '6px',
      zIndex: '2147483646', pointerEvents: 'none',
      fontFamily: 'system-ui, sans-serif',
    });
    indicator.textContent = 'Focus Active';
    document.body.appendChild(indicator);
    setTimeout(() => indicator.remove(), 3000);

    window.addEventListener('mousemove', throttledHeartbeat);
    window.addEventListener('scroll',    throttledHeartbeat);
    window.addEventListener('wheel',     throttledHeartbeat, { passive: true });
    window.addEventListener('keydown',   throttledHeartbeat);
    window.addEventListener('mousedown', throttledHeartbeat);
  }

  // ── Classification status card ────────────────────────────────────────────────

  function injectSpinnerStyle() {
    if (document.getElementById('__ff_spin_style')) return;
    const s = document.createElement('style');
    s.id = '__ff_spin_style';
    s.textContent = '@keyframes __ff_spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(s);
  }

  function makeCard(fullQuestion: string) {
    injectSpinnerStyle();

    const card = document.createElement('div');
    Object.assign(card.style, {
      position: 'fixed', bottom: '16px', right: '16px',
      width: '280px',
      background: '#1e1b4b', color: '#e0e7ff',
      borderRadius: '12px', padding: '12px 14px',
      fontFamily: 'system-ui, sans-serif', fontSize: '12px', lineHeight: '1.5',
      zIndex: '2147483647', boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
      transition: 'opacity 0.4s',
    });

    // header row
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', gap: '6px',
      marginBottom: '8px', fontWeight: 'bold', fontSize: '11px',
      color: '#a5b4fc', letterSpacing: '0.05em', textTransform: 'uppercase',
    });
    header.textContent = '⚡ Focus AI';
    card.appendChild(header);

    // full question box
    const questionBox = document.createElement('div');
    Object.assign(questionBox.style, {
      background: '#312e81', borderRadius: '7px', padding: '7px 9px',
      fontSize: '10px', color: '#c7d2fe', whiteSpace: 'pre-wrap',
      maxHeight: '110px', overflowY: 'auto', marginBottom: '9px',
      wordBreak: 'break-word', lineHeight: '1.45',
    });
    questionBox.textContent = fullQuestion;
    card.appendChild(questionBox);

    // step 1: asking
    const stepAsking = document.createElement('div');
    Object.assign(stepAsking.style, { display: 'flex', alignItems: 'center', gap: '7px', marginBottom: '4px' });

    const spinner = document.createElement('div');
    Object.assign(spinner.style, {
      width: '11px', height: '11px', flexShrink: '0',
      border: '2px solid #6366f1', borderTopColor: '#e0e7ff',
      borderRadius: '50%',
      animation: '__ff_spin 0.7s linear infinite',
    });
    stepAsking.appendChild(spinner);

    const askingText = document.createElement('span');
    askingText.textContent = 'Asking Ollama…';
    stepAsking.appendChild(askingText);
    card.appendChild(stepAsking);

    // step 2: answer (hidden initially)
    const stepAnswer = document.createElement('div');
    Object.assign(stepAnswer.style, { display: 'none', alignItems: 'center', gap: '7px', marginBottom: '4px' });
    const answerIcon = document.createElement('span');
    const answerText = document.createElement('span');
    answerText.style.fontWeight = 'bold';
    stepAnswer.appendChild(answerIcon);
    stepAnswer.appendChild(answerText);
    card.appendChild(stepAnswer);

    // step 3: whitelist action (hidden initially)
    const stepWhitelist = document.createElement('div');
    Object.assign(stepWhitelist.style, { display: 'none', alignItems: 'center', gap: '7px' });
    const whitelistIcon = document.createElement('span');
    const whitelistText = document.createElement('span');
    stepWhitelist.appendChild(whitelistIcon);
    stepWhitelist.appendChild(whitelistText);
    card.appendChild(stepWhitelist);

    document.body.appendChild(card);

    function dismiss(delayMs: number) {
      setTimeout(() => {
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 450);
      }, delayMs);
    }

    return {
      showAnswer(isStudy: boolean, raw: string, error?: string, offline?: boolean) {
        stepAsking.style.display = 'none';
        stepAnswer.style.display = 'flex';
        if (offline) {
          // Ollama not reachable — graceful degradation: leave the page inactive
          // and tell the user they can still whitelist it by hand.
          answerIcon.textContent = '💤';
          answerText.textContent = 'AI classifier offline — page left inactive. Add it from the popup if you want it tracked.';
          answerText.style.color = '#cbd5e1';
          dismiss(5000);
          return;
        }
        if (error) {
          answerIcon.textContent = '⚠️';
          answerText.textContent = `API error: ${error}`;
          answerText.style.color = '#fcd34d';
          dismiss(6000);
          return;
        }
        answerIcon.textContent = isStudy ? '✅' : '❌';
        answerText.textContent = isStudy
          ? `Ollama says: YES${raw && raw !== 'YES' ? ` (${raw})` : ''}`
          : `Ollama says: NO${raw && raw !== 'NO' ? ` (${raw})` : ''}`;
        answerText.style.color = isStudy ? '#86efac' : '#fca5a5';
        if (!isStudy) dismiss(4000);
      },
      showAdding(domain: string) {
        whitelistIcon.textContent = '⏳';
        whitelistText.textContent = `Adding "${domain}"…`;
        stepWhitelist.style.display = 'flex';
      },
      showAdded(domain: string) {
        whitelistIcon.textContent = '✓';
        whitelistText.textContent = `"${domain}" added! Reloading…`;
        whitelistText.style.color = '#86efac';
        dismiss(1800);
      },
    };
  }

  // ── Main init ─────────────────────────────────────────────────────────────────

  // ── Plugin-rendered documents (PDFs) ────────────────────────────────────────
  // Chrome serves a PDF as a tiny HTML wrapper hosting <embed type="application/
  // pdf">, and our content script DOES run in that wrapper — but every mouse and
  // key event goes to the viewer's own inner frame, which we can't reach. The
  // wrapper can therefore see the page and never see a single input.
  //
  // So staying silent is the honest answer. Pinging would register the tab as an
  // HTML page, which the background uses to decide a tab is NOT a viewer — and
  // that would break its PDF classify flow as well as its idea of what this tab
  // is. There is no input to listen for either. Say nothing and let the OS idle
  // poll cover the tab, which it does exactly as well as it covers anything else.
  function isPluginDocument(): boolean {
    if (document.contentType && document.contentType !== 'text/html') return true;
    return !!document.querySelector('embed[type="application/pdf"]');
  }
  if (isPluginDocument()) return;

  // Always start the focus-ping loop regardless of authorization
  try { startFocusPing(); } catch { /* extension context unavailable */ }

  try {
    chrome.storage.local.get(['focusFlowSettings'], (result) => {
      if (stopped) return;
      const url = window.location.href;
      const stored = result?.focusFlowSettings as {
        allowedDomains?: string[];
        classifyPrompt?: string;
        aiRequestEnabled?: boolean;
      } | undefined;
      const allowedDomains: string[] = stored?.allowedDomains ?? [];
      const classifyPrompt: string = stored?.classifyPrompt ?? '';
      // Default OFF, matching DEFAULT_SETTINGS: the classifier needs an address, a
      // model and a backend that is running, so absent configuration means absent
      // feature. `=== true` rather than `!== false` so a stored object written before
      // the key existed reads as off here exactly as it does everywhere else.
      const aiRequestEnabled: boolean = stored?.aiRequestEnabled === true;

      const authorized =
        url.endsWith('.pdf') ||
        (allowedDomains.length > 0
          ? allowedDomains.some(d => d.trim() !== '' && url.includes(d.trim()))
          : FALLBACK_DOMAINS.some(re => re.test(url)));

      if (authorized) { activate(); return; }

      // Unknown page: only consult the AI classifier if the feature is enabled.
      if (!aiRequestEnabled) return;

      if (!isContextValid()) return;

      const fullQuestion = `${classifyPrompt}\n\nURL: ${url}\nTitle: ${document.title}`;
      const card = makeCard(fullQuestion);

      chrome.runtime.sendMessage(
        { type: 'CLASSIFY_PAGE', url, title: document.title },
        (response: { isStudy?: boolean; raw?: string; error?: string; offline?: boolean }) => {
          try { void chrome.runtime.lastError; } catch { /* ignore */ }
          const isStudy = response?.isStudy === true;
          card.showAnswer(isStudy, response?.raw ?? '', response?.error, response?.offline);

          if (!isStudy || stopped) return;

          const domain = window.location.hostname.replace(/^www\./, '');
          if (!domain) return;

          card.showAdding(domain);
          chrome.runtime.sendMessage({ type: 'ADD_DOMAIN', domain }, () => {
            try { void chrome.runtime.lastError; } catch { /* ignore */ }
            card.showAdded(domain);
            setTimeout(() => { if (!stopped) activate(); }, 500);
          });
        },
      );
    });
  } catch { /* extension context unavailable at inject time */ }
}());
