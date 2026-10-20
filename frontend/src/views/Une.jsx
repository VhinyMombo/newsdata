import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, BellOff, Flame, Search, Star } from 'lucide-react';
import { API_URL, authHeaders } from '../utils/api';
import { clock, longDate, sourceLabel } from '../utils/format';
import { computeFollowDeltas } from '../utils/categories';

const LANDING_LAST_VISIT_KEY = 'lekiosque_landing_last_seen_date';

function AskBox({ ask }) {
  const [q, setQ] = useState('');
  return (
    <form className="k-askbox" onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask(q.trim()); }}>
      <label htmlFor="une-ask" className="sr-only">Poser une question sur l'actualité gabonaise</label>
      <Search size={18} aria-hidden="true" />
      <input id="une-ask" value={q} onChange={e => setQ(e.target.value)} placeholder="Une question à la presse gabonaise…" autoComplete="off" />
      <button type="submit" disabled={!q.trim()}>Demander</button>
    </form>
  );
}

function Meta({ a }) {
  const t = clock(a.time);
  return <p className="k-meta"><span className="k-src">{sourceLabel(a.source)}</span>{t && <> · <time>{t}</time></>}</p>;
}

function Headline({ a, size = 'm', lede = true }) {
  return (
    <article className={`k-story k-story-${size}`}>
      <h3><a href={a.url} target="_blank" rel="noreferrer">{a.title}</a></h3>
      {lede && a.lede && <p className="k-lede">{a.lede}</p>}
      <Meta a={a} />
    </article>
  );
}

