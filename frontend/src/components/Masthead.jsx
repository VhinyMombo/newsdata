import { BarChart3, Bell, FileText, LogIn, MessageSquare, Newspaper, Scale } from 'lucide-react';
import { pushSupported } from '../utils/push';

const SECTIONS = [
  { id: 'une', label: 'À la une', short: 'Une', Icon: Newspaper },
  { id: 'assistant', label: 'Assistant', short: 'Assistant', Icon: MessageSquare },
  { id: 'editions', label: 'Éditions', short: 'Éditions', Icon: FileText },
  { id: 'tendances', label: 'Tendances', short: 'Tendances', Icon: BarChart3 },
  { id: 'codes', label: 'Codes de loi', short: 'Lois', Icon: Scale },
  // Not in the phone tab bar, already full: reached there from the newspaper names
  { id: 'journaux', label: 'Journaux', wide: true },
];
const href = (id) => `#/${id === 'une' ? '' : id}`;

function Account({ session }) {
  const { user, openAuth } = session;
  if (user) {
    return (
      <button className="k-account" onClick={() => openAuth('profile')} title="Mon compte">
        <span className="k-avatar">{user.display_name.trim().charAt(0).toUpperCase()}</span>
        <span className="k-account-name">{user.display_name}</span>
      </button>
    );
  }
  return (
    <button className="k-account k-account-login" onClick={() => openAuth('login')} aria-label="Se connecter">
      <LogIn size={15} /><span className="k-account-name">Se connecter</span>
    </button>
  );
}

export default function Masthead({ view, health, session }) {
  const { apiStatus, lastChecked, checkApi } = health;
  const time = lastChecked?.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const statusLabel = apiStatus === 'online' ? 'Service disponible' : apiStatus === 'offline' ? 'Service indisponible' : 'Connexion…';
  return (
    <>
      <a className="k-skip" href="#contenu" onClick={(e) => { e.preventDefault(); document.getElementById('contenu')?.focus(); }}>Aller au contenu</a>
      <header className="k-header">
        <div className="k-wrap k-header-row">
          <a className="k-brand" href="#/" aria-label="Le Kiosque, accueil">
            <img src="/icons/icon-192.png" alt="" width="30" height="30" />
            <span className="k-brand-name">Le Kiosque</span>
          </a>
          <nav className="k-nav" aria-label="Rubriques">
            {SECTIONS.map(s => (
              <a key={s.id} href={href(s.id)} aria-current={view === s.id ? 'page' : undefined}>{s.label}</a>
            ))}
          </nav>
          <div className="k-header-tools">
            <button className={`k-status ${apiStatus}`} onClick={checkApi} title={time ? `${statusLabel}, vérifié à ${time}. Cliquer pour revérifier.` : statusLabel} aria-label={statusLabel}>
              <i aria-hidden="true" />
            </button>
            {pushSupported && (
              <a className="k-bell" href="#/notifications" aria-current={view === 'notifications' ? 'page' : undefined} aria-label="Notifications" title="Notifications">
                <Bell size={17} strokeWidth={1.7} />
              </a>
            )}
            <Account session={session} />
            {view !== 'assistant' && <a className="k-btn primary k-header-cta" href="#/assistant">Poser une question</a>}
          </div>
        </div>
      </header>
      {apiStatus === 'offline' && (
        <div className="k-wrap">
          <div className="k-offline" role="alert">
            Le service ne répond pas pour le moment : les réponses et les éditions sont indisponibles.
            <button onClick={checkApi}>Réessayer</button>
          </div>
        </div>
      )}
      <nav className="k-tabbar" aria-label="Rubriques">
        {SECTIONS.filter(s => !s.wide).map(s => {
          const Icon = s.Icon;
          return (
            <a key={s.id} href={href(s.id)} aria-current={view === s.id ? 'page' : undefined}>
              <Icon size={20} strokeWidth={1.6} /><span>{s.short}</span>
            </a>
          );
        })}
      </nav>
    </>
  );
}
