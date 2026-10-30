import { useEffect, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { API_URL } from '../utils/api';
import { isStandalone } from '../hooks/useInstall';
import { currentSubscription, permission, pushSupported, registerDevice, subscribeThisDevice } from '../utils/push';
import { track } from '../utils/track';

// In the installed app, once: offer the general notifications, no account needed.
// The browser asks only after this tap (iPhone requires it), so a reader who is not
// interested is never shown the system prompt. "Plus tard" keeps it away two weeks.
const KEY = 'kiosque-notif-prompt-closed';
const LATER = 14 * 24 * 60 * 60 * 1000;

const closedRecently = () => {
  try { return Date.now() - Number(localStorage.getItem(KEY) || 0) < LATER; } catch { return false; }
};

export default function NotifPrompt({ authToken }) {
  const [state, setState] = useState(() =>
    pushSupported && isStandalone() && permission() === 'default' && !closedRecently() ? 'ask' : 'hidden');
  const [error, setError] = useState('');

  // A device that already accepted keeps its registration fresh, and one that
  // subscribed through an account before devices existed takes the general ones
  useEffect(() => {
    if (permission() !== 'granted') return;
    currentSubscription().then(sub => sub && registerDevice(sub)).catch(() => { /* offline: next launch */ });
  }, []);

  useEffect(() => {
    if (state !== 'done') return;
    const t = setTimeout(() => setState('hidden'), 8000);
    return () => clearTimeout(t);
  }, [state]);

  if (state === 'hidden') return null;

  const later = () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode: hide for this visit only */ }
    track('notifications-plus-tard');
    setState('hidden');
  };
  const enable = async () => {
    setState('busy'); setError('');
    try {
      const sub = await subscribeThisDevice();
      // Signed in: the account's own notifications reach this device too
      if (authToken) {
        const json = sub.toJSON();
        fetch(`${API_URL}/push/subscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
        }).catch(() => {});
      }
      track('notifications-activees');
      setState('done');
    } catch (e) {
      setError(e.message || 'Erreur notifications.');
      setState(permission() === 'denied' ? 'denied' : 'ask');
    }
  };

  return (
    <div className="k-install-banner k-notif-prompt" role="region" aria-label="Notifications">
      <div className="k-wrap k-install-banner-row">
        <span className="k-notif-prompt-icon" aria-hidden="true"><Bell size={18} /></span>
        {state === 'done' ? (
          <p><strong>C'est activé.</strong> Vous pouvez choisir vos notifications dans les <a href="#/notifications">réglages</a>.</p>
        ) : state === 'denied' ? (
          <p>Les notifications sont bloquées pour Le Kiosque. Vous pouvez les autoriser dans les réglages de votre téléphone.</p>
        ) : (
          <p>
            <strong>Recevoir l'essentiel ?</strong> Les trois sujets du matin, et une alerte quand toute la presse parle d'un même sujet.
            {error && <span className="k-notif-prompt-error"> {error}</span>}
          </p>
        )}
        {(state === 'ask' || state === 'busy') && (
          <button className="k-btn primary" onClick={enable} disabled={state === 'busy'}>{state === 'busy' ? '…' : 'Activer'}</button>
        )}
        <button className="k-install-banner-close" onClick={state === 'done' ? () => setState('hidden') : later} aria-label="Fermer"><X size={18} /></button>
      </div>
    </div>
  );
}
