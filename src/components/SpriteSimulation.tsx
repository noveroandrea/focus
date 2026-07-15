import React, { useState, useEffect, useRef } from 'react';

// Standalone demo of the Focus sprite for local development (npm run dev).
// It mirrors the extension behaviour without Chrome APIs: the character bounces
// while you're active, cries when idle, shrinks from full size toward a minimum
// as focus heartbeats accumulate, then bursts into fireworks and a new character
// takes over at full size. The heartbeat count is small here so it's easy to see.

const CHARACTERS = [
  { id: 0, name: 'Mario', icon: '🍄', color: '#ef4444' },
  { id: 1, name: 'Luigi', icon: '🥬', color: '#22c55e' },
  { id: 2, name: 'Peach', icon: '👑', color: '#ec4899' },
  { id: 3, name: 'Toad', icon: '🍄', color: '#f87171' },
  { id: 4, name: 'Yoshi', icon: '🥚', color: '#4ade80' },
  { id: 5, name: 'Bowser', icon: '🐢', color: '#f97316' },
  { id: 6, name: 'Link', icon: '🛡️', color: '#16a34a' },
  { id: 7, name: 'Zelda', icon: '💎', color: '#eab308' },
  { id: 8, name: 'Kirby', icon: '🎈', color: '#f472b6' },
  { id: 9, name: 'Pikachu', icon: '⚡', color: '#facc15' },
  { id: 10, name: 'DK', icon: '🍌', color: '#92400e' },
  { id: 11, name: 'Samus', icon: '🚀', color: '#ea580c' },
  { id: 12, name: 'Fox', icon: '🦊', color: '#d97706' },
  { id: 13, name: 'Ness', icon: '🧢', color: '#2563eb' },
  { id: 14, name: 'Falcon', icon: '🏎️', color: '#1d4ed8' },
];

const CRYING_ICONS = ['😭', '😢', '💧'];
const SIZE = 60;
const DEMO_HEARTBEATS = 10; // small so the change is visible in the demo
const START_SCALE = 2;
const MIN_SCALE = 0.5;
const FIREWORK_COLORS = ['#fde047', '#f97316', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#a855f7'];

export const SpriteSimulation = () => {
  const [iconId, setIconId] = useState(0);
  const [isActive, setIsActive] = useState(false);
  const [heartbeats, setHeartbeats] = useState(0);
  const [cryingFrame, setCryingFrame] = useState(0);
  const [pos, setPos] = useState({ x: 120, y: 120 });
  const [burst, setBurst] = useState<{ id: number; dx: number; dy: number; color: string }[]>([]);

  const velRef = useRef({ x: 1.6, y: 1.2 });
  const lastActivity = useRef(Date.now());
  const lastTick = useRef(Date.now());
  const lastBeat = useRef(Date.now());

  // Activity detection
  useEffect(() => {
    const onActivity = () => { lastActivity.current = Date.now(); setIsActive(true); };
    window.addEventListener('mousemove', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => {
      window.removeEventListener('mousemove', onActivity);
      window.removeEventListener('keydown', onActivity);
    };
  }, []);

  // Crying frames while idle
  useEffect(() => {
    if (isActive) return;
    const id = setInterval(() => setCryingFrame(p => (p + 1) % CRYING_ICONS.length), 500);
    return () => clearInterval(id);
  }, [isActive]);

  // Fireworks burst on icon change
  const fireFireworks = () => {
    const dots = Array.from({ length: 14 }, (_, i) => {
      const angle = (Math.PI * 2 * i) / 14 + Math.random() * 0.35;
      const dist = 38 + Math.random() * 40;
      return {
        id: Date.now() + i,
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist,
        color: FIREWORK_COLORS[i % FIREWORK_COLORS.length],
      };
    });
    setBurst(dots);
    setTimeout(() => setBurst([]), 900);
  };

  // Main loop: idle detection, heartbeat counting, icon change, movement
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      lastTick.current = now;

      const stillActive = now - lastActivity.current < 2000;
      setIsActive(stillActive);

      if (stillActive) {
        // One heartbeat per active second; at the threshold the sprite has hit
        // its minimum size, so the character changes and restarts at full size.
        if (now - lastBeat.current >= 1000) {
          lastBeat.current = now;
          setHeartbeats(prev => {
            const next = prev + 1;
            if (next >= DEMO_HEARTBEATS) {
              setIconId(p => (p + 1) % CHARACTERS.length);
              fireFireworks();
              return 0;
            }
            return next;
          });
        }

        setPos(prev => {
          let { x, y } = prev;
          const v = velRef.current;
          x += v.x; y += v.y;
          const maxX = window.innerWidth - SIZE;
          const maxY = window.innerHeight - SIZE;
          if (x <= 0 || x >= maxX) v.x = -v.x;
          if (y <= 0 || y >= maxY) v.y = -v.y;
          return { x: Math.max(0, Math.min(x, maxX)), y: Math.max(0, Math.min(y, maxY)) };
        });
      }
    }, 60);
    return () => clearInterval(id);
  }, []);

  const char = CHARACTERS[iconId];
  const progress = Math.min(1, heartbeats / DEMO_HEARTBEATS);
  const scale = isActive ? START_SCALE + (MIN_SCALE - START_SCALE) * progress : 1;

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden bg-slate-50/50">
      {/* Hint */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 text-[11px] text-slate-400 text-center">
        Move the mouse or type to stay active. The character shrinks, then changes every {DEMO_HEARTBEATS} heartbeats.
      </div>

      <div
        className="absolute rounded-full flex items-center justify-center shadow-xl border-4 border-white"
        style={{
          left: pos.x,
          top: pos.y,
          width: SIZE,
          height: SIZE,
          backgroundColor: isActive ? char.color : '#94a3b8',
          transform: `scale(${scale})`,
          transition: 'background-color 0.35s ease, transform 0.9s linear',
        }}
      >
        <span className="text-2xl select-none">
          {isActive ? char.icon : CRYING_ICONS[cryingFrame]}
        </span>

        {/* Fireworks */}
        {burst.map(d => (
          <span
            key={d.id}
            className="absolute rounded-full"
            style={{
              left: '50%',
              top: '50%',
              width: 7,
              height: 7,
              background: d.color,
              boxShadow: `0 0 6px ${d.color}`,
              animation: 'ff-demo-burst 0.8s cubic-bezier(0.15,0.6,0.4,1) forwards',
              // CSS var consumed by the keyframes below
              ['--dx' as string]: `${d.dx}px`,
              ['--dy' as string]: `${d.dy}px`,
            }}
          />
        ))}
      </div>

      <style>{`
        @keyframes ff-demo-burst {
          from { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          to   { transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(0.3); opacity: 0; }
        }
      `}</style>
    </div>
  );
};
