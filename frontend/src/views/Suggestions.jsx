import { useCallback, useEffect, useState } from 'react';
import { API_URL, authHeaders, errorDetail } from '../utils/api';

const KINDS = [['idee', 'Une idée'], ['probleme', 'Un problème'], ['autre', 'Autre chose']];
const KIND_LABELS = { idee: 'Idée', probleme: 'Problème', autre: 'Autre' };
const STATUSES = [['nouvelle', 'Nouvelles'], ['retenue', 'Retenues'], ['faite', 'Faites'], ['ecartee', 'Écartées']];
const PLACEHOLDERS = {
  idee: "Ce qui vous manque dans le Kiosque, un journal ou un code à ajouter, une rubrique…",
  probleme: "Ce que vous faisiez, ce qui s'est passé, sur quel téléphone ou navigateur…",
  autre: 'Votre message',
};

// The team's side of #/suggestions: every message, sorted by status
function Inbox({ authToken }) {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState('nouvelle');
  useEffect(() => {
    fetch(`${API_URL}/admin/suggestions`, { headers: authHeaders(authToken) })
      .then(r => (r.ok ? r.json() : { suggestions: [] }))
      .then(d => setItems(d.suggestions))
      .catch(() => setItems([]));
  }, [authToken]);

  const move = async (id, status) => {
    const res = await fetch(`${API_URL}/admin/suggestions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders(authToken) },
      body: JSON.stringify({ status }),
    });
    if (res.ok) setItems(list => list.map(s => (s.id === id ? { ...s, status } : s)));
  };

  if (!items) return <p className="k-muted">Chargement…</p>;
  const count = (st) => items.filter(s => s.status === st).length;
  const shown = items.filter(s => s.status === filter);
  return (
    <section className="k-suggest-inbox" aria-labelledby="inbox-title">
      <h2 id="inbox-title" className="k-label">Reçues (visible par l'équipe seulement)</h2>
      <div className="k-segmented small" role="group" aria-label="Statut">
        {STATUSES.map(([st, label]) => (
          <button key={st} className={filter === st ? 'on' : ''} onClick={() => setFilter(st)}>{label} · {count(st)}</button>
        ))}
      </div>
      {shown.length === 0 ? <p className="k-muted">Rien ici.</p> : (
        <ul>
          {shown.map(s => (
            <li key={s.id}>
              <p className="k-suggest-meta">
                <span className="k-label">{KIND_LABELS[s.kind]}</span>
                <span className="k-muted">
                  {new Date(`${s.created_at.replace(' ', 'T')}Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}
                  {' · '}{s.user_name ? `${s.user_name}${s.user_email ? ` (${s.user_email})` : ''}` : s.contact || 'sans compte'}
                  {s.page && ` · depuis ${s.page}`}
                </span>
              </p>
              <p className="k-suggest-text">{s.message}</p>
              <div className="k-suggest-actions">
                {STATUSES.filter(([st]) => st !== s.status).map(([st, label]) => (
                  <button key={st} className="k-btn" onClick={() => move(s.id, st)}>{label.replace(/s$/, '')}</button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// #/suggestions: any reader, with or without an account, tells the team what to add or fix
export default function Suggestions({ session, from }) {
  const { authToken, user } = session;
  const [kind, setKind] = useState('idee');
  const [message, setMessage] = useState('');
  const [contact, setContact] = useState('');
  const [site, setSite] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    if (!authToken) { setAdmin(false); return; }
    fetch(`${API_URL}/admin/me`, { headers: authHeaders(authToken) })
      .then(r => (r.ok ? r.json() : { admin: false }))
      .then(d => setAdmin(!!d.admin))
      .catch(() => setAdmin(false));
  }, [authToken]);

  const submit = useCallback(async (e) => {
    e.preventDefault();
    if (message.trim().length < 10) { setError('Écrivez au moins quelques mots.'); return; }
    setBusy(true); setError('');
    try {
      const res = await fetch(`${API_URL}/suggestions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(authToken) },
        body: JSON.stringify({ kind, message: message.trim(), contact: user ? '' : contact.trim(), page: from || '', site }),
      });
      if (res.status === 429) throw new Error('Vous avez déjà envoyé plusieurs messages : réessayez dans une heure.');
      if (!res.ok) throw new Error(await errorDetail(res));
      setSent(true); setMessage(''); setContact('');
    } catch (err) {
      setError(err.message || "Le message n'est pas parti. Réessayez dans un instant.");
    } finally {
      setBusy(false);
    }
  }, [kind, message, contact, site, from, user, authToken]);

  return (
    <div className="k-wrap k-page k-suggest">
      <header className="k-page-head">
        <span className="k-eyebrow">Suggestions</span>
        <h1 className="k-title">Aidez-nous à améliorer le Kiosque</h1>
        <p className="k-dek">Une idée, un journal ou un texte de loi qui manque, quelque chose qui ne marche pas : l'équipe lit chaque message.</p>
      </header>

      {sent ? (
        <div className="k-suggest-done" role="status">
          <p><strong>Merci, c'est bien reçu.</strong> Votre message aide à décider de la suite.</p>
          <div className="k-diffusion-actions">
            <button className="k-btn" onClick={() => setSent(false)}>Écrire autre chose</button>
            <a className="k-btn primary" href="#/">Retour à la Une</a>
          </div>
        </div>
      ) : (
        <form className="k-diffusion-form" onSubmit={submit}>
          <div className="k-segmented" role="group" aria-label="Type de message">
            {KINDS.map(([k, label]) => (
              <button key={k} type="button" className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>
            ))}
          </div>
          <label className="k-label" htmlFor="s-message">Votre message</label>
          <textarea id="s-message" className="k-input" rows={6} value={message} maxLength={2000}
            onChange={e => setMessage(e.target.value)} placeholder={PLACEHOLDERS[kind]} />
          <small className="k-muted">{message.length} / 2000</small>
          {user ? (
            <small className="k-muted">Envoyé au nom de {user.display_name} : l'équipe pourra vous répondre.</small>
          ) : (<>
            <label className="k-label" htmlFor="s-contact">Pour vous répondre (facultatif)</label>
            <input id="s-contact" className="k-input" value={contact} maxLength={200} onChange={e => setContact(e.target.value)}
              placeholder="E-mail ou numéro WhatsApp" autoComplete="email" />
          </>)}
          {/* Hidden from people: only spam robots fill it */}
          <input className="k-hp" tabIndex={-1} autoComplete="off" aria-hidden="true" value={site} onChange={e => setSite(e.target.value)} name="site" />
          <div className="k-diffusion-actions">
            <button type="submit" className="k-btn primary" disabled={busy || !message.trim()}>{busy ? 'Envoi…' : 'Envoyer'}</button>
          </div>
          {error && <p className="k-notifs-error" role="alert">{error}</p>}
        </form>
      )}

      {admin && <Inbox authToken={authToken} />}
    </div>
  );
}
