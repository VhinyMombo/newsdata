import { useEffect, useState } from 'react';

// Hash routes (#/assistant, #/editions/semaine…): the back button and shared links work
// without any server-side rewrite, in dev, behind nginx and as an installed PWA alike.
const parse = () => {
  const [path, qs] = window.location.hash.replace(/^#\/?/, '').split('?');
  const [view, sub] = path.split('/');
  return { view: view || 'une', sub: sub || null, params: new URLSearchParams(qs || '') };
};

export const go = (path) => { window.location.hash = `/${path}`; };

export function useRoute() {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => {
      setRoute(prev => {
        const next = parse();
        if (next.view !== prev.view) window.scrollTo(0, 0);
        return next;
      });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
