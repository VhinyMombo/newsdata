// A click on an article goes to the assistant first: it explains the article
// and its context, and cites it first with the link to the newspaper's site
export function explain(ask, a) {
  return (e) => {
    e.preventDefault();
    ask(`Que dit cet article et dans quel contexte s'inscrit-il : « ${a.title.slice(0, 300)} » ?`, 'presse',
      { url: a.url, title: a.title, source: a.source, date: (a.time || '').slice(0, 10) });
  };
}
