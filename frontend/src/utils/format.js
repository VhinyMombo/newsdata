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
// Publication time as the source wrote it (no timezone shift: some feeds carry none)
export const clock = (ts) => (/T\d\d:\d\d/.test(ts || '') ? ts.slice(11, 16).replace(':', ' h ') : '');
