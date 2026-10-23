import { useCallback, useEffect, useState } from 'react';
import { track } from '../utils/track';
import { API_URL, authHeaders } from '../utils/api';

const TOKEN_KEY = 'lekiosque_auth_token';

// Opaque server session token (see auth.py), so logout is a real server-side revocation
export function useSession() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  const [authModal, setAuthModal] = useState(null); // null | 'login' | 'register' | 'profile'
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    if (!authToken) { setUser(null); return; }
    fetch(`${API_URL}/auth/me`, { headers: authHeaders(authToken) })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(setUser)
      .catch(() => {
        // Expired or revoked server-side: drop it rather than retry on every render
        localStorage.removeItem(TOKEN_KEY);
        setAuthToken(null);
        setUser(null);
      });
  }, [authToken]);

  const submit = useCallback(async (mode, fields) => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await fetch(`${API_URL}/auth/${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || 'Une erreur est survenue.');
      localStorage.setItem(TOKEN_KEY, body.token);
      setAuthToken(body.token);
      setUser(body.user);
      if (mode === 'register') track('inscription');
      setAuthModal(null);
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const logout = useCallback(() => {
    if (authToken) fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: authHeaders(authToken) }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken(null);
    setUser(null);
    setAuthModal(null);
  }, [authToken]);

  const openAuth = useCallback((mode) => { setAuthError(''); setAuthModal(mode); }, []);

  return { authToken, user, setUser, authModal, setAuthModal, openAuth, authBusy, authError, submit, logout };
}
