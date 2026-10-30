import { useCallback, useEffect, useState } from 'react';
import { API_URL, authHeaders, errorDetail } from '../utils/api';

const KIND_LABELS = { morning: "L'essentiel du matin", wave: 'Toute la presse en parle', alerts: 'Annonce' };

// #/diffusion: the team writes an announcement and sends it to every device that
// takes them. A test to one's own devices first; the real send asks to confirm.
export default function Diffusion({ session }) {
  const { authToken, user, openAuth } = session;
  const [admin, setAdmin] = useState(null);
  const [stats, setStats] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('/#/');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!authToken) { setAdmin(false); return; }
    fetch(`${API_URL}/admin/me`, { headers: authHeaders(authToken) })
      .then(r => (r.ok ? r.json() : { admin: false }))
      .then(d => {
        setAdmin(!!d.admin);
        if (!d.admin) return;
        return fetch(`${API_URL}/admin/announcements`, { headers: authHeaders(authToken) })
          .then(r => (r.ok ? r.json() : null)).then(setStats);
      })
      .catch(() => setAdmin(false));
  }, [authToken]);
  useEffect(load, [load]);

  const send = async (test) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const res = await fetch(`${API_URL}/admin/announcements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(authToken) },
        body: JSON.stringify({ title, body, url, test }),
      });
      if (!res.ok) throw new Error(await errorDetail(res));
      const { sent } = await res.json();
      setMessage(test
        ? (sent ? `Test envoyé sur ${sent} de vos appareils.` : "Aucun de vos appareils connectés à votre compte ne reçoit de notifications : activez-les depuis votre profil.")
        : `Annonce envoyée à ${sent} appareil${sent > 1 ? 's' : ''}.`);
      if (!test) { setTitle(''); setBody(''); setUrl('/#/'); load(); }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false); setConfirming(false);
    }
  };

  if (admin === null) return <div className="k-wrap k-page"><p className="k-muted">Chargement…</p></div>;
  if (!admin) {
    return (
      <div className="k-wrap k-page">
        <header className="k-page-head">
          <span className="k-eyebrow">Diffusion</span>
          <h1 className="k-title">Réservé à l'équipe du Kiosque</h1>
        </header>
        {!user && <button className="k-btn primary" onClick={() => openAuth('login')}>Se connecter</button>}
      </div>
    );
  }

  // « {prénom} » becomes each reader's first name; the preview shows the sender's
  const firstName = (user?.display_name || '').trim().split(' ')[0];
  const greet = (s) => s.replace(/\{\s*pr[ée]nom\s*\}/gi, firstName).replace(/ ,/g, ',');
  const reach = stats?.devices?.alerts ?? 0;
  const ready = title.trim() && body.trim();
  return (
    <div className="k-wrap k-page k-diffusion">
      <header className="k-page-head">
        <span className="k-eyebrow">Diffusion</span>
        <h1 className="k-title">Envoyer une annonce</h1>
        <p className="k-dek">
          {stats ? <>{stats.devices.total} appareil{stats.devices.total > 1 ? 's' : ''} reçoivent les notifications du Kiosque, dont {reach} les annonces.</> : '…'}
          {' '}À garder pour les grands rendez-vous : chaque annonce de trop pousse des lecteurs à tout couper.
        </p>
      </header>

      <form className="k-diffusion-form" onSubmit={e => { e.preventDefault(); if (ready) setConfirming(true); }}>
        <label className="k-label" htmlFor="d-title">Titre</label>
        <input id="d-title" className="k-input" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} placeholder="Loi de finances 2027" />
        <label className="k-label" htmlFor="d-body">Texte</label>
        <textarea id="d-body" className="k-input" rows={3} value={body} maxLength={240} onChange={e => setBody(e.target.value)} placeholder="Ce que la presse en dit, journal par journal." />
        <small className="k-muted">{body.length} / 240 · Écrivez {'{prénom}'} pour saluer chaque lecteur par son prénom (« Bonjour {'{prénom}'}, … ») ; sans compte, il lit « Bonjour, … ».</small>
        <label className="k-label" htmlFor="d-url">Page ouverte</label>
        <input id="d-url" className="k-input" value={url} maxLength={300} onChange={e => setUrl(e.target.value)} />
        <small className="k-muted">Une page du Kiosque : /#/ (la Une), /#/editions, /#/assistant?q=Votre question…</small>

        <div className="k-notif-preview" aria-label="Aperçu">
          <img src="/icons/icon-192.png" alt="" width="36" height="36" />
          <div><strong>{greet(title) || 'Titre'}</strong><p>{greet(body) || 'Texte de la notification'}</p></div>
        </div>

        {confirming ? (
          <div className="k-diffusion-confirm" role="alert">
            <p>Envoyer « {title} » à {reach} appareil{reach > 1 ? 's' : ''} ?</p>
            <button type="button" className="k-btn primary" onClick={() => send(false)} disabled={busy}>{busy ? '…' : 'Oui, envoyer à tous'}</button>
            <button type="button" className="k-btn" onClick={() => setConfirming(false)} disabled={busy}>Annuler</button>
          </div>
        ) : (
          <div className="k-diffusion-actions">
            <button type="button" className="k-btn" onClick={() => send(true)} disabled={busy || !ready}>M'envoyer un test</button>
            <button type="submit" className="k-btn primary" disabled={busy || !ready}>Envoyer à tous…</button>
          </div>
        )}
        {message && <p className="k-diffusion-ok" role="status">{message}</p>}
        {error && <p className="k-notifs-error" role="alert">{error}</p>}
      </form>

      {stats?.history?.length > 0 && (
        <section className="k-diffusion-history">
          <h2 className="k-label">Derniers envois (30 jours)</h2>
          <ul>
            {stats.history.map((h, i) => (
              <li key={i}>
                <span className="k-muted">{h.day}</span>
                <span>{KIND_LABELS[h.kind] || h.kind}</span>
                <span>{h.title}</span>
                <span className="k-muted">{h.sent} envoi{h.sent > 1 ? 's' : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
