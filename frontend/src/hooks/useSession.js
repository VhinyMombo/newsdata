import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '../utils/track';
import { API_URL, authHeaders } from '../utils/api';
import { useClerkBridge } from './clerkBridge';

const TOKEN_KEY = 'lekiosque_auth_token';
// Set when the session came from Clerk: signed out of Clerk, it ends here too
const VIA_KEY = 'lekiosque_auth_via';
const store = (key, value) => {
  try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* private mode */ }
};

// After an account is deleted, Clerk keeps a state in the page that leaves its sign-in
// form blank: the page starts afresh, and says on arrival that the account is gone
const DELETED_KEY = 'kiosque_account_deleted';
function deletedThenReload() {
  try { sessionStorage.setItem(DELETED_KEY, '1'); } catch { /* no storage: no message, still a clean page */ }
  window.location.replace(`${window.location.origin}/#/`);
  window.location.reload();
}

// Opaque server session token (see auth.py), so logout is a real server-side revocation
export function useSession() {
  const [authToken, setAuthToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const clerk = useClerkBridge();
  const [user, setUser] = useState(null);
  // null | 'login' | 'register' | 'forgot' | 'reset' | 'profile' | 'deleted'; 'deleted'
  // also right after the reload that follows a deletion (deletedThenReload)
  const [authModal, setAuthModal] = useState(() => {
    try { if (sessionStorage.getItem(DELETED_KEY)) { sessionStorage.removeItem(DELETED_KEY); return 'deleted'; } } catch { /* no storage */ }
    return null;
  });
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
  // and asks the server every two seconds until the sheet has finished. The sheet then
  // shows a code to type here: the secret alone never gives a session, since a link
  // sent by someone else could carry their secret.
  const waitRef = useRef(null);
  const appSecret = useRef(null);
  const [appCodeAsked, setAppCodeAsked] = useState(false);
  const signInFromApp = useCallback((provider) => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const secret = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
    // Kept for the end page in case iPhone brings it back inside the app (see api.py _sheet_page)
    try { localStorage.setItem('lekiosque_app_wait', secret); } catch { /* private mode: the waiting below still works */ }
    window.open(`${API_URL}/auth/${provider}/start?app=${secret}`, '_blank');
    appSecret.current = secret;
    setAppCodeAsked(false);
    clearInterval(waitRef.current);
    setAuthError('');
    setAuthBusy(true);
    const until = Date.now() + 10 * 60 * 1000;
    let expiredSeen = 0;
    // Where the sheet shares this app's storage it finishes by itself (api.py _sheet_page)
    // and leaves the session there: this window, still open underneath, takes it up
    const finishedInSheet = () => {
      let stored = null;
      try { stored = localStorage.getItem(TOKEN_KEY); } catch { /* no storage: the code is the way */ }
      if (!stored) return false;
      clearInterval(waitRef.current);
      setAuthBusy(false);
      setAuthToken(stored);
      setAuthModal(null);
      return true;
    };
    waitRef.current = setInterval(async () => {
      if (Date.now() > until) { clearInterval(waitRef.current); setAuthBusy(false); return; }
      if (finishedInSheet()) return;
      try {
        const res = await fetch(`${API_URL}/auth/app-wait?app=${secret}`);
        const body = await res.json();
        if (body.status === 'pending') return;
        // Gone because the sheet just took the session: its token lands a moment later
        if (body.status === 'expired' && ++expiredSeen < 3) return;
        clearInterval(waitRef.current);
        setAuthBusy(false);
        if (body.status === 'confirm') {
          setAuthError('');
          setAppCodeAsked(true);
          setAuthModal('login');
          return;
        }
        try { localStorage.removeItem('lekiosque_app_wait'); } catch { /* nothing kept */ }
        if (body.status === 'error') {
          setAuthError(body.message);
          setAuthModal('login');
        }
      } catch { /* offline for a moment: try again on the next tick */ }
    }, 2000);
  }, []);
  useEffect(() => () => clearInterval(waitRef.current), []);

  const confirmAppCode = useCallback(async (code) => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await fetch(`${API_URL}/auth/app-confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: appSecret.current, code }),
      });
      if (!res.ok) throw new Error();
      const body = await res.json();
      if (body.status === 'wrong') { setAuthError('Ce code ne correspond pas. Vérifiez-le et réessayez.'); return; }
      setAppCodeAsked(false);
      try { localStorage.removeItem('lekiosque_app_wait'); } catch { /* nothing kept */ }
      if (body.status !== 'ok') { setAuthError('La connexion a expiré. Recommencez.'); return; }
      localStorage.setItem(TOKEN_KEY, body.token);
      setAuthToken(body.token);
      setUser(body.user);
      setAuthModal(null);
    } catch {
      setAuthError("Le code n'a pas pu être vérifié. Réessayez dans un instant.");
    } finally {
      setAuthBusy(false);
    }
  }, []);
  const cancelAppCode = useCallback(() => {
    setAppCodeAsked(false);
    setAuthError('');
    try { localStorage.removeItem('lekiosque_app_wait'); } catch { /* nothing kept */ }
  }, []);

  // Clerk: once it has signed the reader in, trade its token for the Kiosque's session.
  // Signed out of Clerk (elsewhere, or expired), a session that came from it ends.
  const trading = useRef(false);
  // Between "Se déconnecter" and Clerk having signed out, no trade on its own: it
  // would sign straight back in (a click on « Se connecter » still does)
  const signingOut = useRef(false);
  // While « Supprimer mon compte » runs (deleteAccount)
  const deleting = useRef(false);
  const tradeClerk = useCallback(() => {
    if (trading.current) return;
    trading.current = true;
    (async () => {
      try {
        // Right after signing in, Clerk may not hold a token yet: wait for the next change
        const jwt = await clerk.getToken();
        if (!jwt) return;
        const res = await fetch(`${API_URL}/auth/clerk`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: jwt }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'La connexion a échoué. Réessayez.');
        // A session of the old sign-in, still open on this device, makes way
        if (authToken) fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: authHeaders(authToken) }).catch(() => {});
        store(TOKEN_KEY, body.token); store(VIA_KEY, 'clerk');
        setAuthToken(body.token);
        setUser(body.user);
        setAuthModal(null);
      } catch (e) {
        // Out of Clerk too, so the next page does not try again in a loop
        clerk.clerk.signOut().catch(() => {});
        setAuthError(e.message);
        setAuthModal('clerk-error');
      } finally {
        trading.current = false;
      }
    })();
  }, [clerk, authToken]);
  useEffect(() => {
    if (!clerk?.isLoaded) return;
    let via = null;
    try { via = localStorage.getItem(VIA_KEY); } catch { /* private mode */ }
    if (!clerk.isSignedIn) {
      signingOut.current = false;
      if (authToken && via === 'clerk' && !deleting.current) {
        // Left by deleting the account in Clerk's window: the server, on Clerk's word,
        // deletes the Kiosque account too and the page says so
        fetch(`${API_URL}/auth/clerk/ended`, { method: 'POST', headers: authHeaders(authToken) })
          .then(r => r.json()).then(b => { if (b?.deleted) deletedThenReload(); })
          .catch(() => {});
        store(TOKEN_KEY, null); store(VIA_KEY, null);
        setAuthToken(null);
        setUser(null);
      }
      return;
    }
    if ((authToken && via === 'clerk') || signingOut.current) return;
    tradeClerk();
  }, [clerk, authToken, tradeClerk]);

  const showAuthError = useCallback((message) => { setAuthError(message); setAuthModal('login'); }, []);

  const openReset = useCallback((token) => { setResetToken(token); setAuthError(''); setAuthModal('reset'); }, []);

  const logout = useCallback(() => {
    if (clerk?.isSignedIn) signingOut.current = true;
    if (authToken) fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: authHeaders(authToken) }).catch(() => {});
    store(TOKEN_KEY, null); store(VIA_KEY, null);
    setAuthToken(null);
    setUser(null);
    setAuthModal(null);
    // Out of Clerk too, on the same page
    if (clerk?.isSignedIn) clerk.clerk.signOut().catch(() => {});
  }, [authToken, clerk]);

  // Profil › Supprimer mon compte: the server erases the account and all its data
  // (and the reader's Clerk account, api.py delete_me)
  // Clerk is left first, while its session still exists: once the server has deleted the
  // Clerk user, signing out fails and Clerk keeps a dead session in the page, its sign-in
  // form then showing nothing. Meanwhile the Kiosque's session must outlive that sign-out
  // (deleting), or the effect above would end it before the request is sent.
  const deleteAccount = useCallback(async () => {
    deleting.current = true;
    try {
      if (clerk?.isSignedIn) { signingOut.current = true; await clerk.clerk.signOut().catch(() => {}); }
      const res = await fetch(`${API_URL}/auth/me`, { method: 'DELETE', headers: authHeaders(authToken) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Le compte n'a pas pu être supprimé. Réessayez.");
    } finally {
      deleting.current = false;
    }
    store(TOKEN_KEY, null); store(VIA_KEY, null);
    setAuthToken(null);
    setUser(null);
    // Say plainly that it is done, rather than looking like a mere sign-out
    if (clerk) deletedThenReload(); else setAuthModal('deleted');
  }, [authToken, clerk]);

  // With Clerk, signing in and up happen in its windows, in French and the site's
  // colours; the profile stays the Kiosque's own
  const openAuth = useCallback((mode) => {
    setAuthError('');
    if (clerk && ['login', 'register', 'forgot'].includes(mode)) {
      signingOut.current = false;
      setAuthModal(null);
      // Still signed in to Clerk (a sign-out not finished, a session from another tab):
      // Clerk would show nothing, so reopen the Kiosque's session from it
      if (clerk.isSignedIn) { tradeClerk(); return; }
      // The Kiosque's window, with Clerk's form inside (AuthModal)
      setAuthModal(mode === 'register' ? 'register' : 'login');
      return;
    }
    setAuthModal(mode);
  }, [clerk, tradeClerk]);

  // Password, e-mail addresses and linked Google account: Clerk's own window
  // The site-wide appearance keeps Clerk's windows to the sign-in form's 400px; its
  // profile has a menu beside its pages and needs its own width. Deleting the account is
  // there, under Sécurité: the Kiosque account follows (/auth/clerk/ended, above).
  const manageSecurity = useCallback(() => {
    clerk?.clerk.openUserProfile({ appearance: { elements: {
      cardBox: { width: 'min(880px, calc(100vw - 32px))', maxWidth: 'none' },
    } } });
  }, [clerk]);

  return { authToken, user, setUser, authModal, setAuthModal, openAuth, authBusy, authError, submit, logout, forgot, resetToken, openReset, providers, exchange, showAuthError, deleteAccount, signInFromApp, appCodeAsked, confirmAppCode, cancelAppCode, clerkOn: !!clerk, manageSecurity };
}
