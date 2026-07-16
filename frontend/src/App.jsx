import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Plotly from 'plotly.js-dist-min';
import {
  Newspaper, Search, ExternalLink, Loader, ChevronDown, Database, SlidersHorizontal, BarChart3, Map as MapIcon,
  Landmark, TrendingUp, Users, Scale, Trophy, MapPin, Palette, Leaf, Building2, Globe, HeartPulse, GraduationCap, Package,
  Square, RefreshCw, AlertTriangle, Trash2
} from 'lucide-react';
import './index.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
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

function CustomTreemap({ data, total, categories }) {
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
        const hOffset = 130 + (colorIdx * 17) % 70;
        const s = 65 + (colorIdx * 5) % 20;
        const l = 30 + (colorIdx * 4) % 20;
        const color = `hsl(${hOffset}, ${s}%, ${l}%)`;
        const pct = ((item.value / total) * 100).toFixed(1);

        const isActive = activeCategory === item.name;
        
        let breakdownNodes = null;
        if (isActive && categories && categories[item.name]) {
          const srcData = Object.entries(categories[item.name])
            .sort((a,b) => b[1] - a[1]);
          breakdownNodes = (
            <div className="custom-treemap-breakdown">
              <span className="breakdown-title">{item.name} par Source</span>
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
                {item.height > 35 && item.width > 50 && (
                  <div className="custom-treemap-text">
                    <span className="custom-treemap-name">{item.name}</span>
                    {item.height > 75 && (
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

  // Viz controls
  const [method, setMethod] = useState('UMAP');
  const [dim, setDim] = useState('3D');
  const [colorBy, setColorBy] = useState('cluster_name');
  const [showControls, setShowControls] = useState(false);
  // The semantic map is optional viewing — hideable for non-technical users
  const [showMap, setShowMap] = useState(() => localStorage.getItem('lekiosque_show_map') !== '0');
  const toggleMap = useCallback(() => setShowMap(v => {
    localStorage.setItem('lekiosque_show_map', v ? '0' : '1');
    return !v;
  }), []);

  // Chat state — restored from localStorage so the conversation survives reloads
  const [question, setQuestion] = useState('');
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

  const plotRef = useRef(null);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);

  // Ping the API so the user knows if the backend is up
  const checkApi = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(4000) });
      setApiStatus(res.ok ? 'online' : 'offline');
    } catch {
      setApiStatus('offline');
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

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        patch({ answer });
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
      setSearching(false);
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }, [chatHistory.length, corpus]);

  const handleSearch = useCallback((e) => {
    e?.preventDefault();
    if (!question.trim() || searching) return;
    const userQ = question.trim();
    setQuestion('');
    runSearch(userQ);
  }, [question, searching, runSearch]);

  const stopSearch = useCallback(() => abortRef.current?.abort(), []);

  // Map Data
  const latestSources = chatHistory.length > 0 ? chatHistory[chatHistory.length - 1].sources : null;
  const plotTraces = useMemo(() => {
    if (!data || !data.points) return [];
    const highlightUrls = new Set((latestSources || []).map(r => r.url));
    const groups = {};
    data.points.forEach(pt => {
      const coords = pt.projections[`${method}_${dim}`];
      if (!coords) return;
      const g = pt[colorBy] || 'Inconnu';
      if (!groups[g]) groups[g] = {
        name: g, x: [], y: [], z: [], text: [], customdata: [],
        hovertemplate: '%{text}<extra></extra>',
        mode: 'markers', type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: { size: dim === '2D' ? 8 : 5, opacity: highlightUrls.size > 0 ? 0.15 : 1, line: { width: 0 } }
      };
      groups[g].x.push(coords[0]);
      groups[g].y.push(coords[1]);
      if (dim === '3D') groups[g].z.push(coords[2]);
      groups[g].text.push(`<b>${pt.title}</b><br>${pt.date} — ${pt.source}`);
      groups[g].customdata.push(pt.url || '');
    });
    const traces = Object.values(groups);
    if (highlightUrls.size > 0) {
      const hx = [], hy = [], hz = [], ht = [], hd = [];
      data.points.forEach(pt => {
        if (!highlightUrls.has(pt.url)) return;
        const coords = pt.projections[`${method}_${dim}`];
        if (!coords) return;
        hx.push(coords[0]); hy.push(coords[1]);
        if (dim === '3D') hz.push(coords[2]);
        ht.push(`<b>📌 ${pt.title}</b>`);
        hd.push(pt.url || '');
      });
      traces.push({
        name: '📌 Vos Résultats', x: hx, y: hy, z: dim === '3D' ? hz : undefined,
        text: ht, customdata: hd, hovertemplate: '%{text}<extra></extra>', mode: 'markers',
        type: dim === '2D' ? 'scatter' : 'scatter3d',
        marker: { size: dim === '2D' ? 14 : 10, color: '#10b981', symbol: 'diamond' }
      });
    }
    return traces;
  }, [data, method, dim, colorBy, latestSources]);

  // Render Map
  useEffect(() => {
    if (activeView !== 'explore' || !showMap || !plotRef.current || plotTraces.length === 0) return;
    const is3D = dim === '3D';
    const axisStyle = { gridcolor: 'rgba(28,36,31,0.05)', color: '#6e7a72', showticklabels: false, title: '' };
    Plotly.react(plotRef.current, plotTraces, {
      colorway: [
        '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4',
        '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e'
      ],
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: '#6e7a72', family: 'Inter' }, showlegend: false,
      margin: { l: 0, r: 0, b: 0, t: 0 },
      ...(is3D ? { scene: { xaxis: axisStyle, yaxis: axisStyle, zaxis: axisStyle, bgcolor: 'transparent' } } : { xaxis: axisStyle, yaxis: axisStyle })
    }, { responsive: true, displayModeBar: false });
    plotRef.current.removeAllListeners?.('plotly_click');
    plotRef.current.on?.('plotly_click', (e) => {
      const url = e.points[0].customdata;
      if (url) window.open(url, '_blank');
    });
  }, [plotTraces, activeView, dim, showMap]);

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
        <div className="nav-left">
          <Newspaper className="nav-logo" size={20} />
          <span className="nav-title">Le Kiosque</span>
        </div>
        <div className="nav-menu">
          <button className={`nav-item ${activeView === 'explore' ? 'active' : ''}`} onClick={() => setActiveView('explore')}>
            <MapIcon size={16} /> Carte 2D/3D
          </button>
          <button className={`nav-item ${activeView === 'stats' ? 'active' : ''}`} onClick={() => setActiveView('stats')}>
            <BarChart3 size={16} /> Statistiques
          </button>
        </div>
        <div className="nav-date">
          {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </div>
      </nav>

      <main className="main-content">
        {activeView === 'explore' ? (
          <>
            <div className={`chat-panel ${showMap ? '' : 'full'}`}>
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
                </div>
                <div className="chat-header-actions">
                  {showMap && (
                    <button className="controls-toggle" onClick={() => setShowControls(v => !v)} title="Options de la carte">
                      <SlidersHorizontal size={14} />
                    </button>
                  )}
                  <button
                    className={`controls-toggle ${showMap ? 'active' : ''}`}
                    onClick={toggleMap}
                    title={showMap ? 'Masquer la carte' : 'Afficher la carte'}
                  >
                    <MapIcon size={14} />
                  </button>
                </div>
              </div>

              {showControls && (
                <div className="viz-controls">
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

              <div className="chat-messages">
                {chatHistory.length === 0 && !searching && (
                  <div className="chat-empty">
                    <div className="chat-empty-icon"><Search size={24} /></div>
                    <p className="chat-empty-title">Posez une question</p>
                    <p className="chat-empty-sub">L'assistant cherche dans les articles de presse gabonais et synthétise une réponse sourcée.</p>
                    <div className="chat-suggestions">
                      {SUGGESTIONS[corpus].map(s => (
                        <button key={s} className="suggestion-chip" onClick={() => runSearch(s)}>{s}</button>
                      ))}
                    </div>
                  </div>
                )}

                {chatHistory.length > 0 && (
                  <div className="chat-clear-row">
                    <button className="chat-clear-btn" onClick={clearChat} title="Effacer la conversation">
                      <Trash2 size={12} /> Nouvelle conversation
                    </button>
                  </div>
                )}

                {chatHistory.map((entry, idx) => (
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
                        <div className="msg-bubble">
                          <AnswerText text={entry.answer} streaming={idx === chatHistory.length - 1 && searching} />
                          {entry.sources && entry.sources.length > 0 && (
                            <div className="inline-sources">
                              <div className="sources-caption">📎 Sources</div>
                              {entry.sources.map((art, i) => (
                                <a key={i} href={art.url} target="_blank" rel="noreferrer" className="inline-source-link">
                                  [{i+1}] {art.title} <span className="inline-source-meta">· {art.source}{art.date ? `, ${art.date}` : ''}</span>
                                </a>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="chat-thinking">
                        <Loader size={14} className="spin" />
                        <span>{entry.sources ? 'Génération de la réponse...' : 'Recherche en cours...'}</span>
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
              <div className="corpus-switch">
                <button
                  className={`corpus-pill ${corpus === 'presse' ? 'active' : ''}`}
                  onClick={() => setCorpus('presse')}
                >📰 Presse</button>
                <button
                  className={`corpus-pill ${corpus === 'codes' ? 'active' : ''}`}
                  onClick={() => setCorpus('codes')}
                >⚖️ Codes de loi</button>
              </div>
              <form className="chat-input-bar" onSubmit={handleSearch}>
                <input
                  ref={inputRef}
                  className="chat-input"
                  placeholder="Posez une question..."
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  disabled={searching}
                  autoFocus
                />
                {searching ? (
                  <button type="button" className="chat-send-btn stop" onClick={stopSearch} title="Arrêter la génération">
                    <Square size={14} fill="currentColor" />
                  </button>
                ) : (
                  <button type="submit" className="chat-send-btn" disabled={!question.trim()}>
                    <Search size={18} />
                  </button>
                )}
              </form>
            </div>
            {showMap && (
              <div className="plot-panel">
                <div ref={plotRef} className="plot-container" />
              </div>
            )}
          </>
        ) : (
          <MetricsDashboard data={data} />
        )}
      </main>
    </div>
  );
}

function MetricsDashboard({ data }) {
  // Weekly press-review report, streamed from the API
  const [report, setReport] = useState(null); // null = hidden, '' = loading
  const [reportLoading, setReportLoading] = useState(false);

  const fetchReport = useCallback(async () => {
    setReportLoading(true);
    setReport('');
    try {
      const res = await fetch(`${API_URL}/weekly_report`);
      if (!res.ok) throw new Error(`Le serveur a renvoyé une erreur (${res.status}).`);
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
      setReportLoading(false);
    }
  }, []);
  const trendChartRef = useRef(null);
  const catChartRef = useRef(null);
  const sourceDonutRef = useRef(null);
  const [granularity, setGranularity] = useState('day'); // 'day' or 'week'

  const stats = useMemo(() => {
    if (!data || !data.points) return null;
    const sources = {};
    const timeSeries = {}; // keys will be days or mondays
    const categories = {}; // { cat: { source: count } }

    const normalizeCategory = (cat) => {
      if (!cat) return 'Autres';
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
      return cat.charAt(0).toUpperCase() + cat.slice(1);
    };

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
        const cat = normalizeCategory(pt.category);
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
        gabonmediatime:    '#2a78d6',
        gabonreview:       '#008300',
        lunion:            '#e87ba4',
        focusgroupemedia:  '#eda100',
        gabonactu:         '#1baf7a',
        directinfosgabon:  '#eb6834',
        '7joursinfo':      '#4a3aa7',
        insidenews241:     '#e34948',
        depeches241:       '#0f7ea8',
        gabonallsport:     '#9a6a1f',
        kongossanews:      '#b04ad1',
        gabonquotidien:    '#6b7f22',
        ethiquemediagabon: '#c2185b',
      };
      const OTHER_COLOR = '#64748b';
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
      const topCategory = Object.entries(categories)
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

      // Top keywords from titles (stopwords filtered)
      const stopwords = new Set(['le','la','les','de','des','du','un','une','au','aux','en','et','à','a','pour','par','sur','dans','son','sa','ses','ce','cette','il','que','qui','ou','est','sont','avec','pas','se','ne','d','l','n','s','c','j','qu','très','plus','on','nous','leur','leurs','été','être','fait','faire','mais','aussi','entre','tout','tous','après','comme','sans','lors','ils','elle','elles','nos','vos','ces','cet','cette','dont','quand','même','autre','autres','sous','vers','car','donc','ni','nouvelle','nouveau','dernier','dernière','premier','première','grand','grande','deux','trois','quatre','cinq','petit','bon','bien','gabonais','gabonaise','gabon']);
      const wordCounts = {};
      data.points.forEach(pt => {
        if (!pt.title) return;
        pt.title.toLowerCase().replace(/[^a-zàâéèêëïîôùûüÿçœæ\s-]/g, '').split(/\s+/).forEach(w => {
          if (w.length > 2 && !stopwords.has(w)) wordCounts[w] = (wordCounts[w] || 0) + 1;
        });
      });
      const topKeywords = Object.entries(wordCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

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
      // remaining sources aggregated into one "Autres" series
      const trendTraces = mainSources.map(src => ({
        name: src,
        x: sortedTimeKeys,
        y: sortedTimeKeys.map(k => timeSeries[k][src] || 0),
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
          x: sortedTimeKeys,
          y: sortedTimeKeys.map(k => tailSources.reduce((s, src) => s + (timeSeries[k][src] || 0), 0)),
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
        textinfo: 'label+percent',
        textposition: 'outside',
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
        topKeywords, recordDay, sourceFreshness,
        dayOfWeekData, topCatsAbsolute
      };
    } catch (err) {
      console.error('Error calculating metrics:', err);
      return null;
    }
  }, [data, granularity]);

  useEffect(() => {
    if (!trendChartRef.current || !stats || !stats.trendTraces.length) return;
    try {
      Plotly.react(trendChartRef.current, stats.trendTraces, {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        margin: { t: 20, r: 20, l: 50, b: 70 },
        hovermode: 'x',
        xaxis: {
          gridcolor: 'rgba(28,36,31,0.07)', zeroline: false,
          tickangle: -30,
          dtick: granularity === 'week' ? 7 * 86400000 : 14 * 86400000,
          tickfont: { size: 11 }
        },
        yaxis: {
          gridcolor: 'rgba(28,36,31,0.07)',
          title: granularity === 'week' ? 'Articles par semaine' : 'Articles par jour',
          zeroline: false,
          rangemode: 'tozero'
        },
        legend: { orientation: 'h', y: -0.22, x: 0.5, xanchor: 'center', font: { size: 11 } },
        font: { family: 'inherit', size: 12 }
      }, { responsive: true, displayModeBar: false });

      if (sourceDonutRef.current && stats.donutTrace) {
        Plotly.react(sourceDonutRef.current, [stats.donutTrace], {
          paper_bgcolor: 'transparent',
          margin: { t: 10, r: 10, l: 10, b: 10 },
          showlegend: false,
          font: { family: 'inherit', size: 12 },
          annotations: [{
            text: `<b>${stats.total.toLocaleString()}</b><br>articles`,
            showarrow: false, font: { size: 16, color: '#3a463f' }
          }]
        }, { responsive: true, displayModeBar: false });
      }
    } catch (err) {
      console.error('Plotly error:', err);
    }
  }, [stats, granularity]);

  if (!stats) return <div className="metrics-view"><p>Erreur lors du calcul des statistiques. Vérifiez la console.</p></div>;

  return (
    <div className="metrics-view">
      <div className="metrics-header">
        <div>
          <h2 className="metrics-title">Tableau de bord analytique</h2>
          <p className="metrics-subtitle">Vue d'ensemble de la couverture médiatique gabonaise</p>
        </div>
        <button className="weekly-report-btn" onClick={fetchReport} disabled={reportLoading}>
          {reportLoading ? <Loader size={14} className="spin" /> : <Newspaper size={14} />}
          {reportLoading ? 'Rédaction en cours…' : 'Rapport de la semaine'}
        </button>
      </div>

      {report !== null && (
        <div className="weekly-report-card">
          <div className="weekly-report-head">
            <h3>📋 Revue de presse de la semaine</h3>
            <div className="weekly-report-actions">
              {!reportLoading && report && (
                <a className="weekly-report-pdf" href={`${API_URL}/weekly_report/pdf`} target="_blank" rel="noreferrer">
                  ⬇ PDF
                </a>
              )}
              <button className="weekly-report-close" onClick={() => setReport(null)} title="Fermer">✕</button>
            </div>
          </div>
          {report === '' && reportLoading
            ? <div className="chat-thinking"><Loader size={14} className="spin" /><span>Lecture des titres de la semaine…</span></div>
            : <AnswerText text={report} streaming={reportLoading} />}
        </div>
      )}

      {/* ── KPI Row ────────────────────────────────── */}
      <div className="metrics-grid">
        <div className="stat-card stat-highlight">
          <span className="stat-label">📰 Total articles</span>
          <div className="stat-value">{stats.total.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">📅 Période couverte</span>
          <div className="stat-value stat-value-sm">{stats.dateMin}<br/>→ {stats.dateMax}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">📊 Moyenne / jour</span>
          <div className="stat-value">{stats.avgPerDay}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">🏷️ Catégories</span>
          <div className="stat-value">{stats.totalCategories}</div>
        </div>
        {stats.topSource && (
          <div className="stat-card">
            <span className="stat-label">🏆 Source #1</span>
            <div className="stat-value stat-value-sm">{stats.topSource[0]}</div>
            <span className="stat-detail">{stats.topSource[1].toLocaleString()} articles</span>
          </div>
        )}
        {stats.topCategory && (
          <div className="stat-card">
            <span className="stat-label">🔥 Thème #1</span>
            <div className="stat-value stat-value-sm">{stats.topCategory[0]}</div>
            <span className="stat-detail">{stats.topCategory[1].toLocaleString()} articles</span>
          </div>
        )}
        <div className="stat-card">
          <span className="stat-label">📆 Jour le + actif</span>
          <div className="stat-value stat-value-sm">{stats.busiestDay}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">🏆 Record du jour</span>
          <div className="stat-value">{stats.recordDay[1]}</div>
          <span className="stat-detail">{stats.recordDay[0]}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">📈 Cette semaine</span>
          <div className="stat-value">{stats.thisWeekCount}</div>
          <span className="stat-detail" style={{ color: Number(stats.weekTrend) >= 0 ? '#10b981' : '#ef4444' }}>
            {Number(stats.weekTrend) >= 0 ? '▲' : '▼'} {Math.abs(stats.weekTrend)}% vs semaine dern.
          </span>
        </div>
      </div>

      {/* ── Today vs average for this day of week ── */}
      {(() => {
        const dayNames = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
        const now = new Date();
        const todayIdx = now.getDay();
        const todayStr = now.toISOString().split('T')[0];
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

        return (
          <div className="today-comparison">
            <div className="today-main">
              <span className="today-label">📅 Aujourd'hui ({todayName})</span>
              <span className="today-count">{todayCount} <small>articles</small></span>
            </div>
            <div className="today-vs">
              <span className="today-vs-label">Moyenne des {todayName.toLowerCase()}s</span>
              <span className="today-vs-avg">{avgForDay.toFixed(1)} articles</span>
              <span className="today-vs-pct" style={{ color: isAbove ? '#10b981' : '#ef4444' }}>
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
          <div ref={sourceDonutRef} className="chart-viz" style={{ height: '240px' }} />
        </div>
        <div className="chart-container chart-sm">
          <h3 className="chart-title">Volume par source</h3>
          <div className="source-bars">
            {Object.entries(stats.sources).sort((a,b) => b[1] - a[1]).map(([src, count]) => (
              <div key={src} className="source-bar-row">
                <span className="source-bar-label">{src}</span>
                <div className="source-bar-track">
                  <div
                    className="source-bar-fill"
                    style={{
                      width: `${(count / stats.total) * 100}%`,
                      background: stats.colors[src] || '#64748b'
                    }}
                  />
                </div>
                <span className="source-bar-count">{count.toLocaleString()} ({((count / stats.total) * 100).toFixed(0)}%)</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Trend chart ─────────────────────────────── */}
      <div className="chart-container">
        <div className="chart-header">
          <h3 className="chart-title">Évolution de la publication</h3>
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
        <div ref={trendChartRef} className="chart-viz" />
      </div>

      {/* ── Custom React Treemap with Lucide ──────────────────────────── */}
      <div className="chart-container">
        <h3 className="chart-title">Répartition thématique (Top 12 + Autres)</h3>
        <CustomTreemap data={stats.topCatEntries} total={stats.total} categories={stats.categories} />
      </div>

      {/* ── Top Keywords ──────────────────────────── */}
      <div className="charts-row">
        <div className="chart-container chart-sm">
          <h3 className="chart-title">🔑 Mots-clés fréquents</h3>
          <div className="keywords-grid">
            {stats.topKeywords.map(([word, count], i) => (
              <div key={word} className="keyword-chip">
                <span className="keyword-rank">#{i + 1}</span>
                <span className="keyword-word">{word}</span>
                <span className="keyword-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="chart-container chart-sm">
          <h3 className="chart-title">📅 Activité par jour de semaine</h3>
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
                      background: `rgba(22, 111, 67, ${0.2 + intensity * 0.8})`
                    }} />
                    <span className="weekday-count">{d.count.toFixed(1)}</span>
                    <span className="weekday-pct" style={{ color: isAbove ? '#10b981' : '#ef4444' }}>
                      {isAbove ? '▲' : '▼'} {Math.abs(pctDiff)}%
                    </span>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      </div>

      {/* ── Source Freshness ──────────────────── */}
      <div className="chart-container">
        <h3 className="chart-title">⏰ Fraîcheur des sources</h3>
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
