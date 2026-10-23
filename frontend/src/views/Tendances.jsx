import { useEffect, useState } from 'react';
import '../styles/dashboard.css';
import MetricsDashboard from './MetricsDashboard';
import SemanticMap from './SemanticMap';
import Moving from './Moving';
import { go } from '../hooks/useRoute';
import { Thinking } from '../utils/text';

function useIsPhone() {
  const [isPhone, setIsPhone] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const fn = e => setIsPhone(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return isPhone;
}

export default function Tendances({ corpus, sub, ask, session, health, latestSources }) {
  const tab = sub === 'carte' ? 'carte' : sub === 'jour' ? 'jour' : 'chiffres';
  const isPhone = useIsPhone();
  const { data, error, loading, load } = corpus;
  useEffect(() => { load(); }, [load]);

  return (
    <div className="k-wrap k-page k-tendances">
      <header className="k-page-head">
        <span className="k-eyebrow">Tendances</span>
        <h1 className="k-title">Ce qui bouge dans la presse</h1>
        <p className="k-dek">Les noms et les sujets qui reviennent plus que d'habitude, aujourd'hui ou cette semaine. Touchez-en un pour demander à l'assistant ce qui se passe.</p>
      </header>
      <div className="k-segmented" role="tablist" aria-label="Tendances">
        {[['jour', "Aujourd'hui"], ['chiffres', isPhone ? 'Semaine' : 'Cette semaine'], ['carte', isPhone ? 'Carte' : 'La carte des sujets']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(`tendances/${k}`)}>{l}</button>
        ))}
      </div>
      {error ? (
        <div className="k-empty"><p>{error}</p><button className="k-btn" onClick={load}>Réessayer</button></div>
      ) : !data ? (
        <Thinking phrases={[loading ? 'Chargement du corpus (une vingtaine de mégaoctets)…' : 'Préparation…', 'Encore un instant…']} interval={6000} />
      ) : tab === 'carte' ? (
        <SemanticMap data={data} latestSources={latestSources} isPhone={isPhone} />
      ) : tab === 'jour' ? (
        <Moving data={data} ask={ask} period="day" session={session} />
      ) : (
        <Moving data={data} ask={ask} session={session}>
          <MetricsDashboard data={data} gabonToday={health.gabonToday} onAskAssistant={(q) => ask(q)} user={session.user} authToken={session.authToken} />
        </Moving>
      )}
    </div>
  );
}
