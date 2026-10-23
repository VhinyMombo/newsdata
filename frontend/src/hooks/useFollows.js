import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL } from '../utils/api';
import { track } from '../utils/track';

const FOLLOWS_KEY = 'lekiosque_follows';

// Followed keywords, sources and themes. localStorage stays the baseline (works
// logged-out); once signed in, the server becomes the source of truth and any
// local-only follows (e.g. picked before creating an account) are migrated up on
// the first mount after login rather than silently dropped.
export function useFollows({ user, authToken }) {
  const [follows, setFollows] = useState(() => {
    try { return JSON.parse(localStorage.getItem(FOLLOWS_KEY) || '[]'); } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(FOLLOWS_KEY, JSON.stringify(follows)); } catch { /* storage unavailable */ }
  }, [follows]);
  const followsRef = useRef(follows);
  useEffect(() => { followsRef.current = follows; }, [follows]);

  const migratedRef = useRef(false);
  useEffect(() => {
    if (!user || !authToken || migratedRef.current) return;
    migratedRef.current = true;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/follows`, { headers: { Authorization: `Bearer ${authToken}` } });
        const serverFollows = res.ok ? await res.json() : [];
        const localOnly = followsRef.current.filter(f => !serverFollows.some(sf => sf.type === f.type && sf.value === f.value));
        await Promise.all(localOnly.map(f => fetch(`${API_URL}/follows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(f),
        }).catch(() => {})));
        setFollows([...serverFollows, ...localOnly]);
      } catch { /* stay on the local list if the sync itself fails */ }
    })();
  }, [user, authToken]);

  const isFollowed = useCallback(
    (type, value) => follows.some(f => f.type === type && f.value === value),
    [follows]
  );
  const toggleFollow = useCallback((type, value, label) => {
    const existed = follows.some(f => f.type === type && f.value === value);
    setFollows(prev => existed
      ? prev.filter(f => !(f.type === type && f.value === value))
      : [...prev, { type, value, label }]);
    if (!existed) track('suivi', { type });
    if (user && authToken) {
      if (existed) {
        fetch(`${API_URL}/follows?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
        }).catch(() => {});
      } else {
        fetch(`${API_URL}/follows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ type, value, label }),
        }).catch(() => {});
      }
    }
    return !existed;
  }, [follows, user, authToken]);

  return { follows, isFollowed, toggleFollow };
}
