import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowUp, Check, GitCompare, History, ListOrdered, MessageCircle, Newspaper, Plus, RefreshCw, Scale, Square, SquarePen, X } from 'lucide-react';
import { LOCAL_HISTORY_MAX } from '../hooks/useChat';
import { useFollows } from '../hooks/useFollows';
import { followSuggestions } from '../utils/followSuggest';
import { AnswerText, SourceList, Thinking } from '../utils/text';
import { go } from '../hooks/useRoute';
import { API_URL, postJSON } from '../utils/api';
import { opening, sourceLabel, tagged } from '../utils/format';
import { track } from '../utils/track';

const SUGGESTIONS = {
  presse: [
    'Quelles sont les nouvelles du jour ?',
    'Que se passe-t-il avec la SEEG ?',
    "Quoi de neuf dans l'économie gabonaise ?",
  ],
  codes: [
    'Quelles sont les sanctions pour le vol ?',
    'Comment obtenir la nationalité gabonaise ?',
    'Que dit la Constitution sur le mandat du Président ?',
  ],
};

const MODES = [
  ['presse', 'Actualité', Newspaper, 'Cherche dans les articles des journaux gabonais.'],
  ['codes', 'Lois', Scale, 'Cherche dans la Constitution et les codes publiés au Journal officiel.'],
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

// The answer shared on WhatsApp, as the editions are: the question (for an article
// opened with « Expliquer », its title and newspaper, as on the front page), the
// answer's opening sentence, and a short link, lekiosque.hodologic.fr/r/<id>, whose
// preview carries the same title and which opens the answer as it was written.
// Without one (an answer from before, the server unreachable), the link asks the
// same question again.
async function shareOnWhatsApp({ question, answer, pinned, answerId }, corpus) {
  // A new tab opened now, on the click: opened after the request, a browser would block it
  const tab = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? null : window.open('', '_blank');
  let link = tagged(`assistant?q=${encodeURIComponent(question)}${corpus === 'codes' ? '&rubrique=lois' : ''}`, 'reponse');
  if (answerId) {
    try {
      const res = await postJSON('/partages', { answer_id: answerId });
      if (res.ok) link = `${window.location.origin}/r/${(await res.json()).id}`;
    } catch { /* keep the question link */ }
  }
  const head = pinned?.title ? `${pinned.title}\n${sourceLabel(pinned.source)}` : question;
  const url = `https://wa.me/?text=${encodeURIComponent(`${head}\n\n${opening(answer)}\n\n${link}`)}`;
  if (tab) tab.location.href = url;
  else window.location.href = url;
}

// « Suivre » under a press answer: the names its articles' titles share, one click to
// follow. A followed name comes back on the front page (« Depuis votre dernière
// visite ») and, with notifications on, when the press picks it up again.
function FollowChips({ entry, follows }) {
  const [justFollowed, setJustFollowed] = useState(false);
  const names = followSuggestions(entry.pinned?.title || entry.question, entry.sources);
  if (!names.length) return null;
  return (
    <div className="k-follow-row">
      <span className="k-follow-label">Suivre</span>
      {names.map(n => {
        const on = follows.isFollowed(n.type, n.value);
        return (
          <button key={n.value} className={`k-chip k-follow-chip ${on ? 'on' : ''}`} aria-pressed={on}
            onClick={() => setJustFollowed(follows.toggleFollow(n.type, n.value, n.label))}>
            {on ? <Check size={13} aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}{n.label}
          </button>
        );
      })}
      {justFollowed && <span className="k-follow-note">Vous le retrouverez à l'accueil quand la presse en reparle.</span>}
    </div>
  );
}

function Turn({ entry, idx, live, chat, follows }) {
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
          {!writing && chat.corpus === 'presse' && <FollowChips entry={entry} follows={follows} />}
          {!writing && (
            <div className="k-turn-actions">
              <button className="k-btn ghost" onClick={copy}>{copied ? 'Copié' : 'Copier la réponse'}</button>
              <button className="k-btn ghost" onClick={() => {
                track('partage', { canal: 'whatsapp', vue: 'assistant' });
                shareOnWhatsApp(entry, chat.corpus);
              }}>
                <MessageCircle size={14} /> WhatsApp
              </button>
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

// A long conversation is a long scroll: the questions asked so far, listed above
// the dock, each one a jump back to its answer
function QuestionsNav({ entries, threadRef }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  if (entries.length < 2) return null;
  const goTo = (i) => {
    setOpen(false);
    threadRef.current?.children[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <div className="k-qnav" ref={boxRef}>
      <button className="k-icon-btn" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Questions de la conversation">
        <ListOrdered size={15} /><span>Questions</span>
      </button>
      {open && (
        <div className="k-qnav-menu">
          {entries.map((e, i) => (
            <button key={e.id ?? i} onClick={() => goTo(i)}><span>{i + 1}</span>{e.question}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// "14:05" today, "22 oct." before: the server stores UTC
function when(utc) {
  const d = new Date(`${utc.replace(' ', 'T')}Z`);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// Without an account, only the last few conversations stay, on this device: say what signing up keeps
function SaveHint({ openAuth }) {
  return (
    <p className="k-saved-hint">
      <History size={15} aria-hidden="true" />
      <span>Sans compte, seules vos {LOCAL_HISTORY_MAX} dernières conversations restent, sur cet appareil. <button className="k-textlink" onClick={() => openAuth('register')}>Créez un compte</button> pour les garder toutes, sur tous vos appareils.</span>
    </p>
  );
}

// The reader's earlier conversations, the open one left out: from the account when
// signed in (fetched again when `refresh` changes), from this device otherwise
function useEarlierConversations(chat, session, refresh) {
  const { authToken } = session;
  const [server, setServer] = useState(null);
  useEffect(() => {
    if (!authToken) return;
    fetch(`${API_URL}/conversations`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => (r.ok ? r.json() : []))
      .then(l => setServer(Array.isArray(l) ? l : []))
      .catch(() => setServer([]));
  }, [authToken, refresh]);
  const list = (authToken
    ? (server || [])
    : chat.localHistory.map(c => ({ ...c, turns: c.turns.length }))
  ).filter(c => c.id !== chat.threadId);
  const remove = (id) => {
    if (!authToken) { chat.removeLocal(id); return; }
    setServer(l => (l || []).filter(c => c.id !== id));
    fetch(`${API_URL}/conversations/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } }).catch(() => {});
  };
  return { list, remove };
}

function ConversationItems({ list, remove, open, disabled }) {
  return (
    <ul>
      {list.map(c => (
        <li key={c.id}>
          <button className="k-saved-open" onClick={() => open(c.id)} disabled={disabled}>
            {c.corpus === 'codes' ? <Scale size={15} aria-hidden="true" /> : <Newspaper size={15} aria-hidden="true" />}
            <span className="k-saved-title">{c.title}</span>
            <span className="k-saved-meta">{c.turns > 1 ? `${c.turns} questions · ` : ''}{when(c.updated_at)}</span>
          </button>
          <button className="k-saved-del" onClick={() => remove(c.id)} aria-label={`Supprimer la conversation « ${c.title} »`}><X size={15} /></button>
        </li>
      ))}
    </ul>
  );
}

// Above the suggestions, before a conversation starts
function SavedConversations({ chat, session }) {
  const { list, remove } = useEarlierConversations(chat, session, 0);
  const [all, setAll] = useState(false);
  if (!list.length) return null;
  return (
    <section className="k-saved" aria-labelledby="k-saved-title">
      <span className="k-label" id="k-saved-title">Vos conversations</span>
      <ConversationItems list={all ? list : list.slice(0, 5)} remove={remove} open={chat.openConversation} disabled={chat.searching} />
      {list.length > 5 && !all && <button className="k-textlink" onClick={() => setAll(true)}>Voir les {list.length} conversations</button>}
    </section>
  );
}

// On a wide screen, the conversations sit in a column on the left, always in view:
// the open one first, then the earlier ones. Narrower, the dock's « Historique » menu.
// In a drawer (narrow screens, HistoryNav) it carries its own close button, and any
// choice made in it closes it.
function HistorySide({ chat, session, onNew, drawer = false, onClose }) {
  const turns = chat.chatHistory.length;
  // Signed in, the account's list is fetched again as conversations start and grow
  const { list, remove } = useEarlierConversations(chat, session, `${chat.threadId}-${turns}`);
  const current = turns ? chat.chatHistory[0].question : null;
  const done = (fn) => (...args) => { onClose?.(); fn(...args); };
  return (
    <aside className={`k-history-side${drawer ? ' drawer' : ''}`} aria-label="Conversations">
      {drawer && (
        <div className="k-history-head">
          <span>Conversations</span>
          <button className="k-icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </div>
      )}
      <button className="k-history-new" onClick={done(onNew)}><SquarePen size={15} aria-hidden="true" /> Nouvelle conversation</button>
      {current && (
        <div className="k-history-current" aria-current="true">
          <span className="k-history-kicker">En cours</span>
          <span className="k-saved-title">{current}</span>
        </div>
      )}
      {list.length > 0 && <span className="k-history-kicker">Précédentes</span>}
      <ConversationItems list={list} remove={remove} open={done(chat.openConversation)} disabled={chat.searching} />
      {!current && !list.length && <p className="k-muted">Vos conversations apparaîtront ici.</p>}
      {!session.user && (
        <p className="k-history-note">
          Sans compte, vos {LOCAL_HISTORY_MAX} dernières conversations restent sur cet appareil.{' '}
          <button className="k-textlink" onClick={done(() => session.openAuth('register'))}>Créer un compte</button>
        </p>
      )}
    </aside>
  );
}

// In the dock, during a conversation, below the wide screens' column: the same list,
// in a drawer that comes out from the left. Closed by its button, a tap beside it,
// Échap, or a swipe back to the left.
function HistoryNav({ chat, session, onNew }) {
  const [open, setOpen] = useState(false);
  const startX = useRef(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', esc);
    // The page behind stays still while the drawer scrolls
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = before; };
  }, [open]);
  const swipe = {
    onTouchStart: (e) => { startX.current = e.touches[0].clientX; },
    onTouchEnd: (e) => {
      if (startX.current !== null && e.changedTouches[0].clientX - startX.current < -60) setOpen(false);
      startX.current = null;
    },
  };
  return (
    <div className="k-qnav k-history-nav">
      <button className="k-icon-btn" onClick={() => setOpen(true)} aria-expanded={open} aria-label="Conversations">
        <History size={15} /><span>Historique</span>
      </button>
      {open && createPortal(
        <div className="k-history-drawer" {...swipe}>
          <div className="k-history-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <HistorySide chat={chat} session={session} onNew={onNew} drawer onClose={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </div>
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

export default function Assistant({ chat, compare, sub, session }) {
  const mode = sub === 'comparer' ? 'comparer' : chat.corpus;
  const inputRef = useRef(null);
  const threadRef = useRef(null);
  const { chatHistory, searching, corpus } = chat;
  const empty = chatHistory.length === 0 && !searching;
  const follows = useFollows({ user: session.user, authToken: session.authToken });

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

  const newConversation = () => { chat.clear(); inputRef.current?.focus(); };
  // Once a conversation runs, the controls move from the top of the page to the
  // dock above the composer: a long thread no longer means scrolling back up
  const inThread = mode !== 'comparer' && !empty;

  return (
    <div className={`k-wrap k-page k-assistant ${mode !== 'comparer' ? 'with-side' : ''}`}>
      {mode !== 'comparer' && <HistorySide chat={chat} session={session} onNew={newConversation} />}
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
          <SavedConversations chat={chat} session={session} />
          <div className="k-try">
            <span className="k-label">Essayez</span>
            <div className="k-try-grid">
              {SUGGESTIONS[corpus].map(s => (
                <button key={s} className="k-try-card" onClick={() => chat.runSearch(s)} disabled={searching}>{s}<ArrowUp size={15} className="k-try-arrow" /></button>
              ))}
            </div>
          </div>
          {!session.user && <SaveHint openAuth={session.openAuth} />}
        </div>
      ) : (
        <>
          <div className="k-thread" role="log" aria-label="Conversation" ref={threadRef}>
            {chatHistory.map((entry, idx) => (
              <Turn key={entry.id ?? idx} entry={entry} idx={idx} chat={chat} follows={follows} live={idx === chatHistory.length - 1 && searching} />
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
                <HistoryNav chat={chat} session={session} onNew={newConversation} />
                <QuestionsNav entries={chatHistory} threadRef={threadRef} />
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
