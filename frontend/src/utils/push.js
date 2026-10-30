import { API_URL } from './api';

// Web push on this device: asking permission, subscribing, and registering the
// device with the server so it takes the general notifications (the morning
// essentials, a story the whole press picks up, announcements), signed in or not.
// The account's own notifications (evening brief, followed topics) also need the
// subscription tied to the reader: see AuthModal.

export const pushSupported = typeof window !== 'undefined'
  && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const permission = () => (pushSupported ? Notification.permission : 'unsupported');

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

let vapidKey = null;
async function getVapidKey() {
  if (vapidKey) return vapidKey;
  const res = await fetch(`${API_URL}/push/vapid_public_key`);
  vapidKey = (await res.json()).key || '';
  return vapidKey;
}

// The service worker can take a while on a first visit, or never come (a private
// window): past a few seconds, the device counts as not subscribed
export async function currentSubscription() {
  if (!pushSupported) return null;
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise(resolve => setTimeout(() => resolve(null), 5000)),
  ]);
  return reg ? reg.pushManager.getSubscription() : null;
}

// The device's general-notification choices, kept by the server under its endpoint
export async function registerDevice(sub) {
  const json = sub.toJSON();
  const res = await fetch(`${API_URL}/push/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  if (!res.ok) throw new Error("Échec de l'enregistrement des notifications.");
  return res.json();
}

// Ask the browser (it must follow a tap on iPhone), subscribe, register the device
export async function subscribeThisDevice() {
  const key = await getVapidKey().catch(() => '');
  if (!key) throw new Error('Notifications indisponibles pour le moment.');
  const answer = await Notification.requestPermission();
  if (answer !== 'granted') throw new Error('Notifications refusées sur cet appareil.');
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription()
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  await registerDevice(sub);
  return sub;
}

// Stop every notification on this device, general and account ones alike
export async function unsubscribeThisDevice(authToken) {
  const sub = await currentSubscription();
  if (!sub) return;
  const endpoint = encodeURIComponent(sub.endpoint);
  await fetch(`${API_URL}/push/device?endpoint=${endpoint}`, { method: 'DELETE' }).catch(() => {});
  if (authToken) {
    await fetch(`${API_URL}/push/subscribe?endpoint=${endpoint}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
    }).catch(() => {});
  }
  await sub.unsubscribe();
}

export async function getDevicePrefs(sub) {
  const res = await fetch(`${API_URL}/push/device?endpoint=${encodeURIComponent(sub.endpoint)}`);
  return res.ok ? res.json() : registerDevice(sub);
}

export async function setDevicePref(sub, pref, on) {
  const res = await fetch(`${API_URL}/push/device`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint, [pref]: on }),
  });
  if (!res.ok) throw new Error("Échec de l'enregistrement du réglage.");
  return res.json();
}

// The general notifications, as the settings page lists them
export const DEVICE_PREFS = [
  ['morning', "L'essentiel du matin", 'Chaque matin à 7h30, les trois sujets les plus repris depuis la veille au soir.'],
  ['wave', 'Toute la presse en parle', "Quand plusieurs journaux reprennent le même sujet en quelques heures. Une fois par jour au plus."],
  ['alerts', 'Les annonces du Kiosque', 'Rarement : les grands rendez-vous de l’actualité et les nouveautés du Kiosque.'],
];
