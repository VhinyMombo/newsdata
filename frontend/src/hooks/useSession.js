import { useCallback, useEffect, useRef, useState } from 'react';
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
    let tester = false;
    try { tester = localStorage.getItem('lekiosque_tester') === 'facebook'; } catch { /* no storage: no tester */ }
    fetch(`${API_URL}/auth/providers${tester ? '?test=facebook' : ''}`)
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

  // Installed on a phone, Google or Facebook opens in a browser sheet over the app and
  // would come back signed in there, not here. The app keeps a secret, sends it along,
  // and asks the server every two seconds until the sheet has finished.
  const waitRef = useRef(null);
  const signInFromApp = useCallback((provider) => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const secret = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
    // Kept for the end page in case iPhone brings it back inside the app (see api.py _sheet_page)
    try { localStorage.setItem('lekiosque_app_wait', secret); } catch { /* private mode: the waiting below still works */ }
    window.open(`${API_URL}/auth/${provider}/start?app=${secret}`, '_blank');
    clearInterval(waitRef.current);
    setAuthError('');
    setAuthBusy(true);
    const until = Date.now() + 10 * 60 * 1000;
    waitRef.current = setInterval(async () => {
      if (Date.now() > until) { clearInterval(waitRef.current); setAuthBusy(false); return; }
      try {
        const res = await fetch(`${API_URL}/auth/app-wait?app=${secret}`);
        const body = await res.json();
        if (body.status === 'pending') return;
        clearInterval(waitRef.current);
        setAuthBusy(false);
        try { localStorage.removeItem('lekiosque_app_wait'); } catch { /* nothing kept */ }
        if (body.status === 'ok') {
          localStorage.setItem(TOKEN_KEY, body.token);
          setAuthToken(body.token);
          setUser(body.user);
          setAuthModal(null);
        } else if (body.status === 'error') {
          setAuthError(body.message);
          setAuthModal('login');
        }
      } catch { /* offline for a moment: try again on the next tick */ }
    }, 2000);
  }, []);
  useEffect(() => () => clearInterval(waitRef.current), []);

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

  return { authToken, user, setUser, authModal, setAuthModal, openAuth, authBusy, authError, submit, logout, forgot, resetToken, openReset, providers, exchange, showAuthError, deleteAccount, signInFromApp };
}
