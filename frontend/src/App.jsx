import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Plotly from 'plotly.js-dist-min';
import {
  Newspaper, Search, ExternalLink, Loader, ChevronDown, ChevronLeft, Database, SlidersHorizontal, BarChart3, Map as MapIcon,
  Landmark, TrendingUp, Users, Scale, Trophy, MapPin, Palette, Leaf, Building2, Globe, HeartPulse, GraduationCap, Package,
  Square, RefreshCw, AlertTriangle, Trash2, MessageSquare, Archive, BookOpen, Star, X, Flame, BellOff, LogIn
} from 'lucide-react';
import './index.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Shared between the map layout and its HTML legend: Plotly assigns these
// colors to traces in order, so index i in both places means the same group
const PLOT_COLORWAY = [
  '#23805C', '#3A6FB8', '#D0703A', '#9E4A8C', '#C99A2A', '#5752B0',
  '#1EA39B', '#C9434A', '#2E6F8E', '#8A6A43',
];
// Codes browser: codesList is only known once /codes/browse has resolved,
// but back-navigation labels (breadcrumbs) may render before or without it
const CODE_LABELS_FALLBACK = (codesList, code) =>
  codesList?.find(c => c.code === code)?.label || code || '';

const CHAT_STORAGE_KEY = 'lekiosque_chat';
// Past turns sent to the LLM for follow-up understanding
const HISTORY_TURNS = 3;
const HISTORY_ANSWER_CHARS = 1200;

const SUGGESTIONS = {
  presse: [
    'Quelles sont les nouvelles du jour ?',
    'Que se passe-t-il avec la SEEG ?',
    "Quoi de neuf dans l'économie gabonaise ?",
  ],
  codes: [
    'Quelles sont les sanctions pour le vol ?',
    'Comment obtenir la nationalité gabonaise ?',
    'Que dit le code minier sur les permis d\'exploitation ?',
  ],
};

// ── Lightweight markdown rendering (bold + bullet lists) ───────────────────
function formatInline(str) {
  const parts = str.split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p));
}

function AnswerText({ text, streaming }) {
  if (streaming) {
    // Mid-stream, an opened **bold** has no closing marker yet and renders
    // as literal asterisks; close it virtually so the text styles immediately
    if ((text.split('**').length - 1) % 2 === 1) text += '**';
    // A bare list marker ("*", "-", "•") on the last line with no content
    // after it yet flashes as a stray character for one frame, before the
    // next chunk supplies the space and the bullet text that would make it
    // match as a list item; simplest fix is to just not render it yet
    text = text.replace(/\n[ \t]*[-•*][ \t]*$/, '');
  }
  const blocks = [];
  let list = null;
  text.split('\n').forEach(line => {
    const m = line.match(/^\s*[-•*]\s+(.*)/);
    if (m) {
      if (!list) { list = []; blocks.push({ type: 'ul', items: list }); }
      list.push(m[1]);
    } else {
      list = null;
      if (line.trim()) blocks.push({ type: 'p', text: line });
    }
  });
  return (
    <div className="msg-text">
      {blocks.map((b, i) =>
        b.type === 'ul' ? (
          <ul key={i}>{b.items.map((it, j) => <li key={j}>{formatInline(it)}</li>)}</ul>
        ) : (
          <p key={i}>{formatInline(b.text)}</p>
        )
      )}
      {streaming && <span className="stream-cursor" />}
    </div>
  );
}

// ── Custom Treemap Algorithm using Squarify approach ───────────────────────
function computeTreemap(data, width, height) {
  let result = [];
  function recurse(items, rx, ry, rw, rh) {
    if (items.length === 0) return;
    if (items.length === 1 || rw <= 0 || rh <= 0) {
      if (items.length > 0) result.push({ ...items[0], x: rx, y: ry, width: rw, height: rh });
      return;
    }
    const total = items.reduce((s, i) => s + i.value, 0);
    let half = total / 2, sum = 0, splitIdx = 0;
    for (let i = 0; i < items.length - 1; i++) {
      sum += items[i].value;
      if (sum >= half) { splitIdx = i; break; }
    }
    const c1 = items.slice(0, splitIdx + 1);
    const c2 = items.slice(splitIdx + 1);
    const sum1 = c1.reduce((s, i) => s + i.value, 0);
    const ratio = total > 0 ? sum1 / total : 0.5;
    
    if (rw > rh) { // split horizontally
      const lw = rw * ratio;
      recurse(c1, rx, ry, lw, rh);
      recurse(c2, rx + lw, ry, rw - lw, rh);
    } else { // split vertically
      const lh = rh * ratio;
      recurse(c1, rx, ry, rw, lh);
      recurse(c2, rx, ry + lh, rw, rh - lh);
    }
  }
  // Sort descending by value
  recurse([...data].sort((a,b) => b.value - a.value), 0, 0, width, height);
  return result;
}

// Waiting label that advances through phases instead of staying frozen:
// perceived wait drops when the system visibly progresses
function ThinkingLabel({ phrases, interval = 5000 }) {
  const [step, setStep] = useState(0);
  const key = phrases.join('|');
  useEffect(() => {
    setStep(0);
    const id = setInterval(
      () => setStep(s => Math.min(s + 1, phrases.length - 1)),
      interval,
    );
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, interval]);
  return <span>{phrases[Math.min(step, phrases.length - 1)]}</span>;
}

// A lightweight provenance summary under each answer: how many articles,
// from how many distinct outlets. The product promise here is "sourced,
// verifiable" — this is the one line that lets a reader notice, without
// having to count the citations themselves, when an answer is resting on
// a single outlet's account rather than corroborated across several
function ProvenanceLine({ sources }) {
  if (!sources || sources.length === 0) return null;
  const counts = {};
  sources.forEach(s => { counts[s.source] = (counts[s.source] || 0) + 1; });
  const bySource = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = sources.length;
  const single = bySource.length === 1;
  return (
    <p className={`provenance-line ${single ? 'single-source' : ''}`}>
      {single
        ? <>Basé sur une seule source : <strong>{bySource[0][0]}</strong> ({total} article{total > 1 ? 's' : ''})</>
        : <>{total} article{total > 1 ? 's' : ''} · {bySource.length} sources : {bySource.map(([s, c]) => `${s} (${c})`).join(', ')}</>}
    </p>
  );
}

const FOLLOW_TYPE_LABELS = { keyword: 'Mot-clé', source: 'Source', theme: 'Thème' };

