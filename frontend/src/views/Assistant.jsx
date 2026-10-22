import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowUp, GitCompare, Map as MapIcon, Newspaper, RefreshCw, Scale, Square, SquarePen } from 'lucide-react';
import { AnswerText, SourceList, Thinking } from '../utils/text';
import { go } from '../hooks/useRoute';

const SUGGESTIONS = {
  presse: [
    'Quelles sont les nouvelles du jour ?',
    'Que se passe-t-il avec la SEEG ?',
    "Quoi de neuf dans l'économie gabonaise ?",
  ],
  codes: [
    'Quelles sont les sanctions pour le vol ?',
    'Comment obtenir la nationalité gabonaise ?',
    "Que dit le code minier sur les permis d'exploitation ?",
  ],
};

const MODES = [
  ['presse', 'Actualité', Newspaper, 'Cherche dans les articles des journaux gabonais.'],
  ['codes', 'Lois', Scale, 'Cherche dans les codes publiés au Journal officiel.'],
  ['comparer', 'Comparer', GitCompare, 'Un même sujet sur deux périodes.'],
];

function Composer({ chat, inputRef, compact }) {
  const [q, setQ] = useState('');
  const { corpus, searching, runSearch, stop } = chat;
  const submit = (e) => {
    e.preventDefault();
    if (!q.trim() || searching) return;
    runSearch(q.trim());
    setQ('');
  };
  return (
    <form className={`k-composer ${compact ? 'compact' : ''}`} onSubmit={submit}>
      <label htmlFor="k-q" className="sr-only">{corpus === 'codes' ? 'Poser une question sur les codes de loi gabonais' : "Poser une question sur l'actualité gabonaise"}</label>
      <textarea
        id="k-q" ref={inputRef} rows={1} value={q}
        placeholder={compact ? 'Une autre question…' : corpus === 'codes' ? 'Une question sur la loi gabonaise…' : 'Une question sur l’actualité gabonaise…'}
        onChange={e => setQ(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) submit(e); }}
        disabled={searching}
        // Autofocus on touch screens pops the keyboard and iOS scrolls the page under the status bar
        autoFocus={window.innerWidth > 768}
      />
      {searching ? (
        <button type="button" className="k-send stop" onClick={stop} aria-label="Arrêter la génération"><Square size={14} fill="currentColor" /></button>
      ) : (
        <button type="submit" className="k-send" disabled={!q.trim()} aria-label="Envoyer la question"><ArrowUp size={18} /></button>
      )}
    </form>
  );
}

