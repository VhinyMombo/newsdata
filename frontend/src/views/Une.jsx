import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, BellOff, Flame, Search, Sparkles, Star } from 'lucide-react';
import { API_URL, authHeaders } from '../utils/api';
import { clock, longDate, sourceLabel } from '../utils/format';
import { computeFollowDeltas } from '../utils/categories';

// The catch-all buckets of normalize_category (api.py): a label that says nothing
const GENERIC_THEMES = new Set(['Non classé', 'Autres']);

const LANDING_LAST_VISIT_KEY = 'lekiosque_landing_last_seen_date';
const EXAMPLES = ['Que retenir de la journée ?', 'Où en est la réforme du titre foncier ?', 'Que se passe-t-il avec la SEEG ?'];
const GENERIC = new Set(['Non classé', 'Autres']);
const anchor = (name) => `theme-${name.normalize('NFD').replace(/[^a-zA-Z]+/g, '-').toLowerCase()}`;

function AskBox({ ask }) {
  const [q, setQ] = useState('');
  return (
    <div className="k-ask">
      <form className="k-askbox" onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask(q.trim()); }}>
        <label htmlFor="une-ask" className="sr-only">Poser une question sur l'actualité gabonaise</label>
        <Search size={20} aria-hidden="true" />
        <input id="une-ask" value={q} onChange={e => setQ(e.target.value)} placeholder="Posez votre question…" autoComplete="off" enterKeyHint="search" />
        <button type="submit" className="k-btn primary" disabled={!q.trim()}>Demander</button>
      </form>
      <div className="k-examples">
        <span className="k-muted">Par exemple</span>
        {EXAMPLES.map(s => <button key={s} className="k-chip" onClick={() => ask(s)}>{s}</button>)}
      </div>
    </div>
  );
}

// A click on an article goes to the assistant first: it explains the article
// and its context, and cites it first with the link to the newspaper's site
function explain(ask, a) {
  return (e) => {
    e.preventDefault();
    ask(`Que dit cet article et dans quel contexte s'inscrit-il : « ${a.title.slice(0, 300)} » ?`, 'presse',
      { url: a.url, title: a.title, source: a.source, date: (a.time || '').slice(0, 10) });
  };
}