// Web Push's applicationServerKey wants a Uint8Array, VAPID public keys are
// handed out base64url-encoded — standard MDN conversion, no library needed
// for one function.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function AuthModal({ mode, onClose, onSwitchMode, onSubmit, busy, error, user, authToken, onLogout, onProfileUpdated }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  // Profile-only local state: separate from login/register fields since
  // both can be open across a mode switch without bleeding into each other
  const [profileName, setProfileName] = useState(user?.display_name || '');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [profileMsg, setProfileMsg] = useState('');
  const [profileErr, setProfileErr] = useState('');
  const [profileBusy, setProfileBusy] = useState(false);
  const [follows, setFollows] = useState(null);

  // Push notifications: only meaningful once installed as a PWA with an
  // active service worker (see frontend/src/sw.js) — plain browser tabs on
  // most platforms won't have a usable PushManager.
  const pushSupported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushErr, setPushErr] = useState('');
  const [vapidKey, setVapidKey] = useState('');

  useEffect(() => { setProfileName(user?.display_name || ''); }, [user]);

  useEffect(() => {
    if (mode !== 'profile' || !authToken) return;
    fetch(`${API_URL}/follows`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => (r.ok ? r.json() : []))
      .then(setFollows)
      .catch(() => setFollows([]));
  }, [mode, authToken]);

  useEffect(() => {
    if (mode !== 'profile' || !authToken || !pushSupported) return;
    fetch(`${API_URL}/push/vapid_public_key`)
      .then(r => r.json())
      .then(d => setVapidKey(d.key || ''))
      .catch(() => setVapidKey(''));
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => setPushEnabled(!!sub))
      .catch(() => setPushEnabled(false));
  }, [mode, authToken, pushSupported]);

  const togglePush = useCallback(async () => {
    setPushBusy(true); setPushErr('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch(`${API_URL}/push/subscribe?endpoint=${encodeURIComponent(existing.endpoint)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
        }).catch(() => {});
        await existing.unsubscribe();
        setPushEnabled(false);
        return;
      }
      if (!vapidKey) throw new Error('Notifications indisponibles pour le moment.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notifications refusées dans le navigateur.');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const json = sub.toJSON();
      const res = await fetch(`${API_URL}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
      if (!res.ok) throw new Error("Échec de l'enregistrement des notifications.");
      setPushEnabled(true);
    } catch (e) {
      setPushErr(e.message || 'Erreur notifications.');
    } finally {
      setPushBusy(false);
    }
  }, [authToken, vapidKey]);

  const unfollow = useCallback((type, value) => {
    setFollows(prev => prev.filter(f => !(f.type === type && f.value === value)));
    fetch(`${API_URL}/follows?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
    }).catch(() => {});
  }, [authToken]);

  const saveDisplayName = useCallback(async (e) => {
    e.preventDefault();
    setProfileBusy(true); setProfileErr(''); setProfileMsg('');
    try {
      const res = await fetch(`${API_URL}/auth/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ display_name: profileName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || 'Échec de la mise à jour.');
      onProfileUpdated(body);
      setProfileMsg('Nom mis à jour.');
    } catch (e) { setProfileErr(e.message); } finally { setProfileBusy(false); }
  }, [authToken, profileName, onProfileUpdated]);

  const changePassword = useCallback(async (e) => {
    e.preventDefault();
    setProfileBusy(true); setProfileErr(''); setProfileMsg('');
    try {
      const res = await fetch(`${API_URL}/auth/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || 'Échec du changement de mot de passe.');
      setCurrentPw(''); setNewPw('');
      setProfileMsg('Mot de passe mis à jour.');
    } catch (e) { setProfileErr(e.message); } finally { setProfileBusy(false); }
  }, [authToken, currentPw, newPw]);

  return (
    <div className="auth-modal-backdrop" onClick={onClose}>
      <div className="auth-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="auth-modal-close" onClick={onClose} aria-label="Fermer">✕</button>

        {mode !== 'profile' ? (
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit(mode, mode === 'register'
                ? { email, password, display_name: displayName }
                : { email, password });
            }}
          >
            <h2 className="auth-title">{mode === 'register' ? 'Créer un compte' : 'Se connecter'}</h2>
            {mode === 'register' && (
              <input
                className="auth-input" placeholder="Nom affiché" value={displayName}
                onChange={e => setDisplayName(e.target.value)} required maxLength={80}
              />
            )}
            <input
              className="auth-input" type="email" placeholder="E-mail" value={email}
              onChange={e => setEmail(e.target.value)} required autoComplete="username"
            />
            <input
              className="auth-input" type="password" placeholder="Mot de passe" value={password}
              onChange={e => setPassword(e.target.value)} required minLength={8}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
            {error && <p className="auth-error">{error}</p>}
            <button type="submit" className="auth-submit" disabled={busy}>
              {busy ? '…' : mode === 'register' ? 'Créer le compte' : 'Se connecter'}
            </button>
            <button
              type="button" className="auth-switch"
              onClick={() => onSwitchMode(mode === 'register' ? 'login' : 'register')}
            >
              {mode === 'register' ? 'Déjà un compte ? Se connecter' : "Pas de compte ? En créer un"}
            </button>
          </form>
        ) : (
          <div className="auth-profile">
            <h2 className="auth-title">Profil</h2>
            <p className="auth-profile-email">{user?.email}</p>

            <form className="auth-form auth-form-inline" onSubmit={saveDisplayName}>
              <label className="auth-label">Nom affiché</label>
              <div className="auth-inline-row">
                <input className="auth-input" value={profileName} onChange={e => setProfileName(e.target.value)} maxLength={80} required />
                <button type="submit" className="auth-submit auth-submit-sm" disabled={profileBusy}>Enregistrer</button>
              </div>
            </form>

            <form className="auth-form" onSubmit={changePassword}>
              <label className="auth-label">Changer le mot de passe</label>
              <input className="auth-input" type="password" placeholder="Mot de passe actuel" value={currentPw} onChange={e => setCurrentPw(e.target.value)} autoComplete="current-password" />
              <input className="auth-input" type="password" placeholder="Nouveau mot de passe" value={newPw} onChange={e => setNewPw(e.target.value)} minLength={8} autoComplete="new-password" />
              <button type="submit" className="auth-submit auth-submit-sm" disabled={profileBusy || !currentPw || !newPw}>Mettre à jour</button>
            </form>

            {profileErr && <p className="auth-error">{profileErr}</p>}
            {profileMsg && <p className="auth-success">{profileMsg}</p>}

            <div className="auth-follows">
              <label className="auth-label">Sujets suivis</label>
              {follows === null ? (
                <p className="chat-empty-sub">Chargement…</p>
              ) : follows.length === 0 ? (
                <p className="chat-empty-sub">Aucun sujet suivi pour l'instant — suivez un mot-clé, une source ou un thème depuis les Statistiques (icône ★).</p>
              ) : (
                <div className="auth-follows-list">
                  {follows.map(f => (
                    <div key={`${f.type}-${f.value}`} className="auth-follow-row">
                      <span className="auth-follow-type">{FOLLOW_TYPE_LABELS[f.type]}</span>
                      <span className="auth-follow-label">{f.label}</span>
                      <button className="auth-follow-remove" onClick={() => unfollow(f.type, f.value)} title="Ne plus suivre" aria-label={`Ne plus suivre ${f.label}`}>
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {pushSupported && (
              <div className="auth-follows">
                <label className="auth-label">Notifications</label>
                <p className="chat-empty-sub">
                  Recevez une alerte quand un sujet suivi connaît un pic d'actualité.
                </p>
                <button
                  type="button"
                  className="auth-submit auth-submit-sm"
                  onClick={togglePush}
                  disabled={pushBusy}
                >
                  {pushBusy ? '…' : pushEnabled ? 'Désactiver les notifications' : 'Activer les notifications'}
                </button>
                {pushErr && <p className="auth-error">{pushErr}</p>}
              </div>
            )}

            <button type="button" className="auth-logout" onClick={onLogout}>Se déconnecter</button>
          </div>
        )}
      </div>
    </div>
  );
}

// Shown while the report LLM is still digesting the day's/week's headlines
// (a large prompt, so first-token latency runs 10-15s even though the
// endpoint streams from then on) — mimics the report's real shape (an
// opening paragraph, then themed sections with bullets) so the wait reads
// as "the report is assembling" rather than a dead, empty panel.
function ReportSkeleton({ themes = 3 }) {
  return (
    <div className="report-skeleton" aria-hidden="true">
      <div className="rs-line rs-w90" />
      <div className="rs-line rs-w75" />
      <div className="rs-line rs-w60" />
      {Array.from({ length: themes }).map((_, i) => (
        <div key={i} className="rs-theme">
          <div className="rs-line rs-title rs-w40" />
          <div className="rs-line rs-w85" />
          <div className="rs-line rs-w70" />
        </div>
      ))}
    </div>
  );
}

// A rank heatmap, not a line chart: after two rounds a bump chart's crossing
// lines were still the problem, and crossing lines are inherent to that
// form once several words trade ranks often — no amount of smoothing or
// curve-fitting removes the spaghetti, only fewer crossings does. A grid
// has no lines to cross: one row per word (always legible, no legend to
// decode), one cell per bucket, shaded by that bucket's rank. Color here is
// sequential (one hue, light-to-dark by rank), not categorical, so this
// also sidesteps the whole "how many distinct hues can a reader track"
// ceiling entirely — rows can scale well past 10 without any color cost.
function TrendHeatmapStrip({ ranks, buckets, rankCap }) {
  return (
    <div className="trend-heatmap-strip">
      {ranks.map((r, i) => {
        const intensity = r === null ? 0 : 1 - (r - 1) / Math.max(rankCap - 1, 1);
        return (
          <div
            key={i}
            className="trend-heatmap-cell"
            style={r !== null ? { opacity: 0.16 + intensity * 0.8 } : undefined}
            title={r !== null ? `${buckets[i]} — #${r}` : `${buckets[i]} — hors top 10`}
          />
        );
      })}
    </div>
  );
}

function CustomTreemap({ data, total, categories, isFollowed, toggleFollow, onAskAssistant }) {
  const containerRef = useRef(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [activeCategory, setActiveCategory] = useState(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      if (entries[0]) setDims({ width: entries[0].contentRect.width, height: entries[0].contentRect.height });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const catIcons = {
    'Politique': Landmark, 'Économie': TrendingUp, 'Société': Users, 
    'Faits Divers / Justice': Scale, 'Sport': Trophy, 'Provinces': MapPin,
    'Culture': Palette, 'Environnement': Leaf, 'Administration': Building2,
    'Afrique': Globe, 'Santé': HeartPulse, 'Éducation': GraduationCap, 'Monde': Globe,
    'Faits-divers': Scale, 'International': Globe, 'Nécrologie': Package, 'Autres': Package
  };

  const layout = useMemo(() => {
    if (!dims.width || !dims.height || !data || data.length === 0) return [];
    return computeTreemap(data.map((d, i) => ({ name: d[0], value: d[1], index: i })), dims.width, dims.height);
  }, [data, dims.width, dims.height]);

  return (
    <div ref={containerRef} className="custom-treemap-container">
      {layout.map(item => {
        const IconComp = catIcons[item.name] || Package;
        const colorIdx = data.findIndex(d => d[0] === item.name);
        // Single-hue sequential ramp on the brand's deep green: larger
        // themes read darker. Lightness is capped so white labels keep contrast.
        const rankT = data.length > 1 ? colorIdx / (data.length - 1) : 0;
        const color = `hsl(${163 - rankT * 18}, ${30 - rankT * 10}%, ${24 + rankT * 20}%)`;
        const pct = ((item.value / total) * 100).toFixed(1);

        const isActive = activeCategory === item.name;
        
        let breakdownNodes = null;
        if (isActive && categories && categories[item.name]) {
          const srcData = Object.entries(categories[item.name])
            .sort((a,b) => b[1] - a[1]);
          // "Autres" is a mixed catch-all bucket (everything outside the top
          // 12), not a stable normalizeCategory() value — following it
          // wouldn't match anything meaningful in the delta computation
          const followableTheme = item.name !== 'Autres';
          const themeFollowed = followableTheme && isFollowed('theme', item.name);
          breakdownNodes = (
            <div className="custom-treemap-breakdown">
              <div className="breakdown-title-row">
                <span className="breakdown-title">{item.name} par Source</span>
                {followableTheme && (
                  <button
                    className={`follow-toggle on-dark ${themeFollowed ? 'active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleFollow('theme', item.name, item.name); }}
                    title={themeFollowed ? `Ne plus suivre ${item.name}` : `Suivre ${item.name}`}
                    aria-pressed={themeFollowed}
                  >
                    <Star size={13} /> {themeFollowed ? 'Suivi' : 'Suivre'}
                  </button>
                )}
                <button
                  className="follow-toggle on-dark ask-pill"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAskAssistant(`Que disent les articles récents sur le thème ${item.name} ?`);
                  }}
                  title={`Demander à l'assistant : ${item.name}`}
                >
                  Demander à l'assistant →
                </button>
              </div>
              <div className="breakdown-list">
                {srcData.map(([src, count]) => {
                  const srcPct = ((count / item.value) * 100).toFixed(1);
                  return (
                    <div key={src} className="breakdown-row">
                      <span className="breakdown-src">{src}</span>
                      <span className="breakdown-pct">{srcPct}%</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }

        return (
          <div key={item.name} 
            className={`custom-treemap-box ${isActive ? 'active' : ''}`}
            onClick={() => setActiveCategory(isActive ? null : item.name)}
            style={{ 
              left: isActive ? '0px' : `${item.x}px`, top: isActive ? '0px' : `${item.y}px`, 
              width: isActive ? '100%' : `${item.width}px`, height: isActive ? '100%' : `${item.height}px`,
              backgroundColor: color 
            }}>
            
            {isActive ? breakdownNodes : (
              <div className="custom-treemap-content">
                {item.width > 60 && item.height > 60 && (
                   <IconComp className="custom-treemap-icon" size={Math.min(item.width, item.height) * 0.25} />
                )}
                {/* Below these sizes labels truncate unreadably ("vironnem"):
                    small cells stay blank, the hover overlay carries the info */}
                {item.height > 35 && item.width > 90 && (
                  <div className="custom-treemap-text">
                    <span className="custom-treemap-name">{item.name}</span>
                    {item.height > 75 && item.width > 110 && (
                      <span className="custom-treemap-meta">{item.value} art. ({pct}%)</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Hover overlay via CSS (hidden when active) */}
            {!isActive && (
              <div className="custom-treemap-hover">
                <span className="hover-name">{item.name}</span>
                <span className="hover-val">{item.value} articles ({pct}%)</span>
                <span className="hover-hint">Cliquer pour voir les sources</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeView, setActiveView] = useState('explore'); // 'explore' or 'stats'

  // Auth — opaque session token (see auth.py), not a JWT, so logout is a
  // real server-side revocation rather than "hope the client forgets it"
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('lekiosque_auth_token'));
  const [user, setUser] = useState(null);
  const [authModal, setAuthModal] = useState(null); // null | 'login' | 'register' | 'profile'
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');

  useEffect(() => {
    if (!authToken) { setUser(null); return; }
    fetch(`${API_URL}/auth/me`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(setUser)
      .catch(() => {
        // Token expired/revoked server-side — drop it rather than keep
        // silently retrying every render
        localStorage.removeItem('lekiosque_auth_token');
        setAuthToken(null);
        setUser(null);
      });
  }, [authToken]);

  const handleAuthSubmit = useCallback(async (mode, fields) => {
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = await fetch(`${API_URL}/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.detail || 'Une erreur est survenue.');
      localStorage.setItem('lekiosque_auth_token', body.token);
      setAuthToken(body.token);
      setUser(body.user);
      setAuthModal(null);
    } catch (e) {
      setAuthError(e.message);
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const logout = useCallback(() => {
    if (authToken) {
      fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${authToken}` } }).catch(() => {});
    }
    localStorage.removeItem('lekiosque_auth_token');
    setAuthToken(null);
    setUser(null);
    setAuthModal(null);
  }, [authToken]);

  // "Since your last visit", surfaced on the actual front door (the
  // Assistant landing state) rather than only inside Statistiques — logging
  // in should visibly change what greets you, or the account is plumbing
  // without payoff. Tracked independently from the Statistiques strip's own
  // last-seen marker (that one only advances when Statistiques is actually
  // opened; this one advances on every app load, which is the more honest
  // reading of "since you were last here" for a landing-page feature).
  const LANDING_LAST_VISIT_KEY = 'lekiosque_landing_last_seen_date';
  const [landingFollows, setLandingFollows] = useState([]);
  const [landingLastSeenDate] = useState(() => localStorage.getItem(LANDING_LAST_VISIT_KEY));
  const dateMax = useMemo(() => {
    const dates = data?.points?.map(p => p.date).filter(Boolean);
    return dates?.length ? dates.reduce((a, b) => (b > a ? b : a)) : null;
  }, [data]);
  useEffect(() => {
    if (dateMax) localStorage.setItem(LANDING_LAST_VISIT_KEY, dateMax);
  }, [dateMax]);
  useEffect(() => {
    if (!user || !authToken) { setLandingFollows([]); return; }
    fetch(`${API_URL}/follows`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => (r.ok ? r.json() : []))
      .then(setLandingFollows)
      .catch(() => setLandingFollows([]));
  }, [user, authToken]);
  const landingDeltas = useMemo(
    () => computeFollowDeltas(data?.points, landingFollows, landingLastSeenDate, dateMax),
    [data, landingFollows, landingLastSeenDate, dateMax]
  );

  // Viz controls
  const [method, setMethod] = useState('UMAP');
  const [dim, setDim] = useState('3D');
    // Default to the editorial rubrique rather than the HDBSCAN clusters:
  // cluster_name lumps every "noise" point (HDBSCAN label -1, points too
  // sparse to join a dense cluster) under "Divers / Non-classé", which at
  // this corpus size dominates the map and has nothing to do with the
  // cleaned-up category taxonomy used everywhere else in the dashboard
  const [colorBy, setColorBy] = useState('category');
  const [showControls, setShowControls] = useState(false);
  // The semantic map is optional viewing — hideable for non-technical users.
  // Chat and the daily briefing are the primary job — a cloud of 100+
  // same-ish colored dots is high-cognition, low-immediate-payoff, and the
  // map used to claim ~55% of the desktop screen (the entire screen on
  // mobile) by default before a user reached the thing they came for. The
  // map is a genuine credibility/exploration asset, but it's opt-in now on
  // both platforms; an explicit "show map" choice is still remembered per
  // breakpoint (separate keys so a desktop preference can't hand a phone a
  // full-viewport map with no visible way back).
  const phoneAtLoad = window.matchMedia('(max-width: 768px)').matches;
  const [showMap, setShowMap] = useState(() => {
    const key = phoneAtLoad ? 'lekiosque_show_map_phone' : 'lekiosque_show_map_desktop';
    return localStorage.getItem(key) === '1';
  });
  const toggleMap = useCallback(() => setShowMap(v => {
    const key = window.matchMedia('(max-width: 768px)').matches
      ? 'lekiosque_show_map_phone' : 'lekiosque_show_map_desktop';
    localStorage.setItem(key, v ? '0' : '1');
    // Closing the map also closes its settings panel, so no control residue
    // can linger over the chat (mobile overlay bug)
    if (v) { setShowControls(false); setHoveredPoint(null); setHighlightedGroup(null); }
    return !v;
  }), []);
  const closeMap = useCallback(() => {
    const key = window.matchMedia('(max-width: 768px)').matches
      ? 'lekiosque_show_map_phone' : 'lekiosque_show_map_desktop';
    localStorage.setItem(key, '0');
    setShowControls(false);
    setShowMap(false);
    setHoveredPoint(null);
    setHighlightedGroup(null);
  }, []);

  // Codes de loi side panel — browse codes/titres/chapitres/articles.
  // No equivalent projection exists for this corpus, so it's a plain
  // tree browser rather than the press map's semantic scatter.
  const [showCodesBrowser, setShowCodesBrowser] = useState(false);
  const [codesList, setCodesList] = useState(null);       // [{code,label,count}] | null (not fetched yet)
  const [codeEntries, setCodeEntries] = useState({});      // {[code]: [{id,numero,type,contexte}]}
  const [activeCode, setActiveCode] = useState(null);      // currently browsed code slug
  const [activeArticle, setActiveArticle] = useState(null); // {id,numero,contexte,label,url,text} | {id,loading:true} | null

  const openCodesBrowser = useCallback(() => {
    setShowCodesBrowser(true);
    setCodesList(list => {
      if (list !== null) return list;
      fetch(`${API_URL}/codes/browse`)
        .then(r => r.json())
        .then(body => setCodesList(body.codes || []))
        .catch(() => setCodesList([]));
      return list;
    });
  }, []);
  const closeCodesBrowser = useCallback(() => {
    setShowCodesBrowser(false);
  }, []);
  const toggleCodesBrowser = useCallback(() => {
    setShowCodesBrowser(v => {
      if (!v) openCodesBrowser();
      return !v;
    });
  }, [openCodesBrowser]);
  const openCode = useCallback((code) => {
    setActiveCode(code);
    setActiveArticle(null);
    setCodeEntries(prev => {
      if (prev[code]) return prev;
      fetch(`${API_URL}/codes/browse/${encodeURIComponent(code)}`)
        .then(r => r.json())
        .then(body => setCodeEntries(p => ({ ...p, [code]: body.entries || [] })))
        .catch(() => setCodeEntries(p => ({ ...p, [code]: [] })));
      return prev;
    });
  }, []);
  const openArticle = useCallback((id) => {
    setActiveArticle({ id, loading: true });
    fetch(`${API_URL}/codes/article/${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then(body => setActiveArticle(body))
      .catch(() => setActiveArticle(null));
  }, []);
  // Groups a code's flat entry list into Titre → Chapitre → [articles],
  // mirroring the " | "-joined hierarchy the ingestion script already
  // derived from each code's own section headings
  const codeTree = useMemo(() => {
    const entries = activeCode ? codeEntries[activeCode] : null;
    if (!entries) return null;
    const titres = new Map();
    for (const e of entries) {
      const parts = (e.contexte || '').split('|').map(s => s.trim()).filter(Boolean);
      const titre = parts[0] || 'Préambule';
      const chapitre = parts[1] || null;
      if (!titres.has(titre)) titres.set(titre, new Map());
      const chapitres = titres.get(titre);
      const key = chapitre || '__direct__';
      if (!chapitres.has(key)) chapitres.set(key, { label: chapitre, items: [] });
      chapitres.get(key).items.push(e);
    }
    return titres;
  }, [activeCode, codeEntries]);

  // Chat state — restored from localStorage so the conversation survives reloads
  const [question, setQuestion] = useState('');
  // Which chat turn's "Copié !" confirmation is currently showing
  const [copiedIdx, setCopiedIdx] = useState(null);
  const copyAnswer = useCallback((idx, text) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(i => (i === idx ? null : i)), 1800);
    });
  }, []);
  const [searching, setSearching] = useState(false);
  const [corpus, setCorpus] = useState('presse'); // 'presse' | 'codes'
  const [chatHistory, setChatHistory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]');
      // Drop turns interrupted mid-stream (no answer, no error)
      return Array.isArray(saved) ? saved.filter(c => c.answer || c.error) : [];
    } catch { return []; }
  }); // { question, answer, sources, error }
  const [apiStatus, setApiStatus] = useState('checking'); // 'checking' | 'online' | 'offline'

  // Press-review report (daily or weekly), streamed from the API into a side panel.
  // reportOpen drives the panel's slide transition; report keeps its text while
  // the panel closes so it doesn't collapse empty
  const [report, setReport] = useState(null); // null = never generated, '' = loading
  const [reportOpen, setReportOpen] = useState(false);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportKind, setReportKind] = useState('weekly'); // 'daily' | 'weekly'

  const genLockRef = useRef(false);

  // Archive of past reports (report_archive.py / SQLite on the server).
  // viewingArchiveId marks the currently-open report as a re-read of a past
  // edition rather than a fresh generation (hides the PDF link — archived
  // entries don't keep the exact article list a PDF rebuild would need —
  // and shows its real date instead of "en cours").
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveList, setArchiveList] = useState(null);
  const [viewingArchiveId, setViewingArchiveId] = useState(null);
  // Server-confirmed cache hit on the *live* endpoint — a lighter signal
  // than viewingArchiveId: the PDF link stays valid here, only the tag differs
  const [reportFromCache, setReportFromCache] = useState(false);
  // "New since your last visit" badge: compares the newest archive id
  // against the highest id this browser has actually opened
  const [lastSeenArchiveId, setLastSeenArchiveId] = useState(() =>
    Number(localStorage.getItem('lekiosque_last_seen_report_id')) || 0);
  const [latestArchiveId, setLatestArchiveId] = useState(0);
  const newSinceVisit = Math.max(0, latestArchiveId - lastSeenArchiveId);

  useEffect(() => {
    fetch(`${API_URL}/reports/archive?limit=1`)
      .then(r => r.ok ? r.json() : [])
      .then(list => { if (list[0]) setLatestArchiveId(list[0].id); })
      .catch(() => {});
  }, []);

  const openArchive = useCallback(async () => {
    if (genLockRef.current) return;
    setArchiveOpen(true);
    setReportOpen(true);
    try {
      const res = await fetch(`${API_URL}/reports/archive?limit=30`);
      const list = res.ok ? await res.json() : [];
      setArchiveList(list);
      if (list[0]) {
        setLastSeenArchiveId(list[0].id);
        localStorage.setItem('lekiosque_last_seen_report_id', String(list[0].id));
      }
    } catch {
      setArchiveList([]);
    }
  }, []);

  const openArchivedReport = useCallback(async (id) => {
    setArchiveOpen(false);
    setReportOpen(true);
    setReport('');
    setReportFromCache(false);
    setReportLoading(true);
    try {
      const res = await fetch(`${API_URL}/reports/archive/${id}`);
      if (!res.ok) throw new Error();
      const row = await res.json();
      setReportKind(row.kind);
      setViewingArchiveId(id);
      setReport(row.text);
    } catch {
      setReport("Impossible de charger cette édition archivée.");
    } finally {
      setReportLoading(false);
    }
  }, []);

  const fetchReport = useCallback(async (kind = 'weekly') => {
    // Same single-flight lock as the chat: a report launched while an answer
    // streams would just queue behind it in Ollama and look frozen
    if (genLockRef.current) return;
    genLockRef.current = true;
    setReportKind(kind);
    setReportOpen(true);
    setArchiveOpen(false);
    setViewingArchiveId(null);
    setReportLoading(true);
    setReport('');
    setReportFromCache(false);
    try {
      const res = await fetch(`${API_URL}/${kind === 'daily' ? 'daily_report' : 'weekly_report'}`);
      if (!res.ok) throw new Error(`Le serveur a renvoyé une erreur (${res.status}).`);
      // Distinct from "édition archivée": a cache hit still has this
      // window's article list server-side, so the PDF link stays valid —
      // unlike an archive-reloaded report (text only). Told explicitly by
      // the server rather than guessed from how fast the response arrived.
      setReportFromCache(res.headers.get('X-Report-Source') === 'cache');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setReport(text);
      }
    } catch (e) {
      setReport(`Impossible de générer le rapport : ${e.message}`);
    } finally {
      genLockRef.current = false;
      setReportLoading(false);
    }
  }, []);

  const plotRef = useRef(null);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const mapToggleRef = useRef(null);
  const codesToggleRef = useRef(null);

  // Escape closes whichever overlay is open (map, codes browser, or report),
  // and returns focus to the control that opened it — without this, these
  // are keyboard traps on mobile, where they're full-screen sheets with no
  // other dismissal in reach
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (showMap) { closeMap(); mapToggleRef.current?.focus(); }
      else if (showCodesBrowser) { closeCodesBrowser(); codesToggleRef.current?.focus(); }
      else if (reportOpen) { setReportOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showMap, showCodesBrowser, reportOpen, closeMap, closeCodesBrowser]);

  // Ping the API so the user knows if the backend is up. Also carries the
  // server's Gabon-anchored "today", the only reliable source for it: a
  // visitor's own device clock/timezone can't be trusted (see gabon_now()
  // in api.py — this is the same fix, applied to the dashboard's own
  // "Aujourd'hui" framing instead of the RAG windows).
  const [gabonToday, setGabonToday] = useState(null);
  // When we last actually heard back from /health — distinct from gabonToday
  // (the corpus's freshness date): this is "is the connection itself current
  // right now", shown next to the status dot so a stale check isn't mistaken
  // for a live one (same reasoning as the iOS widget's "MàJ" timestamp).
  const [lastChecked, setLastChecked] = useState(null);
  const checkApi = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(4000) });
      setApiStatus(res.ok ? 'online' : 'offline');
      setLastChecked(new Date());
      if (res.ok) {
        const body = await res.json();
        if (body.gabon_today) setGabonToday(body.gabon_today);
      }
    } catch {
      setApiStatus('offline');
      setLastChecked(new Date());
    }
  }, []);

  useEffect(() => {
    checkApi();
    const id = setInterval(checkApi, 30000);
    return () => clearInterval(id);
  }, [checkApi]);

  // Abort any in-flight request on unmount
  useEffect(() => () => abortRef.current?.abort(), []);

  // Live view of chatHistory for runSearch (its closure only refreshes on
  // length changes, so streamed answer content would otherwise be stale)
  const chatRef = useRef(chatHistory);
  useEffect(() => { chatRef.current = chatHistory; }, [chatHistory]);

  // Persist the conversation once streaming settles
  useEffect(() => {
    if (searching) return;
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory.slice(-30)));
    } catch { /* storage full or unavailable — chat just won't persist */ }
  }, [chatHistory, searching]);

  const clearChat = useCallback(() => {
    abortRef.current?.abort();
    setChatHistory([]);
    localStorage.removeItem(CHAT_STORAGE_KEY);
    inputRef.current?.focus();
  }, []);

  // Most recent article date — surfaced so stale data is visible at a glance
  const latestDate = useMemo(() => {
    if (!data?.points) return null;
    let max = '';
    data.points.forEach(p => { if (p.date && p.date > max) max = p.date; });
    return max || null;
  }, [data]);

  // Load data.json
  useEffect(() => {
    fetch('/data.json')
      .then(res => {
        if (!res.ok) throw new Error('data.json not found. Run export_embeddings.py first.');
        return res.json();
      })
      .then(json => { setData(json); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  // Scroll chat
  useEffect(() => {
    if (chatHistory.length > 0 && activeView === 'explore') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory, activeView]);

  const runSearch = useCallback(async (userQ, existingIdx = null) => {
    // Single-flight: Ollama serializes generations anyway, and two concurrent
    // runs capture the same history index and overwrite each other's turn
    if (genLockRef.current) return;
    genLockRef.current = true;
    setSearching(true);
    const controller = new AbortController();
    abortRef.current = controller;

    // Completed turns before this one — conversational context for the API
    const priorTurns = chatRef.current
      .slice(0, existingIdx ?? chatRef.current.length)
      .filter(c => c.answer && !c.error);
    const prevQuestion = priorTurns.length ? priorTurns[priorTurns.length - 1].question : '';

    // Add a pending entry (or reset the retried one in place)
    const idx = existingIdx ?? chatHistory.length;
    const fresh = { question: userQ, answer: '', sources: null, error: null };
    setChatHistory(prev => existingIdx === null
      ? [...prev, fresh]
      : prev.map((c, i) => (i === idx ? fresh : c)));
    const patch = (p) => setChatHistory(prev => prev.map((c, i) => (i === idx ? { ...c, ...p } : c)));

    let answer = '';
    try {
      const res = await fetch(`${API_URL}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: userQ, n_results: 5, previous_question: prevQuestion, corpus }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = `Le serveur a renvoyé une erreur (${res.status}).`;
        try {
          const j = await res.json();
          if (j.detail) detail = typeof j.detail === 'string' ? j.detail : detail;
        } catch { /* non-JSON error body */ }
        throw new Error(detail);
      }

      const json = await res.json();
      patch({ sources: json.results });

      // Stream the AI answer
      const streamRes = await fetch(`${API_URL}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userQ,
          corpus,
          urls: corpus === 'codes' ? [] : json.results.map(r => r.url),
          ids: corpus === 'codes' ? json.results.map(r => r.id) : [],
          history: priorTurns.slice(-HISTORY_TURNS).map(c => ({
            question: c.question,
            answer: c.answer.slice(0, HISTORY_ANSWER_CHARS),
          })),
        }),
        signal: controller.signal,
      });
      if (!streamRes.ok) throw new Error(`La génération a échoué (${streamRes.status}).`);
      // Same corpus/question/sources already answered recently (someone
      // else asked it, a retry, a refresh) — served from cache instead of
      // paying the local-LLM tax again. Surfaced honestly rather than
      // silently, same reasoning as the report's cache tag.
      const fromCache = streamRes.headers.get('X-Answer-Source') === 'cache';

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        patch({ answer, fromCache });
      }
      setApiStatus('online');

    } catch (err) {
      if (err.name === 'AbortError') {
        // User stopped the generation — keep whatever was streamed
        patch(answer ? { answer } : { error: 'Recherche interrompue.' });
      } else if (err instanceof TypeError) {
        // Network-level failure (API not running / unreachable)
        setApiStatus('offline');
        patch({ error: `Impossible de contacter l'API sur ${API_URL}. Vérifiez que le serveur est lancé (python api.py).` });
      } else {
        console.error(err);
        patch({ error: err.message });
      }
    } finally {
      genLockRef.current = false;
      setSearching(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }, [chatHistory.length, corpus]);

  const handleSearch = useCallback((e) => {
    e?.preventDefault();
    if (!question.trim() || searching || reportLoading) return;
    const userQ = question.trim();
    setQuestion('');
    runSearch(userQ);
  }, [question, searching, runSearch]);

  const stopSearch = useCallback(() => abortRef.current?.abort(), []);

  // Map Data
  const latestSources = chatHistory.length > 0 ? chatHistory[chatHistory.length - 1].sources : null;
  // Long unwrapped titles push the hover tooltip past the container edge
  // near the right/bottom of the map; force line breaks at word boundaries
  const wrapTitle = (title, width = 42) => {
    const words = (title || '').split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > width) { lines.push(line.trim()); line = w; }
      else line = (line + ' ' + w).trim();
    }
    if (line) lines.push(line);
    return lines.join('<br>');
  };
  // Clicking a legend chip isolates that category — the map's ~100+ thematic
  // groups lean on color alone, which colorblind users and dense scatter
  // both defeat; isolating one at a time doesn't depend on distinguishing hues
  const [highlightedGroup, setHighlightedGroup] = useState(null);
  const plotTraces = useMemo(() => {
    if (!data || !data.points) return [];
    const highlightUrls = new Set((latestSources || []).map(r => r.url));
    const groups = {};
    data.points.forEach(pt => {
      const coords = pt.projections[`${method}_${dim}`];
      if (!coords) return;
      // Raw category values are inconsistent across sources/collection eras
      // ("societe" vs "société" vs "societe-et-politique"…) — the rest of
      // the dashboard folds them through normalizeCategory before display;
      // the map must do the same or the same rubrique fragments into lookalike
      // legend entries. cluster_name/source need no such normalization.
      const g = colorBy === 'category'
        ? normalizeCategory(pt.category, pt.source)
        : (pt[colorBy] || 'Inconnu');
      if (!groups[g]) {
        groups[g] = {
          name: g, x: [], y: [], z: [], text: [], customdata: [],
          hovertemplate: '%{text}<extra></extra>',
          mode: 'markers', type: dim === '2D' ? 'scatter' : 'scatter3d',
          marker: { size: dim === '2D' ? 8 : 5, opacity: highlightUrls.size > 0 ? 0.15 : 1, line: { width: 0 } }
        };
      }
      groups[g].x.push(coords[0]);
      groups[g].y.push(coords[1]);
      if (dim === '3D') groups[g].z.push(coords[2]);
      groups[g].text.push(`<b>${wrapTitle(pt.title)}</b><br>${pt.date} — ${pt.source}`);
      // Richer than a bare URL: powers both the click-to-open handler and
      // the mobile "Ouvrir l'article" confirm button (built from the last
      // hovered/tapped point, since taps on 3D scatter often start a
      // rotate gesture instead of registering as a click)
      groups[g].customdata.push({ url: pt.url || '', title: pt.title, date: pt.date, source: pt.source });
    });
    // normalizeCategory() only explicitly folds the ~9 core rubriques —
    // anything it doesn't recognize (source-specific tags like "Sosconso",
    // "Can 2025", "Publirédactionnel"…) falls through unchanged, so category
    // mode was ending up with ~30 distinct traces/colors/legend entries
    // instead of a readable set. Bucket everything past the top 8 by size
    // into "Autres" here, before Plotly (and the legend, built from these
    // same traces) ever sees them.
    if (colorBy === 'category') {
      const CAP = 8;
      const bySize = Object.keys(groups)
        .filter(n => n !== 'Autres')
        .sort((a, b) => groups[b].x.length - groups[a].x.length);
      if (bySize.length > CAP) {
        const autres = groups['Autres'] || {
          name: 'Autres', x: [], y: [], z: [], text: [], customdata: [],
          hovertemplate: '%{text}<extra></extra>', mode: 'markers',
          type: dim === '2D' ? 'scatter' : 'scatter3d',
          marker: { size: dim === '2D' ? 8 : 5, opacity: highlightUrls.size > 0 ? 0.15 : 1, line: { width: 0 } },
        };
        bySize.slice(CAP).forEach(name => {
          const g = groups[name];
          autres.x.push(...g.x); autres.y.push(...g.y); autres.z.push(...g.z);
          autres.text.push(...g.text); autres.customdata.push(...g.customdata);
          delete groups[name];
        });
        groups['Autres'] = autres;
      }
    }
    const traces = Object.values(groups);
    if (highlightUrls.size > 0) {
      const hx = [], hy = [], hz = [], ht = [], hd = [];
      data.points.forEach(pt => {
        if (!highlightUrls.has(pt.url)) return;
        const coords = pt.projections[`${method}_${dim}`];
        if (!coords) return;
        hx.push(coords[0]); hy.push(coords[1]);
        if (dim === '3D') hz.push(coords[2]);
        ht.push(`<b>${wrapTitle(pt.title)}</b>`);
        hd.push({ url: pt.url || '', title: pt.title, date: pt.date, source: pt.source });
      });
      traces.push({
        name: 'Vos Résultats', x: hx, y: hy, z: dim === '3D' ? hz : undefined,
        text: ht, customdata: hd, hovertemplate: '%{text}<extra></extra>', mode: 'markers',
        type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: { size: dim === '2D' ? 14 : 10, color: '#0F2A3A', symbol: 'diamond' }
      });
    }
    return traces;
  }, [data, method, dim, colorBy, latestSources]);
  // A highlighted group name only means something for the colorBy dimension
  // it was picked under ("Politique" vs. a cluster name aren't comparable)
  useEffect(() => setHighlightedGroup(null), [colorBy]);

  // Render Map
  useEffect(() => {
    if (activeView !== 'explore' || !showMap || !plotRef.current || plotTraces.length === 0) return;
    const is3D = dim === '3D';
    // Embedding axes carry no user-facing meaning: hide them entirely, the
    // legend caption explains that proximity = topical similarity
    const axisStyle = { visible: false };
    Plotly.react(plotRef.current, plotTraces, {
      colorway: PLOT_COLORWAY,
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#5B6B7A', family: 'Poppins' }, showlegend: false,
      margin: { l: 0, r: 0, b: 0, t: 0 },
      // Wrapped titles (wrapTitle) already stay narrow; this just keeps the
      // label styled and left-aligned so multi-line text reads cleanly
      hoverlabel: { bgcolor: '#FFFFFF', bordercolor: '#6B8F7A', align: 'left', font: { size: 11.5 } },
      ...(is3D ? { scene: { xaxis: axisStyle, yaxis: axisStyle, zaxis: axisStyle, bgcolor: 'transparent' } } : { xaxis: axisStyle, yaxis: axisStyle })
    }, { responsive: true, displayModeBar: false });
    plotRef.current.removeAllListeners?.('plotly_click');
    plotRef.current.on?.('plotly_click', (e) => {
      const url = e.points[0].customdata?.url;
      if (url) window.open(url, '_blank');
    });
    // On 3D scatter, a mobile tap is easily swallowed by the orbit/rotate
    // gesture before it registers as a click; hover fires reliably on tap
    // instead, so it drives the confirm button below the map
    plotRef.current.removeAllListeners?.('plotly_hover');
    plotRef.current.on?.('plotly_hover', (e) => {
      const cd = e.points[0].customdata;
      if (cd?.url) setHoveredPoint(cd);
    });
  }, [plotTraces, activeView, dim, showMap]);

  // Legend-driven category isolation, via Plotly.restyle. Two rejected
  // attempts first: (a) opacity alone looked right for the sparse isolated
  // group but did nothing for the dense main cluster — hundreds of
  // overlapping same-hued points alpha-composite back toward full color
  // even at 5% each; (b) hiding other traces entirely (visible:false) fixed
  // that but throws away the spatial context of where everything else sits,
  // which defeats the point of a "highlight" (confirmed unwanted).
  // Recoloring to a flat neutral grey solves both: grey stacked on grey is
  // still grey, no compounding back to a saturated hue, and the map stays
  // populated. Reads from `plotTraces` (our own memo) rather than the live
  // `gd.data`, since restyle mutates the plot's data in place and a later
  // run must not treat its own previous grey/dim output as the baseline.
  const NEUTRAL_MARKER = '#D5DBD7';
  useEffect(() => {
    const gd = plotRef.current;
    if (activeView !== 'explore' || !showMap || !gd?.data?.length
        || plotTraces.length !== gd.data.length) return;
    // Never read color/opacity back off plotTraces[i].marker here: Plotly
    // keeps the same object references and restyle mutates them in place,
    // so a later run would see its OWN previous output (e.g. the neutral
    // grey) as if it were the original base — silently losing a trace's
    // real color after a couple of highlight/clear cycles. Recompute the
    // true baseline from scratch every time instead.
    const searchHighlightActive = (latestSources || []).length > 0;
    const baseOpacity = searchHighlightActive ? 0.15 : 1;
    const colors = plotTraces.map((t, i) => {
      if (t.name === 'Vos Résultats') return '#0F2A3A';
      const base = PLOT_COLORWAY[i % PLOT_COLORWAY.length];
      return !highlightedGroup || t.name === highlightedGroup ? base : NEUTRAL_MARKER;
    });
    const opacities = plotTraces.map(t => {
      if (t.name === 'Vos Résultats') return 1;
      if (!highlightedGroup || t.name === highlightedGroup) return baseOpacity;
      return Math.min(baseOpacity, 0.4);
    });
    Plotly.restyle(gd, {
      'marker.color': colors,
      'marker.opacity': opacities,
      visible: plotTraces.map(() => true),
    });
  }, [highlightedGroup, plotTraces, activeView, showMap, latestSources]);

  // The panel slides open over 0.45s; Plotly renders before the width settles,
  // so resize once the transition is done
  useEffect(() => {
    if (!showMap || reportOpen || !plotRef.current) return;
    const t = setTimeout(() => {
      try { Plotly.Plots.resize(plotRef.current); } catch { /* plot not drawn yet */ }
    }, 500);
    return () => clearTimeout(t);
  }, [showMap, reportOpen]);

  // Last hovered/tapped map point, for the mobile "Ouvrir l'article" button
  const [hoveredPoint, setHoveredPoint] = useState(null);

  // Reactive breakpoint: inline width overrides must release when the window
  // narrows, otherwise a stored divider width defeats the mobile stacking
  const [isPhone, setIsPhone] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const fn = e => setIsPhone(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  // Draggable divider: the reader chooses the chat/map balance; width is
  // remembered per browser, double-click resets to the default clamp
  const [chatWidth, setChatWidth] = useState(() => {
    const w = Number(localStorage.getItem('lekiosque_chat_w'));
    return w >= 400 ? w : null;
  });
  const chatWidthRef = useRef(chatWidth);
  const startDivider = useCallback((e) => {
    e.preventDefault();
    const onMove = (ev) => {
      const w = Math.min(Math.max(ev.clientX, 400), window.innerWidth - 320);
      chatWidthRef.current = w;
      setChatWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (chatWidthRef.current) {
        localStorage.setItem('lekiosque_chat_w', String(Math.round(chatWidthRef.current)));
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);
  const resetDivider = useCallback(() => {
    chatWidthRef.current = null;
    setChatWidth(null);
    localStorage.removeItem('lekiosque_chat_w');
  }, []);
  // The map (presse) and the codes browser (codes) share one "secondary
  // panel" slot — corpus mode gates which one the toggle even offers, and
  // switchCorpus force-closes the other, so at most one is ever open
  const secondaryPanelOpen = showMap || showCodesBrowser;
  const sidePanelOpen = secondaryPanelOpen || reportOpen;
  // On desktop, the secondary panel and report can coexist (stacked) rather
  // than one hiding the other — reading today's brief while eyeballing
  // where those stories cluster on the map is a real research move the old
  // single-slot panel didn't allow. On mobile both are full-screen overlay
  // sheets with no room to share, so opening one still closes the other there.
  const mapVisible = showMap && (!isPhone || !reportOpen);
  const codesBrowserVisible = showCodesBrowser && corpus === 'codes' && (!isPhone || !reportOpen);
  const workspaceStacked = !isPhone && secondaryPanelOpen && reportOpen;
  const customChatStyle = sidePanelOpen && chatWidth && !isPhone
    ? { flex: 'none', width: chatWidth, minWidth: chatWidth, maxWidth: chatWidth }
    : undefined;

  // Corpus switch + input live in the hero on the empty landing screen
  // (ChatGPT-style centered composition) and at the bottom once a
  // conversation exists
  const chatIsEmpty = chatHistory.length === 0 && !searching;
  // Switching corpus starts a fresh thread: mixing press and legal answers
  // in one conversation makes the history ambiguous on re-reading
  const switchCorpus = (c) => {
    if (c === corpus) return;
    setCorpus(c);
    if (chatHistory.length > 0 || searching) clearChat();
    // The semantic map only exists for the press corpus (no equivalent
    // projection has been built for the legal codes) — switching to Codes
    // de loi with the map open used to leave press-corpus dots on screen
    // while the user asked legal questions, captioned "la carte couvre le
    // corpus presse, pas les codes de loi" as if that were an acceptable
    // caveat. It isn't: close it rather than show data from the other mode.
    if (c === 'codes' && showMap) closeMap();
    // Symmetric guard: the codes browser has no meaning for the press
    // corpus either, so leaving codes closes it the same way
    if (c === 'presse' && showCodesBrowser) closeCodesBrowser();
  };

  // Statistiques → Assistant hand-off: a keyword/source/thème click there
  // seeds and runs a scoped question here, so the dashboard's "interesting
  // data" becomes an actual next step instead of a dead end. The dashboard
  // is press-only, so this always targets the presse corpus — if the user
  // was in Codes de loi, switchCorpus's setCorpus('presse') won't be visible
  // to runSearch's closure until the next render, so the question is queued
  // and fired from the effect below once corpus has actually caught up.
  const [pendingAsk, setPendingAsk] = useState(null);
  const askAssistant = useCallback((q) => {
    setActiveView('explore');
    if (corpus !== 'presse') {
      switchCorpus('presse');
      setPendingAsk(q);
    } else {
      runSearch(q);
    }
  }, [corpus, runSearch]);
  useEffect(() => {
    if (pendingAsk && corpus === 'presse') {
      runSearch(pendingAsk);
      setPendingAsk(null);
    }
  }, [pendingAsk, corpus, runSearch]);

  // Comparison ("vs") mode: same topic, two time periods, two independent
  // search+answer runs rendered as sourced columns. Press-only (the whole
  // premise is contrasting press coverage across time) and deliberately not
  // part of chatHistory — a comparison isn't a conversational turn a
  // follow-up question could sensibly continue from, so it gets its own
  // self-contained state instead of stretching the chat turn shape to fit.
  const [compareMode, setCompareMode] = useState(false);
  const [compareTopic, setCompareTopic] = useState('');
  const [comparePreset, setComparePreset] = useState('week'); // 'week' | 'month' | 'custom'
  const [compareCustom, setCompareCustom] = useState({ aStart: '', aEnd: '', bStart: '', bEnd: '' });
  const [compareResult, setCompareResult] = useState(null);
  const [comparing, setComparing] = useState(false);
  // Points at whichever column's fetch is currently in flight — stopCompare
  // aborts through this, one column at a time (see runCompare below for why
  // the two columns run sequentially rather than concurrently)
  const compareAbortRef = useRef(null);
  // Distinguishes "user hit Arrêter" from "the per-column timeout fired",
  // both of which surface as an AbortError in the same catch block
  const compareStopRef = useRef(false);
  // Bumped on every runCompare call; a column only applies its patch if this
  // still matches the id it was started with — without this, a column from
  // a run the user already stopped/replaced could land its answer on top of
  // a newer run's column by array index alone
  const compareRunIdRef = useRef(0);

  const isoDate = (d) => d.toISOString().slice(0, 10);
  const periodPresetRanges = useCallback((preset) => {
    const today = gabonToday ? new Date(gabonToday) : new Date();
    if (preset === 'week') {
      const aEnd = new Date(today);
      const aStart = new Date(today); aStart.setDate(aStart.getDate() - 6);
      const bEnd = new Date(aStart); bEnd.setDate(bEnd.getDate() - 1);
      const bStart = new Date(bEnd); bStart.setDate(bStart.getDate() - 6);
      return [
        { label: 'Cette semaine', start: isoDate(aStart), end: isoDate(aEnd) },
        { label: 'La semaine dernière', start: isoDate(bStart), end: isoDate(bEnd) },
      ];
    }
    if (preset === 'month') {
      const aStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const bEndDate = new Date(aStart); bEndDate.setDate(bEndDate.getDate() - 1);
      const bStart = new Date(bEndDate.getFullYear(), bEndDate.getMonth(), 1);
      return [
        { label: 'Ce mois-ci', start: isoDate(aStart), end: isoDate(today) },
        { label: 'Le mois dernier', start: isoDate(bStart), end: isoDate(bEndDate) },
      ];
    }
    return [
      { label: `${compareCustom.aStart} → ${compareCustom.aEnd}`, start: compareCustom.aStart, end: compareCustom.aEnd },
      { label: `${compareCustom.bStart} → ${compareCustom.bEnd}`, start: compareCustom.bStart, end: compareCustom.bEnd },
    ];
  }, [gabonToday, compareCustom]);

  // Timeout is a backstop, not the primary fix: normal generations on this
  // model regularly take 1-3 minutes even alone, so anything tighter would
  // false-positive on legitimate (if slow) answers
  const COMPARE_TIMEOUT_MS = 4 * 60 * 1000;

  const runCompareSide = useCallback(async (idx, topic, period, runId) => {
    const patchCol = (upd) => {
      if (compareRunIdRef.current !== runId) return; // superseded run — ignore
      setCompareResult(prev => {
        if (!prev) return prev;
        return { ...prev, columns: prev.columns.map((c, i) => (i === idx ? { ...c, ...upd } : c)) };
      });
    };
    const controller = new AbortController();
    compareAbortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), COMPARE_TIMEOUT_MS);
    patchCol({ queued: false, loading: true });
    try {
      const res = await fetch(`${API_URL}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: topic, n_results: 5, corpus: 'presse',
          period_start: period.start, period_end: period.end,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        let detail = `Le serveur a renvoyé une erreur (${res.status}).`;
        try { const j = await res.json(); if (j.detail) detail = typeof j.detail === 'string' ? j.detail : detail; } catch {}
        throw new Error(detail);
      }
      const json = await res.json();
      patchCol({ sources: json.results });
      if (json.results.length === 0) {
        patchCol({ loading: false, empty: true });
        return;
      }

      const streamRes = await fetch(`${API_URL}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: topic, corpus: 'presse',
          urls: json.results.map(r => r.url), ids: [], history: [],
        }),
        signal: controller.signal,
      });
      if (!streamRes.ok) throw new Error(`La génération a échoué (${streamRes.status}).`);
      const fromCache = streamRes.headers.get('X-Answer-Source') === 'cache';
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let answer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        patchCol({ answer, loading: true });
      }
      patchCol({ loading: false, fromCache });
    } catch (err) {
      if (err.name === 'AbortError') {
        patchCol(compareStopRef.current
          ? { loading: false, stopped: true }
          : { loading: false, timedOut: true });
      } else {
        patchCol({ error: err.message, loading: false });
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  // Columns run one after another, not concurrently. Confirmed by hand:
  // Ollama on this setup serializes generation against a single model
  // instance — firing two /answer streams at once doesn't parallelize them,
  // it just queues the second behind the first with no visibility into that
  // queueing, which is exactly what read as "the left column hung" (it
  // wasn't stuck, it was waiting its turn with no indication of why).
  // Running sequentially costs no wall-clock time on this hardware either
  // way, and lets the UI show an honest "1/2 puis 2/2" progression instead.
  const runCompare = useCallback(async () => {
    const topic = compareTopic.trim();
    if (!topic || comparing) return;
    const periods = periodPresetRanges(comparePreset);
    if (periods.some(p => !p.start || !p.end)) return;
    const runId = ++compareRunIdRef.current;
    compareStopRef.current = false;
    setStoppingCompare(false);
    setComparing(true);
    // Same as the main chat's handleSearch: clear on submit rather than
    // leaving the previous topic sitting in the field — otherwise typing a
    // next comparison without first selecting the old text concatenates
    // onto it ("la dette" + "la santé" → "la dettela santé"). The topic
    // itself is shown as a heading over the columns below instead.
    setCompareTopic('');
    setCompareResult({
      topic,
      columns: periods.map((p, i) => ({
        label: p.label, start: p.start, end: p.end,
        answer: '', sources: null, error: null,
        loading: i === 0, queued: i > 0, empty: false, timedOut: false, stopped: false,
      })),
    });
    for (let i = 0; i < periods.length; i++) {
      if (compareRunIdRef.current !== runId || compareStopRef.current) break;
      await runCompareSide(i, topic, periods[i], runId);
    }
    if (compareRunIdRef.current === runId) {
      // A column stopped before its turn (still "queued" when the loop
      // broke) never went through runCompareSide's own stopped-state patch
      if (compareStopRef.current) {
        setCompareResult(prev => prev && ({
          ...prev,
          columns: prev.columns.map(c => (c.queued ? { ...c, queued: false, loading: false, stopped: true } : c)),
        }));
      }
      finishComparing();
    }
  }, [compareTopic, comparePreset, comparing, periodPresetRanges, runCompareSide]);

  // Separate from `comparing`: lets the button react to the click itself
  // (disable + relabel) independently of whatever the abort/fetch actually
  // does — without this there was no visible response to clicking Arrêter
  // until the in-flight column's promise chain fully unwound, which read as
  // the click not having registered at all
  const [stoppingCompare, setStoppingCompare] = useState(false);
  const stopCompare = useCallback(() => {
    setStoppingCompare(true);
    compareStopRef.current = true;
    compareAbortRef.current?.abort();
  }, []);

  // "Arrêter" and "Comparer" occupy the same screen position (one replaces
  // the other the instant `comparing` flips), and a stop can resolve in well
  // under a second — confirmed live: a user clicking Arrêter once, then
  // clicking the same spot again out of habit/uncertainty before the label
  // visibly changed, lands squarely on the reappeared "Comparer" button and
  // resubmits the form, which looks exactly like "stopping restarted the
  // run" even though the stop itself worked. A brief disabled window on
  // re-submission closes that gap.
  const [compareCooldown, setCompareCooldown] = useState(false);
  const finishComparing = useCallback(() => {
    setComparing(false);
    setCompareCooldown(true);
    setTimeout(() => setCompareCooldown(false), 700);
  }, []);

  // Re-runs a single column in place (after a timeout/stop/error) without
  // discarding whichever column already succeeded
  const retryCompareColumn = useCallback(async (idx) => {
    if (!compareResult || comparing) return;
    const { start, end } = compareResult.columns[idx];
    compareStopRef.current = false;
    setStoppingCompare(false);
    setComparing(true);
    setCompareResult(prev => ({
      ...prev,
      columns: prev.columns.map((c, i) => (i === idx
        ? { ...c, loading: true, queued: false, error: null, empty: false, timedOut: false, stopped: false, answer: '', sources: null }
        : c)),
    }));
    await runCompareSide(idx, compareResult.topic, { start, end }, compareRunIdRef.current);
    finishComparing();
  }, [compareResult, comparing, runCompareSide]);

  const corpusSwitch = (
    <div className="corpus-switch">
      <button
        className={`corpus-pill ${corpus === 'presse' ? 'active' : ''}`}
        onClick={() => switchCorpus('presse')}
        title="Interroger les articles de la presse gabonaise en ligne"
      >Presse</button>
      <button
        className={`corpus-pill ${corpus === 'codes' ? 'active' : ''}`}
        onClick={() => switchCorpus('codes')}
        title="Interroger les codes de loi gabonais (Journal Officiel)"
      >Codes de loi</button>
      {/* Comparison contrasts press coverage across time — no legal-corpus
          equivalent, so it's offered only alongside Presse, same reasoning
          as the map/codes-browser panels being corpus-specific */}
      {corpus === 'presse' && (
        <button
          className="corpus-pill compare-pill"
          onClick={() => setCompareMode(true)}
          title="Comparer la couverture d'un sujet sur deux périodes"
        >Comparer</button>
      )}
    </div>
  );
  const inputBar = (
    <>
    <form className="chat-input-bar" onSubmit={handleSearch}>
      <input
        ref={inputRef}
        className="chat-input"
        placeholder="Posez une question..."
        aria-label={corpus === 'codes' ? 'Poser une question sur les codes de loi gabonais' : "Poser une question sur l'actualité gabonaise"}
        value={question}
        onChange={e => setQuestion(e.target.value)}
        disabled={searching}
        // Autofocus on touch screens pops the keyboard and iOS scrolls the
        // whole page under the status bar; the blur handler undoes any
        // leftover keyboard scroll offset
        autoFocus={window.innerWidth > 768}
        onBlur={() => window.scrollTo(0, 0)}
      />
      {searching ? (
        <button type="button" className="chat-send-btn stop" onClick={stopSearch} title="Arrêter la génération" aria-label="Arrêter la génération">
          <Square size={14} fill="currentColor" />
        </button>
      ) : (
        <button type="submit" className="chat-send-btn" disabled={!question.trim()} aria-label="Envoyer la question">
          <Search size={18} />
        </button>
      )}
    </form>
    <p className="ai-disclaimer">
      Réponses rédigées par IA à partir des articles cités ci-dessus — peuvent contenir des erreurs, vérifiez toujours les sources.
    </p>
    </>
  );

  if (loading) return <div className="loading-full"><div className="spinner" /><p>Chargement des données...</p></div>;

  if (error || !data) return (
    <div className="loading-full">
      <div className="error-screen">
        <AlertTriangle size={32} />
        <p className="error-screen-title">Impossible de charger les données</p>
        <p className="error-screen-detail">{error || 'data.json est vide ou introuvable.'}</p>
        <button className="retry-btn" onClick={() => window.location.reload()}>
          <RefreshCw size={14} /> Recharger
        </button>
      </div>
    </div>
  );

  return (
    <div className="app-container">
      <nav className="navbar">
        <button className="nav-left" onClick={() => setActiveView('explore')} title="Accueil">
          <img className="nav-logo" src="/icons/icon-192.png" alt="" width={48} height={48} />
          <span className="nav-title">Le Kiosque</span>
        </button>
        <div className="nav-menu">
          <button className={`nav-item ${activeView === 'explore' ? 'active' : ''}`} onClick={() => setActiveView('explore')}>
            <MessageSquare size={16} /> Assistant
          </button>
          <button className={`nav-item ${activeView === 'stats' ? 'active' : ''}`} onClick={() => setActiveView('stats')}>
            <BarChart3 size={16} /> Statistiques
          </button>
        </div>
        <div className="nav-date">
          {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </div>
        {user ? (
          <button className="nav-account" onClick={() => setAuthModal('profile')} title="Profil">
            <span className="nav-account-avatar">{user.display_name.trim().charAt(0).toUpperCase()}</span>
            <span className="nav-account-name">{user.display_name}</span>
          </button>
        ) : (
          <button
            className="nav-account nav-account-login"
            onClick={() => { setAuthError(''); setAuthModal('login'); }}
            title="Se connecter"
            aria-label="Se connecter"
          >
            <LogIn size={15} className="nav-account-login-icon" />
            <span className="nav-account-login-text">Se connecter</span>
          </button>
        )}
      </nav>

      {authModal && (
        <AuthModal
          mode={authModal}
          onClose={() => setAuthModal(null)}
          onSwitchMode={(m) => { setAuthError(''); setAuthModal(m); }}
          onSubmit={handleAuthSubmit}
          busy={authBusy}
          error={authError}
          user={user}
          authToken={authToken}
          onLogout={logout}
          onProfileUpdated={setUser}
        />
      )}

      {/* Invisible page title: screen readers land on a real h1 */}
      <h1 className="sr-only">Le Kiosque : la presse gabonaise interrogeable</h1>
      {/* Kept in the DOM even once the conversation starts (the visible
          "Posez une question" h2 only renders on the empty state), so the
          heading order never skips from h1 straight to h3 */}
      {activeView === 'explore' && <h2 className="sr-only">Assistant</h2>}

      <main className="main-content">
        {activeView === 'explore' ? (
          <>
            <div className={`chat-panel ${sidePanelOpen ? '' : 'full'}`} style={customChatStyle}>
              <div className="chat-header">
                <div className="chat-header-left">
                  <Database size={16} className="chat-logo" />
                  <span className="chat-subtitle">
                    {(data.metadata?.total_articles ?? data.points?.length ?? 0).toLocaleString()} articles
                    {latestDate && <span className="chat-freshness"> · à jour au {latestDate}</span>}
                  </span>
                  <span
                    className={`api-dot ${apiStatus}`}
                    title={apiStatus === 'online' ? 'API connectée' : apiStatus === 'offline' ? 'API hors ligne' : 'Vérification…'}
                  />
                  {lastChecked && (
                    <span className="chat-last-checked" title="Dernière vérification de la connexion à l'API">
                      vérifié à {lastChecked.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
                <div className="chat-header-actions">
                  {/* Pinned in the header rather than inline in the transcript:
                      a primary action returned to often shouldn't require
                      scrolling back up past a growing conversation */}
                  {chatHistory.length > 0 && (
                    <button className="controls-toggle" onClick={clearChat} title="Nouvelle conversation" aria-label="Nouvelle conversation">
                      <Trash2 size={14} />
                    </button>
                  )}
                  {/* Settings toggle now lives on the map panel itself
                      (plot-panel-settings), right where its effect appears.
                      Each corpus gets its own secondary-panel entry point —
                      the semantic map for presse, a Titre/Chapitre/Article
                      browser for codes — rather than either mode opening
                      onto the other corpus's data */}
                  {corpus === 'presse' && (
                    <button
                      ref={mapToggleRef}
                      className={`controls-toggle ${showMap ? 'active' : ''}`}
                      onClick={toggleMap}
                      title={showMap ? 'Masquer la carte' : 'Explorer la carte sémantique'}
                      aria-label={showMap ? 'Masquer la carte' : 'Explorer la carte sémantique'}
                    >
                      <MapIcon size={14} />
                    </button>
                  )}
                  {corpus === 'codes' && (
                    <button
                      ref={codesToggleRef}
                      className={`controls-toggle ${showCodesBrowser ? 'active' : ''}`}
                      onClick={toggleCodesBrowser}
                      title={showCodesBrowser ? 'Masquer les codes' : 'Parcourir les codes de loi'}
                      aria-label={showCodesBrowser ? 'Masquer les codes' : 'Parcourir les codes de loi'}
                    >
                      <BookOpen size={14} />
                    </button>
                  )}
                </div>
              </div>

              {/* On the empty landing state, this row used to be the same
                  visual weight as the question input right below it — a
                  first-time visitor couldn't tell whether the product was
                  "ask a question" or "read a briefing". The sourced-answer
                  assistant is the front door; once a conversation exists,
                  this reverts to its normal prominence as a toolbar action
                  next to real content, where the competition is gone. */}
              <div className={`report-buttons chat-report-row ${chatIsEmpty ? 'chat-report-row-secondary' : ''}`}>
                <button className="weekly-report-btn" onClick={() => fetchReport('daily')} disabled={reportLoading || searching}>
                  {reportLoading && reportKind === 'daily' ? <Loader size={14} className="spin" /> : <Newspaper size={14} />}
                  {reportLoading && reportKind === 'daily' ? 'Rédaction en cours…' : 'Rapport du jour'}
                </button>
                <button className="weekly-report-btn" onClick={() => fetchReport('weekly')} disabled={reportLoading || searching}>
                  {reportLoading && reportKind === 'weekly' ? <Loader size={14} className="spin" /> : <Newspaper size={14} />}
                  {reportLoading && reportKind === 'weekly' ? 'Rédaction en cours…' : 'Rapport de la semaine'}
                </button>
                <button
                  className="weekly-report-btn archive-btn"
                  onClick={openArchive}
                  disabled={reportLoading || searching}
                  title="Éditions précédentes"
                  aria-label={`Archives des rapports${newSinceVisit > 0 ? ` (${newSinceVisit} nouveaux)` : ''}`}
                >
                  <Archive size={14} />
                  <span className="archive-btn-label">Archives</span>
                  {newSinceVisit > 0 && <span className="archive-badge">{newSinceVisit}</span>}
                </button>
              </div>

              {/* role="log": the standard landmark for a chat transcript,
                  giving screen-reader users a way to jump straight to it
                  rather than tabbing through the whole page */}
              <div className="chat-messages" role="log" aria-label="Conversation">
                {compareMode && (
                  <div className="compare-view">
                    <div className="compare-header">
                      <h2 className="compare-title">Comparer deux périodes</h2>
                      <button
                        className="compare-close"
                        onClick={() => { setCompareMode(false); setCompareResult(null); }}
                        title="Fermer le mode comparaison"
                        aria-label="Fermer le mode comparaison"
                      >✕</button>
                    </div>
                    <p className="chat-empty-sub">
                      Un même sujet, deux périodes — pour voir ce qui a changé dans la couverture presse.
                    </p>
                    <form className="compare-form" onSubmit={(e) => { e.preventDefault(); runCompare(); }}>
                      <input
                        className="compare-topic-input"
                        placeholder="Sujet à comparer (ex : l'économie, la dette de l'état…)"
                        value={compareTopic}
                        onChange={e => setCompareTopic(e.target.value)}
                        disabled={comparing}
                        aria-label="Sujet à comparer"
                      />
                      <div className="granularity-selector compare-preset-row">
                        {[['week', 'Cette semaine vs la semaine dernière'], ['month', 'Ce mois vs le mois dernier'], ['custom', 'Personnalisé']].map(([k, label]) => (
                          <button
                            key={k} type="button"
                            className={`granularity-btn ${comparePreset === k ? 'active' : ''}`}
                            onClick={() => setComparePreset(k)}
                            disabled={comparing}
                          >{label}</button>
                        ))}
                      </div>
                      {comparePreset === 'custom' && (
                        <div className="compare-custom-ranges">
                          <div className="compare-custom-period">
                            <span>Période A</span>
                            <input type="date" value={compareCustom.aStart} onChange={e => setCompareCustom(c => ({ ...c, aStart: e.target.value }))} aria-label="Période A, début" disabled={comparing} />
                            <input type="date" value={compareCustom.aEnd} onChange={e => setCompareCustom(c => ({ ...c, aEnd: e.target.value }))} aria-label="Période A, fin" disabled={comparing} />
                          </div>
                          <div className="compare-custom-period">
                            <span>Période B</span>
                            <input type="date" value={compareCustom.bStart} onChange={e => setCompareCustom(c => ({ ...c, bStart: e.target.value }))} aria-label="Période B, début" disabled={comparing} />
                            <input type="date" value={compareCustom.bEnd} onChange={e => setCompareCustom(c => ({ ...c, bEnd: e.target.value }))} aria-label="Période B, fin" disabled={comparing} />
                          </div>
                        </div>
                      )}
                      {comparing ? (
                        <button
                          type="button" className="compare-submit stop"
                          onClick={stopCompare}
                          disabled={stoppingCompare}
                        >
                          <Square size={14} fill="currentColor" /> {stoppingCompare ? 'Arrêt en cours…' : 'Arrêter'}
                        </button>
                      ) : (
                        <button
                          type="submit" className="compare-submit"
                          disabled={compareCooldown || !compareTopic.trim() || (comparePreset === 'custom' && Object.values(compareCustom).some(v => !v))}
                        >
                          <Search size={14} /> Comparer
                        </button>
                      )}
                    </form>

                    {compareResult && (
                      <>
                        <p className="compare-topic-heading">Sujet : « {compareResult.topic} »</p>
                        <div className="compare-columns">
                        {compareResult.columns.map((col, i) => (
                          <div key={i} className="compare-column">
                            <div className="compare-column-head">
                              <span className="compare-column-label">{col.label}</span>
                              <span className="compare-column-range">{col.start} → {col.end}</span>
                              {col.fromCache && (
                                <span className="archive-viewing-tag cache-tag" title="Déjà comparée récemment — réponse resservie sans regénération">
                                  instantané
                                </span>
                              )}
                            </div>
                            {col.queued && (
                              <p className="chat-empty-sub compare-queued">
                                En attente — la période précédente est en cours de traitement…
                              </p>
                            )}
                            {col.loading && !col.answer && !col.error && !col.empty && (
                              <div className="chat-thinking" role="status" aria-live="polite">
                                <Loader size={14} className="spin" />
                                <ThinkingLabel interval={4000} phrases={[
                                  'Recherche dans les articles de la période…',
                                  'Lecture des articles retrouvés…',
                                  'Rédaction de la réponse…',
                                  'Les réponses IA prennent 1 à 3 minutes sur ce modèle local…',
                                ]} />
                              </div>
                            )}
                            {col.error ? (
                              <div className="chat-error">
                                <div className="chat-error-msg"><AlertTriangle size={14} /><span>{col.error}</span></div>
                                <button className="retry-btn" onClick={() => retryCompareColumn(i)} disabled={comparing}>
                                  <RefreshCw size={12} /> Réessayer
                                </button>
                              </div>
                            ) : col.timedOut ? (
                              <div className="chat-error">
                                <div className="chat-error-msg"><AlertTriangle size={14} /><span>Délai dépassé pour cette période.</span></div>
                                <button className="retry-btn" onClick={() => retryCompareColumn(i)} disabled={comparing}>
                                  <RefreshCw size={12} /> Réessayer
                                </button>
                              </div>
                            ) : col.stopped ? (
                              <p className="chat-empty-sub">Interrompu.</p>
                            ) : col.empty ? (
                              <p className="chat-empty-sub">Aucun article trouvé sur ce sujet pour cette période.</p>
                            ) : col.answer ? (
                              <div aria-live="polite" aria-atomic="true" aria-busy={col.loading}>
                                <AnswerText text={col.answer} streaming={col.loading} />
                                {col.sources && col.sources.length > 0 && !col.loading && (
                                  <div className="inline-sources">
                                    <ProvenanceLine sources={col.sources} />
                                    <h3 className="sources-caption">Sources</h3>
                                    {col.sources.map((art, si) => (
                                      <a key={si} href={art.url} target="_blank" rel="noreferrer" className="inline-source-link">
                                        [{si + 1}] {art.title} <span className="inline-source-meta">· {art.source}{art.date ? `, ${art.date}` : ''}</span>
                                      </a>
                                    ))}
                                  </div>
                                )}
                              </div>
                            ) : null}
                          </div>
                        ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
                {!compareMode && chatIsEmpty && (
                  <div className="chat-empty">
                    {/* The one thing that should visibly change when logged
                        in — otherwise the account is plumbing with no
                        payoff. Informational, not a competing call to
                        action: same reasoning that kept the report row
                        prominent-but-secondary applies here in reverse —
                        this stays quiet relative to "Posez une question" */}
                    {user && corpus === 'presse' && landingDeltas.length > 0 && (
                      <div className="landing-deltas">
                        <span className="landing-deltas-title">
                          Depuis votre dernière visite, {user.display_name.split(' ')[0]}
                        </span>
                        <div className="landing-deltas-chips">
                          {landingDeltas.slice(0, 4).map(d => (
                            <button
                              key={`${d.type}-${d.value}`}
                              className={`landing-delta-chip ${d.status}`}
                              onClick={() => askAssistant(
                                d.status === 'quiet'
                                  ? `Que s'est-il passé récemment sur ${d.label} ?`
                                  : `Que disent les articles récents sur ${d.label} ?`
                              )}
                            >
                              {d.status === 'spiked' && <Flame size={12} />}
                              {d.status === 'quiet' && <BellOff size={12} />}
                              {d.status === 'new' && <Star size={12} />}
                              {d.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {user && corpus === 'presse' && landingDeltas.length === 0 && landingFollows.length === 0 && (
                      <p className="landing-follow-hint">
                        <Star size={11} /> Suivez un sujet dans Statistiques (icône ★) pour voir son actualité ici à votre prochaine visite.
                      </p>
                    )}
                    <div className="chat-empty-icon"><Search size={24} /></div>
                    <h2 className="chat-empty-title">Posez une question</h2>
                    <p className="chat-empty-sub">
                      {corpus === 'presse'
                        ? "L'assistant cherche dans les articles de la presse gabonaise et rédige une réponse sourcée, chaque affirmation étant liée à son article d'origine."
                        : "L'assistant cherche dans les codes de loi gabonais et répond en citant les numéros d'articles exacts. Ceci ne constitue pas un conseil juridique."}
                    </p>
                    {corpusSwitch}
                    {inputBar}
                    <div className="chat-suggestions">
                      {SUGGESTIONS[corpus].map(s => (
                        <button key={s} className="suggestion-chip" disabled={searching || reportLoading} onClick={() => runSearch(s)}>{s}</button>
                      ))}
                    </div>
                  </div>
                )}


                {!compareMode && chatHistory.map((entry, idx) => (
                  <div key={idx} className="chat-turn">
                    {/* User question */}
                    <div className="msg-user">
                      <div className="msg-user-bubble">{entry.question}</div>
                    </div>

                    {/* AI answer */}
                    {entry.error ? (
                      <div className="chat-error">
                        <div className="chat-error-msg">
                          <AlertTriangle size={14} />
                          <span>{entry.error}</span>
                        </div>
                        <button className="retry-btn" onClick={() => runSearch(entry.question, idx)} disabled={searching}>
                          <RefreshCw size={12} /> Réessayer
                        </button>
                      </div>
                    ) : entry.answer ? (
                      <div className="msg-ai">
                        <div className="msg-avatar">IA</div>
                        <div
                          className="msg-bubble"
                          // aria-busy suppresses live announcements while true, so a
                          // screen reader stays silent through the token-by-token
                          // stream (announcing every word would be unusable) and
                          // reads the complete answer once, atomically, the instant
                          // streaming ends and busy flips to false
                          aria-live="polite"
                          aria-atomic="true"
                          aria-busy={idx === chatHistory.length - 1 && searching}
                        >
                          {idx === chatHistory.length - 1 && searching && (
                            <span className="msg-writing-tag">L'assistant rédige…</span>
                          )}
                          {entry.fromCache && !(idx === chatHistory.length - 1 && searching) && (
                            <span className="archive-viewing-tag cache-tag msg-cache-tag" title="Question déjà posée récemment — réponse resservie sans regénération">
                              Réponse instantanée
                            </span>
                          )}
                          <AnswerText text={entry.answer} streaming={idx === chatHistory.length - 1 && searching} />
                          {/* Sources appear once the answer is complete: shown
                              during streaming, they pin the auto-scroll on
                              themselves and the text writes itself off-screen */}
                          {entry.sources && entry.sources.length > 0 && !(idx === chatHistory.length - 1 && searching) && (
                            <div className="inline-sources">
                              <ProvenanceLine sources={entry.sources} />
                              <h3 className="sources-caption">Sources</h3>
                              {entry.sources.map((art, i) => (
                                <a key={i} href={art.url} target="_blank" rel="noreferrer" className="inline-source-link">
                                  [{i+1}] {art.title} <span className="inline-source-meta">· {art.source}{art.date ? `, ${art.date}` : ''}</span>
                                </a>
                              ))}
                            </div>
                          )}
                          {!(idx === chatHistory.length - 1 && searching) && (
                            <button
                              className="msg-copy-btn"
                              onClick={() => copyAnswer(idx, entry.answer)}
                              aria-label="Copier la réponse"
                            >
                              {copiedIdx === idx ? '✓ Copié' : '⧉ Copier la réponse'}
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      // Announced live: this is the "nothing happened yet" phase,
                      // exactly where a screen reader user would otherwise hear
                      // and see nothing at all while the search/generation runs
                      <div className="chat-thinking" role="status" aria-live="polite">
                        <Loader size={14} className="spin" />
                        {entry.sources ? (
                          <ThinkingLabel phrases={[
                            'Lecture des articles retrouvés…',
                            'Rédaction de la réponse…',
                            'Vérification des dates et des sources…',
                            'Encore quelques secondes…',
                          ]} />
                        ) : (
                          <ThinkingLabel interval={3500} phrases={[
                            'Recherche dans le corpus…',
                            'Sélection des articles pertinents…',
                          ]} />
                        )}
                      </div>
                    )}
                  </div>
                ))}

                <div ref={chatEndRef} />
              </div>

              {apiStatus === 'offline' && (
                <div className="api-offline-banner">
                  <AlertTriangle size={13} />
                  <span>API hors ligne — lancez <code>python api.py</code></span>
                  <button onClick={checkApi}>Réessayer</button>
                </div>
              )}
              {!compareMode && !chatIsEmpty && corpusSwitch}
              {!compareMode && !chatIsEmpty && inputBar}
            </div>
            {sidePanelOpen && (
              <div
                className="panel-divider"
                onMouseDown={startDivider}
                onDoubleClick={resetDivider}
                title="Glisser pour redimensionner · double-clic pour réinitialiser"
              />
            )}
            {/* Visually collapsed via CSS transition, but stays in the DOM through it —
    without aria-hidden/inert a keyboard/screen-reader user could still tab
    into controls inside a panel sighted users can no longer see */}
            {/* On desktop, when both the map and the report are open at once,
                they stack vertically (report on top in natural reading order,
                map below as the reference surface) instead of one hiding the
                other — reading today's brief while eyeballing where those
                stories cluster on the map is a real move the old single-slot
                layout didn't allow. Otherwise this wrapper is transparent:
                exactly one child is visible and behaves as before. */}
            <div className={`workspace-slot ${workspaceStacked ? 'stacked' : ''} ${sidePanelOpen ? '' : 'empty'}`}>
              <div className={`report-panel ${reportOpen ? '' : 'hidden'}`} aria-hidden={!reportOpen} inert={!reportOpen}>
              {archiveOpen ? (
                <div className="report-panel-scroll">
                  <div className="weekly-report-card">
                    <div className="weekly-report-head">
                      <h3>Archives des rapports</h3>
                      <button className="weekly-report-close" onClick={() => setReportOpen(false)} title="Fermer" aria-label="Fermer les archives">✕</button>
                    </div>
                    {archiveList === null ? (
                      <div className="chat-thinking" role="status" aria-live="polite"><Loader size={14} className="spin" /><span>Chargement des archives…</span></div>
                    ) : archiveList.length === 0 ? (
                      <p className="chat-empty-sub">Aucun rapport archivé pour l'instant. Les rapports générés — depuis l'interface ou automatiquement — s'accumulent ici.</p>
                    ) : (
                      <div className="archive-list">
                        {archiveList.map(r => (
                          <button key={r.id} className="archive-item" onClick={() => openArchivedReport(r.id)}>
                            <div className="archive-item-head">
                              <span className={`archive-item-kind ${r.kind}`}>{r.kind === 'daily' ? 'Quotidien' : 'Hebdo'}</span>
                              <span className="archive-item-date">{r.period_end}</span>
                              <span className="archive-item-count">{r.article_count} articles</span>
                            </div>
                            <p className="archive-item-excerpt">{r.excerpt}…</p>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : report !== null && (
                <div className="report-panel-scroll">
                  <div className="weekly-report-card">
                    <div className="weekly-report-head">
                      <h3>
                        {reportKind === 'daily' ? "Le point d'actualité du jour" : 'Revue de presse de la semaine'}
                        {viewingArchiveId && <span className="archive-viewing-tag">édition archivée</span>}
                        {!viewingArchiveId && reportFromCache && (
                          <span className="archive-viewing-tag cache-tag" title="Déjà généré pour cette période — le PDF reste régénérable à l'identique">
                            déjà généré
                          </span>
                        )}
                      </h3>
                      <div className="weekly-report-actions">
                        {!reportLoading && report && !viewingArchiveId && (
                          <a className="weekly-report-pdf" href={`${API_URL}/${reportKind === 'daily' ? 'daily_report' : 'weekly_report'}/pdf`} target="_blank" rel="noreferrer">
                            ⬇ PDF
                          </a>
                        )}
                        <button className="weekly-report-close" onClick={() => setReportOpen(false)} title="Fermer" aria-label="Fermer le rapport">✕</button>
                      </div>
                    </div>
                    {report === '' && reportLoading
                      ? (
                        <>
                          <div className="chat-thinking" role="status" aria-live="polite"><Loader size={14} className="spin" /><span>{reportKind === 'daily' ? 'Lecture des titres du jour…' : 'Lecture des titres de la semaine…'}</span></div>
                          <ReportSkeleton themes={reportKind === 'daily' ? 3 : 5} />
                        </>
                      )
                      : <div aria-live="polite" aria-atomic="true" aria-busy={reportLoading}>
                          <AnswerText text={report} streaming={reportLoading} />
                        </div>}
                  </div>
                </div>
              )}
            </div>
                          <div
                className={`plot-panel ${mapVisible ? '' : 'hidden'}`}
                role="region"
                aria-label="Carte sémantique des articles"
                aria-hidden={!mapVisible}
                inert={!mapVisible}
              >
              {/* Closing directly on the panel: the header toggle is easy to
                  miss once the map fills the screen (mobile) or sits far
                  from where the user is actually looking (desktop) */}
              <button className="plot-panel-close" onClick={closeMap} title="Fermer la carte" aria-label="Fermer la carte">✕</button>
              {/* Settings trigger lives on the panel itself, right where its
                  effect appears — the header icon was a long reach away from
                  what it controls */}
              <button
                className={`plot-panel-settings ${showControls ? 'active' : ''}`}
                onClick={() => setShowControls(v => !v)}
                title="Réglages de la carte"
                aria-label="Réglages de la carte"
              >
                <SlidersHorizontal size={14} /> Format · Groupe
              </button>
              {showControls && (
                <div className="viz-controls plot-controls">
                  <div className="viz-row">
                    <span className="viz-label">Format</span>
                    <div className="pill-group">
                      {['2D', '3D'].map(d => <button key={d} className={`pill ${dim === d ? 'active' : ''}`} onClick={() => setDim(d)}>{d}</button>)}
                    </div>
                  </div>
                  <div className="viz-row">
                    <span className="viz-label">Grouper par</span>
                    <div className="select-wrapper">
                      <select className="select-box" value={colorBy} onChange={e => setColorBy(e.target.value)}>
                        <option value="cluster_name">Thématiques IA</option>
                        <option value="category">Rubriques</option>
                        <option value="source">Journal</option>
                      </select>
                      <ChevronDown size={14} className="select-icon" />
                    </div>
                  </div>
                </div>
              )}
              {/* Plotly renders to canvas/WebGL: invisible to screen readers.
                  role="img" + aria-label give an equivalent summary; the map
                  stays purely decorative/exploratory for assistive tech,
                  same articles remain reachable through the chat and its
                  cited sources */}
              <div
                ref={plotRef}
                className="plot-container"
                role="img"
                aria-label={`Carte des ${data.points?.length ?? 0} articles de presse projetés selon leur similarité de sujet. Cliquez sur un point pour ouvrir l'article correspondant. Cette visualisation est secondaire : les mêmes articles restent accessibles via les réponses de l'assistant et leurs sources citées.`}
              />
              {/* A tap on 3D scatter often gets swallowed by the orbit
                  gesture before it registers as a click. Hover fires
                  reliably on tap though, so it selects the point here and
                  this bar becomes the actual "open" confirmation on mobile,
                  a much bigger and more forgiving target than the dot itself */}
              {isPhone && hoveredPoint && (
                <div className="map-open-bar">
                  <div className="map-open-info">
                    <span className="map-open-title">{hoveredPoint.title}</span>
                    <span className="map-open-meta">{hoveredPoint.date} — {hoveredPoint.source}</span>
                  </div>
                  <a
                    className="map-open-btn"
                    href={hoveredPoint.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Ouvrir l'article <ExternalLink size={13} />
                  </a>
                </div>
              )}
              {/* Color key for the groups, so the map is readable without
                  hovering or opening the settings */}
              {(() => {
                const entries = plotTraces
                  .map((t, i) => ({
                    name: t.name,
                    // Same reasoning as `fixed` below: t.marker.color may
                    // hold a stale restyle-mutated value (grey when
                    // de-emphasized), so the swatch always uses the
                    // deterministic colorway assignment instead of trusting it
                    color: PLOT_COLORWAY[i % PLOT_COLORWAY.length],
                    n: t.x.length,
                    // Identify the search-highlight trace by name, not by
                    // "has an explicit marker.color": Plotly.react keeps the
                    // same object references we pass it, so the isolate
                    // effect's Plotly.restyle({'marker.color': ...}) mutates
                    // these very objects in place — after the first restyle,
                    // every trace (not just the highlight one) would end up
                    // with an explicit marker.color and get wrongly filtered
                    fixed: t.name === 'Vos Résultats',
                  }))
                  .filter(e => !e.fixed)
                  .sort((a, b) => b.n - a.n);
                if (!entries.length) return null;
                // cluster_name (100+ semantic groups) needs an explicit cap;
                // "Journal" (13 sources) is a small closed list, every entry
                // meaningful. "Rubriques" no longer needs one either — the
                // trace-building step above already bucket the long tail
                // into "Autres", so entries.length is already ≤9 here
                const cap = colorBy === 'cluster_name' ? 8 : entries.length;
                const shown = entries.slice(0, cap);
                // The isolated group might rank outside what's shown by
                // default (e.g. picked from "+121 autres") — always keep it
                // visible in the strip so its own toggle stays reachable
                const visible = highlightedGroup && !shown.some(e => e.name === highlightedGroup)
                  ? [entries.find(e => e.name === highlightedGroup), ...shown].filter(Boolean)
                  : shown;
                return (
                  <div className="html-legend plot-legend">
                    <span className="plot-caption">
                      Chaque point est un article de presse, cliquez pour l'ouvrir · deux points proches traitent de sujets similaires · cliquez une rubrique ci-dessous pour l'isoler
                      {corpus === 'codes' && ' · la carte couvre le corpus presse, pas les codes de loi'}
                    </span>
                    {highlightedGroup && (
                      <button className="html-legend-item html-legend-reset" onClick={() => setHighlightedGroup(null)}>
                        ✕ Tout afficher
                      </button>
                    )}
                    {visible.map(e => (
                      <button
                        key={e.name}
                        className={`html-legend-item html-legend-btn ${highlightedGroup === e.name ? 'active' : ''}`}
                        onClick={() => setHighlightedGroup(g => g === e.name ? null : e.name)}
                        aria-pressed={highlightedGroup === e.name}
                      >
                        <span className="html-legend-swatch" style={{ background: e.color }} />
                        {e.name.length > 24 ? e.name.slice(0, 23) + '…' : e.name}
                      </button>
                    ))}
                    {entries.length > shown.length && (
                      <span className="html-legend-item">+{entries.length - shown.length} autres</span>
                    )}
                  </div>
                );
              })()}
            </div>
            {/* Codes de loi's secondary panel: a plain Titre/Chapitre/Article
                browser, reusing .plot-panel's slide/overlay mechanics (same
                positioning, transitions, mobile bottom-sheet behavior) since
                only one of map/codes-browser is ever visible at once */}
            <div
              className={`plot-panel codes-panel ${codesBrowserVisible ? '' : 'hidden'}`}
              role="region"
              aria-label="Navigation des codes de loi gabonais"
              aria-hidden={!codesBrowserVisible}
              inert={!codesBrowserVisible}
            >
              <button className="plot-panel-close" onClick={closeCodesBrowser} title="Fermer les codes" aria-label="Fermer les codes">✕</button>
              <div className="codes-panel-scroll">
                {activeArticle ? (
                  <div className="codes-article-view">
                    <button className="codes-back-btn" onClick={() => setActiveArticle(null)}>
                      <ChevronLeft size={14} /> Retour à {CODE_LABELS_FALLBACK(codesList, activeCode)}
                    </button>
                    {activeArticle.loading ? (
                      <div className="chat-thinking" role="status" aria-live="polite"><Loader size={14} className="spin" /><span>Chargement…</span></div>
                    ) : !activeArticle.text ? (
                      <p className="chat-empty-sub">Article introuvable.</p>
                    ) : (
                      <>
                        <h3 className="codes-article-title">{activeArticle.numero || activeArticle.label}</h3>
                        {activeArticle.contexte && (
                          <p className="codes-article-context">{activeArticle.contexte.split('|').map(s => s.trim()).filter(Boolean).join(' › ')}</p>
                        )}
                        <p className="codes-article-text">{activeArticle.text}</p>
                        {activeArticle.url && (
                          <a className="codes-article-source" href={activeArticle.url} target="_blank" rel="noreferrer">
                            Voir la source (Journal Officiel) <ExternalLink size={12} />
                          </a>
                        )}
                      </>
                    )}
                  </div>
                ) : activeCode ? (
                  <div className="codes-tree-view">
                    <button className="codes-back-btn" onClick={() => setActiveCode(null)}>
                      <ChevronLeft size={14} /> Tous les codes
                    </button>
                    <h3 className="codes-panel-title">{CODE_LABELS_FALLBACK(codesList, activeCode)}</h3>
                    {!codeTree ? (
                      <div className="chat-thinking" role="status" aria-live="polite"><Loader size={14} className="spin" /><span>Chargement…</span></div>
                    ) : (
                      Array.from(codeTree.entries()).map(([titre, chapitres]) => (
                        <details key={titre} className="codes-titre">
                          <summary>{titre}</summary>
                          {Array.from(chapitres.values()).map((chap, ci) => (
                            chap.label ? (
                              <details key={ci} className="codes-chapitre">
                                <summary>{chap.label}</summary>
                                <ul className="codes-article-list">
                                  {chap.items.map(it => (
                                    <li key={it.id}>
                                      <button onClick={() => openArticle(it.id)}>{it.numero || it.type}</button>
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            ) : (
                              <ul key={ci} className="codes-article-list codes-article-list-direct">
                                {chap.items.map(it => (
                                  <li key={it.id}>
                                    <button onClick={() => openArticle(it.id)}>{it.numero || it.type}</button>
                                  </li>
                                ))}
                              </ul>
                            )
                          ))}
                        </details>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="codes-list-view">
                    <h3 className="codes-panel-title">Codes de loi disponibles</h3>
                    {codesList === null ? (
                      <div className="chat-thinking" role="status" aria-live="polite"><Loader size={14} className="spin" /><span>Chargement…</span></div>
                    ) : codesList.length === 0 ? (
                      <p className="chat-empty-sub">Corpus des codes juridiques indisponible pour le moment.</p>
                    ) : (
                      <div className="codes-list">
                        {codesList.map(c => (
                          <button key={c.code} className="codes-list-item" onClick={() => openCode(c.code)}>
                            <span className="codes-list-label">{c.label}</span>
                            <span className="codes-list-count">{c.count} articles</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            </div>
          </>
        ) : (
          <MetricsDashboard data={data} gabonToday={gabonToday} onAskAssistant={askAssistant} user={user} authToken={authToken} />
        )}
      </main>
    </div>
  );
}

// Mono-thematic outlets: their generic front-page rubriques ("À la une")
// still carry an unambiguous topic
const MONO_THEME_SOURCES = { gabonallsport: 'Sport' };

const normalizeCategory = (cat, source) => {
  const fallback = MONO_THEME_SOURCES[source];
  if (!cat) return fallback || 'Autres';
  const c = cat.toLowerCase().trim().replace(/['"«»]/g, '');
  if (c.includes('politique')) return 'Politique';
  if (c.includes('economie') || c.includes('économie')) return 'Économie';
  if (c.includes('societe') || c.includes('société') || c.includes('social')) return 'Société';
  if (c.includes('sport') || c.includes('foot')) return 'Sport';
  if (c.includes('justice') || c.includes('fait divers') || c.includes('faits_divers') || c.includes('faits divers')) return 'Faits Divers / Justice';
  if (c.includes('provinces')) return 'Provinces';
  if (c.includes('culture') || c.includes('musique') || c.includes('cinéma')) return 'Culture';
  if (c.includes('enviro')) return 'Environnement';
  if (c.includes('santé') || c.includes('sante')) return 'Santé';
  if (c.includes('admin') || c.includes('instit')) return 'Administration';
  if (c.includes('diplomatie')) return 'Diplomatie';
  if (c.includes('international')) return 'International';
  if (c.includes('education') || c.includes('formation')) return 'Éducation';
  if (c.includes('communication') || c.includes('médias')) return 'Communication';
  if (c.includes('ia') || c.includes('numérique')) return 'IA / Numérique';
  // Generic front-page rubriques (mostly the WordPress REST sources) carry no topic
  if (/^(a|à) la une/.test(c) || c.startsWith('actualit') || c === 'news' || c === 'infos' || c.includes('non class') || c.includes('uncategorized')) return fallback || 'Non classé';
  return cat.charAt(0).toUpperCase() + cat.slice(1);
};

// Sourced from spacy.lang.fr.stop_words.STOP_WORDS (spaCy's French stopword
// list, ~500 words) rather than the earlier ~60-word hand-picked set, plus a
// small domain layer spaCy has no way to know about: "gabon"/"gabonais"/
// "gabonaise" are meaningless as a "trending topic" in a Gabon-only corpus,
// and a few generic adjectives ("dernier", "nouvelle", "grand"...) that are
// mostly headline noise here even though they're not stopwords in general
// prose. Elided forms spaCy lists (l', d', qu'...) are deliberately omitted:
// titleWords()'s regex below strips apostrophes without inserting a space,
// so "l'économie" becomes one token ("leconomie"), never a standalone "l" —
// those entries could never match anything, in JS or in the original list.
const TITLE_STOPWORDS = new Set([
  'a','abord','afin','ah','ai','aie','ainsi','ait','allaient','allons','alors','anterieur',
  'anterieure','anterieures','antérieur','antérieure','antérieures','apres','après','as','assez',
  'attendu','au','aupres','auquel','aura','auraient','aurait','auront','aussi','autre',
  'autrement','autres','autrui','aux','auxquelles','auxquels','avaient','avais','avait','avant',
  'avec','avoir','avons','ayant','bas','basee','bat','c\'','car','ce','ceci','cela','celle',
  'celle-ci','celle-la','celle-là','celles','celles-ci','celles-la','celles-là','celui',
  'celui-ci','celui-la','celui-là','cent','cependant','certain','certaine','certaines','certains',
  'certes','ces','cet','cette','ceux','ceux-ci','ceux-là','chacun','chacune','chaque','chez','ci',
  'cinq','cinquantaine','cinquante','cinquantième','cinquième','combien','comme','comment',
  'compris','concernant','c’','d\'','da','dans','de','debout','dedans','dehors','deja','dejà',
  'delà','depuis','derriere','derrière','des','desormais','desquelles','desquels','dessous',
  'dessus','deux','deuxième','deuxièmement','devant','devers','devra','different','differente',
  'differentes','differents','différent','différente','différentes','différents','dire','directe',
  'directement','dit','dite','dits','divers','diverse','diverses','dix','dix-huit','dix-neuf',
  'dix-sept','dixième','doit','doivent','donc','dont','douze','douzième','du','duquel','durant',
  'dès','déja','déjà','désormais','d’','effet','egalement','eh','elle','elle-meme','elle-même',
  'elles','elles-memes','elles-mêmes','en','encore','enfin','entre','envers','environ','es','est',
  'et','etaient','etais','etait','etant','etc','etre','eu','eux','eux-mêmes','exactement',
  'excepté','facon','fais','faisaient','faisant','fait','façon','feront','font','gens','ha','hem',
  'hep','hi','ho','hormis','hors','hou','houp','hue','hui','huit','huitième','hé','i','il','ils',
  'importe','j\'','je','jusqu','jusque','juste','j’','l\'','la','laisser','laquelle','le',
  'lequel','les','lesquelles','lesquels','leur','leurs','longtemps','lors','lorsque','lui',
  'lui-meme','lui-même','là','lès','l’','m\'','ma','maint','maintenant','mais','malgre','malgré',
  'me','meme','memes','merci','mes','mien','mienne','miennes','miens','mille','moi','moi-meme',
  'moi-même','moindres','moins','mon','même','mêmes','m’','n\'','na','ne','neanmoins','neuvième',
  'ni','nombreuses','nombreux','nos','notamment','notre','nous','nous-mêmes','nouveau','nul',
  'néanmoins','nôtre','nôtres','n’','o','on','ont','onze','onzième','or','ou','ouias','ouste',
  'outre','ouvert','ouverte','ouverts','où','par','parce','parfois','parle','parlent','parler',
  'parmi','partant','pas','pendant','pense','permet','personne','peu','peut','peuvent','peux',
  'plus','plusieurs','plutot','plutôt','possible','possibles','pour','pourquoi','pourrais',
  'pourrait','pouvait','prealable','precisement','premier','première','premièrement','pres',
  'procedant','proche','près','préalable','précisement','pu','puis','puisque','qu\'','quand',
  'quant','quant-à-soi','quarante','quatorze','quatre','quatre-vingt','quatrième','quatrièmement',
  'que','quel','quelconque','quelle','quelles','quelqu\'un','quelque','quelques','quels','qui',
  'quiconque','quinze','quoi','quoique','qu’','relative','relativement','rend','rendre','restant',
  'reste','restent','retour','revoici','revoila','revoilà','s\'','sa','sait','sans','sauf','se',
  'seize','selon','semblable','semblaient','semble','semblent','sent','sept','septième','sera',
  'seraient','serait','seront','ses','seul','seule','seulement','seules','seuls','si','sien',
  'sienne','siennes','siens','sinon','six','sixième','soi','soi-meme','soi-même','soit',
  'soixante','son','sont','sous','souvent','specifique','specifiques','spécifique','spécifiques',
  'stop','suffisant','suffisante','suffit','suis','suit','suivant','suivante','suivantes',
  'suivants','suivre','sur','surtout','s’','t\'','ta','tant','te','tel','telle','tellement',
  'telles','tels','tenant','tend','tenir','tente','tes','tien','tienne','tiennes','tiens','toi',
  'toi-meme','toi-même','ton','touchant','toujours','tous','tout','toute','toutes','treize',
  'trente','tres','trois','troisième','troisièmement','très','tu','té','t’','un','une','unes',
  'uns','va','vais','vas','vers','via','vingt','voici','voila','voilà','vont','vos','votre',
  'votres','vous','vous-mêmes','vu','vé','vôtre','vôtres','y','à','â','ça','ès','également',
  'étaient','étais','était','étant','être','ô',
  // Domain-specific additions spaCy's generic list doesn't have: 'gabon'/'gabonais'/'gabonaise'
  // would otherwise dominate every single day trivially in a Gabon-focused corpus, and a
  // handful of adjectives ('dernier', 'nouvelle', 'grand'...) are common enough in headline
  // phrasing to be noise here even though they are not universal linguistic stopwords.
  'bon','contre','dernier','derniere','dernière','gabon','gabonais','gabonaise','grand','grande',
  'nouvelle','petit'
]);

// Elisions (l'état, d'un, qu'il, jusqu'à, lorsqu'elle, puisqu'on,
// quelqu'un...) are a short function word swallowing its apostrophe, not a
// compound — stripping the apostrophe outright used to glue them to the
// next word ("l'état" -> "létat"), which then slipped past the stopword
// list as one unrecognizable token instead of correctly reading as "état".
// This only fires right after a word boundary (\b), so it can't misfire
// on a real word that merely contains an apostrophe mid-token, like
// "aujourd'hui" — the "d" there sits after "aujour", not after a boundary.
const ELISION_PREFIX = /\b(jusqu|lorsqu|puisqu|quelqu|qu|l|d|j|m|n|s|t|c)['’]/gi;

// Shared by the keyword-frequency chart and the followed-keyword delta
// matcher, so "follow this word" and "this word is trending" agree on
// what a word even is
const titleWords = (title) =>
  (title || '').toLowerCase()
    .replace(ELISION_PREFIX, ' ')
    .replace(/[^a-zàâéèêëïîôùûüÿçœæ\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w));

// Only for "Sujets tendance" (trendTopicsSeries below) — titleWords()
// deliberately stays untouched since keyword-follow matching depends on its
// exact single-word tokens. A plain word-frequency count surfaces ordinary
// words ("Contre", "Ans", "État") alongside real names just because they're
// frequent, and worse, splits a name like "Oligui Nguema" into two unrelated
// "topics". This is a proper-noun heuristic instead: runs of consecutive
// Title-Case words in the *original* (non-lowercased) title are merged into
// one phrase — no NER model, so it's still approximate (a capitalized
// sentence-opener that isn't a stopword could slip through), but matches
// what the word actually looks like in the source text rather than treating
// every non-stopword token as equally "topic"-worthy.
// Each hyphen-joined segment must itself start capitalized ("Port-Gentil"),
// not just the first letter of the whole token — a plain [a-z'-]* tail
// would silently reject "Port-Gentil" the moment it hit the internal "G".
const CAPITALIZED_WORD_RE = /^[A-ZÀÂÉÈÊËÏÎÔÙÛÜŸÇŒÆ][a-zàâéèêëïîôùûüÿçœæ']*(-[A-ZÀÂÉÈÊËÏÎÔÙÛÜŸÇŒÆ][a-zàâéèêëïîôùûüÿçœæ']*)*$/;
const titlePhrases = (title) => {
  if (!title) return [];
  const rawWords = title.replace(ELISION_PREFIX, ' ').match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*/g) || [];
  const phrases = [];
  let current = [];
  rawWords.forEach(w => {
    const lower = w.toLowerCase();
    if (CAPITALIZED_WORD_RE.test(w) && lower.length > 2 && !TITLE_STOPWORDS.has(lower)) {
      current.push(lower);
    } else if (current.length) {
      phrases.push(current.join(' '));
      current = [];
    }
  });
  if (current.length) phrases.push(current.join(' '));
  return phrases;
};

// Shared by the Statistiques "since your last visit" strip and the Assistant
// landing page's personalized suggestions — same underlying question ("did
// anything change for what I follow?"), two surfaces. Kept as one pure
// function so the spiked/quiet/new thresholds can't drift between them.
const computeFollowDeltas = (points, follows, lastSeenDate, dateMax) => {
  if (!points || !dateMax || !lastSeenDate || !follows || follows.length === 0) return [];
  if (lastSeenDate >= dateMax) return [];

  const matches = (item, pt) => {
    if (item.type === 'source') return pt.source === item.value;
    if (item.type === 'theme') return normalizeCategory(pt.category, pt.source) === item.value;
    // Substring match rather than titleWords().includes(): "Sujets tendance"
    // can now hand out multi-word phrases ("oligui nguema") via titlePhrases,
    // which titleWords' single-word tokens would never equal. A lowercased
    // substring check handles both a single followed word and a followed
    // phrase the same way.
    if (item.type === 'keyword') return pt.title ? pt.title.toLowerCase().includes(item.value) : false;
    return false;
  };

  const daysSince = Math.max(1, Math.round((new Date(dateMax) - new Date(lastSeenDate)) / 86400000));
  const baselineStart = new Date(lastSeenDate);
  baselineStart.setDate(baselineStart.getDate() - daysSince);
  const baselineStartStr = baselineStart.toISOString().slice(0, 10);

  return follows.map(item => {
    let sinceCount = 0, baselineCount = 0;
    points.forEach(pt => {
      if (!pt.date || !matches(item, pt)) return;
      if (pt.date > lastSeenDate) sinceCount++;
      else if (pt.date >= baselineStartStr && pt.date <= lastSeenDate) baselineCount++;
    });
    let status = null;
    if (sinceCount === 0 && baselineCount >= 2) status = 'quiet';
    else if (sinceCount > 0 && baselineCount > 0 && sinceCount / baselineCount >= 1.6) status = 'spiked';
    else if (sinceCount > 0) status = 'new';
    return { ...item, sinceCount, baselineCount, status };
  }).filter(d => d.status !== null);
};

// Editorial profile — fixed entity→color map (8 validated categorical hues,
// adjacent-pair CVD-checked on the white panel); every other rubrique folds
// into a neutral "Autres" so colors never depend on the data.
const PROFILE_COLORS = {
  'Politique': '#23805C',
  'Société': '#3A6FB8',
  'Économie': '#D0703A',
  'Sport': '#9E4A8C',
  'Faits Divers / Justice': '#C99A2A',
  'Culture': '#5752B0',
  'Provinces': '#1EA39B',
  'Environnement': '#C9434A',
};
const PROFILE_OTHER = 'Autres / non classé';
const PROFILE_OTHER_COLOR = '#6B7A89';

const FOLLOWS_KEY = 'lekiosque_follows';
const LAST_VISIT_KEY = 'lekiosque_stats_last_seen_date';

function MetricsDashboard({ data, gabonToday, onAskAssistant, user, authToken }) {
  const trendChartRef = useRef(null);
  const catChartRef = useRef(null);
  const sourceDonutRef = useRef(null);
  const profileChartRef = useRef(null);

  // Followed keywords/sources/thèmes — persisted so the "since your last
  // visit" strip below has something to diff against on the next visit.
  // localStorage stays the baseline (works logged-out); once signed in, the
  // server becomes the source of truth and any local-only follows (e.g.
  // picked before creating an account) are migrated up on the first mount
  // after login rather than silently dropped.
  const [follows, setFollows] = useState(() => {
    try { return JSON.parse(localStorage.getItem(FOLLOWS_KEY) || '[]'); } catch { return []; }
  });
  useEffect(() => {
    localStorage.setItem(FOLLOWS_KEY, JSON.stringify(follows));
  }, [follows]);
  const migratedRef = useRef(false);
  useEffect(() => {
    if (!user || !authToken || migratedRef.current) return;
    migratedRef.current = true;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/follows`, { headers: { Authorization: `Bearer ${authToken}` } });
        const serverFollows = res.ok ? await res.json() : [];
        const localOnly = follows.filter(f => !serverFollows.some(sf => sf.type === f.type && sf.value === f.value));
        await Promise.all(localOnly.map(f => fetch(`${API_URL}/follows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(f),
        }).catch(() => {})));
        setFollows([...serverFollows, ...localOnly]);
      } catch { /* stay on the local list if the sync itself fails */ }
    })();
  }, [user, authToken]);

  const isFollowed = useCallback(
    (type, value) => follows.some(f => f.type === type && f.value === value),
    [follows]
  );
  const toggleFollow = useCallback((type, value, label) => {
    const existed = follows.some(f => f.type === type && f.value === value);
    setFollows(prev => existed
      ? prev.filter(f => !(f.type === type && f.value === value))
      : [...prev, { type, value, label }]);
    if (user && authToken) {
      if (existed) {
        fetch(`${API_URL}/follows?type=${encodeURIComponent(type)}&value=${encodeURIComponent(value)}`, {
          method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` },
        }).catch(() => {});
      } else {
        fetch(`${API_URL}/follows`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ type, value, label }),
        }).catch(() => {});
      }
    }
  }, [follows, user, authToken]);
  // Snapshot the *previous* visit's date once per mount, before this visit
  // overwrites it below — same "mark as seen on open" pattern as the report
  // archive badge, anchored on the corpus's own latest article date (not the
  // visitor's device clock) so it stays correct across timezones/misconfig
  const [lastSeenDate] = useState(() => localStorage.getItem(LAST_VISIT_KEY));

  // Phones default to a readable window (90 days, weekly); desktop shows all
  const [granularity, setGranularity] = useState(() => window.innerWidth <= 768 ? 'week' : 'day');
  const [trendRange, setTrendRange] = useState(() => window.innerWidth <= 768 ? '90' : 'all');

  const stats = useMemo(() => {
    if (!data || !data.points) return null;
    const sources = {};
    const timeSeries = {}; // keys will be days or mondays
    const categories = {}; // { cat: { source: count } }

    const getMonday = (dStr) => {
      const d = new Date(dStr);
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      return new Date(d.setDate(diff)).toISOString().split('T')[0];
    };

    try {
      data.points.forEach(pt => {
        if (!pt.source) return;

        // Total by source
        sources[pt.source] = (sources[pt.source] || 0) + 1;

        // Time trend
        if (pt.date) {
          const timeKey = granularity === 'week' ? getMonday(pt.date) : pt.date;
          if (!timeSeries[timeKey]) timeSeries[timeKey] = {};
          timeSeries[timeKey][pt.source] = (timeSeries[timeKey][pt.source] || 0) + 1;
        }

        // Category distribution
        const cat = normalizeCategory(pt.category, pt.source);
        if (!categories[cat]) categories[cat] = {};
        categories[cat][pt.source] = (categories[cat][pt.source] || 0) + 1;
      });

      // The corpus starts in December 2025; the trickle of older articles
      // (long archive tails of some sources) makes a misleading flat prefix
      const TREND_START = '2025-12-01';
      const sortedTimeKeys = Object.keys(timeSeries).filter(k => k >= TREND_START).sort();
      const sourcesList = Object.keys(sources);
      // Fixed per-entity palette, 13 validated categorical hues. The order below
      // (descending source volume) passes the CVD/normal-vision adjacency checks;
      // the tightest pairs sit in the 6–8 CVD band, acceptable because every view
      // carries direct labels. New sources beyond these fold into "Autres".
      const colors = {
        gabonmediatime:    '#23805C',
        gabonreview:       '#3A6FB8',
        lunion:            '#D0703A',
        focusgroupemedia:  '#9E4A8C',
        gabonactu:         '#C99A2A',
        directinfosgabon:  '#5752B0',
        '7joursinfo':      '#1EA39B',
        insidenews241:     '#C9434A',
        depeches241:       '#2E6F8E',
        gabonallsport:     '#8A6A43',
        kongossanews:      '#7A5AA0',
        gabonquotidien:    '#6B7F22',
        ethiquemediagabon: '#B0476E',
      };
      const OTHER_COLOR = '#6B7A89';
      const OTHER_LABEL = 'Autres';
      const mainSources = Object.keys(colors).filter(s => sources[s]);
      const tailSources = sourcesList.filter(s => !colors[s]);

      // KPI calculations
      const dates = data.points.map(p => p.date).filter(Boolean).sort();
      const dateMin = dates[0] || '—';
      const dateMax = dates[dates.length - 1] || '—';
      const uniqueDays = new Set(dates).size;
      const avgPerDay = uniqueDays > 0 ? (data.points.length / uniqueDays).toFixed(1) : 0;
      const totalCategories = Object.keys(categories).length;
      const topSource = Object.entries(sources).sort((a, b) => b[1] - a[1])[0];
      // Catch-all buckets are not themes: they must not win "Thème #1"
      const NON_THEMES = new Set(['Non classé', 'Autres', 'Autres / non classé']);
      const topCategory = Object.entries(categories)
        .filter(([cat]) => !NON_THEMES.has(cat))
        .map(([cat, srcMap]) => [cat, Object.values(srcMap).reduce((s, v) => s + v, 0)])
        .sort((a, b) => b[1] - a[1])[0];

      // Busiest day of week
      const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
      const dayCounts = [0, 0, 0, 0, 0, 0, 0];
      dates.forEach(d => { try { dayCounts[new Date(d).getDay()]++; } catch {} });
      // Busiest by average per occurrence (computed below), not raw totals
      let busiestDay = dayNames[dayCounts.indexOf(Math.max(...dayCounts))];

      // Week-over-week trend
      const now = new Date();
      const oneWeekAgo = new Date(now); oneWeekAgo.setDate(now.getDate() - 7);
      const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(now.getDate() - 14);
      const thisWeekStr = oneWeekAgo.toISOString().split('T')[0];
      const lastWeekStr = twoWeeksAgo.toISOString().split('T')[0];
      const nowStr = now.toISOString().split('T')[0];
      const thisWeekCount = dates.filter(d => d >= thisWeekStr && d <= nowStr).length;
      const lastWeekCount = dates.filter(d => d >= lastWeekStr && d < thisWeekStr).length;
      const weekTrend = lastWeekCount > 0 ? (((thisWeekCount - lastWeekCount) / lastWeekCount) * 100).toFixed(0) : 0;

      // Record day (single day with most articles)
      const dayArticleCounts = {};
      dates.forEach(d => { dayArticleCounts[d] = (dayArticleCounts[d] || 0) + 1; });
      const recordDay = Object.entries(dayArticleCounts).sort((a, b) => b[1] - a[1])[0] || ['—', 0];

      // Source freshness — latest article date per source
      const sourceFreshness = {};
      data.points.forEach(pt => {
        if (!pt.source || !pt.date) return;
        if (!sourceFreshness[pt.source] || pt.date > sourceFreshness[pt.source]) {
          sourceFreshness[pt.source] = pt.date;
        }
      });


      // Day-of-week heatmap data — average per weekday occurrence, not totals
      // (totals just mirror how many of each weekday the corpus happens to span)
      const dayOccurrences = [0, 0, 0, 0, 0, 0, 0];
      new Set(dates).forEach(d => { try { dayOccurrences[new Date(d).getDay()]++; } catch { /* bad date */ } });
      const dayOfWeekData = dayNames.map((name, i) => ({
        name,
        count: dayOccurrences[i] > 0 ? dayCounts[i] / dayOccurrences[i] : 0,
      }));
      busiestDay = dayOfWeekData.reduce((a, b) => (b.count > a.count ? b : a)).name;

      // 1. Trend Traces — stacked area chart: the 8 colored sources as series,
      // remaining sources aggregated into one "Autres" series.
      // Data is sliced to the selected window (not just an axis range) so the
      // y-axis rescales to what is actually visible
      let trendKeys = sortedTimeKeys;
      if (trendRange !== 'all' && sortedTimeKeys.length) {
        const last = new Date(sortedTimeKeys[sortedTimeKeys.length - 1]);
        const cutoff = new Date(last.getTime() - Number(trendRange) * 86400000)
          .toISOString().slice(0, 10);
        trendKeys = sortedTimeKeys.filter(k => k >= cutoff);
      }
      const trendTraces = mainSources.map(src => ({
        name: src,
        x: trendKeys,
        y: trendKeys.map(k => timeSeries[k][src] || 0),
        type: 'scatter',
        mode: 'lines',
        fill: 'tonexty',
        stackgroup: 'one',
        line: { shape: 'spline', width: 1, color: colors[src] },
        fillcolor: colors[src] + '55'
      }));
      if (tailSources.length > 0) {
        trendTraces.push({
          name: `${OTHER_LABEL} (${tailSources.length} sources)`,
          x: trendKeys,
          y: trendKeys.map(k => tailSources.reduce((s, src) => s + (timeSeries[k][src] || 0), 0)),
          type: 'scatter',
          mode: 'lines',
          fill: 'tonexty',
          stackgroup: 'one',
          line: { shape: 'spline', width: 1, color: OTHER_COLOR },
          fillcolor: OTHER_COLOR + '55'
        });
      }

      // 2. Category Top Entries (for custom treemap)
      const catTotals = Object.entries(categories).map(([cat, srcMap]) => [
        cat, Object.values(srcMap).reduce((s, v) => s + v, 0)
      ]).sort((a, b) => b[1] - a[1]);

      const topCatsAbsolute = catTotals.slice(0, 8);

      const TOP_N = 14;
      const topCatEntries = catTotals.slice(0, TOP_N);
      const otherCats = catTotals.slice(TOP_N);
      const otherTotal = otherCats.reduce((s, c) => s + c[1], 0);

      if (otherTotal > 0) {
        topCatEntries.push(['Autres', otherTotal]);
        const autresSources = {};
        otherCats.forEach(([cat]) => {
          if (categories[cat]) {
            Object.entries(categories[cat]).forEach(([src, count]) => {
              autresSources[src] = (autresSources[src] || 0) + count;
            });
          }
        });
        categories['Autres'] = autresSources;
      }

      // 3. Source donut — colored sources as slices, the rest folded into "Autres"
      const mainEntries = mainSources
        .map(s => [s, sources[s]])
        .sort((a, b) => b[1] - a[1]);
      const tailTotal = tailSources.reduce((s, src) => s + sources[src], 0);
      const donutEntries = tailTotal > 0
        ? [...mainEntries, [`${OTHER_LABEL} (${tailSources.length} sources)`, tailTotal]]
        : mainEntries;
      const donutTrace = {
        labels: donutEntries.map(e => e[0]),
        values: donutEntries.map(e => e[1]),
        type: 'pie',
        hole: 0.55,
        // Outside labels with automargin: the pie shrinks to fit them inside
        // the pinned-height chart instead of overflowing the card
        textinfo: 'label+percent',
        textposition: 'outside',
        automargin: true,
        outsidetextfont: { size: 11 },
        marker: { colors: donutEntries.map(e => colors[e[0]] || OTHER_COLOR) },
        hoverinfo: 'label+value+percent',
        sort: false
      };

      return {
        trendTraces, topCatEntries, donutTrace,
        total: data.points.length, sources, categories,
        dateMin, dateMax, avgPerDay, totalCategories,
        topSource, topCategory, colors,
        busiestDay, thisWeekCount, lastWeekCount, weekTrend,
        recordDay, sourceFreshness,
        dayOfWeekData, topCatsAbsolute
      };
    } catch (err) {
      console.error('Error calculating metrics:', err);
      return null;
    }
  }, [data, granularity, trendRange]);

  // Marks this visit as "seen" for next time — deliberately happens after
  // lastSeenDate was already snapshotted into state above, so this visit's
  // own strip still diffs against the *previous* visit, not itself
  useEffect(() => {
    if (stats?.dateMax) localStorage.setItem(LAST_VISIT_KEY, stats.dateMax);
  }, [stats?.dateMax]);

  // "Depuis votre dernière visite": for each followed keyword/source/thème,
  // compare articles published since lastSeenDate against a same-length
  // baseline window immediately before it — a flat "3 nouveaux articles"
  // means little without knowing whether 3 is normal, a spike, or the item
  // going quiet, same reasoning as sourceMomentum's day-of-week comparison
  // above, just anchored on the visitor's own last visit instead of a
  // calendar period
  const followDeltas = useMemo(
    () => computeFollowDeltas(data?.points, follows, lastSeenDate, stats?.dateMax),
    [data, follows, lastSeenDate, stats?.dateMax]
  );

  // Editorial profile per media, with its own time window.
  // Windows are anchored on the most recent collected article, not the wall
  // clock, so the view stays populated when scraping lags.
  const [profileRange, setProfileRange] = useState('all'); // 'day' | 'week' | 'all'
  const profileTraces = useMemo(() => {
    if (!data || !data.points) return [];
    const allDates = data.points.map(p => p.date).filter(Boolean);
    const maxDate = allDates.length ? allDates.reduce((a, b) => (b > a ? b : a)) : null;
    let cutoff = null;
    if (maxDate && profileRange === 'day') cutoff = maxDate;
    if (maxDate && profileRange === 'week') {
      const d = new Date(maxDate);
      d.setDate(d.getDate() - 6);
      cutoff = d.toISOString().split('T')[0];
    }

    const sources = {};
    const bySource = {};
    data.points.forEach(pt => {
      if (!pt.source) return;
      if (cutoff && (!pt.date || pt.date < cutoff)) return;
      sources[pt.source] = (sources[pt.source] || 0) + 1;
      const cat = normalizeCategory(pt.category, pt.source);
      if (!bySource[pt.source]) bySource[pt.source] = {};
      bySource[pt.source][cat] = (bySource[pt.source][cat] || 0) + 1;
    });

    const lightHues = new Set(['#C99A2A', '#1EA39B']);
    const profileSources = Object.keys(sources).sort((a, b) => sources[b] - sources[a]);
    return [...Object.keys(PROFILE_COLORS), PROFILE_OTHER].map(cat => {
      const counts = profileSources.map(src => {
        const m = bySource[src] || {};
        if (cat === PROFILE_OTHER) {
          return Object.entries(m).reduce((s, [c, n]) => s + (PROFILE_COLORS[c] ? 0 : n), 0);
        }
        return m[cat] || 0;
      });
      const color = PROFILE_COLORS[cat] || PROFILE_OTHER_COLOR;
      const pcts = profileSources.map((src, i) => (sources[src] ? (counts[i] / sources[src]) * 100 : 0));
      return {
        name: cat,
        type: 'bar',
        orientation: 'h',
        y: profileSources,
        x: pcts,
        customdata: counts,
        marker: { color, line: { color: '#ffffff', width: 1 } },
        text: pcts.map(p => (p >= 7 ? `${Math.round(p)}%` : '')),
        textposition: 'inside',
        insidetextanchor: 'middle',
        textfont: { size: 10, color: lightHues.has(color) ? '#0F2A3A' : '#ffffff' },
        hovertemplate: `<b>%{y}</b> · ${cat}<br>%{customdata} articles (%{x:.1f} %)<extra></extra>`,
      };
    });
  }, [data, profileRange]);

  // Source momentum: current period vs the one before, anchored on the
  // newest collected article rather than the wall clock. Same toggle
  // pattern as the editorial profile above.
  const [momentumRange, setMomentumRange] = useState('week'); // 'day' | 'week' | 'all'
  const sourceMomentum = useMemo(() => {
    if (!data || !data.points) return [];
    const freshness = {};
    data.points.forEach(pt => {
      if (!pt.source || !pt.date) return;
      if (!freshness[pt.source] || pt.date > freshness[pt.source]) freshness[pt.source] = pt.date;
    });
    const maxDateStr = Object.values(freshness).sort().pop();
    if (!maxDateStr) return [];

    if (momentumRange === 'all') {
      // No "previous period" over the whole corpus: a straight volume
      // ranking instead of a delta
      const total = {};
      data.points.forEach(pt => {
        if (!pt.source) return;
        total[pt.source] = (total[pt.source] || 0) + 1;
      });
      return Object.entries(total)
        .map(([name, w1]) => ({ name, w1, w0: 0, delta: null }))
        .sort((a, b) => b.w1 - a.w1);
    }

    if (momentumRange === 'day') {
      // A single-previous-day comparison is too noisy at daily volumes (2
      // vs 5 articles reads as "+150 %"), and a source doesn't publish at
      // the same pace every weekday (weekend lull, etc.) — so "normal" for
      // a Monday means the average of previous Mondays, not the average of
      // every day. Same framing as the day-of-week KPI card elsewhere in
      // this dashboard, applied per source.
      const todayDow = new Date(maxDateStr).getDay();
      const byDate = {}; // { source: { date: count } }
      data.points.forEach(pt => {
        if (!pt.source || !pt.date) return;
        (byDate[pt.source] ||= {})[pt.date] = (byDate[pt.source][pt.date] || 0) + 1;
      });
      return Object.entries(byDate)
        .map(([name, dates]) => {
          const w1 = dates[maxDateStr] || 0;
          const sameDowPriorDays = Object.keys(dates).filter(d => {
            if (d === maxDateStr) return false;
            const t = new Date(d);
            return !isNaN(t.getTime()) && t.getDay() === todayDow;
          });
          const avg = sameDowPriorDays.length
            ? sameDowPriorDays.reduce((s, d) => s + dates[d], 0) / sameDowPriorDays.length
            : 0;
          return {
            name, w1, w0: avg,
            delta: avg > 0 ? Math.round((w1 - avg) / avg * 100) : null,
          };
        })
        .sort((a, b) => b.w1 - a.w1);
    }

    const spanDays = 7;
    const maxT = new Date(maxDateStr).getTime();
    const curStart = maxT - (spanDays - 1) * 86400000;
    const prevStart = maxT - (spanDays * 2 - 1) * 86400000;
    const momentum = {};
    data.points.forEach(pt => {
      const t = new Date(pt.date).getTime();
      if (!pt.source || isNaN(t) || t < prevStart) return;
      const m = momentum[pt.source] || (momentum[pt.source] = { w1: 0, w0: 0 });
      if (t >= curStart) m.w1++; else m.w0++;
    });
    return Object.entries(momentum)
      .map(([name, m]) => ({
        name, w1: m.w1, w0: m.w0,
        delta: m.w0 > 0 ? Math.round((m.w1 - m.w0) / m.w0 * 100) : null,
      }))
      .sort((a, b) => b.w1 - a.w1);
  }, [data, momentumRange]);

  // Top keywords from titles, same adjustable-window pattern
  const [keywordsRange, setKeywordsRange] = useState('all'); // 'day' | 'week' | 'all'
  const topKeywords = useMemo(() => {
    if (!data || !data.points) return [];
    const allDates = data.points.map(p => p.date).filter(Boolean);
    const maxDate = allDates.length ? allDates.reduce((a, b) => (b > a ? b : a)) : null;
    let cutoff = null;
    if (maxDate && keywordsRange === 'day') cutoff = maxDate;
    if (maxDate && keywordsRange === 'week') {
      const d = new Date(maxDate);
      d.setDate(d.getDate() - 6);
      cutoff = d.toISOString().split('T')[0];
    }
    const wordCounts = {};
    data.points.forEach(pt => {
      if (!pt.title) return;
      if (cutoff && (!pt.date || pt.date < cutoff)) return;
      titleWords(pt.title).forEach(w => { wordCounts[w] = (wordCounts[w] || 0) + 1; });
    });
    return Object.entries(wordCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [data, keywordsRange]);

  // Top 10 trending topics as a bump chart (rank over time), not a raw-count
  // line chart. Two problems with the earlier version, both real: (1) "top
  // 10" was decided once from the total across the whole window and then
  // held fixed — a word that only became prominent this week could never
  // appear, and one that mattered early but faded never dropped off; a
  // *trending* list has to be allowed to turn over. (2) raw daily counts are
  // small, noisy integers — ties and one-off spikes made the lines an
  // unreadable tangle. Ranking each bucket independently fixes both: the
  // top 10 is recomputed per bucket (so the roster genuinely rotates), and
  // rank is a bounded 1-10 ordinal, structurally smoother than raw counts.
  const RANK_CAP = 10;
  // Total distinct words that pass through the top 10 across a whole window
  // can run well past 10 (a rotating roster, by design) — capped here to
  // keep the color/line count sane, favoring words that held a top-10 spot
  // for the most buckets (sustained relevance) over one-day flashes.
  const CAST_CAP = 12;
  const [trendTopicsGranularity, setTrendTopicsGranularity] = useState('week'); // 'day' | 'week' | 'month'
  const trendTopicsSeries = useMemo(() => {
    if (!data || !data.points) return { series: [], buckets: [] };
    const allDates = data.points.map(p => p.date).filter(Boolean);
    if (!allDates.length) return { series: [], buckets: [] };
    const maxDate = allDates.reduce((a, b) => (b > a ? b : a));

    let windowStartStr;
    if (trendTopicsGranularity === 'day') {
      const d = new Date(maxDate); d.setDate(d.getDate() - 29);
      windowStartStr = d.toISOString().slice(0, 10);
    } else if (trendTopicsGranularity === 'week') {
      const d = new Date(maxDate); d.setDate(d.getDate() - 7 * 15);
      windowStartStr = d.toISOString().slice(0, 10);
    } else {
      // Monthly: the whole corpus (it only starts Dec 2025, so this is
      // already a handful of buckets, not hundreds)
      windowStartStr = '2025-12-01';
    }

    const bucketKey = (dateStr) => {
      if (trendTopicsGranularity === 'month') return dateStr.slice(0, 7);
      if (trendTopicsGranularity === 'week') {
        const d = new Date(dateStr);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        return new Date(d.setDate(diff)).toISOString().slice(0, 10);
      }
      return dateStr;
    };

    const bucketWordCounts = {}; // bucket -> { word: count }
    const bucketSet = new Set();
    data.points.forEach(pt => {
      if (!pt.title || !pt.date || pt.date < windowStartStr) return;
      const bucket = bucketKey(pt.date);
      bucketSet.add(bucket);
      const counts = (bucketWordCounts[bucket] ||= {});
      titlePhrases(pt.title).forEach(w => { counts[w] = (counts[w] || 0) + 1; });
    });
    const buckets = Array.from(bucketSet).sort();

    // Ranking on a single bucket's raw count is noisy past the top 2-3
    // spots — daily counts are small integers with frequent near-ties, so
    // rank order for anything below the leaders flips around on almost
    // nothing. A trailing rolling sum smooths that into something that
    // reads as an actual trend rather than single-day static; weekly/
    // monthly buckets are already coarse enough that this matters less.
    const ROLLING_WINDOW = trendTopicsGranularity === 'day' ? 3 : trendTopicsGranularity === 'week' ? 2 : 1;
    const smoothedCounts = buckets.map((_, i) => {
      const merged = {};
      buckets.slice(Math.max(0, i - ROLLING_WINDOW + 1), i + 1).forEach(b => {
        Object.entries(bucketWordCounts[b] || {}).forEach(([w, c]) => { merged[w] = (merged[w] || 0) + c; });
      });
      return merged;
    });

    // Per bucket, the top 10 words that bucket (by smoothed count) — an
    // independent ranking each time, which is exactly what lets the roster
    // turn over
    const bucketTop10 = smoothedCounts.map(counts =>
      Object.entries(counts).sort((a, c) => c[1] - a[1]).slice(0, RANK_CAP).map(([w]) => w)
    );

    const appearances = {};
    bucketTop10.forEach(ranked => ranked.forEach(w => { appearances[w] = (appearances[w] || 0) + 1; }));
    const cast = Object.entries(appearances).sort((a, b) => b[1] - a[1]).slice(0, CAST_CAP).map(([w]) => w);
    const castSet = new Set(cast);

    const wordTotals = {};
    data.points.forEach(pt => {
      if (!pt.title || !pt.date || pt.date < windowStartStr) return;
      titlePhrases(pt.title).forEach(w => { if (castSet.has(w)) wordTotals[w] = (wordTotals[w] || 0) + 1; });
    });

    const series = cast.map(word => {
      const ranks = bucketTop10.map(ranked => {
        const idx = ranked.indexOf(word);
        return idx === -1 ? null : idx + 1;
      });
      return { word, ranks, total: wordTotals[word] || 0 };
    }).sort((a, b) => {
      // Currently-ranked words first (best rank first), then words that
      // have since dropped out of the top 10 entirely
      const aLast = a.ranks[a.ranks.length - 1];
      const bLast = b.ranks[b.ranks.length - 1];
      if (aLast !== null && bLast !== null) return aLast - bLast;
      if (aLast !== null) return -1;
      if (bLast !== null) return 1;
      return b.total - a.total;
    });

    return { series, buckets };
  }, [data, trendTopicsGranularity]);

  // Shared by the Plotly layout and the wrapper div: the flex container only
  // grows past its min-height when the div itself carries the height.
  // On mobile the legend is HTML (above the chart), not Plotly's.
  // Reactive so the charts re-render with the right config on window resize
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia('(max-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const fn = e => setIsNarrow(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  const profileHeight = profileTraces.length
    ? Math.max(180, (isNarrow ? 30 : 90) + profileTraces[0].y.length * 36)
    : 200;

  useEffect(() => {
    if (!profileChartRef.current || !profileTraces.length) return;
    try {
      Plotly.react(profileChartRef.current, profileTraces, {
        barmode: 'stack',
        bargap: 0.45,
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        // Narrow screens: a 140px gutter would eat a third of the width
        margin: { t: 10, r: isNarrow ? 8 : 20, l: isNarrow ? 104 : 140, b: 30 },
        height: profileHeight,
        xaxis: {
          range: [0, 100], ticksuffix: ' %',
          gridcolor: 'rgba(15,42,58,0.07)', zeroline: false, tickfont: { size: 11 }
        },
        yaxis: { autorange: 'reversed', tickfont: { size: isNarrow ? 10 : 12 } },
        // Mobile uses the wrapping HTML legend rendered above the chart:
        // Plotly's own legend refuses to pack tightly on narrow screens
        showlegend: !isNarrow,
        legend: {
          orientation: 'h', y: 1.02, yanchor: 'bottom', x: 0.5, xanchor: 'center',
          font: { size: 11 }, traceorder: 'normal',
        },
        font: { family: 'inherit', size: 12 },
      }, { responsive: true, displayModeBar: false });
    } catch (err) {
      console.error('Plotly error (profile):', err);
    }
  }, [profileTraces, profileHeight, isNarrow]);

  useEffect(() => {
    if (!trendChartRef.current || !stats || !stats.trendTraces.length) return;
    try {
      Plotly.react(trendChartRef.current, stats.trendTraces, {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: isNarrow ? { t: 12, r: 8, l: 34, b: 48 } : { t: 20, r: 20, l: 50, b: 70 },
        hovermode: 'x',
        xaxis: {
          gridcolor: 'rgba(15,42,58,0.07)', zeroline: false,
          tickangle: -30,
          // Tick spacing follows the visible window (wider on phones) so the
          // date axis stays legible
          dtick: (trendRange === '30' ? 7
                  : trendRange === '90' ? (isNarrow ? 21 : 14)
                  : trendRange === '180' ? (isNarrow ? 30 : 21)
                  : granularity === 'week' ? (isNarrow ? 28 : 7)
                  : (isNarrow ? 30 : 14)) * 86400000,
          tickfont: { size: isNarrow ? 10 : 11 }
        },
        yaxis: {
          gridcolor: 'rgba(15,42,58,0.07)',
          title: isNarrow ? '' : (granularity === 'week' ? 'Articles par semaine' : 'Articles par jour'),
          zeroline: false,
          rangemode: 'tozero',
          tickfont: { size: isNarrow ? 10 : 12 }
        },
        // Mobile uses the wrapping HTML legend under the chart
        showlegend: !isNarrow,
        legend: { orientation: 'h', y: -0.22, x: 0.5, xanchor: 'center', font: { size: 11 } },
        font: { family: 'inherit', size: 12 }
      }, { responsive: true, displayModeBar: false });

      if (sourceDonutRef.current && stats.donutTrace) {
        // Narrow screens: outside labels degenerate into a ragged column, so
        // switch to inside percents + a wrapping legend below the donut
        const mobile = isNarrow;
        const donutTrace = mobile ? {
          ...stats.donutTrace,
          textinfo: 'percent',
          textposition: 'inside',
          insidetextorientation: 'horizontal',
          automargin: false,
        } : stats.donutTrace;
        Plotly.react(sourceDonutRef.current, [donutTrace], {
          paper_bgcolor: 'transparent',
          margin: mobile ? { t: 6, r: 6, l: 6, b: 6 } : { t: 16, r: 16, l: 16, b: 16 },
          height: 380,  // pinned: matches the container div, never trust auto-sizing
          showlegend: mobile,
          ...(mobile ? {
            legend: { orientation: 'h', y: -0.04, x: 0.5, xanchor: 'center', font: { size: 10 } },
            uniformtext: { minsize: 10, mode: 'hide' },
          } : {}),
          font: { family: 'inherit', size: 12 },
          annotations: [{
            text: `<b>${stats.total.toLocaleString()}</b><br>articles`,
            showarrow: false, font: { size: mobile ? 15 : 18, color: '#34495A' }
          }]
        }, { responsive: true, displayModeBar: false });
      }
    } catch (err) {
      console.error('Plotly error:', err);
    }
  }, [stats, granularity, trendRange, isNarrow]);

  if (!stats) return <div className="metrics-view"><p>Erreur lors du calcul des statistiques. Vérifiez la console.</p></div>;

  return (
    <div className="metrics-view">
      <div className="metrics-header">
        <div>
          <h2 className="metrics-title">Tableau de bord analytique</h2>
          <p className="metrics-subtitle">Vue d'ensemble de la couverture médiatique gabonaise</p>
        </div>
      </div>

      {/* ── Since your last visit ─────────────────────
          Only followed items produce a card here, and only once there's a
          real previous visit to diff against (first-ever visit has nothing
          to compare, so it stays silent rather than showing empty state) */}
      {followDeltas.length > 0 && (
        <div className="follow-strip">
          <span className="follow-strip-title">Depuis votre dernière visite</span>
          <div className="follow-strip-items">
            {followDeltas.map(d => (
              <div key={`${d.type}-${d.value}`} className={`follow-card ${d.status}`}>
                {d.status === 'spiked' && <Flame size={14} />}
                {d.status === 'quiet' && <BellOff size={14} />}
                {d.status === 'new' && <Star size={14} />}
                <div className="follow-card-body">
                  <span className="follow-card-label">{d.label}</span>
                  <span className="follow-card-detail">
                    {d.status === 'spiked' && `${d.sinceCount} articles — bien plus que d'habitude (~${d.baselineCount})`}
                    {d.status === 'quiet' && `silence depuis — habituellement ~${d.baselineCount} sur cette période`}
                    {d.status === 'new' && `${d.sinceCount} nouvel${d.sinceCount > 1 ? 'les' : ''} article${d.sinceCount > 1 ? 's' : ''}`}
                  </span>
                </div>
                <button
                  className="follow-card-remove"
                  onClick={() => toggleFollow(d.type, d.value, d.label)}
                  title={`Ne plus suivre ${d.label}`}
                  aria-label={`Ne plus suivre ${d.label}`}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {follows.length === 0 && (
        <p className="follow-hint">
          <Star size={12} /> Suivez un mot-clé, une source ou un thème ci-dessous (icône ★) pour voir leur évolution ici à votre prochaine visite.
        </p>
      )}

      {/* ── KPI Row ────────────────────────────────── */}
      <div className="metrics-grid">
        <div className="stat-card stat-highlight">
          <span className="stat-label">Articles collectés</span>
          <div className="stat-value">{stats.total.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Période couverte</span>
          <div className="stat-value stat-value-sm">{stats.dateMin}<br/>→ {stats.dateMax}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Articles par jour en moyenne</span>
          <div className="stat-value">{stats.avgPerDay}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Rubriques recensées</span>
          <div className="stat-value">{stats.totalCategories}</div>
        </div>
        {stats.topSource && (
          <div className="stat-card">
            <span className="stat-label">Média le plus prolifique</span>
            <div className="stat-value stat-value-sm">{stats.topSource[0]}</div>
            <span className="stat-detail">{stats.topSource[1].toLocaleString()} articles</span>
          </div>
        )}
        {stats.topCategory && (
          <div className="stat-card">
            <span className="stat-label">Thème le plus couvert</span>
            <div className="stat-value stat-value-sm">{stats.topCategory[0]}</div>
            <span className="stat-detail">{stats.topCategory[1].toLocaleString()} articles</span>
          </div>
        )}
        <div className="stat-card">
          <span className="stat-label">Jour de la semaine le plus actif</span>
          <div className="stat-value stat-value-sm">{stats.busiestDay}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Record d'articles en une journée</span>
          <div className="stat-value">{stats.recordDay[1]}</div>
          <span className="stat-detail">le {stats.recordDay[0]}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Articles ces 7 derniers jours</span>
          <div className="stat-value">{stats.thisWeekCount}</div>
          <span className="stat-detail" style={{ color: Number(stats.weekTrend) >= 0 ? '#2E554B' : '#A8433A' }}>
            {Number(stats.weekTrend) >= 0 ? '▲' : '▼'} {Math.abs(stats.weekTrend)}% vs la semaine précédente
          </span>
        </div>
        {/* Silent ingestion failures directly degrade answer freshness:
            surface them at the top instead of burying them at page bottom */}
        {(() => {
          const stale = Object.entries(stats.sourceFreshness)
            .filter(([, d]) => (new Date() - new Date(d)) / 86400000 > 7);
          if (!stale.length) return null;
          return (
            <div className="stat-card stat-alert">
              <span className="stat-label">Sources silencieuses (+ de 7 jours)</span>
              <div className="stat-value">{stale.length}</div>
              <span className="stat-detail">{stale.map(([s]) => s).slice(0, 3).join(', ')}{stale.length > 3 ? '…' : ''}</span>
            </div>
          );
        })()}
      </div>

      {/* ── Today vs average for this day of week ── */}
      {(() => {
        const dayNames = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
        // Anchored on the newest collected article, not the visitor's own
        // device clock: a device's local date (or worse, its UTC date via
        // toISOString()) can disagree with Gabon's calendar day for a chunk
        // of every 24h, for any visitor outside Gabon's timezone — same
        // anchoring principle as the temporal RAG "today" queries.
        const todayStr = stats.dateMax;
        const todayIdx = todayStr && todayStr !== '—' ? new Date(todayStr).getDay() : new Date().getDay();
        const todayName = dayNames[todayIdx];

        // Count articles published today
        const todayCount = data.points.filter(p => p.date === todayStr).length;

        // Count how many of this weekday exist in the dataset and their total articles
        const allDates = [...new Set(data.points.map(p => p.date).filter(Boolean))];
        const sameDayDates = allDates.filter(d => new Date(d).getDay() === todayIdx && d !== todayStr);
        const sameDayArticles = data.points.filter(p => sameDayDates.includes(p.date)).length;
        const avgForDay = sameDayDates.length > 0 ? sameDayArticles / sameDayDates.length : 0;

        const pctDiff = avgForDay > 0 ? ((todayCount - avgForDay) / avgForDay * 100).toFixed(0) : 0;
        const isAbove = Number(pctDiff) >= 0;

        // Data can lag the real calendar day (scraping runs 3x/day, not
        // continuously) — say so plainly instead of implying today's
        // articles are in when the freshest thing we have is yesterday's.
        // gabonToday is the server's authoritative "today" (§ api.py
        // gabon_now()); until it loads, don't guess off a device clock.
        const isTrueToday = gabonToday && todayStr === gabonToday;

        return (
          <div className="today-comparison">
            <div className="today-main">
              <span className="today-label">
                {isTrueToday
                  ? `Publiés aujourd'hui (${todayName.toLowerCase()})`
                  : `Dernier jour couvert (${todayName.toLowerCase()})`}
              </span>
              <span className="today-count">{todayCount} <small>articles</small></span>
              {!isTrueToday && gabonToday && (
                <span className="today-stale-note">La collecte du jour n'est pas encore arrivée.</span>
              )}
            </div>
            <div className="today-vs">
              <span className="today-vs-label">Moyenne des {todayName.toLowerCase()}s</span>
              <span className="today-vs-avg">{avgForDay.toFixed(1)} articles</span>
              <span className="today-vs-pct" style={{ color: isAbove ? '#2E554B' : '#A8433A' }}>
                {isAbove ? '▲' : '▼'} {Math.abs(pctDiff)}%
              </span>
            </div>
          </div>
        );
      })()}

      {/* ── Source donut + Bar breakdown side by side ── */}
      <div className="charts-row">
        <div className="chart-container chart-sm">
          <h3 className="chart-title">Répartition par source</h3>
          <div ref={sourceDonutRef} className="chart-viz" style={{ height: '380px' }} />
        </div>
        <div className="chart-container chart-sm">
          <div className="chart-header">
            <h3 className="chart-title">Dynamique des sources</h3>
            <div className="granularity-selector">
              {[['day', "Aujourd'hui"], ['week', '7 jours'], ['all', 'Tout']].map(([key, label]) => (
                <button
                  key={key}
                  className={`granularity-btn ${momentumRange === key ? 'active' : ''}`}
                  onClick={() => setMomentumRange(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="chart-note">
            {momentumRange === 'day'
              ? (() => {
                  const dowNames = ['dimanches', 'lundis', 'mardis', 'mercredis', 'jeudis', 'vendredis', 'samedis'];
                  const dow = dowNames[new Date().getDay()];
                  return `Articles publiés le dernier jour couvert, comparés à la moyenne des ${dow} de chaque source.`;
                })()
              : momentumRange === 'week'
              ? "Articles publiés sur les 7 derniers jours couverts, et évolution par rapport aux 7 jours précédents."
              : "Total des articles publiés par source depuis le début de la collecte."}
          </p>
          <div className="source-bars">
            {sourceMomentum.map(({ name, w1, w0, delta }) => {
              const max = sourceMomentum[0]?.w1 || 1;
              const cls = delta === null ? 'flat' : delta > 5 ? 'up' : delta < -5 ? 'down' : 'flat';
              const label = momentumRange === 'all' ? ''
                : delta === null ? 'nouveau'
                : `${delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : ''}${delta} %`;
              // The reference the % is computed against — same value driving
              // `delta` above, just also shown so "+40 %" is legible as
              // "12 vs 8.6", not a bare number nobody can double-check.
              const baseline = label && delta !== null
                ? (Number.isInteger(w0) ? w0 : w0.toFixed(1))
                : null;
              const baselineTitle = momentumRange === 'day'
                ? `Moyenne des mêmes jours de la semaine pour ${name}`
                : `${name} sur les 7 jours précédents`;
              const followed = isFollowed('source', name);
              return (
                <div key={name} className="source-bar-row">
                  <button
                    className={`follow-toggle ${followed ? 'active' : ''}`}
                    onClick={() => toggleFollow('source', name, name)}
                    title={followed ? `Ne plus suivre ${name}` : `Suivre ${name}`}
                    aria-label={followed ? `Ne plus suivre ${name}` : `Suivre ${name}`}
                    aria-pressed={followed}
                  >
                    <Star size={12} />
                  </button>
                  <button
                    className="source-bar-label"
                    onClick={() => onAskAssistant(`Quelles sont les dernières actualités de ${name} ?`)}
                    title={`Demander à l'assistant : dernières actualités de ${name}`}
                  >
                    {name}
                  </button>
                  <div className="source-bar-track">
                    <div
                      className="source-bar-fill"
                      style={{ width: `${(w1 / max) * 100}%`, background: stats.colors[name] || '#6B7A89' }}
                    />
                  </div>
                  <span className="source-bar-count">
                    {w1}
                    {baseline !== null && (
                      <span className="source-bar-baseline" title={baselineTitle}> ({baseline})</span>
                    )}
                  </span>
                  {label && <span className={`source-delta ${cls}`}>{label}</span>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Trend chart ─────────────────────────────── */}
      <div className="chart-container">
        <div className="chart-header">
          <h3 className="chart-title">Évolution de la publication</h3>
          <div className="chart-header-controls">
            <div className="granularity-selector">
              {[['30', '30 j'], ['90', '90 j'], ['180', '6 mois'], ['all', 'Tout']].map(([val, label]) => (
                <button
                  key={val}
                  className={`granularity-btn ${trendRange === val ? 'active' : ''}`}
                  onClick={() => setTrendRange(val)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="granularity-selector">
              <button
                className={`granularity-btn ${granularity === 'day' ? 'active' : ''}`}
                onClick={() => setGranularity('day')}
              >
                Journalier
              </button>
              <button
                className={`granularity-btn ${granularity === 'week' ? 'active' : ''}`}
                onClick={() => setGranularity('week')}
              >
                Hebdomadaire
              </button>
            </div>
          </div>
        </div>
        <div ref={trendChartRef} className="chart-viz" />
        {isNarrow && stats.trendTraces.length > 0 && (
          <div className="html-legend">
            {stats.trendTraces.map(t => (
              <span key={t.name} className="html-legend-item">
                <span className="html-legend-swatch" style={{ background: t.line.color }} />
                {t.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Custom React Treemap with Lucide ──────────────────────────── */}
      <div className="chart-container">
        <h3 className="chart-title">Répartition thématique (Top 12 + Autres)</h3>
        <CustomTreemap
          data={stats.topCatEntries} total={stats.total} categories={stats.categories}
          isFollowed={isFollowed} toggleFollow={toggleFollow} onAskAssistant={onAskAssistant}
        />
      </div>

      {/* ── Editorial profile per media ────────────── */}
      <div className="chart-container">
        <div className="chart-header">
          <h3 className="chart-title">Profil éditorial par média</h3>
          <div className="granularity-selector">
            {[['day', 'Aujourd\'hui'], ['week', '7 jours'], ['all', 'Tout']].map(([key, label]) => (
              <button
                key={key}
                className={`granularity-btn ${profileRange === key ? 'active' : ''}`}
                onClick={() => setProfileRange(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="chart-note">Part de chaque rubrique dans la production de chaque source. Les rubriques génériques (« À la une », « Actualités ») et les thèmes minoritaires sont regroupés dans « Autres / non classé ». Fenêtres ancrées sur le dernier article collecté.</p>
        {isNarrow && profileTraces.length > 0 && (
          <div className="html-legend">
            {profileTraces.map(t => (
              <span key={t.name} className="html-legend-item">
                <span className="html-legend-swatch" style={{ background: t.marker.color }} />
                {t.name}
              </span>
            ))}
          </div>
        )}
        <div ref={profileChartRef} className="chart-viz" style={{ height: `${profileHeight}px`, flex: 'none' }} />
      </div>

      {/* ── Top Keywords ──────────────────────────── */}
      <div className="charts-row">
        <div className="chart-container chart-sm">
          <div className="chart-header">
            <h3 className="chart-title">Mots-clés fréquents</h3>
            <div className="granularity-selector">
              {[['day', "Aujourd'hui"], ['week', '7 jours'], ['all', 'Tout']].map(([key, label]) => (
                <button
                  key={key}
                  className={`granularity-btn ${keywordsRange === key ? 'active' : ''}`}
                  onClick={() => setKeywordsRange(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="chart-note">
            {keywordsRange === 'day'
              ? "Les mots qui reviennent le plus dans les titres du dernier jour couvert (mots courants exclus)."
              : keywordsRange === 'week'
              ? "Les mots qui reviennent le plus dans les titres des 7 derniers jours couverts (mots courants exclus)."
              : "Les mots qui reviennent le plus dans les titres d'articles depuis le début de la collecte (mots courants exclus)."}
          </p>
          <div className="keywords-grid">
            {topKeywords.map(([word, count], i) => {
              const followed = isFollowed('keyword', word);
              return (
                <div key={word} className={`keyword-chip ${followed ? 'active' : ''}`}>
                  <button
                    className="follow-toggle"
                    onClick={() => toggleFollow('keyword', word, word)}
                    title={followed ? `Ne plus suivre "${word}"` : `Suivre "${word}"`}
                    aria-label={followed ? `Ne plus suivre "${word}"` : `Suivre "${word}"`}
                    aria-pressed={followed}
                  >
                    <Star size={11} />
                  </button>
                  <button
                    className="keyword-chip-main"
                    onClick={() => onAskAssistant(`Que disent les articles récents sur ${word} ?`)}
                    title={`Demander à l'assistant : ${word}`}
                  >
                    <span className="keyword-rank">#{i + 1}</span>
                    <span className="keyword-word">{word}</span>
                    <span className="keyword-count">{count}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="chart-container chart-sm">
          <h3 className="chart-title">Activité par jour de la semaine</h3>
          <p className="chart-note">
            Nombre moyen d'articles publiés pour chaque jour de la semaine,
            calculé sur toute la période couverte. Le pourcentage compare
            chaque jour à la moyenne générale : la presse publie surtout en
            semaine, beaucoup moins le week-end.
          </p>
          <div className="weekday-heatmap">
            {(() => {
              const avgCount = stats.dayOfWeekData.reduce((s, d) => s + d.count, 0) / 7;
              const maxCount = Math.max(...stats.dayOfWeekData.map(x => x.count));
              return stats.dayOfWeekData.map(d => {
                const intensity = maxCount > 0 ? d.count / maxCount : 0;
                const pctDiff = avgCount > 0 ? ((d.count - avgCount) / avgCount * 100).toFixed(0) : 0;
                const isAbove = Number(pctDiff) >= 0;
                return (
                  <div key={d.name} className="weekday-cell">
                    <span className="weekday-name">{d.name.slice(0, 3)}</span>
                    <div className="weekday-bar" style={{
                      height: `${Math.max(intensity * 100, 5)}%`,
                      background: `rgba(46, 85, 75, ${0.2 + intensity * 0.8})`
                    }} />
                    <span className="weekday-count">{d.count.toFixed(1)}</span>
                    <span className="weekday-pct" style={{ color: isAbove ? '#2E554B' : '#A8433A' }}>
                      {isAbove ? '▲' : '▼'} {Math.abs(pctDiff)}%
                    </span>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>

      {/* ── Trending topics time series ─────────── */}
      <div className="chart-container">
        <div className="chart-header">
          <h3 className="chart-title">Sujets tendance</h3>
          <div className="granularity-selector">
            {[['day', 'Quotidien'], ['week', 'Hebdomadaire'], ['month', 'Mensuel']].map(([key, label]) => (
              <button
                key={key}
                className={`granularity-btn ${trendTopicsGranularity === key ? 'active' : ''}`}
                onClick={() => setTrendTopicsGranularity(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="chart-note">
          Classement (1 = le plus mentionné) des mots les plus présents dans les titres,
          {trendTopicsGranularity === 'day' ? ' recalculé jour par jour sur les 30 derniers jours couverts.'
            : trendTopicsGranularity === 'week' ? ' recalculé semaine par semaine sur les 15 dernières semaines couvertes.'
            : ' recalculé mois par mois depuis le début de la collecte.'}
          {' '}Le top 10 est propre à chaque période : un mot peut y entrer ou en sortir — une case vide
          veut dire que le mot n'était simplement pas dans le top 10 ce jour-là. Plus une case est
          foncée, plus le classement était haut.
        </p>
        {trendTopicsSeries.series.length > 0 ? (
          <div className="trend-topics-list">
            <div className="trend-topic-row trend-topic-row-header">
              <span className="trend-heatmap-date">{trendTopicsSeries.buckets[0]}</span>
              <span className="trend-heatmap-date trend-heatmap-date-end">{trendTopicsSeries.buckets[trendTopicsSeries.buckets.length - 1]}</span>
            </div>
            {trendTopicsSeries.series.map((s) => {
              const followed = isFollowed('keyword', s.word);
              const currentRank = s.ranks[s.ranks.length - 1];
              return (
                <div key={s.word} className={`trend-topic-row ${followed ? 'active' : ''}`}>
                  <button
                    className="follow-toggle"
                    onClick={() => toggleFollow('keyword', s.word, s.word)}
                    title={followed ? `Ne plus suivre "${s.word}"` : `Suivre "${s.word}"`}
                    aria-label={followed ? `Ne plus suivre "${s.word}"` : `Suivre "${s.word}"`}
                    aria-pressed={followed}
                  >
                    <Star size={11} />
                  </button>
                  <button
                    className="trend-topic-name"
                    onClick={() => onAskAssistant(`Que disent les articles récents sur ${s.word} ?`)}
                    title={`Demander à l'assistant : ${s.word}`}
                  >
                    {s.word}
                  </button>
                  <TrendHeatmapStrip ranks={s.ranks} buckets={trendTopicsSeries.buckets} rankCap={RANK_CAP} />
                  <span className="trend-topic-total">{s.total} mention{s.total > 1 ? 's' : ''}</span>
                  <span className={`source-delta ${currentRank === null ? 'down' : currentRank <= 3 ? 'up' : 'flat'}`}>
                    {currentRank === null ? 'hors top 10' : `#${currentRank} actuellement`}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="chat-empty-sub">Pas assez de données sur cette période pour dégager des tendances.</p>
        )}
      </div>

      {/* ── Source Freshness ──────────────────── */}
      <div className="chart-container">
        <h3 className="chart-title">Dernière publication par source</h3>
        <p className="chart-note">
          Date du dernier article collecté pour chaque média. Un média sans
          publication récente peut être en pause ou poser un problème de
          collecte.
        </p>
        <div className="freshness-grid">
          {Object.entries(stats.sourceFreshness).sort((a, b) => b[1].localeCompare(a[1])).map(([src, lastDate]) => {
            const daysAgo = Math.floor((new Date() - new Date(lastDate)) / 86400000);
            const fresh = daysAgo <= 1 ? 'fresh' : daysAgo <= 7 ? 'recent' : 'stale';
            return (
              <div key={src} className={`freshness-card freshness-${fresh}`}>
                <span className="freshness-source">{src}</span>
                <span className="freshness-date">{lastDate}</span>
                <span className="freshness-badge">
                  {daysAgo === 0 ? "Aujourd'hui" : daysAgo === 1 ? 'Hier' : `Il y a ${daysAgo}j`}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
