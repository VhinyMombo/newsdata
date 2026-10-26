import { track } from './track';

// A notification opens the app on a link marked n=<kind> (jour, semaine, sujets; see
// push_notify.py). Count that opening once in the statistics, then drop the mark from
// the address, so a link copied or shared from there is not counted again.
// The tracker loads after the app starts: wait for it a few seconds, then give up.
export function countNotificationOpen() {
  const [path, qs] = window.location.hash.split('?');
  const params = new URLSearchParams(qs || '');
  const kind = params.get('n');
  if (!kind) return;
  params.delete('n');
  const rest = params.toString();
  window.history.replaceState(null, '', path + (rest ? `?${rest}` : ''));

  const until = Date.now() + 8000;
  const send = () => {
    if (window.umami) track('notification', { type: kind });
    else if (Date.now() < until) setTimeout(send, 300);
  };
  send();
}
