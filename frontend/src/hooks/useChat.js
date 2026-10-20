import { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, errorDetail, postJSON, readStream } from '../utils/api';
import { acquire, release } from '../utils/lock';

const CHAT_STORAGE_KEY = 'lekiosque_chat';
// Past turns sent to the LLM for follow-up understanding
const HISTORY_TURNS = 3;
const HISTORY_ANSWER_CHARS = 1200;

export function useChat({ setApiStatus }) {
  const [corpus, setCorpus] = useState('presse'); // 'presse' | 'codes'
  const [searching, setSearching] = useState(false);
  const [chatHistory, setChatHistory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]');
      // Drop turns interrupted mid-stream (no answer, no error)
      return Array.isArray(saved) ? saved.filter(c => c.answer || c.error) : [];
    } catch { return []; }
  }); // [{ question, answer, sources, error, fromCache }]
  const abortRef = useRef(null);

  // Live view for runSearch: its closure would otherwise read stale streamed content
  const chatRef = useRef(chatHistory);
  useEffect(() => { chatRef.current = chatHistory; }, [chatHistory]);

  useEffect(() => {
    if (searching) return;
    try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory.slice(-30))); }
    catch { /* storage full or unavailable: the chat just won't persist */ }
  }, [chatHistory, searching]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const runSearch = useCallback(async (userQ, existingIdx = null, corpusOverride = null) => {
    if (!acquire()) return;
    const c = corpusOverride || corpus;
    setSearching(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const priorTurns = chatRef.current.slice(0, existingIdx ?? chatRef.current.length).filter(t => t.answer && !t.error);
    const prevQuestion = priorTurns.length ? priorTurns[priorTurns.length - 1].question : '';

    const idx = existingIdx ?? chatRef.current.length;
    const fresh = { question: userQ, answer: '', sources: null, error: null };
    setChatHistory(prev => (existingIdx === null ? [...prev, fresh] : prev.map((t, i) => (i === idx ? fresh : t))));
    const patch = (p) => setChatHistory(prev => prev.map((t, i) => (i === idx ? { ...t, ...p } : t)));

    let answer = '';
    try {
      const res = await postJSON('/search', { question: userQ, n_results: 5, previous_question: prevQuestion, corpus: c }, controller.signal);
      if (!res.ok) throw new Error(await errorDetail(res));
      const json = await res.json();
      patch({ sources: json.results });

      const streamRes = await postJSON('/answer', {
        question: userQ,
        corpus: c,
        urls: c === 'codes' ? [] : json.results.map(r => r.url),
        ids: c === 'codes' ? json.results.map(r => r.id) : [],
        history: priorTurns.slice(-HISTORY_TURNS).map(t => ({ question: t.question, answer: t.answer.slice(0, HISTORY_ANSWER_CHARS) })),
      }, controller.signal);
      if (!streamRes.ok) throw new Error(`La génération a échoué (${streamRes.status}).`);
      // Same question and sources answered recently: served from cache, and said so
      const fromCache = streamRes.headers.get('X-Answer-Source') === 'cache';
      answer = await readStream(streamRes, (text) => { answer = text; patch({ answer: text, fromCache }); });
      setApiStatus('online');
    } catch (err) {
      if (err.name === 'AbortError') {
        patch(answer ? { answer } : { error: 'Recherche interrompue.' });
      } else if (err instanceof TypeError) {
        setApiStatus('offline');
        patch({ error: `Impossible de contacter l'API sur ${API_URL}. Vérifiez que le serveur est lancé (python api.py).` });
      } else {
        console.error(err);
        patch({ error: err.message });
      }
    } finally {
      release();
      setSearching(false);
      abortRef.current = null;
    }
  }, [corpus, setApiStatus]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setChatHistory([]);
    localStorage.removeItem(CHAT_STORAGE_KEY);
  }, []);

  // Switching corpus starts a fresh thread: mixed press and legal answers read ambiguously
  const switchCorpus = useCallback((next) => {
    if (next === corpus) return;
    setCorpus(next);
    if (chatRef.current.length > 0) {
      clear();
      // A question sent in the same tick must not see the previous thread as its context
      chatRef.current = [];
    }
  }, [corpus, clear]);

  return { corpus, switchCorpus, searching, chatHistory, runSearch, stop, clear };
}
