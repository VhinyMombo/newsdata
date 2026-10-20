import { useEffect, useState } from 'react';
import '../styles/dashboard.css';
import MetricsDashboard from './MetricsDashboard';
import SemanticMap from './SemanticMap';
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
  const tab = sub === 'carte' ? 'carte' : 'chiffres';
  const isPhone = useIsPhone();
  const { data, error, loading, load } = corpus;
  useEffect(() => { load(); }, [load]);

  return (
    <div className="k-wrap k-page k-tendances">
      <header className="k-page-head">
        <span className="k-eyebrow">Tendances</span>
        <h1 className="k-title">Ce dont parle la presse, en chiffres</h1>
        <p className="k-dek">Qui publie, sur quels sujets, et ce qui monte. Suivez un sujet avec l'étoile pour le retrouver à votre prochaine visite.</p>
      </header>
      <div className="k-segmented" role="tablist" aria-label="Tendances">
        {[['chiffres', 'Les chiffres'], ['carte', 'La carte des sujets']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => go(`tendances/${k}`)}>{l}</button>
        ))}
      </div>
      {error ? (
        <div className="k-empty"><p>{error}</p><button className="k-btn" onClick={load}>Réessayer</button></div>
      ) : !data ? (
        <Thinking phrases={[loading ? 'Chargement du corpus (une vingtaine de mégaoctets)…' : 'Préparation…', 'Encore un instant…']} interval={6000} />
      ) : tab === 'carte' ? (
        <SemanticMap data={data} latestSources={latestSources} isPhone={isPhone} />
      ) : (
        <MetricsDashboard data={data} gabonToday={health.gabonToday} onAskAssistant={(q) => ask(q)} user={session.user} authToken={session.authToken} />
      )}
    </div>
  );
}
