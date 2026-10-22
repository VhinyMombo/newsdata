import { useCallback, useMemo, useRef, useState } from 'react';

// data.json is the ~20 MB corpus export behind the map and the statistics. Loaded on
// demand only, so the front page and the assistant never wait for it.
export function useCorpusData() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);

  const load = useCallback(() => {
    if (started.current) return;
    started.current = true;
    setLoading(true);
    fetch('/data.json')
      .then(res => {
        if (!res.ok) throw new Error("data.json introuvable. Lancez d'abord export_embeddings.py.");
        return res.json();
      })
      .then(json => setData(json))
      .catch(err => { setError(err.message); started.current = false; })
      .finally(() => setLoading(false));
  }, []);

  const dateMax = useMemo(() => {
    const dates = data?.points?.map(p => p.date).filter(Boolean);
    return dates?.length ? dates.reduce((a, b) => (b > a ? b : a)) : null;
  }, [data]);

  return { data, error, loading, load, dateMax };
}
