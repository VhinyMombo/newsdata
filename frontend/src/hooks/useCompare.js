import { useCallback, useRef, useState } from 'react';
import { track } from '../utils/track';
import { errorDetail, postJSON, readStream } from '../utils/api';
import { acquire, release } from '../utils/lock';

// A backstop, not the main fix: a normal answer on this local model takes 1 to 3 minutes
const COMPARE_TIMEOUT_MS = 4 * 60 * 1000;
const isoDate = (d) => d.toISOString().slice(0, 10);

// Same topic, two periods, two independent search + answer runs. Press only, and kept out
// of the chat history: a comparison is not a turn a follow-up question can continue from.
export function useCompare({ gabonToday }) {
  const [preset, setPreset] = useState('week'); // 'week' | 'month' | 'custom'
  const [custom, setCustom] = useState({ aStart: '', aEnd: '', bStart: '', bEnd: '' });
  const [result, setResult] = useState(null); // { topic, columns[] }
  const [comparing, setComparing] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Stop and Compare share one spot on screen: a short pause keeps a double click from restarting
  const [cooldown, setCooldown] = useState(false);
  const abortRef = useRef(null);
  const stopRef = useRef(false); // user stop vs timeout, both surface as AbortError
  const runIdRef = useRef(0); // a superseded run must not patch the newer one's columns

  const periods = useCallback((p) => {
    const today = gabonToday ? new Date(gabonToday) : new Date();
    if (p === 'week') {
      const aStart = new Date(today); aStart.setDate(aStart.getDate() - 6);
      const bEnd = new Date(aStart); bEnd.setDate(bEnd.getDate() - 1);
      const bStart = new Date(bEnd); bStart.setDate(bStart.getDate() - 6);
      return [
        { label: 'Cette semaine', start: isoDate(aStart), end: isoDate(today) },
        { label: 'La semaine dernière', start: isoDate(bStart), end: isoDate(bEnd) },
      ];
    }
    if (p === 'month') {
      const aStart = new Date(today.getFullYear(), today.getMonth(), 1);
      const bEnd = new Date(aStart); bEnd.setDate(bEnd.getDate() - 1);
      const bStart = new Date(bEnd.getFullYear(), bEnd.getMonth(), 1);
      return [
        { label: 'Ce mois-ci', start: isoDate(aStart), end: isoDate(today) },
        { label: 'Le mois dernier', start: isoDate(bStart), end: isoDate(bEnd) },
      ];
    }
    return [
      { label: `${custom.aStart} → ${custom.aEnd}`, start: custom.aStart, end: custom.aEnd },
      { label: `${custom.bStart} → ${custom.bEnd}`, start: custom.bStart, end: custom.bEnd },
    ];
  }, [gabonToday, custom]);

  const runSide = useCallback(async (idx, topic, period, runId) => {
    const patchCol = (upd) => {
      if (runIdRef.current !== runId) return;
      setResult(prev => prev && { ...prev, columns: prev.columns.map((c, i) => (i === idx ? { ...c, ...upd } : c)) });
    };
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), COMPARE_TIMEOUT_MS);
    patchCol({ queued: false, loading: true });
    try {
      const res = await postJSON('/search', { question: topic, n_results: 5, corpus: 'presse', period_start: period.start, period_end: period.end }, controller.signal);
      if (!res.ok) throw new Error(await errorDetail(res));
      const json = await res.json();
      patchCol({ sources: json.results });
      if (json.results.length === 0) { patchCol({ loading: false, empty: true }); return; }
      const streamRes = await postJSON('/answer', { question: topic, corpus: 'presse', urls: json.results.map(r => r.url), ids: [], history: [] }, controller.signal);
      if (!streamRes.ok) throw new Error(`La génération a échoué (${streamRes.status}).`);
      const fromCache = streamRes.headers.get('X-Answer-Source') === 'cache';
      await readStream(streamRes, (answer) => patchCol({ answer, loading: true }));
      patchCol({ loading: false, fromCache });
    } catch (err) {
      if (err.name === 'AbortError') patchCol(stopRef.current ? { loading: false, stopped: true } : { loading: false, timedOut: true });
      else patchCol({ error: err.message, loading: false });
    } finally {
      clearTimeout(timeoutId);
    }
  }, []);

  const finish = useCallback(() => {
    release();
    setComparing(false);
    setCooldown(true);
    setTimeout(() => setCooldown(false), 700);
  }, []);

  // Columns run one after the other: Ollama serialises generations, so running them at
  // once would only queue the second silently. Sequential shows an honest 1/2 then 2/2.
  const run = useCallback(async (rawTopic) => {
    const topic = rawTopic.trim();
    if (!topic || comparing) return false;
    const ps = periods(preset);
    if (ps.some(p => !p.start || !p.end)) return false;
    if (!acquire()) return false;
    track('comparaison', { periode: preset });
    const runId = ++runIdRef.current;
    stopRef.current = false;
    setStopping(false);
    setComparing(true);
    setResult({
      topic,
      columns: ps.map((p, i) => ({
        label: p.label, start: p.start, end: p.end, answer: '', sources: null, error: null,
        loading: i === 0, queued: i > 0, empty: false, timedOut: false, stopped: false,
      })),
    });
    for (let i = 0; i < ps.length; i++) {
      if (runIdRef.current !== runId || stopRef.current) break;
      await runSide(i, topic, ps[i], runId);
    }
    if (runIdRef.current === runId) {
      if (stopRef.current) {
        setResult(prev => prev && { ...prev, columns: prev.columns.map(c => (c.queued ? { ...c, queued: false, loading: false, stopped: true } : c)) });
      }
      finish();
    }
    return true;
  }, [comparing, periods, preset, runSide, finish]);

  const stop = useCallback(() => {
    setStopping(true);
    stopRef.current = true;
    abortRef.current?.abort();
  }, []);

  const retryColumn = useCallback(async (idx) => {
    if (!result || comparing || !acquire()) return;
    const { start, end } = result.columns[idx];
    stopRef.current = false;
    setStopping(false);
    setComparing(true);
    setResult(prev => ({
      ...prev,
      columns: prev.columns.map((c, i) => (i === idx
        ? { ...c, loading: true, queued: false, error: null, empty: false, timedOut: false, stopped: false, answer: '', sources: null }
        : c)),
    }));
    await runSide(idx, result.topic, { start, end }, runIdRef.current);
    finish();
  }, [result, comparing, runSide, finish]);

  const reset = useCallback(() => setResult(null), []);

  return { preset, setPreset, custom, setCustom, result, comparing, stopping, cooldown, run, stop, retryColumn, reset };
}
