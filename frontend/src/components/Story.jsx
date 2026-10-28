import { ArrowUpRight, Sparkles } from 'lucide-react';
import { clock, sourceLabel } from '../utils/format';
import { explain } from '../utils/explain';

// An article: the whole card and its "Expliquer" button open the assistant, and
// "Lire l'article" opens the original on the newspaper's site
export default function Story({ a, ask, size = 'm', lede = true }) {
  const t = clock(a.time);
  return (
    <article className={`k-story k-story-${size}`}>
      <a className="k-story-ask" href="#/assistant" onClick={explain(ask, a)}>
        <h3>{a.title}</h3>
        {lede && a.lede && <p className="k-lede">{a.lede}</p>}
      </a>
      <p className="k-meta">
        <a className="k-src" href={`#/journal/${a.source}`}>{sourceLabel(a.source)}</a>{t && <> · <time>{t}</time></>}
        <span className="k-story-actions">
          {a.url && (
            <a className="k-story-read" href={a.url} target="_blank" rel="noopener" aria-label={`Lire l'article sur le site de ${sourceLabel(a.source)}`}>
              Lire l'article<ArrowUpRight size={13} aria-hidden="true" />
            </a>
          )}
          <a className="k-story-explain" href="#/assistant" onClick={explain(ask, a)} aria-label={`Expliquer l'article avec l'assistant : ${a.title}`}>
            <Sparkles size={13} aria-hidden="true" />Expliquer
          </a>
        </span>
      </p>
    </article>
  );
}
