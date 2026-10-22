import { useEffect, useState } from 'react';
import { ArrowRight, ChevronLeft, ExternalLink, Search } from 'lucide-react';
import { Thinking } from '../utils/text';

function AskCodes({ ask }) {
  const [q, setQ] = useState('');
  return (
    <form className="k-askbox k-ask" onSubmit={(e) => { e.preventDefault(); if (q.trim()) ask(q.trim(), 'codes'); }}>
      <label htmlFor="codes-ask" className="sr-only">Poser une question sur les codes de loi gabonais</label>
      <Search size={18} aria-hidden="true" />
      <input id="codes-ask" value={q} onChange={e => setQ(e.target.value)} placeholder="Une question sur la loi, par exemple les sanctions pour le vol…" autoComplete="off" />
      <button type="submit" className="k-btn primary" disabled={!q.trim()}>Demander</button>
    </form>
  );
}

export default function Codes({ codes, ask }) {
  const { codesList, loadList, activeCode, openCode, activeArticle, openArticle, codeTree, codeLabel } = codes;
  useEffect(() => { loadList(); }, [loadList]);

  return (
    <div className="k-wrap k-page k-codes">
      <header className="k-page-head">
        <span className="k-eyebrow">Codes de loi</span>
        <h1 className="k-title">La loi gabonaise, article par article</h1>
        <p className="k-dek">Les codes publiés au Journal officiel, à parcourir ou à interroger en langage courant. Les réponses citent les articles exacts. Ce n'est pas un conseil juridique.</p>
      </header>
      <AskCodes ask={ask} />

      <div className="k-codes-grid">
        <nav className="k-codes-list" aria-label="Codes disponibles">
          <h3 className="k-kicker">Codes disponibles</h3>
          {codesList === null ? <Thinking phrases={['Chargement…']} />
            : codesList.length === 0 ? <p className="k-muted">Le corpus des codes est indisponible pour le moment.</p>
              : (
                <ul>
                  {codesList.map(c => (
                    <li key={c.code}>
                      <button className={activeCode === c.code ? 'on' : ''} aria-current={activeCode === c.code || undefined} onClick={() => openCode(c.code)}>
                        <span>{c.label}</span><span className="k-muted">{c.count} articles</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        </nav>

        <section className="k-codes-body" aria-live="polite">
          {activeArticle ? (
            <article className="k-code-article">
              <button className="k-back" onClick={() => openArticle(null)}><ChevronLeft size={14} /> {codeLabel(activeCode)}</button>
              {activeArticle.loading ? <Thinking phrases={['Chargement…']} />
                : !activeArticle.text ? <p className="k-muted">Article introuvable.</p>
                  : (
                    <>
                      {activeArticle.contexte && <p className="k-kicker">{activeArticle.contexte.split('|').map(s => s.trim()).filter(Boolean).join(' › ')}</p>}
                      <h3>{activeArticle.numero || activeArticle.label}</h3>
                      <p className="k-code-text">{activeArticle.text}</p>
                      <div className="k-turn-actions">
                        {activeArticle.url && <a className="k-btn ghost" href={activeArticle.url} target="_blank" rel="noreferrer">Source au Journal officiel <ExternalLink size={12} /></a>}
                        <button className="k-btn ghost" onClick={() => ask(`Que prévoit ${activeArticle.numero || 'cet article'} du ${codeLabel(activeCode)} ?`, 'codes')}>Expliquer cet article <ArrowRight size={13} /></button>
                      </div>
                    </>
                  )}
            </article>
          ) : activeCode ? (
            <div className="k-code-tree">
              <h3>{codeLabel(activeCode)}</h3>
              {!codeTree ? <Thinking phrases={['Chargement…']} /> : Array.from(codeTree.entries()).map(([titre, chapitres]) => (
                <details key={titre}>
                  <summary>{titre}</summary>
                  {Array.from(chapitres.values()).map((chap, ci) => {
                    const list = (
                      <ul className="k-code-articles">
                        {chap.items.map(it => <li key={it.id}><button onClick={() => openArticle(it.id)}>{it.numero || it.type}</button></li>)}
                      </ul>
                    );
                    return chap.label ? <details key={ci} className="k-chapitre"><summary>{chap.label}</summary>{list}</details> : <div key={ci}>{list}</div>;
                  })}
                </details>
              ))}
            </div>
          ) : (
            <p className="k-muted k-codes-placeholder">Choisissez un code pour le parcourir.</p>
          )}
        </section>
      </div>
    </div>
  );
}
