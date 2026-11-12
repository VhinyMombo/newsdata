import { StrictMode, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './styles/accent.css'
import App from './App.jsx'
import Installer from './views/Installer.jsx'
import { registerSW } from 'virtual:pwa-register'
import { resume } from './utils/resume'
import { countNotificationOpen } from './utils/notifOpen'
import { countNewspaperClicks } from './utils/outbound'
import { settleAfterKeyboard } from './utils/keyboard'
import { isBusy } from './utils/lock'
import { CLERK_KEY } from './hooks/clerkBridge'

// A new version takes over a few seconds after the page opens. Reloading onto it
// then swallowed the reader's first click or the question being typed: reload at
// once only while the reader has not touched anything yet, otherwise at the next
// safe moment (page hidden, or a move to another section, with nothing typed).
let touched = false
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => { touched = true }, { capture: true, once: true })
const typedSomething = () => [...document.querySelectorAll('input, textarea')].some(el => el.type !== 'hidden' && el.value.trim())
const safe = () => !isBusy() && !typedSomething()
function reloadWhenSafe() {
  if (!touched && !isBusy()) { window.location.reload(); return }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && safe()) window.location.reload() })
  // Not on the way to the assistant: the question just asked would be lost
  window.addEventListener('hashchange', () => { if (safe() && !/^#\/assistant/.test(window.location.hash)) window.location.reload() })
}

// Installed on a phone, the app can stay open in the background for days without
// a full reload, so a new deploy never reached it: look for a new version each time
// it comes back to the foreground, and hourly; autoUpdate then reloads onto it.
registerSW({
  immediate: true,
  onNeedReload: reloadWhenSafe,
  onRegisteredSW(_url, reg) {
    if (!reg) return
    const check = () => { if (document.visibilityState === 'visible') reg.update() }
    document.addEventListener('visibilitychange', check)
    setInterval(check, 60 * 60 * 1000)
  },
})

// The shared install link gets its own light page: the app would first pull the 20 MB
// corpus export, a heavy start on a phone's data plan for someone who has not chosen yet
const installer = window.location.pathname.replace(/\/+$/, '') === '/installer'
const restoreScroll = installer ? () => {} : resume()
countNotificationOpen()
window.addEventListener('hashchange', countNotificationOpen)
countNewspaperClicks()
settleAfterKeyboard()

const root = createRoot(document.getElementById('root'))
const render = (app) => root.render(<StrictMode>{app}</StrictMode>)

// With Clerk's key in the build, Clerk proves who signs in (hooks/clerkBridge.js); its
// code is fetched only then
if (!installer && CLERK_KEY) {
  const RETRY_KEY = 'kiosque_clerk_retry'
  import('./components/ClerkRoot.jsx')
    .then(m => {
      try { sessionStorage.removeItem(RETRY_KEY) } catch { /* no storage */ }
      render(createElement(m.default, null, <App />))
    })
    .catch(err => {
      // Most often a page kept from before an update, asking for a file the server no
      // longer has: reload. Only once a minute, so a lasting failure cannot loop; the
      // site's own sign-in then still works.
      console.error('[Kiosque] Clerk not loaded:', err)
      let last = 0
      try { last = Number(sessionStorage.getItem(RETRY_KEY)) || 0; sessionStorage.setItem(RETRY_KEY, String(Date.now())) } catch { last = Date.now() }
      if (Date.now() - last > 60_000) window.location.reload()
      else render(<App />)
    })
} else {
  render(installer ? <Installer /> : <App />)
}

// Lift the installed app's splash (index.html) once the first frame is painted
requestAnimationFrame(() => {
  window.__kiosqueReady?.()
  restoreScroll()
})
