import { track } from './track';
import { SOURCE_SITES, sourceLabel } from './format';

// Readers sent to the newspapers: every click on a link to a newspaper's site,
// wherever it sits (Une, an article card, the assistant's sources, Tendances, a
// newspaper's page), is counted as a "lecture" event for that newspaper in Umami.
// The newspaper is told by the link's host, so a new link needs no code here.
const bare = (host) => host.replace(/^www\./, '');
const HOSTS = Object.fromEntries(Object.entries(SOURCE_SITES).map(([s, url]) => [bare(new URL(url).hostname), s]));
HOSTS['medias241.com'] = 'medias241';  // its feed's domain; the articles live on .ga

function onClick(e) {
  if (e.type === 'auxclick' && e.button !== 1) return;  // middle click opens a tab; right click doesn't
  const a = e.target.closest?.('a[href^="http"]');
  if (!a) return;
  const url = new URL(a.href);
  const source = HOSTS[bare(url.hostname)];
  if (!source) return;
  track('lecture', {
    journal: sourceLabel(source),
    // the newspaper's front page, or one of its articles
    // (some sites name articles by query only: depeches241.com/?p=1234)
    type: url.pathname.replace(/\/$/, '') === '' && !url.search ? 'site' : 'article',
    depuis: window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'une',
  });
}

export function countNewspaperClicks() {
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
}
