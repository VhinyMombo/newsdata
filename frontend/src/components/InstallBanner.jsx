import { useState } from 'react';
import { X } from 'lucide-react';
import { isPhone, useInstall } from '../hooks/useInstall';

// A quiet line under the header for phone visitors who came by any other address than
// /installer. Closing it keeps it away for a month on this phone.
const KEY = 'kiosque-install-banner-closed';
const MONTH = 30 * 24 * 60 * 60 * 1000;

const closedRecently = () => {
  try { return Date.now() - Number(localStorage.getItem(KEY) || 0) < MONTH; } catch { return false; }
};

export default function InstallBanner() {
  const { canPrompt, installed, install } = useInstall();
  const [hidden, setHidden] = useState(closedRecently);

  if (installed || hidden || (!isPhone && !canPrompt)) return null;

  const close = () => {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* private mode: hide for this visit only */ }
    setHidden(true);
  };
  // Chrome's dialog when it is on offer, otherwise the page with this phone's steps
  const open = () => { if (canPrompt) install(); else window.location.href = '/installer'; };

  return (
    <div className="k-install-banner" role="region" aria-label="Installer l'application">
      <div className="k-wrap k-install-banner-row">
        <img src="/icons/icon-192.png" alt="" width="32" height="32" />
        <p>Ajoutez <strong>Le Kiosque</strong> à votre écran d'accueil.</p>
        <button className="k-btn primary" onClick={open}>Installer</button>
        <button className="k-install-banner-close" onClick={close} aria-label="Fermer"><X size={18} /></button>
      </div>
    </div>
  );
}
