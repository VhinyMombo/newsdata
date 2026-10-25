// Installed on an iPhone, the app is relaunched from scratch each time the reader
// comes back from an article opened on a newspaper's site: it reopens at its start
// address, the front page, and the reader loses their place. Where they were (the
// screen, and how far down it) is kept for half an hour and restored on such a
// relaunch. The conversation itself already survives (useChat, localStorage).
const KEY = 'lekiosque_resume';
const FRESH_MS = 30 * 60 * 1000;

const installed = () =>
  window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ hash: window.location.hash, y: Math.round(window.scrollY), at: Date.now() }));
  } catch { /* storage unavailable: nothing to restore */ }
}

function saved() {
  try {
    const point = JSON.parse(localStorage.getItem(KEY) || 'null');
    return point && Date.now() - point.at < FRESH_MS ? point : null;
  } catch { return null; }
}

// The page fills in as its data arrives: scroll once it is tall enough, and give up
// if the reader starts scrolling first or after a few seconds
function scrollWhenReady(y) {
  if (!y) return;
  const until = Date.now() + 4000;
  let stopped = false;
  const stop = () => { stopped = true; };
  window.addEventListener('touchstart', stop, { once: true, passive: true });
  window.addEventListener('wheel', stop, { once: true, passive: true });
  const step = () => {
    if (stopped) return;
    if (document.documentElement.scrollHeight - window.innerHeight >= y) window.scrollTo(0, y);
    else if (Date.now() < until) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Called before the first render: put back the screen the app was relaunched away
// from, then keep the resume point up to date. Returns a function to call once the
// first frame is painted, which restores the scroll position.
export function resume() {
  if (!installed()) return () => {};
  const point = saved();
  const atStart = !window.location.hash || window.location.hash === '#/';
  const restore = point && atStart && point.hash && point.hash !== '#/';
  if (restore) window.history.replaceState(null, '', point.hash);

  let timer = null;
  window.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(save, 300);
  }, { passive: true });
  window.addEventListener('hashchange', save);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });

  return () => { if (point && atStart) scrollWhenReady(point.y); };
}