// A hosted model can deliver a whole answer in a second, in a few large chunks:
// reveal it at a steady pace instead, word by word, about 45 characters a second,
// faster when far behind so a long answer never trails by more than a few seconds.
// Answers restored from an earlier visit, and reduced-motion readers, get it at once.
function useSteadyText(text, live) {
  const [n, setN] = useState(() => (live ? 0 : Infinity));
  const textRef = useRef(text);
  const liveRef = useRef(live);
  useEffect(() => { textRef.current = text; liveRef.current = live; });
  useEffect(() => {
    if (n === Infinity) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setN(Infinity); return; }
    let raf, last = performance.now(), pos = 0;
    const tick = (now) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const len = textRef.current.length;
      pos = Math.min(len, pos + Math.max(45, (len - pos) / 6) * dt);
      setN(Math.floor(pos));
      if (liveRef.current || pos < len) raf = requestAnimationFrame(tick);
      else setN(Infinity);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (n >= text.length) return text;
  // End on a word boundary so words appear whole
  const cut = text.lastIndexOf(' ', n);
  return text.slice(0, cut > 0 ? cut : n);
}

function Turn({ entry, idx, live, chat }) {
  const [copied, setCopied] = useState(false);
  const shown = useSteadyText(entry.answer || '', live);
  const writing = live || shown.length < (entry.answer || '').length;
  const copy = () => navigator.clipboard?.writeText(entry.answer).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  return (
    <article className="k-turn">
      <h3 className="k-question">{entry.question}</h3>
      {entry.error ? (
        <div className="k-error">
          <p><AlertTriangle size={14} /> {entry.error}</p>
          <button className="k-btn ghost" onClick={() => chat.runSearch(entry.question, idx)} disabled={chat.searching}><RefreshCw size={13} /> Réessayer</button>
        </div>
      ) : entry.answer ? (
        // aria-busy keeps screen readers quiet through the stream, then reads the answer once
        <div className="k-answer" aria-live="polite" aria-atomic="true" aria-busy={writing}>
          {entry.fromCache && !writing && <span className="k-tag" title="Question déjà posée récemment : réponse resservie sans regénération">Réponse instantanée</span>}
          <AnswerText text={shown} streaming={writing} sources={entry.sources} />
          {!writing && <SourceList sources={entry.sources} />}
          {!writing && (
            <div className="k-turn-actions">
              <button className="k-btn ghost" onClick={copy}>{copied ? 'Copié' : 'Copier la réponse'}</button>
            </div>
          )}
        </div>
      ) : entry.sources ? (
        <Thinking phrases={['Lecture des articles retrouvés…', 'Rédaction de la réponse…', 'Vérification des dates et des sources…', 'Encore un instant…']} />
      ) : (
        <Thinking interval={3500} phrases={['Recherche dans le corpus…', 'Sélection des articles pertinents…']} />
      )}
    </article>
  );
}

function Compare({ compare }) {
  const [topic, setTopic] = useState('');
  const { preset, setPreset, custom, setCustom, result, comparing, stopping, cooldown, run, stop, retryColumn } = compare;
  const customMissing = preset === 'custom' && Object.values(custom).some(v => !v);
  const submit = async (e) => {
    e.preventDefault();
    if (await run(topic)) setTopic('');
  };
  const field = (k, label) => (
    <input type="date" value={custom[k]} onChange={e => setCustom(c => ({ ...c, [k]: e.target.value }))} aria-label={label} disabled={comparing} />
  );
  return (
    <div className="k-compare">
      <p className="k-dek small">Choisissez un sujet et deux périodes : l'assistant rédige une réponse pour chacune, pour voir ce qui a changé dans la couverture de la presse.</p>
      <form className="k-compare-form" onSubmit={submit}>
        <input className="k-input" placeholder="Sujet à comparer, par exemple la dette de l'État" value={topic} onChange={e => setTopic(e.target.value)} disabled={comparing} aria-label="Sujet à comparer" />
        <div className="k-segmented" role="group" aria-label="Périodes">
          {[['week', 'Cette semaine et la précédente'], ['month', 'Ce mois et le précédent'], ['custom', 'Dates au choix']].map(([k, l]) => (
            <button key={k} type="button" className={preset === k ? 'on' : ''} aria-pressed={preset === k} onClick={() => setPreset(k)} disabled={comparing}>{l}</button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="k-ranges">
            <span>Période A</span>{field('aStart', 'Période A, début')}{field('aEnd', 'Période A, fin')}
            <span>Période B</span>{field('bStart', 'Période B, début')}{field('bEnd', 'Période B, fin')}
          </div>
        )}
        {comparing ? (
          <button type="button" className="k-btn" onClick={stop} disabled={stopping}><Square size={12} fill="currentColor" /> {stopping ? 'Arrêt en cours…' : 'Arrêter'}</button>
        ) : (
          <button type="submit" className="k-btn primary" disabled={cooldown || !topic.trim() || customMissing}>Comparer</button>
        )}
      </form>

      {result && (
        <>
          <h3 className="k-question">« {result.topic} »</h3>
          <div className="k-compare-cols">
            {result.columns.map((col, i) => (
              <section key={i} className="k-compare-col" aria-label={col.label}>
                <header>
                  <span className="k-kicker">{col.label}</span>
                  <span className="k-muted">{col.start} → {col.end}</span>
                  {col.fromCache && <span className="k-tag">instantané</span>}
                </header>
                {col.queued && <p className="k-muted">En attente : l'autre période est en cours de traitement…</p>}
                {col.loading && !col.answer && !col.error && !col.empty && (
                  <Thinking interval={4000} phrases={['Recherche dans les articles de la période…', 'Lecture des articles retrouvés…', 'Rédaction de la réponse…', 'Encore un instant…']} />
                )}
                {col.error || col.timedOut ? (
                  <div className="k-error">
                    <p><AlertTriangle size={14} /> {col.error || 'Délai dépassé pour cette période.'}</p>
                    <button className="k-btn ghost" onClick={() => retryColumn(i)} disabled={comparing}><RefreshCw size={13} /> Réessayer</button>
                  </div>
                ) : col.stopped ? <p className="k-muted">Interrompu.</p>
                  : col.empty ? <p className="k-muted">Aucun article sur ce sujet pour cette période.</p>
                    : col.answer ? (
                      <div aria-live="polite" aria-atomic="true" aria-busy={col.loading}>
                        <AnswerText text={col.answer} streaming={col.loading} sources={col.sources} />
                        {!col.loading && <SourceList sources={col.sources} />}
                      </div>
                    ) : null}
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function Assistant({ chat, compare, sub }) {
  const mode = sub === 'comparer' ? 'comparer' : chat.corpus;
  const inputRef = useRef(null);
  const threadRef = useRef(null);
  const { chatHistory, searching, corpus } = chat;
  const empty = chatHistory.length === 0 && !searching;

  // A new question goes to the top of the screen once; the answer then grows
  // below it without moving the page. Following every streamed chunk made the
  // text jump on phones and pulled the reader back down mid-sentence.
  const turns = chatHistory.length;
  useEffect(() => {
    if (turns) threadRef.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [turns]);

  const setMode = (m) => {
    if (m === 'comparer') { go('assistant/comparer'); return; }
    chat.switchCorpus(m);
    go('assistant');
  };
  const hasSources = corpus === 'presse' && chatHistory.at(-1)?.sources?.length > 0;

  const newConversation = () => { chat.clear(); inputRef.current?.focus(); };
  // Once a conversation runs, the controls move from the top of the page to the
  // dock above the composer: a long thread no longer means scrolling back up
  const inThread = mode !== 'comparer' && !empty;

  return (
    <div className="k-wrap k-page k-assistant">
      {!inThread && (<>
      <header className="k-page-head">
        <span className="k-eyebrow">Assistant</span>
        <h1 className="k-title">{mode === 'comparer' ? 'Comparer deux périodes' : corpus === 'codes' ? 'Que dit la loi gabonaise ?' : 'Que voulez-vous savoir ?'}</h1>
      </header>
      <div className="k-assistant-bar">
        <div className="k-modes" role="tablist" aria-label="Où chercher">
          {MODES.map((m) => {
            const [k, l, Icon, d] = m;
            return (
            <button key={k} role="tab" aria-selected={mode === k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>
              <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
              <span><b>{l}</b><small>{d}</small></span>
            </button>
            );
          })}
        </div>
      </div>
      </>)}

      {mode === 'comparer' ? <Compare compare={compare} /> : empty ? (
        <div className="k-hero">
          <Composer chat={chat} inputRef={inputRef} />
          <p className="k-dek small">
            {corpus === 'codes'
              ? "La réponse cite les numéros d'articles exacts. Elle ne remplace pas un conseil juridique."
              : "La réponse est rédigée à partir de cinq articles au plus, cités en dessous pour que vous puissiez vérifier."}
          </p>
          <div className="k-try">
            <span className="k-label">Essayez</span>
            <div className="k-try-grid">
              {SUGGESTIONS[corpus].map(s => (
                <button key={s} className="k-try-card" onClick={() => chat.runSearch(s)} disabled={searching}>{s}<ArrowUp size={15} className="k-try-arrow" /></button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="k-thread" role="log" aria-label="Conversation" ref={threadRef}>
            {chatHistory.map((entry, idx) => (
              <Turn key={entry.id ?? idx} entry={entry} idx={idx} chat={chat} live={idx === chatHistory.length - 1 && searching} />
            ))}
          </div>
          <div className="k-dock">
            <div className="k-dock-tools">
              <div className="k-dock-modes" role="tablist" aria-label="Où chercher">
                {MODES.map((m) => {
                  const [k, l, Icon] = m;
                  return (
                    <button key={k} role="tab" aria-selected={mode === k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>
                      <Icon size={14} strokeWidth={1.8} aria-hidden="true" />{l}
                    </button>
                  );
                })}
              </div>
              <div className="k-dock-actions">
                {hasSources && <a className="k-icon-btn" href="#/tendances/carte" aria-label="Voir sur la carte"><MapIcon size={15} /><span>Carte</span></a>}
                <button className="k-icon-btn" onClick={newConversation} aria-label="Nouvelle conversation"><SquarePen size={15} /><span>Nouvelle</span></button>
              </div>
            </div>
            <Composer chat={chat} inputRef={inputRef} compact />
            <p className="k-disclaimer">
              <span className="long">Réponses rédigées par IA à partir des articles cités. Elles peuvent contenir des erreurs : vérifiez toujours les sources.</span>
              <span className="short">Rédigé par IA : vérifiez toujours les sources.</span>
            </p>
          </div>
        </>
      )}
    </div>
  );
}
