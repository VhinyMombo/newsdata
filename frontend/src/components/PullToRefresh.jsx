import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { isStandalone } from '../hooks/useInstall';
import { isBusy } from '../utils/lock';

// Opened from the home screen, Le Kiosque has no browser around it, so no
// pull-to-refresh: pulling the page down from the top did nothing but show a blank
// band. Here the pull shows a turning arrow, and past THRESHOLD the page reloads
// (new articles, and a new version of the app if one was deployed).
const THRESHOLD = 70;
const MAX = 110;

export default function PullToRefresh({ disabled }) {
  const [pull, setPull] = useState(0);
  const [loading, setLoading] = useState(false);
  const startY = useRef(null);
  const pulled = useRef(0);

  useEffect(() => {
    if (disabled || !isStandalone()) return;
    const set = (v) => { pulled.current = v; setPull(v); };

    const onStart = (e) => {
      // Only from the very top, one finger, and never while an answer is being written
      startY.current = window.scrollY <= 0 && e.touches.length === 1 && !isBusy() ? e.touches[0].clientY : null;
    };
    const onMove = (e) => {
      if (startY.current === null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0 || window.scrollY > 0) { set(0); return; }
      e.preventDefault(); // instead of the elastic bounce that showed the blank band
      set(Math.min(MAX, dy * 0.5));
    };
    const onEnd = () => {
      if (startY.current === null) return;
      startY.current = null;
      if (pulled.current >= THRESHOLD) {
        set(THRESHOLD);
        setLoading(true);
        window.setTimeout(() => window.location.reload(), 300);
      } else {
        set(0);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [disabled]);

  if (!pull && !loading) return null;
  const ready = pull >= THRESHOLD;
  return (
    <div
      className={`k-ptr${ready ? ' is-ready' : ''}${loading ? ' is-loading' : ''}`}
      style={{ '--pull': `${pull}px`, '--turn': `${(pull / THRESHOLD) * 270}deg`, opacity: Math.min(1, pull / 40) }}
      role="status"
      aria-label={loading ? 'Actualisation…' : ready ? 'Relâchez pour actualiser' : 'Tirez pour actualiser'}
    >
      <RefreshCw size={20} aria-hidden="true" />
    </div>
  );
}
