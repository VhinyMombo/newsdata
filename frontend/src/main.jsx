import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import './styles/accent.css'
import App from './App.jsx'
import { registerSW } from 'virtual:pwa-register'

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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
