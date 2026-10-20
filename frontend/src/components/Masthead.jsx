import { BarChart3, FileText, LogIn, MessageSquare, Newspaper, Scale } from 'lucide-react';

const SECTIONS = [
  { id: 'une', label: 'À la une', short: 'Une', Icon: Newspaper },
  { id: 'assistant', label: 'Assistant', short: 'Assistant', Icon: MessageSquare },
  { id: 'editions', label: 'Éditions', short: 'Éditions', Icon: FileText },
  { id: 'tendances', label: 'Tendances', short: 'Tendances', Icon: BarChart3 },
  { id: 'codes', label: 'Codes de loi', short: 'Codes', Icon: Scale },
];

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

function Status({ health }) {
  const { apiStatus, lastChecked, checkApi } = health;
  const label = apiStatus === 'online' ? 'En ligne' : apiStatus === 'offline' ? 'Hors ligne' : 'Connexion…';
  const time = lastChecked?.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return (
    <button className={`k-status ${apiStatus}`} onClick={checkApi} title={time ? `Vérifié à ${time}. Cliquer pour revérifier.` : 'Vérification…'}>
      <i aria-hidden="true" />{label}
    </button>
  );
}

export default function Masthead({ view, health, session }) {
  const today = health.gabonToday ? new Date(`${health.gabonToday}T12:00:00`) : new Date();
  const dateLine = today.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <>
      <a className="k-skip" href="#contenu" onClick={(e) => { e.preventDefault(); document.getElementById('contenu')?.focus(); }}>Aller au contenu</a>
      <header className="k-masthead">
        <div className="k-topline">
          <span className="k-dateline">{dateLine}</span>
          <div className="k-topline-right">
            {health.articles != null && <span className="k-count">{health.articles.toLocaleString('fr-FR')} articles</span>}
            <Status health={health} />
            <Account session={session} />
          </div>
        </div>
        <a className="k-brand" href="#/" aria-label="Le Kiosque, accueil">
          <img src="/icons/icon-192.png" alt="" width="40" height="40" />
          <span className="k-brand-name">Le Kiosque</span>
        </a>
        <p className="k-tagline">La presse gabonaise, lue et interrogée</p>
      </header>
      <nav className="k-nav" aria-label="Rubriques">
          {SECTIONS.map(s => (
            <a key={s.id} href={`#/${s.id === 'une' ? '' : s.id}`} className={view === s.id ? 'on' : ''} aria-current={view === s.id ? 'page' : undefined}>
              {s.label}
            </a>
          ))}
      </nav>
      {health.apiStatus === 'offline' && (
        <div className="k-offline" role="alert">
          L'API ne répond pas. Les réponses et les éditions sont indisponibles. Lancez <code>python api.py</code>, puis
          <button onClick={health.checkApi}>réessayez</button>.
        </div>
      )}
      <nav className="k-tabbar" aria-label="Rubriques">
        {SECTIONS.map(s => {
          const Icon = s.Icon;
          return (
            <a key={s.id} href={`#/${s.id === 'une' ? '' : s.id}`} className={view === s.id ? 'on' : ''} aria-current={view === s.id ? 'page' : undefined}>
              <Icon size={20} strokeWidth={1.6} /><span>{s.short}</span>
            </a>
          );
        })}
      </nav>
    </>
  );
}
