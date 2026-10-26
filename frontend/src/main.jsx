import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './styles/accent.css'
import App from './App.jsx'
import Installer from './views/Installer.jsx'
import { registerSW } from 'virtual:pwa-register'
import { resume } from './utils/resume'
import { countNotificationOpen } from './utils/notifOpen'

// Installed on a phone, the app can stay open in the background for days without
// a full reload, so a new deploy never reached it: look for a new version each time
// it comes back to the foreground, and hourly; autoUpdate then reloads onto it.
registerSW({
  immediate: true,
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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {installer ? <Installer /> : <App />}
  </StrictMode>,
)

// Lift the installed app's splash (index.html) once the first frame is painted
requestAnimationFrame(() => {
  window.__kiosqueReady?.()
  restoreScroll()
})
