import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown } from 'lucide-react';
import { computeMoving } from '../utils/trends';
import { shortDate, sourceLabel } from '../utils/format';

const fr = (n, d = 0) => n.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: d });
const plural = (n, w) => `${fr(n)} ${w}${n > 1 ? 's' : ''}`;

function usualText(usual) {
  if (usual < 0.5) return 'presque jamais cité avant';
  if (usual < 1.5) return "environ 1 par semaine d'habitude";
  return `environ ${fr(usual)} par semaine d'habitude`;
}

// Twelve weeks of a topic, the current week last and in green. Weeks without collection stay blank.
function Spark({ weeks, gaps }) {
  const max = Math.max(...weeks, 1);
  const w = 6;
  const gap = 3;
  return (
    <svg className="k-spark" viewBox={`0 0 ${weeks.length * (w + gap)} 28`} aria-hidden="true">
      {weeks.map((v, i) => (gaps[i] ? null : (
        <rect key={i} x={i * (w + gap)} y={28 - Math.max(2, (v / max) * 28)} width={w} height={Math.max(2, (v / max) * 28)}
          rx="1" className={i === weeks.length - 1 ? 'now' : ''} />
      )))}
    </svg>
  );
}

function Sources({ list }) {
  return <p className="k-move-sources">{list.slice(0, 4).map(sourceLabel).join(', ')}{list.length > 4 ? ` et ${list.length - 4} autre${list.length > 5 ? 's' : ''}` : ''}</p>;
}

function NameCard({ t, ask, lead }) {
  // the headline that actually carries the label ("Cour constitutionnelle", not "Cour des comptes")
  const a = t.articles.find(x => x.title.includes(t.label)) || t.articles[0];
  return (
    <article className={`k-move-card ${lead ? 'lead' : ''}`}>
      <header>
        <h3>{t.label}</h3>
        <span className="k-move-badge">{t.isNew ? 'Nouveau' : `×${fr(t.lift, t.lift < 10 ? 1 : 0)}`}</span>
      </header>
      <p className="k-move-count"><b>{plural(t.count, 'article')}</b> cette semaine, {usualText(t.usual)}</p>
      <a className="k-move-headline" href={a.url} target="_blank" rel="noreferrer">{a.title}<ArrowUpRight size={13} aria-label="ouvre le site du journal" /></a>
      {lead && t.articles.length > 1 && (
        <ul className="k-move-more">
          {t.articles.filter(x => x !== a).slice(0, 4).map(x => (
            <li key={x.id}><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a><span>{sourceLabel(x.source)}</span></li>
          ))}
        </ul>
      )}
      <Sources list={t.sources} />
      <button className="k-textlink" onClick={() => ask(`Que se passe-t-il cette semaine avec ${t.label} ?`)}>
        Demander à l'assistant <ArrowRight size={14} />
      </button>
    </article>
  );
}

function TopicRow({ s, ask, up }) {
  const pct = s.change === null ? null : Math.round(s.change * 100);
  return (
    <li>
      <button className="k-move-topic" onClick={() => ask(up ? `Que disent les articles récents sur le thème ${s.name} ?` : `Où en est le sujet ${s.name} ?`)}>
        <span className="k-move-topic-name">{s.name}</span>
        <Spark weeks={s.weeks} gaps={s.gaps} />
        <span className={`k-move-delta ${up ? 'up' : 'down'}`}>
          {up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
          {pct === null ? 'nouveau' : `${pct > 0 ? '+' : ''}${fr(pct)} %`}
        </span>
        <span className="k-muted k-move-topic-n">{fr(s.now)} contre {fr(s.usual)}</span>
      </button>
    </li>
  );
}

export default function Moving({ data, ask, children }) {
  const m = useMemo(() => computeMoving(data.points), [data]);
  const [details, setDetails] = useState(false);
  if (!m) return <div className="k-empty"><p>Pas encore assez d'articles pour dégager des tendances.</p></div>;
  const vsUsual = m.usualWeek ? Math.round(((m.week - m.usualWeek) / m.usualWeek) * 100) : null;
  const [lead, ...others] = m.names;

  return (
    <div className="k-moving">
      <p className="k-move-week">
        Semaine du {shortDate(m.start)} au {shortDate(m.end)} : <b>{plural(m.week, 'article')}</b> de {m.sources} journaux
        {vsUsual !== null && Math.abs(vsUsual) >= 5 && <>, {vsUsual > 0 ? `${fr(vsUsual)} % de plus` : `${fr(-vsUsual)} % de moins`} qu'une semaine ordinaire</>}.
        {' '}Comparé aux huit semaines précédentes.
      </p>

      {m.names.length > 0 && (
        <section aria-labelledby="mv-names">
          <span className="k-eyebrow" id="mv-names">Les noms qui reviennent cette semaine</span>
          <div className="k-move-grid">
            {lead && <NameCard t={lead} ask={ask} lead />}
            {others.map(t => <NameCard key={t.label} t={t} ask={ask} />)}
          </div>
        </section>
      )}

      <div className="k-move-split">
        {m.rising.length > 0 && (
          <section aria-labelledby="mv-up">
            <span className="k-eyebrow" id="mv-up">Les sujets qui montent</span>
            <ul className="k-move-topics">{m.rising.map(s => <TopicRow key={s.name} s={s} ask={ask} up />)}</ul>
          </section>
        )}
        {m.fading.length > 0 && (
          <section aria-labelledby="mv-down">
            <span className="k-eyebrow" id="mv-down">Les sujets qui retombent</span>
            <ul className="k-move-topics">{m.fading.map(s => <TopicRow key={s.name} s={s} ask={ask} />)}</ul>
          </section>
        )}
      </div>

      {m.widely.length > 0 && (
        <section className="k-move-wide" aria-labelledby="mv-wide">
          <span className="k-eyebrow" id="mv-wide">Repris par toute la presse</span>
          <ol>
            {m.widely.map(t => (
              <li key={t.label}>
                <button onClick={() => ask(`Que disent les journaux cette semaine sur ${t.label} ?`)}>
                  <strong>{t.label}</strong>
                  <span className="k-move-dots" aria-label={`${t.sources.length} journaux sur ${m.sources}`}>
                    {Array.from({ length: m.sources }, (_, i) => <i key={i} className={i < t.sources.length ? 'on' : ''} />)}
                  </span>
                  <span className="k-muted">{t.sources.length} journaux, {plural(t.count, 'article')}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="k-move-details">
        <button className="k-btn ghost" aria-expanded={details} onClick={() => setDetails(v => !v)}>
          Statistiques détaillées du corpus <ChevronDown size={15} className={details ? 'flip' : ''} />
        </button>
        {details && children}
      </section>
    </div>
  );
}
