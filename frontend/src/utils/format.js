// Display names for the scrapers' source identifiers
export const SOURCE_LABELS = {
  gabonreview: 'Gabonreview', gabonmediatime: 'Gabon Media Time', gabonactu: 'Gabonactu', lunion: "L'Union",
  depeches241: 'Dépêches 241', '7joursinfo': '7 Jours Info', ethiquemediagabon: 'Éthique Média',
  focusgroupemedia: 'Focus Groupe Média', gabonallsport: 'Gabon All Sport', gabonquotidien: 'Gabon Quotidien',
  directinfosgabon: 'Direct Infos Gabon', insidenews241: 'Inside News 241', kongossanews: 'Kongossa News',
};
export const sourceLabel = (s) => SOURCE_LABELS[s] || s;

export const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
// Publication time in the reader's own time zone. Sources give UTC or Libreville time
// with an offset; older entries carry none and are read as Libreville time (UTC+1).
export const clock = (ts) => {
  if (!/T\d\d:\d\d/.test(ts || '')) return '';
  const d = new Date(/(Z|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}+01:00`);
  if (Number.isNaN(d.getTime())) return ts.slice(11, 16).replace(':', ' h ');
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', ' h ');
};
