import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '../utils/api';

// Pings the API every 30 s. Also carries the server's Gabon-anchored "today", the only
// reliable source for it (a visitor's device clock and timezone can't be trusted).
export function useHealth() {
  const [apiStatus, setApiStatus] = useState('checking'); // 'checking' | 'online' | 'offline'
  const [gabonToday, setGabonToday] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);
  const [articles, setArticles] = useState(null);
  const [lastArticleDate, setLastArticleDate] = useState(null);

  const checkApi = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(4000) });
      setApiStatus(res.ok ? 'online' : 'offline');
      setLastChecked(new Date());
      if (res.ok) {
        const body = await res.json();
        if (body.gabon_today) setGabonToday(body.gabon_today);
        if (body.articles != null) setArticles(body.articles);
        if (body.last_article_date) setLastArticleDate(body.last_article_date);
      }
    } catch {
      // A long generation can hold the API past the timeout: only call it offline when
      // nothing is generating, otherwise keep the last known state
      setApiStatus(s => (document.body.dataset.generating === '1' ? s : 'offline'));
      setLastChecked(new Date());
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(checkApi, 0);
    const id = setInterval(checkApi, 30000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [checkApi]);

  return { apiStatus, setApiStatus, gabonToday, lastChecked, checkApi, articles, lastArticleDate };
}
