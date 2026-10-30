import { useCallback, useEffect, useState } from 'react';
import { isPhone, isStandalone, PLATFORM } from '../hooks/useInstall';
import {
  DEVICE_PREFS, currentSubscription, getDevicePrefs, permission, pushSupported,
  setDevicePref, subscribeThisDevice, unsubscribeThisDevice,
} from '../utils/push';

// #/notifications: this device's general notifications, no account needed. The
// evening brief, the weekly review and followed topics stay in the profile.
export default function Notifications({ session }) {
  const [sub, setSub] = useState(undefined);
  const [prefs, setPrefs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!pushSupported) { setSub(null); return; }
    currentSubscription()
      .then(async s => {
        setSub(s);
        if (s) setPrefs(await getDevicePrefs(s));
      })
      .catch(() => setSub(null));
  }, []);

  const run = useCallback(async (fn) => {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(e.message || 'Erreur notifications.'); } finally { setBusy(false); }
  }, []);

  const enable = () => run(async () => {
    const s = await subscribeThisDevice();
    setSub(s);
    setPrefs(await getDevicePrefs(s));
  });
  const disable = () => run(async () => {
    await unsubscribeThisDevice(session.authToken);
    setSub(null); setPrefs(null);
  });
  const toggle = (pref) => run(async () => {
    setPrefs(await setDevicePref(sub, pref, !prefs[pref]));
  });

  const iosBrowser = PLATFORM.startsWith('ios') && !isStandalone();
  return (
    <div className="k-wrap k-page k-notifs">
      <header className="k-page-head">
        <span className="k-eyebrow">Notifications</span>
        <h1 className="k-title">Ce que Le Kiosque vous envoie</h1>
        <p className="k-dek">Ces notifications arrivent sur cet appareil, sans compte. Deux par jour au plus, jamais entre 22h et 7h.</p>
      </header>

      {!pushSupported ? (
        <p className="k-notifs-note">
          {iosBrowser
            ? "Sur iPhone, les notifications passent par l'application : ajoutez Le Kiosque à l'écran d'accueil (Partager, puis « Sur l'écran d'accueil »), ouvrez-le, puis revenez ici."
            : 'Ce navigateur ne permet pas les notifications.'}
          {iosBrowser && <> <a href="/installer">Voir comment installer</a></>}
        </p>
      ) : sub === undefined ? (
        <p className="k-muted">Chargement…</p>
      ) : !sub ? (
        <div className="k-notifs-off">
          <p className="k-notifs-note">
            {permission() === 'denied'
              ? 'Les notifications sont bloquées pour Le Kiosque : autorisez-les dans les réglages de votre téléphone ou de votre navigateur, puis revenez ici.'
              : "Cet appareil ne reçoit pas de notifications."}
          </p>
          {permission() !== 'denied' && (
            <button className="k-btn primary" onClick={enable} disabled={busy}>{busy ? '…' : 'Activer les notifications'}</button>
          )}
          {isPhone && !isStandalone() && <p className="k-muted">Elles marchent mieux depuis l'application installée.</p>}
        </div>
      ) : (
        <>
          <ul className="k-notifs-list">
            {DEVICE_PREFS.map(([pref, label, when]) => (
              <li key={pref}>
                <label>
                  <input type="checkbox" checked={!!prefs?.[pref]} onChange={() => toggle(pref)} disabled={busy || !prefs} />
                  <span><strong>{label}</strong><small>{when}</small></span>
                </label>
              </li>
            ))}
          </ul>
          <p className="k-notifs-note">
            {session.user
              ? <>Le résumé du soir, la revue de la semaine et vos sujets suivis se règlent dans <button className="k-link" onClick={() => session.openAuth('profile')}>votre profil</button>.</>
              : <>Avec un compte, vous pouvez aussi recevoir le résumé du soir et une alerte sur les sujets que vous suivez. <button className="k-link" onClick={() => session.openAuth('register')}>Créer un compte</button></>}
          </p>
          <button className="k-btn" onClick={disable} disabled={busy}>Ne plus rien recevoir sur cet appareil</button>
        </>
      )}
      {error && <p className="k-notifs-error" role="alert">{error}</p>}
    </div>
  );
}