// "Since your last visit": the followed topics that moved, for a signed-in reader
function SinceLastVisit({ session, corpus, ask }) {
  const { user, authToken } = session;
  const [follows, setFollows] = useState([]);
  const [lastSeen] = useState(() => localStorage.getItem(LANDING_LAST_VISIT_KEY));
  useEffect(() => {
    if (!user || !authToken) return;
    fetch(`${API_URL}/follows`, { headers: authHeaders(authToken) })
      .then(r => (r.ok ? r.json() : []))
      .then(setFollows)
      .catch(() => setFollows([]));
  }, [user, authToken]);
  const active = user ? follows : [];
  const { load, data, dateMax } = corpus;
  useEffect(() => { if (active.length) load(); }, [active.length, load]);
  useEffect(() => { if (dateMax) localStorage.setItem(LANDING_LAST_VISIT_KEY, dateMax); }, [dateMax]);
  const deltas = useMemo(() => computeFollowDeltas(data?.points, active, lastSeen, dateMax), [data, active, lastSeen, dateMax]);

  if (!user) return null;
  if (!active.length) {
    return <p className="k-hint"><Star size={12} /> Suivez un sujet, une source ou un mot-clé dans <a href="#/tendances">Tendances</a> pour retrouver ici ce qui a bougé.</p>;
  }
  if (!deltas.length) return null;
  return (
    <section className="k-since" aria-label="Depuis votre dernière visite">
      <span className="k-kicker">Depuis votre dernière visite, {user.display_name.split(' ')[0]}</span>
      <div className="k-chips">
        {deltas.slice(0, 6).map(d => (
          <button key={`${d.type}-${d.value}`} className={`k-chip ${d.status}`}
            onClick={() => ask(d.status === 'quiet' ? `Que s'est-il passé récemment sur ${d.label} ?` : `Que disent les articles récents sur ${d.label} ?`)}>
            {d.status === 'spiked' && <Flame size={12} />}
            {d.status === 'quiet' && <BellOff size={12} />}
            {d.status === 'new' && <Star size={12} />}
            {d.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export default function Une({ ask, session, corpus, health, reports }) {
  const [today, setToday] = useState(null);
  const [error, setError] = useState(null);
  const fetchToday = () => fetch(`${API_URL}/today`)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`Erreur ${r.status}`))))
    .then(setToday)
    .catch(e => setError(e.message));
  const load = () => { setError(null); fetchToday(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchToday(); }, []);

  if (error) {
    return (
      <div className="k-page">
        <AskBox ask={ask} />
        <div className="k-empty"><p>La une n'a pas pu être chargée ({error}).</p><button className="k-btn" onClick={load}>Réessayer</button></div>
      </div>
    );
  }
  if (!today) {
    return (
      <div className="k-page">
        <AskBox ask={ask} />
        <div className="k-une k-loading" aria-busy="true"><div className="k-skel-block" /><div className="k-skel-block" /></div>
      </div>
    );
  }

  const [lead, ...rest] = today.themes;
  const isToday = today.date === (today.gabon_today || health.gabonToday);
  const latestReport = reports.newSinceVisit > 0;

  return (
    <div className="k-page">
      <p className="k-edition">
        {isToday ? 'Édition du ' : 'Dernière collecte : '}{longDate(today.date)}
        <span> · {today.count} articles de {today.sources} sources</span>
      </p>
      <AskBox ask={ask} />
      <SinceLastVisit session={session} corpus={corpus} ask={ask} />

      {today.count === 0 ? (
        <div className="k-empty"><p>Aucun article collecté pour cette journée.</p></div>
      ) : (
        <>
          <div className="k-front">
            <section className="k-lead" aria-labelledby="une-lead">
              <span className="k-kicker" id="une-lead">À la une · {lead.name}</span>
              <Headline a={lead.articles[0]} size="xl" />
              <div className="k-lead-more">
                {lead.articles.slice(1, 4).map(a => <Headline key={a.url} a={a} size="s" lede={false} />)}
              </div>
              {lead.articles.length > 4 && (
                <ul className="k-also" aria-label={`Aussi en ${lead.name}`}>
                  {lead.articles.slice(4).map(a => <li key={a.url}><a href={a.url} target="_blank" rel="noreferrer">{a.title}</a><span className="k-src">{sourceLabel(a.source)}</span></li>)}
                </ul>
              )}
              <button className="k-link" onClick={() => ask(`Que disent les articles récents sur le thème ${lead.name} ?`)}>
                Demander à l'assistant ce qu'en dit la presse <ArrowRight size={14} />
              </button>
            </section>

            <aside className="k-rail">
              <a className="k-briefing" href="#/editions/jour">
                <span className="k-kicker">Le point du jour</span>
                <strong>L'essentiel de la journée, rédigé à partir de tous les titres.</strong>
                <span className="k-link">Lire le point du jour <ArrowRight size={14} /></span>
                {latestReport && <span className="k-badge">{reports.newSinceVisit} nouvelle{reports.newSinceVisit > 1 ? 's' : ''} édition{reports.newSinceVisit > 1 ? 's' : ''}</span>}
              </a>
              <section aria-labelledby="une-fil">
                <h2 className="k-kicker" id="une-fil">Le fil</h2>
                <ol className="k-wire">
                  {today.latest.slice(0, 8).map(a => (
                    <li key={a.url}>
                      <time>{clock(a.time) || '—'}</time>
                      <div><a href={a.url} target="_blank" rel="noreferrer">{a.title}</a><span className="k-src">{sourceLabel(a.source)}</span></div>
                    </li>
                  ))}
                </ol>
              </section>
            </aside>
          </div>

          <div className="k-sections">
            {rest.map(t => (
              <section key={t.name} className="k-section" aria-labelledby={`sec-${t.name}`}>
                <header>
                  <h2 id={`sec-${t.name}`}>{t.name}</h2>
                  <span className="k-muted">{t.count} article{t.count > 1 ? 's' : ''}</span>
                </header>
                <Headline a={t.articles[0]} size="m" />
                <ul className="k-titles">
                  {t.articles.slice(1).map(a => (
                    <li key={a.url}><a href={a.url} target="_blank" rel="noreferrer">{a.title}</a><span className="k-src">{sourceLabel(a.source)}</span></li>
                  ))}
                </ul>
                <button className="k-link" onClick={() => ask(`Que disent les articles récents sur le thème ${t.name} ?`)}>
                  Interroger l'assistant <ArrowRight size={14} />
                </button>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
