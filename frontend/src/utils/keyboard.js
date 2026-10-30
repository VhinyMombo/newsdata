import { track } from './track';

// On an iPhone the bars fixed to the bottom (the tab bar, the assistant's question
// bar) can end up mid-screen, where the keyboard's top edge was, with the page
// running on below them. Two ways in: the keyboard closing (they stay until the
// page scrolls), and leaving the app with the keyboard open, then coming back:
// iOS keeps placing them against the shortened height, and scrolling does not help.
// So: nudge the scroll when the keyboard closes or the app comes back, and if the
// visible screen still reaches below the height the bars are placed against, move
// them down by the difference (--vv-shift and .vv-shifted, read by .k-tabbar and
// .k-dock; only then, as a transform would also change how their content is placed).

const nudge = () => requestAnimationFrame(() => {
  const { scrollX, scrollY } = window;
  window.scrollTo(scrollX, scrollY + 1);
  window.scrollTo(scrollX, scrollY);
});

const typing = () => document.activeElement?.matches?.('input, textarea, [contenteditable]');

let reported = false;
function realign(vv) {
  // With the keyboard open the visible screen is shorter: the bars stay put then
  const gap = typing() ? 0 : Math.max(0, Math.round(vv.height + vv.offsetTop - window.innerHeight));
  document.documentElement.style.setProperty('--vv-shift', `${gap}px`);
  document.documentElement.classList.toggle('vv-shifted', gap > 0);
  if (gap > 40 && !reported) {
    reported = true; // once per visit: enough to tell how often it happens
    track('ecran-decale', { ecart: gap, installee: window.navigator.standalone === true ? 'oui' : 'non' });
  }
}

export function settleAfterKeyboard() {
  const vv = window.visualViewport;
  if (!vv || !/iP(hone|ad|od)/.test(navigator.userAgent)) return;

  // The keyboard shows as the visual viewport shrinking well below its full height
  let full = vv.height;
  let open = false;
  const onResize = () => {
    full = Math.max(full, vv.height);
    const nowOpen = vv.height < full - 120;
    if (open && !nowOpen) nudge();
    open = nowOpen;
    realign(vv);
  };
  vv.addEventListener('resize', onResize);
  vv.addEventListener('scroll', () => realign(vv));
  window.addEventListener('orientationchange', () => { full = 0; });

  // Leaving a text field closes the keyboard: settle once its animation is over
  document.addEventListener('focusout', (e) => {
    if (e.target.matches?.('input, textarea')) window.setTimeout(() => { nudge(); realign(vv); }, 350);
  });

  // Back to the app: a keyboard left open on the way out is closed, then the page
  // settles (twice: iOS restores the screen height a moment after showing the app)
  const comeBack = () => {
    if (document.visibilityState !== 'visible') return;
    if (typing()) document.activeElement.blur();
    for (const ms of [50, 400]) window.setTimeout(() => { nudge(); realign(vv); }, ms);
  };
  document.addEventListener('visibilitychange', comeBack);
  window.addEventListener('pageshow', comeBack);
}
