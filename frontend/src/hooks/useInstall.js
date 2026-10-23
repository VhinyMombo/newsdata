import { useCallback, useEffect, useState } from 'react';
import { track } from '../utils/track';

// Where the visitor opened the link decides how Le Kiosque gets onto the home screen:
// Chrome on Android hands us its install dialog, Safari on iPhone only has its share
// menu, and the browsers built into WhatsApp, Facebook or Instagram cannot install at all.
const ua = navigator.userAgent;
const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const android = /Android/.test(ua);
// In-app browsers name themselves in the user agent; a bare iOS web view lacks the Safari token
const inApp = /FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Messenger|Line\/|Snapchat|TikTok|musical_ly|; wv\)/i.test(ua)
  || (ios && !/Safari\//.test(ua));

export const isStandalone = () =>
  window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;

export const PLATFORM = ios
  ? (inApp ? 'ios-inapp' : /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari')
  : android ? (inApp ? 'android-inapp' : 'android') : 'desktop';

export const isPhone = ios || android;

export function useInstall() {
  // index.html keeps Chrome's install event, which can fire before React mounts
  const [prompt, setPrompt] = useState(() => window.__kiosqueInstall || null);
  const [installed, setInstalled] = useState(isStandalone);

  useEffect(() => {
    const onReady = () => setPrompt(window.__kiosqueInstall || null);
    const onInstalled = () => { window.__kiosqueInstall = null; setPrompt(null); setInstalled(true); track('installation', { plateforme: PLATFORM }); };
    window.addEventListener('kiosque-installable', onReady);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('kiosque-installable', onReady);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // The dialog can be shown only once per event: forget it whatever the answer
  const install = useCallback(async () => {
    if (!prompt) return false;
    track('installation-demandee', { plateforme: PLATFORM });
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    window.__kiosqueInstall = null;
    setPrompt(null);
    if (outcome === 'accepted') setInstalled(true);
    return outcome === 'accepted';
  }, [prompt]);

  // Only Chrome on Android and on computers offers the dialog; never trust it elsewhere
  const offered = !!prompt && (PLATFORM === 'android' || PLATFORM === 'desktop');
  return { platform: PLATFORM, canPrompt: offered, installed, install };
}
