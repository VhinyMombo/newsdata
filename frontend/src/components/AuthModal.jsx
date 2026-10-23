import { useState, useEffect, useCallback } from 'react';
import '../styles/auth.css';
import {
  Bell, History, Star, X,
} from 'lucide-react';
import { API_URL } from '../utils/api';

const FOLLOW_TYPE_LABELS = { keyword: 'Mot-clé', source: 'Source', theme: 'Thème' };

// Web Push's applicationServerKey wants a Uint8Array, VAPID public keys are
// handed out base64url-encoded — standard MDN conversion, no library needed
// for one function.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

export default function AuthModal({ mode, onClose, onSwitchMode, onSubmit, busy, error, user, authToken, onLogout, onProfileUpdated }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  // Profile-only local state: separate from login/register fields since
  // both can be open across a mode switch without bleeding into each other
  const [profileName, setProfileName] = useState(user?.display_name || '');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [profileMsg, setProfileMsg] = useState('');
  const [profileErr, setProfileErr] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [follows, setFollows] = useState(null);

  // Push notifications: only meaningful once installed as a PWA with an
  // active service worker (see frontend/src/sw.js) — plain browser tabs on
  // most platforms won't have a usable PushManager.
  const pushSupported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState('');
  const [vapidKey, setVapidKey] = useState('');

  useEffect(() => { setProfileName(user?.display_name || ''); }, [user]);

  useEffect(() => {
    if (mode !== 'profile' || !authToken) return;
    fetch(`${API_URL}/follows`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => (r.ok ? r.json() : []))
      .then(setFollows)
      .catch(() => setFollows([]));
  }, [mode, authToken]);

  useEffect(() => {
    if (mode !== 'profile' || !authToken || !pushSupported) return;
    fetch(`${API_URL}/push/vapid_public_key`)
      .then(r => r.json())
      .then(d => setVapidKey(d.key || ''))
      .catch(() => setVapidKey(''));
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => setPushEnabled(!!sub))
      .catch(() => setPushEnabled(false));
  }, [mode, authToken, pushSupported]);

  const togglePush = useCallback(async () => {
    setPushBusy(true); setPushErr('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch(`${API_URL}/push/subscribe?endpoint=${encodeURIComponent(existing.endpoint)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
        }).catch(() => {});
        await existing.unsubscribe();
        setPushEnabled(false);
        return;
      }
      if (!vapidKey) throw new Error('Notifications indisponibles pour le moment.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notifications refusées dans le navigateur.');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const json = sub.toJSON();
      const res = await fetch(`${API_URL}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
      if (!res.ok) throw new Error("Échec de l'enregistrement des notifications.");
      setPushEnabled(true);
    } catch (e) {
      setPushErr(e.message || 'Erreur notifications.');
    } finally {
      setPushBusy(false);
    }
  }, [authToken, vapidKey]);

  const unfollow = useCallback((type, value) => {
    setFollows(prev => prev.filter(f => !(f.type === type && f.value === value)));
    fetch(`${API_URL}/follows?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
    }).catch(() => {});
  }, [authToken]);

  const saveDisplayName = useCallback(async (e) => {
    e.preventDefault();
    setProfileBusy(true); setProfileErr(''); setProfileMsg('');
    try {
      const res = await fetch(`${API_URL}/auth/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ display_name: profileName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || 'Échec de la mise à jour.');
      onProfileUpdated(body);
      setProfileMsg('Nom mis à jour.');
    } catch (e) { setProfileErr(e.message); } finally { setProfileBusy(false); }
  }, [authToken, profileName, onProfileUpdated]);

  const changePassword = useCallback(async (e) => {
    e.preventDefault();
    setProfileBusy(true); setProfileErr(''); setProfileMsg('');
    try {
      const res = await fetch(`${API_URL}/auth/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || 'Échec du changement de mot de passe.');
      setCurrentPw(''); setNewPw('');
      setProfileMsg('Mot de passe mis à jour.');
    } catch (e) { setProfileErr(e.message); } finally { setProfileBusy(false); }
  }, [authToken, currentPw, newPw]);

  return (
    <div className="auth-modal-backdrop" onClick={onClose}>
      <div className={`auth-modal ${mode !== 'profile' ? 'auth-modal-entry' : ''}`} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="auth-modal-close" onClick={onClose} aria-label="Fermer"><X size={18} /></button>

        {mode !== 'profile' ? (
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(mode, mode === 'register'
                ? { email, password, display_name: displayName }
                : { email, password });
            }}
          >
            <header className="auth-brand">
              <img src="/icons/icon-192.png" alt="" width="56" height="56" />
              <span className="auth-brand-name">Le Kiosque</span>
              <span className="auth-brand-rule" aria-hidden="true" />
              <p className="auth-brand-dek">La presse et les lois, à portée de question.</p>
            </header>
            <div className="auth-tabs" role="tablist" aria-label="Compte">
              <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => onSwitchMode('login')}>Se connecter</button>
              <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => onSwitchMode('register')}>Créer un compte</button>
            </div>
            <h2 className="sr-only">{mode === 'register' ? 'Créer un compte' : 'Se connecter'}</h2>
            {/* Said in both modes: the header button opens "Se connecter", where most
            visitors have no account yet */}
            <ul className="auth-perks">
              <li><History size={16} aria-hidden="true" /><span><b>Vos conversations gardées.</b> Reprenez-les plus tard, sur tous vos appareils.</span></li>
              <li><Star size={16} aria-hidden="true" /><span><b>Vos sujets suivis.</b> Un nom, un thème ou un journal : l'accueil vous montre ce qui a bougé depuis votre visite.</span></li>
              <li><Bell size={16} aria-hidden="true" /><span><b>Prévenu quand ça bouge.</b> Une notification quand un sujet suivi revient fort dans la presse.</span></li>
            </ul>
            {mode === 'register' && (
              <input
                className="auth-input" placeholder="Nom affiché" value={displayName}
                onChange={e => setDisplayName(e.target.value)} required maxLength={80}
              />
            )}
            <input
              className="auth-input" type="email" placeholder="E-mail" value={email}
              onChange={e => setEmail(e.target.value)} required autoComplete="username"
            />
            <input
              className="auth-input" type="password" placeholder="Mot de passe" value={password}
              onChange={e => setPassword(e.target.value)} required minLength={8}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
            {error && <p className="auth-error">{error}</p>}
            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? '…' : mode === 'register' ? 'Créer le compte' : 'Se connecter'}
            </button>
            <p className="auth-fineprint">Gratuit. Votre e-mail sert seulement à vous connecter.</p>
          </form>
        ) : (
          <div className="auth-profile">
            <h2 className="auth-title">Profil</h2>
            <p className="auth-profile-email">{user?.email}</p>

            <form className="auth-form auth-form-inline" onSubmit={saveDisplayName}>
              <label className="auth-label">Nom affiché</label>
              <div className="auth-inline-row">
                <input className="auth-input" value={profileName} onChange={e => setProfileName(e.target.value)} maxLength={80} required />
                <button type="submit" className="auth-submit auth-submit-sm" disabled={profileBusy}>Enregistrer</button>
              </div>
            </form>

            <form className="auth-form" onSubmit={changePassword}>
              <label className="auth-label">Changer le mot de passe</label>
              <input className="auth-input" type="password" placeholder="Mot de passe actuel" value={currentPw} onChange={e => setCurrentPw(e.target.value)} autoComplete="current-password" />
              <input className="auth-input" type="password" placeholder="Nouveau mot de passe" value={newPw} onChange={e => setNewPw(e.target.value)} minLength={8} autoComplete="new-password" />
              <button type="submit" className="auth-submit auth-submit-sm" disabled={profileBusy || !currentPw || !newPw}>Mettre à jour</button>
            </form>

            {profileErr && <p className="auth-error">{profileErr}</p>}
            {profileMsg && <p className="auth-success">{profileMsg}</p>}

            <div className="auth-follows">
              <label className="auth-label">Sujets suivis</label>
              {follows === null ? (
                <p className="chat-empty-sub">Chargement…</p>
              ) : follows.length === 0 ? (
                <p className="chat-empty-sub">Aucun sujet suivi pour l'instant — suivez un mot-clé, une source ou un thème depuis les Statistiques (icône ★).</p>
              ) : (
                <div className="auth-follows-list">
                  {follows.map(f => (
                    <div key={`${f.type}-${f.value}`} className="auth-follow-row">
                      <span className="auth-follow-type">{FOLLOW_TYPE_LABELS[f.type]}</span>
                      <span className="auth-follow-label">{f.label}</span>
                      <button className="auth-follow-remove" onClick={() => unfollow(f.type, f.value)} title="Ne plus suivre" aria-label={`Ne plus suivre ${f.label}`}>
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {pushSupported && (
              <div className="auth-follows">
                <label className="auth-label">Notifications</label>
                <p className="chat-empty-sub">
                  Recevez une alerte quand un sujet suivi connaît un pic d'actualité.
                </p>
                <button
                  type="button"
                  className="auth-submit auth-submit-sm"
                  onClick={togglePush}
                  disabled={pushBusy}
                >
                  {pushBusy ? '…' : pushEnabled ? 'Désactiver les notifications' : 'Activer les notifications'}
                </button>
                {pushErr && <p className="auth-error">{pushErr}</p>}
              </div>
            )}

            <button type="button" className="auth-logout" onClick={onLogout}>Se déconnecter</button>
          </div>
        )}
      </div>
    </div>
  );
}
