import { useCallback, useEffect, useState } from 'react';
import { track } from '../utils/track';
import { API_URL, authHeaders } from '../utils/api';

const TOKEN_KEY = 'lekiosque_auth_token';

// Opaque server session token (see auth.py), so logout is a real server-side revocation
export function useSession() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(null);
  const [authModal, setAuthModal] = useState(null); // null | 'login' | 'register' | 'forgot' | 'reset' | 'profile'
  // From the e-mailed link (#/reinitialiser?token=…), kept here once the address bar is cleaned
  const [resetToken, setResetToken] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  // Google and Facebook, when the server has their keys
  const [providers, setProviders] = useState([]);

  useEffect(() => {
    fetch(`${API_URL}/auth/providers`)
      .then(r => (r.ok ? r.json() : { providers: [] }))
      .then(d => setProviders(d.providers || []))
      .catch(() => setProviders([]));
  }, []);

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

  // Always "sent" when the server accepts: it never says whether the address has an account
  const forgot = useCallback(async (email) => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await fetch(`${API_URL}/auth/forgot`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || 'Une erreur est survenue.');
      return true;
    } catch (e) {
      setAuthError(e.message);
      return false;
    } finally {
      setAuthBusy(false);
    }
  }, []);

  // Back from Google or Facebook (#/connexion?code=…): trade the one-time code for a session
  const exchange = useCallback(async (code) => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await fetch(`${API_URL}/auth/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || 'Une erreur est survenue.');
      localStorage.setItem(TOKEN_KEY, body.token);
      setAuthToken(body.token);
      setUser(body.user);
      setAuthModal(null);
    } catch (e) {
      setAuthError(e.message);
      setAuthModal('login');
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const showAuthError = useCallback((message) => { setAuthError(message); setAuthModal('login'); }, []);

  const openReset = useCallback((token) => { setResetToken(token); setAuthError(''); setAuthModal('reset'); }, []);

  const logout = useCallback(() => {
    if (authToken) fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: authHeaders(authToken) }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken(null);
    setUser(null);
    setAuthModal(null);
  }, [authToken]);

  // Profil › Supprimer mon compte: the server erases the account and all its data
  const deleteAccount = useCallback(async () => {
    const res = await fetch(`${API_URL}/auth/me`, { method: 'DELETE', headers: authHeaders(authToken) });
    if (!res.ok) throw new Error("Le compte n'a pas pu être supprimé. Réessayez.");
    localStorage.removeItem(TOKEN_KEY);
    setAuthToken(null);
    setUser(null);
    setAuthModal(null);
  }, [authToken]);

  const openAuth = useCallback((mode) => { setAuthError(''); setAuthModal(mode); }, []);

  return { authToken, user, setUser, authModal, setAuthModal, openAuth, authBusy, authError, submit, logout, forgot, resetToken, openReset, providers, exchange, showAuthError, deleteAccount };
}
