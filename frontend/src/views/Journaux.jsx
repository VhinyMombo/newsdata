import { useEffect, useState } from 'react';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { API_URL } from '../utils/api';
import { longDate, siteName, SOURCE_LABELS, SOURCE_SITES, sourceLabel } from '../utils/format';
import { Thinking } from '../utils/text';
import Story from '../components/Story';

const byName = Object.keys(SOURCE_LABELS).sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b), 'fr'));

function SiteLink({ source, className = 'k-btn' }) {
  if (!SOURCE_SITES[source]) return null;
  return (
    <a className={className} href={SOURCE_SITES[source]} target="_blank" rel="noopener">
      {siteName(source)}<ArrowUpRight size={15} aria-hidden="true" />
    </a>
  );
}

// #/journaux: every newspaper in the Kiosque, each with its page and its own site
function Index() {
  return (
    <div className="k-wrap k-page">
      <header className="k-page-head">
        <span className="k-eyebrow">Les journaux</span>
        <h1 className="k-title">La presse gabonaise du Kiosque</h1>
        <p className="k-dek">Le Kiosque rassemble ces journaux pour vous donner à lire plusieurs titres plutôt qu'un seul. Chaque article s'ouvre sur le site du journal qui l'a publié.</p>
      </header>
      <ul className="k-journals">
        {byName.map(s => (
          <li key={s}>
            <a className="k-journal-name" href={`#/journal/${s}`}>{sourceLabel(s)}<ArrowRight size={16} aria-hidden="true" /></a>
            <SiteLink source={s} className="k-journal-site" />
          </li>
        ))}
      </ul>
    </div>
  );
}

// #/journal/<source>: one newspaper's latest articles, grouped by day
function Journal({ source, ask }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = () => {
    setError(null);
    setData(null);
    fetch(`${API_URL}/journal/${encodeURIComponent(source)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`erreur ${r.status}`))))
      .then(setData)
      .catch(e => setError(e.message));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [source]);

  const days = [];
  for (const a of data?.articles || []) {
    const d = a.time.slice(0, 10);
    if (days.at(-1)?.date !== d) days.push({ date: d, articles: [] });
    days.at(-1).articles.push(a);
  }
  const dayLabel = (d) => (d === data?.gabon_today ? "Aujourd'hui" : longDate(d));
  const name = sourceLabel(source);

  return (
    <div className="k-wrap k-page k-journal">
      <header className="k-page-head">
        <span className="k-eyebrow"><a href="#/journaux">Les journaux</a></span>
        <h1 className="k-title">{name}</h1>
        <p className="k-dek">Ses derniers articles dans Le Kiosque. Touchez un titre pour que l'assistant l'explique, ou lisez-le sur le site du journal.</p>
        <div className="k-journal-actions">
          <SiteLink source={source} className="k-btn primary" />
          <button className="k-btn" onClick={() => ask(`Que publie ${name} ces derniers jours ?`)}>Résumer avec l'assistant</button>
        </div>
      </header>
      {error ? (
        <div className="k-empty"><p>Les articles n'ont pas pu être chargés ({error}).</p><button className="k-btn" onClick={load}>Réessayer</button></div>
      ) : !data ? (
        <Thinking phrases={['Chargement des articles…']} />
      ) : !days.length ? (
        <div className="k-empty"><p>Pas d'article de {name} dans Le Kiosque ces trente derniers jours.</p></div>
      ) : (
        days.map(d => (
          <section key={d.date} className="k-journal-day" aria-label={dayLabel(d.date)}>
            <h2 className="k-label">{dayLabel(d.date)}</h2>
            <ul className="k-list">
              {d.articles.map(a => <li key={a.url}><Story ask={ask} a={a} size="xs" /></li>)}
            </ul>
          </section>
        ))
      )}
      <nav className="k-journal-others" aria-label="Les autres journaux">
        <h2 className="k-label">Les autres journaux</h2>
        <div className="k-chips">
          {byName.filter(s => s !== source).map(s => <a key={s} className="k-chip" href={`#/journal/${s}`}>{sourceLabel(s)}</a>)}
        </div>
      </nav>
    </div>
  );
}

export default function Journaux({ sub, ask }) {
  return SOURCE_LABELS[sub] ? <Journal source={sub} ask={ask} /> : <Index />;
}
