import { useCallback, useMemo, useState } from 'react';
import { API_URL } from '../utils/api';

// Browse the legal codes: code → titre → chapitre → article
export function useCodes() {
  const [codesList, setCodesList] = useState(null); // [{code,label,count}] | null (not fetched yet)
  const [codeEntries, setCodeEntries] = useState({}); // {[code]: [{id,numero,type,contexte}]}
  const [activeCode, setActiveCode] = useState(null);
  const [activeArticle, setActiveArticle] = useState(null); // article | {id,loading:true} | null

  const loadList = useCallback(() => {
    setCodesList(list => {
      if (list !== null) return list;
      fetch(`${API_URL}/codes/browse`)
        .then(r => r.json())
        .then(body => setCodesList(body.codes || []))
        .catch(() => setCodesList([]));
      return list;
    });
  }, []);

  const openCode = useCallback((code) => {
    setActiveCode(code);
    setActiveArticle(null);
    if (!code) return;
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
    if (!id) { setActiveArticle(null); return; }
    setActiveArticle({ id, loading: true });
    fetch(`${API_URL}/codes/article/${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then(setActiveArticle)
      .catch(() => setActiveArticle(null));
  }, []);

  // The flat entry list grouped into Titre → Chapitre → [articles], from the " | "-joined context
  const codeTree = useMemo(() => {
    const entries = activeCode ? codeEntries[activeCode] : null;
    if (!entries) return null;
    const titres = new Map();
    for (const e of entries) {
      const parts = (e.contexte || '').split('|').map(s => s.trim()).filter(Boolean);
      const titre = parts[0] || 'Préambule';
      const key = parts[1] || '__direct__';
      if (!titres.has(titre)) titres.set(titre, new Map());
      const chapitres = titres.get(titre);
      if (!chapitres.has(key)) chapitres.set(key, { label: parts[1] || null, items: [] });
      chapitres.get(key).items.push(e);
    }
    return titres;
  }, [activeCode, codeEntries]);

  const codeLabel = (code) => codesList?.find(c => c.code === code)?.label || code || '';

  return { codesList, loadList, activeCode, openCode, activeArticle, openArticle, codeTree, codeLabel };
}
