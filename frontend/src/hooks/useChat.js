import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '../utils/track';
import { API_URL, errorDetail, postJSON, readStream } from '../utils/api';
import { acquire, isBusy, release } from '../utils/lock';

const CHAT_STORAGE_KEY = 'lekiosque_chat';
const THREAD_STORAGE_KEY = 'lekiosque_thread';
const CORPUS_STORAGE_KEY = 'lekiosque_corpus';
// Past turns sent to the LLM for follow-up understanding
const HISTORY_TURNS = 3;
const HISTORY_ANSWER_CHARS = 1200;

const newThreadId = () => `t${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
// What a saved conversation keeps of each cited article: long passages stay on the server
const slimSource = (s) => Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== 'string' || v.length <= 600));
const savedTurns = (history) => history
  .filter(t => t.answer && !t.error)
  .map(t => ({ question: t.question, answer: t.answer, sources: (t.sources || []).slice(0, 10).map(slimSource) }));

export function useChat({ setApiStatus, authToken }) {
  // Kept with the conversation, so a relaunched app goes on in the same corpus
  const [corpus, setCorpus] = useState(() => {
    try { return localStorage.getItem(CORPUS_STORAGE_KEY) === 'codes' ? 'codes' : 'presse'; } catch { return 'presse'; }
  }); // 'presse' | 'codes'
  const [searching, setSearching] = useState(false);
  const [chatHistory, setChatHistory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]');
      // Drop turns interrupted mid-stream (no answer, no error)
      return Array.isArray(saved) ? saved.filter(c => c.answer || c.error) : [];
    } catch { return []; }
  }); // [{ question, answer, sources, error, fromCache }]
  const abortRef = useRef(null);
  // Each conversation has an id: for a signed-in reader it is saved under it, and can be reopened
  const [threadId, setThreadId] = useState(() => {
    try { return localStorage.getItem(THREAD_STORAGE_KEY) || newThreadId(); } catch { return newThreadId(); }
  });
  const savedRef = useRef('');

  // Live view for runSearch: its closure would otherwise read stale streamed content
  const chatRef = useRef(chatHistory);
  useEffect(() => { chatRef.current = chatHistory; }, [chatHistory]);

  useEffect(() => {
    if (searching) return;
    try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory.slice(-30))); }
    catch { /* storage full or unavailable: the chat just won't persist */ }
  }, [chatHistory, searching]);

  useEffect(() => {
    try { localStorage.setItem(THREAD_STORAGE_KEY, threadId); } catch { /* storage unavailable */ }
  }, [threadId]);

  useEffect(() => {
    try { localStorage.setItem(CORPUS_STORAGE_KEY, corpus); } catch { /* storage unavailable */ }
  }, [corpus]);

  // Signed in: once an answer is complete, the conversation is saved to the account
  useEffect(() => {
    if (searching || !authToken) return;
    const turns = savedTurns(chatHistory);
    if (!turns.length) return;
    const body = JSON.stringify({ corpus, turns });
    if (body === savedRef.current) return;
    savedRef.current = body;
    fetch(`${API_URL}/conversations/${threadId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` }, body,
    }).catch(() => { savedRef.current = ''; });
  }, [chatHistory, searching, authToken, threadId, corpus]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // pinned: an article the reader clicked; it leads the sources whatever the search finds.
  // newThread: start a conversation of its own (each clicked article), so an earlier
  // article is neither shown above nor sent to the model as context.
  const runSearch = useCallback(async (userQ, existingIdx = null, corpusOverride = null, pinned = null, newThread = false) => {
    if (newThread && abortRef.current) {
      abortRef.current.abort();
      for (let i = 0; i < 40 && isBusy(); i++) await new Promise(r => setTimeout(r, 50));
    }
    if (!acquire()) return;
    if (newThread) { chatRef.current = []; setThreadId(newThreadId()); }
    const c = corpusOverride || corpus;
    track('question', { rubrique: c === 'codes' ? 'lois' : 'actualite', origine: pinned ? 'article' : existingIdx !== null ? 'relance' : 'saisie' });
    if (existingIdx !== null) pinned = pinned || chatRef.current[existingIdx]?.pinned || null;
    setSearching(true);
    const controller = new AbortController();
    abortRef.current = controller;

    const priorTurns = chatRef.current.slice(0, existingIdx ?? chatRef.current.length).filter(t => t.answer && !t.error);
    const prevQuestion = priorTurns.length ? priorTurns[priorTurns.length - 1].question : '';

    const idx = existingIdx ?? chatRef.current.length;
    // id: a new key per turn, so a new thread's first answer is animated afresh
    const fresh = { id: Date.now(), question: userQ, answer: '', sources: null, error: null, pinned };
    setChatHistory(prev => (newThread ? [fresh] : existingIdx === null ? [...prev, fresh] : prev.map((t, i) => (i === idx ? fresh : t))));
    const patch = (p) => setChatHistory(prev => prev.map((t, i) => (i === idx ? { ...t, ...p } : t)));

    let answer = '';
    try {
      const res = await postJSON('/search', { question: userQ, n_results: 5, previous_question: prevQuestion, corpus: c }, controller.signal);
      if (!res.ok) throw new Error(await errorDetail(res));
      const json = await res.json();
      const sources = pinned
        ? [pinned, ...json.results.filter(r => r.url !== pinned.url)].slice(0, 5)
        : json.results;
      patch({ sources });

      const streamRes = await postJSON('/answer', {
        question: userQ,
        corpus: c,
        urls: c === 'codes' ? [] : sources.map(r => r.url),
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
    setThreadId(newThreadId());
    localStorage.removeItem(CHAT_STORAGE_KEY);
  }, []);

  // Reopen a saved conversation where it was left; a question asked next continues it
  const openConversation = useCallback(async (id) => {
    // Opening generates nothing: only a chat answer still streaming stands in the way
    if (!authToken || abortRef.current) return false;
    const res = await fetch(`${API_URL}/conversations/${id}`, { headers: { Authorization: `Bearer ${authToken}` } }).catch(() => null);
    if (!res?.ok) return false;
    const conv = await res.json();
    const turns = conv.turns.map((t, i) => ({ id: `${id}-${i}`, question: t.question, answer: t.answer, sources: t.sources, error: null }));
    savedRef.current = JSON.stringify({ corpus: conv.corpus, turns: savedTurns(turns) });
    setCorpus(conv.corpus);
    setThreadId(conv.id);
    chatRef.current = turns;
    setChatHistory(turns);
    return true;
  }, [authToken]);

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

  return { corpus, switchCorpus, searching, chatHistory, runSearch, stop, clear, threadId, openConversation };
}