// An article: the whole card opens the assistant (the mark says so), and
// "Lire l'article" opens the original on the newspaper's site
function Story({ a, ask, size = 'm', lede = true }) {
  const t = clock(a.time);
  return (
    <article className={`k-story k-story-${size}`}>
      <a className="k-story-ask" href="#/assistant" onClick={explain(ask, a)}>
        <h3>{a.title}</h3>
        {lede && a.lede && <p className="k-lede">{a.lede}</p>}
      </a>
      <p className="k-meta">
        <span className="k-src">{sourceLabel(a.source)}</span>{t && <> · <time>{t}</time></>}
        {a.url && (
          <a className="k-story-read" href={a.url} target="_blank" rel="noopener" aria-label={`Lire l'article sur le site de ${sourceLabel(a.source)}`}>
            Lire l'article<ArrowUpRight size={13} aria-hidden="true" />
          </a>
        )}
        <Sparkles size={14} aria-label="expliqué par l'assistant" />
      </p>
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
  const active = useMemo(() => (user ? follows : []), [user, follows]);
  const { load, data, dateMax } = corpus;
  useEffect(() => { if (active.length) load(); }, [active.length, load]);
  useEffect(() => { if (dateMax) localStorage.setItem(LANDING_LAST_VISIT_KEY, dateMax); }, [dateMax]);
  const deltas = useMemo(() => computeFollowDeltas(data?.points, active, lastSeen, dateMax), [data, active, lastSeen, dateMax]);

  if (!user) return null;
  if (!active.length) {
    return <p className="k-hint"><Star size={13} /><span>Astuce : suivez un sujet, un journal ou un mot-clé dans <a href="#/tendances">Tendances</a> (icône étoile) pour retrouver ici ce qui a bougé.</span></p>;
  }
  if (!deltas.length) return null;
  return (
    <section className="k-since" aria-label="Depuis votre dernière visite">
      <span className="k-eyebrow">Depuis votre dernière visite, {user.display_name.split(' ')[0]}</span>
      <div className="k-chips">
        {deltas.slice(0, 6).map(d => (
          <button key={`${d.type}-${d.value}`} className={`k-chip ${d.status}`}
            onClick={() => ask(d.status === 'quiet' ? `Que s'est-il passé récemment sur ${d.label} ?` : `Que disent les articles récents sur ${d.label} ?`)}>
            {d.status === 'spiked' && <Flame size={13} />}
            {d.status === 'quiet' && <BellOff size={13} />}
            {d.status === 'new' && <Star size={13} />}
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
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`erreur ${r.status}`))))
    .then(setToday)
    .catch(e => setError(e.message));
  const load = () => { setError(null); fetchToday(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchToday(); }, []);

  const isToday = today && today.date === (today.gabon_today || health.gabonToday);
  const edition = today ? `${isToday ? 'Édition du' : 'Dernière collecte :'} ${longDate(today.date)}` : 'Presse gabonaise';
  const [lead, ...rest] = today?.themes || [];
  // Topics with a single article, or no real topic, read better as one short list
  const sections = rest.filter(t => t.count >= 2 && !GENERIC.has(t.name));
  const brief = rest.filter(t => !sections.includes(t)).flatMap(t => t.articles.map(a => ({ ...a, theme: t.name })));
  const shortcuts = today?.themes.filter(t => t.count >= 2 && !GENERIC.has(t.name)) || [];

  return (
    <>
      <section className="k-hero-band">
        <div className="k-wrap">
          <span className="k-eyebrow">{edition}</span>
          <h1 className="k-display">Ce que dit la presse gabonaise, <em>aujourd'hui</em></h1>
          <p className="k-dek">
            {today
              ? `${today.count} articles de la presse gabonaise ${isToday ? 'depuis ce matin' : 'ce jour-là'}, mis à jour toutes les heures.`
              : 'Les articles de la presse gabonaise, mis à jour toutes les heures.'}
            {' '}Parcourez l'essentiel ou posez une question : chaque réponse cite les articles d'où elle vient.
          </p>
          <AskBox ask={ask} />
          <SinceLastVisit session={session} corpus={corpus} ask={ask} />
        </div>
      </section>

      <div className="k-wrap k-page">
        {error ? (
          <div className="k-empty"><p>La une n'a pas pu être chargée ({error}).</p><button className="k-btn" onClick={load}>Réessayer</button></div>
        ) : !today ? (
          <div className="k-loading" aria-busy="true"><div className="k-skel-block" /><div className="k-skel-block" /></div>
        ) : today.count === 0 ? (
          <div className="k-empty"><p>Aucun article collecté pour cette journée.</p></div>
        ) : (
          <>
            <nav className="k-topics" aria-label="Les sujets du jour">
              <span className="k-label">Les sujets du jour</span>
              {shortcuts.map(t => (
                <a key={t.name} className="k-chip" href={`#${anchor(t.name)}`}
                  onClick={(e) => { e.preventDefault(); document.getElementById(anchor(t.name))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>
                  {t.name} <b>{t.count}</b>
                </a>
              ))}
            </nav>

            <div className="k-front">
              <section className="k-lead" id={anchor(lead.name)} aria-labelledby="une-lead">
                <span className="k-eyebrow" id="une-lead">À la une · {lead.name}</span>
                <Story ask={ask} a={lead.articles[0]} size="xl" />
                <div className="k-grid3">
                  {lead.articles.slice(1, 4).map(a => <Story ask={ask} key={a.url} a={a} size="s" lede={false} />)}
                </div>
                {lead.articles.length > 4 && (
                  <ul className="k-list" aria-label={`Aussi en ${lead.name}`}>
                    {lead.articles.slice(4).map(a => <li key={a.url}><Story ask={ask} a={a} size="xs" lede={false} /></li>)}
                  </ul>
                )}
                <button className="k-btn" onClick={() => ask(`Que disent les articles récents sur le thème ${lead.name} ?`)}>
                  Résumer ce sujet avec l'assistant <ArrowRight size={15} />
                </button>
              </section>

              <aside className="k-rail">
                <a className="k-briefing" href="#/editions/jour">
                  <span className="k-eyebrow">Le point du jour</span>
                  <strong>L'essentiel de la journée en deux minutes de lecture</strong>
                  <span>Rédigé à partir de tous les titres du jour, avec un PDF à partager.</span>
                  <span className="k-briefing-cta">Lire le point du jour <ArrowRight size={15} /></span>
                  {reports.newSinceVisit > 0 && <span className="k-badge">{reports.newSinceVisit} nouvelle{reports.newSinceVisit > 1 ? 's' : ''} édition{reports.newSinceVisit > 1 ? 's' : ''}</span>}
                </a>
                <section aria-labelledby="une-fil">
                  <h2 className="k-label" id="une-fil">Les derniers articles</h2>
                  <ol className="k-wire">
                    {today.latest.slice(0, 8).map(a => (
                      <li key={a.url}>
                        <a className="k-wire-ask" href="#/assistant" onClick={explain(ask, a)}>
                          <time>{clock(a.time) || '—'}</time>
                          <span>{a.title}</span>
                        </a>
                        {/* As on the cards: the title opens the assistant, "Lire l'article" the newspaper's site */}
                        <p className="k-wire-meta">
                          <span className="k-src">{sourceLabel(a.source)}</span>
                          {a.url && (
                            <a className="k-story-read" href={a.url} target="_blank" rel="noopener" aria-label={`Lire l'article sur le site de ${sourceLabel(a.source)}`}>
                              Lire l'article<ArrowUpRight size={12} aria-hidden="true" />
                            </a>
                          )}
                        </p>
                      </li>
                    ))}
                  </ol>
                </section>
              </aside>
            </div>
          </>
        )}
      </div>

      {(sections.length > 0 || brief.length > 0) && (
        <section className="k-band" aria-label="Les autres sujets">
          <div className="k-wrap">
            <span className="k-eyebrow">Les autres sujets</span>
            <div className="k-sections">
              {sections.map(t => (
                <section key={t.name} id={anchor(t.name)} className="k-section" aria-labelledby={`sec-${anchor(t.name)}`}>
                  <header>
                    <h2 id={`sec-${anchor(t.name)}`}>{t.name}</h2>
                    <span className="k-muted">{t.count} article{t.count > 1 ? 's' : ''}</span>
                  </header>
                  <Story ask={ask} a={t.articles[0]} size="m" />
                  <ul className="k-list">
                    {t.articles.slice(1).map(a => <li key={a.url}><Story ask={ask} a={a} size="xs" lede={false} /></li>)}
                  </ul>
                  <button className="k-textlink" onClick={() => ask(`Que disent les articles récents sur le thème ${t.name} ?`)}>
                    Résumer avec l'assistant <ArrowRight size={14} />
                  </button>
                </section>
              ))}
              {brief.length > 0 && (
                <section className="k-section" aria-labelledby="sec-bref">
                  <header>
                    <h2 id="sec-bref">En bref</h2>
                    <span className="k-muted">{brief.length} article{brief.length > 1 ? 's' : ''}</span>
                  </header>
                  <ul className="k-list">
                    {brief.slice(0, 10).map(a => (
                      <li key={a.url}>{!GENERIC_THEMES.has(a.theme) && <span className="k-label k-brief-theme">{a.theme}</span>}<Story ask={ask} a={a} size="xs" lede={false} /></li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>
        </section>
      )}
      {/* Google shows the app's name on its sign-in page only when the home page links the privacy policy */}
      <p className="k-wrap k-legal"><a href="/confidentialite.html">Confidentialité</a></p>
    </>
  );
}
