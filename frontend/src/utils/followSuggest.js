import { TITLE_STOPWORDS } from './categories';

// "Suivre" under an answer: the names worth following, taken from the cited
// articles' titles, so that a followed name is one the titles really use, which is
// what the front page and the notifications look for (in the lowercased title).
// Names the question itself asks about come first, then the ones most titles share.

const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[-'’]/g, ' ').replace(/\s+/g, ' ').trim();

// Capitalised words (« Diba-Diba », « Lac Bleu ») and acronyms (« SEEG »)
const NAME_WORD = /^(\p{Lu}[\p{Ll}'’]*(-\p{Lu}[\p{Ll}'’]*)*|\p{Lu}{2,})$/u;
const ELISION = /\b(jusqu|lorsqu|puisqu|quelqu|qu|l|d|j|m|n|s|t|c)['’]/giu;

// Runs of name words, never across punctuation: « Diba-Diba, Okala » is two names.
// The title's first word is capitalised anyway: kept only if the next one is too, or
// if it stands alone before the colon (« Mbanié : … », « Foncier : … »).
function titleNames(title) {
  const names = [];
  (title || '').replace(ELISION, ' ').split(/[,;:.!?«»()"“”…–—|/]+/).forEach((segment, si) => {
    const words = segment.match(/[\p{L}][\p{L}'’-]*/gu) || [];
    let run = [];
    const flush = () => {
      if (run.length) names.push(run.join(' '));
      run = [];
    };
    words.forEach((w, wi) => {
      const lower = w.toLowerCase();
      const isName = NAME_WORD.test(w) && lower.length > 2 && !TITLE_STOPWORDS.has(lower);
      if (!isName) { flush(); return; }
      run.push(lower);
      if (si === 0 && wi === 0 && words.length > 1 && !NAME_WORD.test(words[1])) run = [];
    });
    flush();
  });
  return names;
}

const label = (name) => name.replace(/(^|[\s-])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());

export function followSuggestions(question, sources, max = 3) {
  if (!sources?.length) return [];
  const q = ` ${plain(question || '')} `;
  const counts = new Map();
  sources.forEach(s => new Set(titleNames(s.title)).forEach(n => counts.set(n, (counts.get(n) || 0) + 1)));
  // « Affaire Mbanié » and « Mbanié »: the shorter name, followed, finds both titles
  for (const long of [...counts.keys()]) {
    const short = [...counts.keys()].find(s => s !== long && ` ${long} `.includes(` ${s} `));
    if (short) { counts.set(short, counts.get(short) + counts.get(long)); counts.delete(long); }
  }
  return [...counts.entries()]
    .map(([value, n]) => ({ value, n, asked: q.includes(` ${plain(value)} `) }))
    // A name from a single title the question does not mention is too incidental
    .filter(c => c.asked || c.n >= 2)
    .sort((a, b) => (b.asked - a.asked) || (b.n - a.n))
    .slice(0, max)
    // Acronyms keep their capitals on screen; the followed value stays lowercase
    .map(c => ({ type: 'keyword', value: c.value, label: /^[\p{Ll}]{2,6}$/u.test(c.value) && sources.some(s => (s.title || '').includes(c.value.toUpperCase())) ? c.value.toUpperCase() : label(c.value) }));
}
