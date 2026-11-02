import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { API_URL, errorDetail } from '../utils/api';
import { sourceLabel } from '../utils/format';
import { AnswerText, SourceList, Thinking } from '../utils/text';
import { go } from '../hooks/useRoute';

// #/r/<id>: an answer shared on WhatsApp (lekiosque.hodologic.fr/r/<id> leads here),
// as the assistant wrote it, with its sources. For an article opened with
// « Expliquer », the page is headed by the article's title and newspaper.
export default function Partage({ id }) {
  const [share, setShare] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`${API_URL}/partages/${encodeURIComponent(id || '')}`)
      .then(async res => { if (!res.ok) throw new Error(await errorDetail(res)); return res.json(); })
      .then(setShare)
      .catch(e => setError(e.message || 'Réponse introuvable.'));
  }, [id]);

  return (
    <div className="k-wrap k-page k-shared">
      <header className="k-page-head">
        <span className="k-eyebrow">Réponse partagée</span>
        {share && <h1 className="k-title">{share.headline || share.question}</h1>}
        {share?.headline && <p className="k-dek">{sourceLabel(share.sources[0]?.source)}</p>}
      </header>
      {error ? (
        <p className="k-muted">{error}</p>
      ) : !share ? (
        <Thinking phrases={['Chargement de la réponse…']} />
      ) : (
        <article className="k-turn">
          {share.headline && <h3 className="k-question">{share.question}</h3>}
          <div className="k-answer">
            <AnswerText text={share.answer} sources={share.sources} />
            <SourceList sources={share.sources} />
          </div>
        </article>
      )}
      <p className="k-shared-more">
        <button className="k-btn primary" onClick={() => go('assistant')}>
          Posez votre question au Kiosque <ArrowRight size={14} />
        </button>
      </p>
      <p className="k-muted">Réponse rédigée par IA à partir des articles cités : vérifiez toujours les sources.</p>
    </div>
  );
}
