import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Plotly from 'plotly.js-dist-min';
import {
  Newspaper, Search, ExternalLink, Loader, ChevronDown, Database, SlidersHorizontal, BarChart3, Map as MapIcon,
  Landmark, TrendingUp, Users, Scale, Trophy, MapPin, Palette, Leaf, Building2, Globe, HeartPulse, GraduationCap, Package,
  Square, RefreshCw, AlertTriangle, Trash2, MessageSquare
} from 'lucide-react';
import './index.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

// Shared between the map layout and its HTML legend: Plotly assigns these
// colors to traces in order, so index i in both places means the same group
const PLOT_COLORWAY = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4',
  '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e',
];
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
  // Phones always start chat-only regardless of any desktop preference: a
  // "show map" choice made on a wide screen must never hand a phone a
  // full-viewport map with no visible way back (separate storage keys so
  // the two breakpoints don't contaminate each other)
  const phoneAtLoad = window.matchMedia('(max-width: 768px)').matches;
  const [showMap, setShowMap] = useState(() => {
    if (phoneAtLoad) return localStorage.getItem('lekiosque_show_map_phone') === '1';
    return localStorage.getItem('lekiosque_show_map_desktop') !== '0';
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

  const fetchReport = useCallback(async (kind = 'weekly') => {
    // Same single-flight lock as the chat: a report launched while an answer
    // streams would just queue behind it in Ollama and look frozen
    if (genLockRef.current) return;
    genLockRef.current = true;
    setReportKind(kind);
    setReportOpen(true);
    setReportLoading(true);
    setReport('');
    try {
      const res = await fetch(`${API_URL}/${kind === 'daily' ? 'daily_report' : 'weekly_report'}`);
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
      genLockRef.current = false;
      setReportLoading(false);
    }
  }, []);

  const plotRef = useRef(null);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const mapToggleRef = useRef(null);

  // Escape closes whichever overlay is open (map or report), and returns
  // focus to the control that opened it — without this, the map is a
  // keyboard trap on mobile, where it's a full-screen sheet with no other
  // dismissal in reach
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if (showMap) { closeMap(); mapToggleRef.current?.focus(); }
      else if (reportOpen) { setReportOpen(false); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showMap, reportOpen, closeMap]);

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
    const traces = Object.values(groups);
    if (highlightUrls.size > 0) {
      const hx = [], hy = [], hz = [], ht = [], hd = [];
      data.points.forEach(pt => {
        if (!highlightUrls.has(pt.url)) return;
        const coords = pt.projections[`${method}_${dim}`];
        if (!coords) return;
        hx.push(coords[0]); hy.push(coords[1]);
        if (dim === '3D') hz.push(coords[2]);
        ht.push(`<b>📌 ${wrapTitle(pt.title)}</b>`);
        hd.push({ url: pt.url || '', title: pt.title, date: pt.date, source: pt.source });
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
      font: { color: '#6e7a72', family: 'Inter' }, showlegend: false,
      margin: { l: 0, r: 0, b: 0, t: 0 },
      // Wrapped titles (wrapTitle) already stay narrow; this just keeps the
      // label styled and left-aligned so multi-line text reads cleanly
      hoverlabel: { bgcolor: '#fffdf8', bordercolor: '#a7c6b4', align: 'left', font: { size: 11.5 } },
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
  const NEUTRAL_MARKER = '#d7d2c4';
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
      if (t.name === '📌 Vos Résultats') return '#10b981';
      const base = PLOT_COLORWAY[i % PLOT_COLORWAY.length];
      return !highlightedGroup || t.name === highlightedGroup ? base : NEUTRAL_MARKER;
    });
    const opacities = plotTraces.map(t => {
      if (t.name === '📌 Vos Résultats') return 1;
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
  const sidePanelOpen = showMap || reportOpen;
  const mapVisible = showMap && !reportOpen;
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
  };
  const corpusSwitch = (
    <div className="corpus-switch">
      <button
        className={`corpus-pill ${corpus === 'presse' ? 'active' : ''}`}
        onClick={() => switchCorpus('presse')}
        title="Interroger les articles de la presse gabonaise en ligne"
      >📰 Presse</button>
      <button
        className={`corpus-pill ${corpus === 'codes' ? 'active' : ''}`}
        onClick={() => switchCorpus('codes')}
        title="Interroger les codes de loi gabonais (Journal Officiel)"
      >⚖️ Codes de loi</button>
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
          <Newspaper className="nav-logo" size={20} />
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
      </nav>

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
                      (plot-panel-settings), right where its effect appears */}
                  <button
                    ref={mapToggleRef}
                    className={`controls-toggle ${showMap ? 'active' : ''}`}
                    onClick={toggleMap}
                    title={showMap ? 'Masquer la carte' : 'Afficher la carte'}
                    aria-label={showMap ? 'Masquer la carte' : 'Afficher la carte'}
                  >
                    <MapIcon size={14} />
                  </button>
                </div>
              </div>

              <div className="report-buttons chat-report-row">
                <button className="weekly-report-btn" onClick={() => fetchReport('daily')} disabled={reportLoading || searching}>
                  {reportLoading && reportKind === 'daily' ? <Loader size={14} className="spin" /> : <Newspaper size={14} />}
                  {reportLoading && reportKind === 'daily' ? 'Rédaction en cours…' : 'Rapport du jour'}
                </button>
                <button className="weekly-report-btn" onClick={() => fetchReport('weekly')} disabled={reportLoading || searching}>
                  {reportLoading && reportKind === 'weekly' ? <Loader size={14} className="spin" /> : <Newspaper size={14} />}
                  {reportLoading && reportKind === 'weekly' ? 'Rédaction en cours…' : 'Rapport de la semaine'}
                </button>
              </div>

              {/* role="log": the standard landmark for a chat transcript,
                  giving screen-reader users a way to jump straight to it
                  rather than tabbing through the whole page */}
              <div className="chat-messages" role="log" aria-label="Conversation">
                {chatIsEmpty && (
                  <div className="chat-empty">
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
                            <span className="msg-writing-tag">✍️ L'assistant rédige…</span>
                          )}
                          <AnswerText text={entry.answer} streaming={idx === chatHistory.length - 1 && searching} />
                          {/* Sources appear once the answer is complete: shown
                              during streaming, they pin the auto-scroll on
                              themselves and the text writes itself off-screen */}
                          {entry.sources && entry.sources.length > 0 && !(idx === chatHistory.length - 1 && searching) && (
                            <div className="inline-sources">
                              <h3 className="sources-caption">📎 Sources</h3>
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
              {!chatIsEmpty && corpusSwitch}
              {!chatIsEmpty && inputBar}
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
              <div className={`report-panel ${reportOpen ? '' : 'hidden'}`} aria-hidden={!reportOpen} inert={!reportOpen}>
              {report !== null && (
                <div className="report-panel-scroll">
                  <div className="weekly-report-card">
                    <div className="weekly-report-head">
                      <h3>{reportKind === 'daily' ? "📋 Le point d'actualité du jour" : '📋 Revue de presse de la semaine'}</h3>
                      <div className="weekly-report-actions">
                        {!reportLoading && report && (
                          <a className="weekly-report-pdf" href={`${API_URL}/${reportKind === 'daily' ? 'daily_report' : 'weekly_report'}/pdf`} target="_blank" rel="noreferrer">
                            ⬇ PDF
                          </a>
                        )}
                        <button className="weekly-report-close" onClick={() => setReportOpen(false)} title="Fermer" aria-label="Fermer le rapport">✕</button>
                      </div>
                    </div>
                    {report === '' && reportLoading
                      ? <div className="chat-thinking" role="status" aria-live="polite"><Loader size={14} className="spin" /><span>{reportKind === 'daily' ? 'Lecture des titres du jour…' : 'Lecture des titres de la semaine…'}</span></div>
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
                    fixed: t.name === '📌 Vos Résultats',
                  }))
                  .filter(e => !e.fixed)
                  .sort((a, b) => b.n - a.n);
                if (!entries.length) return null;
                // Capping to 8 makes sense for cluster_name (100+ semantic
                // groups) but "Rubriques" (~9) and "Journal" (13 sources)
                // are small closed lists — every one of them is a real,
                // individually meaningful entry, so show them all
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
          </>
        ) : (
          <MetricsDashboard data={data} />
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

const TITLE_STOPWORDS = new Set(['le','la','les','de','des','du','un','une','au','aux','en','et','à','a','pour','par','sur','dans','son','sa','ses','ce','cette','il','que','qui','ou','est','sont','avec','pas','se','ne','d','l','n','s','c','j','qu','très','plus','on','nous','leur','leurs','été','être','fait','faire','mais','aussi','entre','tout','tous','après','comme','sans','lors','ils','elle','elles','nos','vos','ces','cet','dont','quand','même','autre','autres','sous','vers','car','donc','ni','nouvelle','nouveau','dernier','dernière','premier','première','grand','grande','deux','trois','quatre','cinq','petit','bon','bien','gabonais','gabonaise','gabon']);

// Editorial profile — fixed entity→color map (8 validated categorical hues,
// adjacent-pair CVD-checked on the white panel); every other rubrique folds
// into a neutral "Autres" so colors never depend on the data.
const PROFILE_COLORS = {
  'Politique': '#2a78d6',
  'Société': '#008300',
  'Économie': '#e87ba4',
  'Sport': '#eda100',
  'Faits Divers / Justice': '#1baf7a',
  'Culture': '#eb6834',
  'Provinces': '#4a3aa7',
  'Environnement': '#e34948',
};
const PROFILE_OTHER = 'Autres / non classé';
const PROFILE_OTHER_COLOR = '#64748b';

function MetricsDashboard({ data }) {
  const trendChartRef = useRef(null);
  const catChartRef = useRef(null);
  const sourceDonutRef = useRef(null);
  const profileChartRef = useRef(null);
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

    const lightHues = new Set(['#e87ba4', '#eda100', '#1baf7a']);
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
        textfont: { size: 10, color: lightHues.has(color) ? '#1c241f' : '#ffffff' },
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
      pt.title.toLowerCase().replace(/[^a-zàâéèêëïîôùûüÿçœæ\s-]/g, '').split(/\s+/).forEach(w => {
        if (w.length > 2 && !TITLE_STOPWORDS.has(w)) wordCounts[w] = (wordCounts[w] || 0) + 1;
      });
    });
    return Object.entries(wordCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [data, keywordsRange]);

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
          gridcolor: 'rgba(28,36,31,0.07)', zeroline: false, tickfont: { size: 11 }
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
          gridcolor: 'rgba(28,36,31,0.07)', zeroline: false,
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
          gridcolor: 'rgba(28,36,31,0.07)',
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
            showarrow: false, font: { size: mobile ? 15 : 18, color: '#3a463f' }
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

      {/* ── KPI Row ────────────────────────────────── */}
      <div className="metrics-grid">
        <div className="stat-card stat-highlight">
          <span className="stat-label">📰 Articles collectés</span>
          <div className="stat-value">{stats.total.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">📅 Période couverte</span>
          <div className="stat-value stat-value-sm">{stats.dateMin}<br/>→ {stats.dateMax}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">📊 Articles par jour en moyenne</span>
          <div className="stat-value">{stats.avgPerDay}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">🏷️ Rubriques recensées</span>
          <div className="stat-value">{stats.totalCategories}</div>
        </div>
        {stats.topSource && (
          <div className="stat-card">
            <span className="stat-label">🏆 Média le plus prolifique</span>
            <div className="stat-value stat-value-sm">{stats.topSource[0]}</div>
            <span className="stat-detail">{stats.topSource[1].toLocaleString()} articles</span>
          </div>
        )}
        {stats.topCategory && (
          <div className="stat-card">
            <span className="stat-label">🔥 Thème le plus couvert</span>
            <div className="stat-value stat-value-sm">{stats.topCategory[0]}</div>
            <span className="stat-detail">{stats.topCategory[1].toLocaleString()} articles</span>
          </div>
        )}
        <div className="stat-card">
          <span className="stat-label">📆 Jour de la semaine le plus actif</span>
          <div className="stat-value stat-value-sm">{stats.busiestDay}</div>
        </div>
        <div className="stat-card">
          <span className="stat-label">🏆 Record d'articles en une journée</span>
          <div className="stat-value">{stats.recordDay[1]}</div>
          <span className="stat-detail">le {stats.recordDay[0]}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">📈 Articles ces 7 derniers jours</span>
          <div className="stat-value">{stats.thisWeekCount}</div>
          <span className="stat-detail" style={{ color: Number(stats.weekTrend) >= 0 ? '#0c7a52' : '#c43d3d' }}>
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
              <span className="stat-label">⚠️ Sources silencieuses (+ de 7 jours)</span>
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

        return (
          <div className="today-comparison">
            <div className="today-main">
              <span className="today-label">📅 Publiés aujourd'hui ({todayName.toLowerCase()})</span>
              <span className="today-count">{todayCount} <small>articles</small></span>
            </div>
            <div className="today-vs">
              <span className="today-vs-label">Moyenne des {todayName.toLowerCase()}s</span>
              <span className="today-vs-avg">{avgForDay.toFixed(1)} articles</span>
              <span className="today-vs-pct" style={{ color: isAbove ? '#0c7a52' : '#c43d3d' }}>
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
            {sourceMomentum.map(({ name, w1, delta }) => {
              const max = sourceMomentum[0]?.w1 || 1;
              const cls = delta === null ? 'flat' : delta > 5 ? 'up' : delta < -5 ? 'down' : 'flat';
              const label = momentumRange === 'all' ? ''
                : delta === null ? 'nouveau'
                : `${delta > 0 ? '▲ +' : delta < 0 ? '▼ ' : ''}${delta} %`;
              return (
                <div key={name} className="source-bar-row">
                  <span className="source-bar-label">{name}</span>
                  <div className="source-bar-track">
                    <div
                      className="source-bar-fill"
                      style={{ width: `${(w1 / max) * 100}%`, background: stats.colors[name] || '#64748b' }}
                    />
                  </div>
                  <span className="source-bar-count">{w1}</span>
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
        <CustomTreemap data={stats.topCatEntries} total={stats.total} categories={stats.categories} />
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
            <h3 className="chart-title">🔑 Mots-clés fréquents</h3>
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
            {topKeywords.map(([word, count], i) => (
              <div key={word} className="keyword-chip">
                <span className="keyword-rank">#{i + 1}</span>
                <span className="keyword-word">{word}</span>
                <span className="keyword-count">{count}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="chart-container chart-sm">
          <h3 className="chart-title">📅 Activité par jour de la semaine</h3>
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
                      background: `rgba(22, 111, 67, ${0.2 + intensity * 0.8})`
                    }} />
                    <span className="weekday-count">{d.count.toFixed(1)}</span>
                    <span className="weekday-pct" style={{ color: isAbove ? '#0c7a52' : '#c43d3d' }}>
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
        <h3 className="chart-title">⏰ Dernière publication par source</h3>
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
