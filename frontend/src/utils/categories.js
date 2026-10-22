// Mono-thematic outlets: their generic front-page rubriques ("À la une")
// still carry an unambiguous topic
export const MONO_THEME_SOURCES = { gabonallsport: 'Sport' };

export const normalizeCategory = (cat, source) => {
  const fallback = MONO_THEME_SOURCES[source];
  if (!cat) return fallback || 'Autres';
  const c = cat.toLowerCase().trim().replace(/['"«»]/g, '');
  if (c.includes('politique')) return 'Politique';
  if (c.includes('economie') || c.includes('économie')) return 'Économie';
  if (c.includes('societe') || c.includes('société') || c.includes('social')) return 'Société';
  if (c.includes('sport') || c.includes('foot')) return 'Sport';
  if (c.includes('justice') || c.includes('fait divers') || c.includes('faits_divers') || c.includes('faits divers')) return 'Faits Divers / Justice';
  if (c.includes('provinces')) return 'Provinces';
  if (c.includes('culture') || c.includes('musique') || c.includes('cinéma')) return 'Culture';
  if (c.includes('enviro')) return 'Environnement';
  if (c.includes('santé') || c.includes('sante')) return 'Santé';
  if (c.includes('admin') || c.includes('instit')) return 'Administration';
  if (c.includes('diplomatie')) return 'Diplomatie';
  if (c.includes('international')) return 'International';
  if (c.includes('education') || c.includes('formation')) return 'Éducation';
  if (c.includes('communication') || c.includes('médias')) return 'Communication';
  if (c.includes('ia') || c.includes('numérique')) return 'IA / Numérique';
  // Generic front-page rubriques (mostly the WordPress REST sources) carry no topic
  if (/^(a|à) la une/.test(c) || c.startsWith('actualit') || c === 'news' || c === 'infos' || c.includes('non class') || c.includes('uncategorized')) return fallback || 'Non classé';
  return cat.charAt(0).toUpperCase() + cat.slice(1);
};

// Sourced from spacy.lang.fr.stop_words.STOP_WORDS (spaCy's French stopword
// list, ~500 words) rather than the earlier ~60-word hand-picked set, plus a
// small domain layer spaCy has no way to know about: "gabon"/"gabonais"/
// "gabonaise" are meaningless as a "trending topic" in a Gabon-only corpus,
// and a few generic adjectives ("dernier", "nouvelle", "grand"...) that are
// mostly headline noise here even though they're not stopwords in general
// prose. Elided forms spaCy lists (l', d', qu'...) are deliberately omitted:
// titleWords()'s regex below strips apostrophes without inserting a space,
// so "l'économie" becomes one token ("leconomie"), never a standalone "l" —
// those entries could never match anything, in JS or in the original list.
export const TITLE_STOPWORDS = new Set([
  'a','abord','afin','ah','ai','aie','ainsi','ait','allaient','allons','alors','anterieur',
  'anterieure','anterieures','antérieur','antérieure','antérieures','apres','après','as','assez',
  'attendu','au','aupres','auquel','aura','auraient','aurait','auront','aussi','autre',
  'autrement','autres','autrui','aux','auxquelles','auxquels','avaient','avais','avait','avant',
  'avec','avoir','avons','ayant','bas','basee','bat','c\'','car','ce','ceci','cela','celle',
  'celle-ci','celle-la','celle-là','celles','celles-ci','celles-la','celles-là','celui',
  'celui-ci','celui-la','celui-là','cent','cependant','certain','certaine','certaines','certains',
  'certes','ces','cet','cette','ceux','ceux-ci','ceux-là','chacun','chacune','chaque','chez','ci',
  'cinq','cinquantaine','cinquante','cinquantième','cinquième','combien','comme','comment',
  'compris','concernant','c’','d\'','da','dans','de','debout','dedans','dehors','deja','dejà',
  'delà','depuis','derriere','derrière','des','desormais','desquelles','desquels','dessous',
  'dessus','deux','deuxième','deuxièmement','devant','devers','devra','different','differente',
  'differentes','differents','différent','différente','différentes','différents','dire','directe',
  'directement','dit','dite','dits','divers','diverse','diverses','dix','dix-huit','dix-neuf',
  'dix-sept','dixième','doit','doivent','donc','dont','douze','douzième','du','duquel','durant',
  'dès','déja','déjà','désormais','d’','effet','egalement','eh','elle','elle-meme','elle-même',
  'elles','elles-memes','elles-mêmes','en','encore','enfin','entre','envers','environ','es','est',
  'et','etaient','etais','etait','etant','etc','etre','eu','eux','eux-mêmes','exactement',
  'excepté','facon','fais','faisaient','faisant','fait','façon','feront','font','gens','ha','hem',
  'hep','hi','ho','hormis','hors','hou','houp','hue','hui','huit','huitième','hé','i','il','ils',
  'importe','j\'','je','jusqu','jusque','juste','j’','l\'','la','laisser','laquelle','le',
  'lequel','les','lesquelles','lesquels','leur','leurs','longtemps','lors','lorsque','lui',
  'lui-meme','lui-même','là','lès','l’','m\'','ma','maint','maintenant','mais','malgre','malgré',
  'me','meme','memes','merci','mes','mien','mienne','miennes','miens','mille','moi','moi-meme',
  'moi-même','moindres','moins','mon','même','mêmes','m’','n\'','na','ne','neanmoins','neuvième',
  'ni','nombreuses','nombreux','nos','notamment','notre','nous','nous-mêmes','nouveau','nul',
  'néanmoins','nôtre','nôtres','n’','o','on','ont','onze','onzième','or','ou','ouias','ouste',
  'outre','ouvert','ouverte','ouverts','où','par','parce','parfois','parle','parlent','parler',
  'parmi','partant','pas','pendant','pense','permet','personne','peu','peut','peuvent','peux',
  'plus','plusieurs','plutot','plutôt','possible','possibles','pour','pourquoi','pourrais',
  'pourrait','pouvait','prealable','precisement','premier','première','premièrement','pres',
  'procedant','proche','près','préalable','précisement','pu','puis','puisque','qu\'','quand',
  'quant','quant-à-soi','quarante','quatorze','quatre','quatre-vingt','quatrième','quatrièmement',
  'que','quel','quelconque','quelle','quelles','quelqu\'un','quelque','quelques','quels','qui',
  'quiconque','quinze','quoi','quoique','qu’','relative','relativement','rend','rendre','restant',
  'reste','restent','retour','revoici','revoila','revoilà','s\'','sa','sait','sans','sauf','se',
  'seize','selon','semblable','semblaient','semble','semblent','sent','sept','septième','sera',
  'seraient','serait','seront','ses','seul','seule','seulement','seules','seuls','si','sien',
  'sienne','siennes','siens','sinon','six','sixième','soi','soi-meme','soi-même','soit',
  'soixante','son','sont','sous','souvent','specifique','specifiques','spécifique','spécifiques',
  'stop','suffisant','suffisante','suffit','suis','suit','suivant','suivante','suivantes',
  'suivants','suivre','sur','surtout','s’','t\'','ta','tant','te','tel','telle','tellement',
  'telles','tels','tenant','tend','tenir','tente','tes','tien','tienne','tiennes','tiens','toi',
  'toi-meme','toi-même','ton','touchant','toujours','tous','tout','toute','toutes','treize',
  'trente','tres','trois','troisième','troisièmement','très','tu','té','t’','un','une','unes',
  'uns','va','vais','vas','vers','via','vingt','voici','voila','voilà','vont','vos','votre',
  'votres','vous','vous-mêmes','vu','vé','vôtre','vôtres','y','à','â','ça','ès','également',
  'étaient','étais','était','étant','être','ô',
  // Domain-specific additions spaCy's generic list doesn't have: 'gabon'/'gabonais'/'gabonaise'
  // would otherwise dominate every single day trivially in a Gabon-focused corpus, and a
  // handful of adjectives ('dernier', 'nouvelle', 'grand'...) are common enough in headline
  // phrasing to be noise here even though they are not universal linguistic stopwords.
  'bon','contre','dernier','derniere','dernière','gabon','gabonais','gabonaise','grand','grande',
  'nouvelle','petit'
]);

// Elisions (l'état, d'un, qu'il, jusqu'à, lorsqu'elle, puisqu'on,
// quelqu'un...) are a short function word swallowing its apostrophe, not a
// compound — stripping the apostrophe outright used to glue them to the
// next word ("l'état" -> "létat"), which then slipped past the stopword
// list as one unrecognizable token instead of correctly reading as "état".
// This only fires right after a word boundary (\b), so it can't misfire
// on a real word that merely contains an apostrophe mid-token, like
// "aujourd'hui" — the "d" there sits after "aujour", not after a boundary.
const ELISION_PREFIX = /\b(jusqu|lorsqu|puisqu|quelqu|qu|l|d|j|m|n|s|t|c)['’]/gi;

// Shared by the keyword-frequency chart and the followed-keyword delta
// matcher, so "follow this word" and "this word is trending" agree on
// what a word even is
export const titleWords = (title) =>
  (title || '').toLowerCase()
    .replace(ELISION_PREFIX, ' ')
    .replace(/[^a-zàâéèêëïîôùûüÿçœæ\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w));

// Only for "Sujets tendance" (trendTopicsSeries below) — titleWords()
// deliberately stays untouched since keyword-follow matching depends on its
// exact single-word tokens. A plain word-frequency count surfaces ordinary
// words ("Contre", "Ans", "État") alongside real names just because they're
// frequent, and worse, splits a name like "Oligui Nguema" into two unrelated
// "topics". This is a proper-noun heuristic instead: runs of consecutive
// Title-Case words in the *original* (non-lowercased) title are merged into
// one phrase — no NER model, so it's still approximate (a capitalized
// sentence-opener that isn't a stopword could slip through), but matches
// what the word actually looks like in the source text rather than treating
// every non-stopword token as equally "topic"-worthy.
// Each hyphen-joined segment must itself start capitalized ("Port-Gentil"),
// not just the first letter of the whole token — a plain [a-z'-]* tail
// would silently reject "Port-Gentil" the moment it hit the internal "G".
const CAPITALIZED_WORD_RE = /^[A-ZÀÂÉÈÊËÏÎÔÙÛÜŸÇŒÆ][a-zàâéèêëïîôùûüÿçœæ']*(-[A-ZÀÂÉÈÊËÏÎÔÙÛÜŸÇŒÆ][a-zàâéèêëïîôùûüÿçœæ']*)*$/;
export const titlePhrases = (title) => {
  if (!title) return [];
  const rawWords = title.replace(ELISION_PREFIX, ' ').match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]*/g) || [];
  const phrases = [];
  let current = [];
  rawWords.forEach(w => {
    const lower = w.toLowerCase();
    if (CAPITALIZED_WORD_RE.test(w) && lower.length > 2 && !TITLE_STOPWORDS.has(lower)) {
      current.push(lower);
    } else if (current.length) {
      phrases.push(current.join(' '));
      current = [];
    }
  });
  if (current.length) phrases.push(current.join(' '));
  return phrases;
};

// Shared by the Statistiques "since your last visit" strip and the Assistant
// landing page's personalized suggestions — same underlying question ("did
// anything change for what I follow?"), two surfaces. Kept as one pure
// function so the spiked/quiet/new thresholds can't drift between them.
export const computeFollowDeltas = (points, follows, lastSeenDate, dateMax) => {
  if (!points || !dateMax || !lastSeenDate || !follows || follows.length === 0) return [];
  if (lastSeenDate >= dateMax) return [];

  const matches = (item, pt) => {
    if (item.type === 'source') return pt.source === item.value;
    if (item.type === 'theme') return normalizeCategory(pt.category, pt.source) === item.value;
    // Substring match rather than titleWords().includes(): "Sujets tendance"
    // can now hand out multi-word phrases ("oligui nguema") via titlePhrases,
    // which titleWords' single-word tokens would never equal. A lowercased
    // substring check handles both a single followed word and a followed
    // phrase the same way.
    if (item.type === 'keyword') return pt.title ? pt.title.toLowerCase().includes(item.value) : false;
    return false;
  };

  const daysSince = Math.max(1, Math.round((new Date(dateMax) - new Date(lastSeenDate)) / 86400000));
  const baselineStart = new Date(lastSeenDate);
  baselineStart.setDate(baselineStart.getDate() - daysSince);
  const baselineStartStr = baselineStart.toISOString().slice(0, 10);

  return follows.map(item => {
    let sinceCount = 0, baselineCount = 0;
    points.forEach(pt => {
      if (!pt.date || !matches(item, pt)) return;
      if (pt.date > lastSeenDate) sinceCount++;
      else if (pt.date >= baselineStartStr && pt.date <= lastSeenDate) baselineCount++;
    });
    let status = null;
    if (sinceCount === 0 && baselineCount >= 2) status = 'quiet';
    else if (sinceCount > 0 && baselineCount > 0 && sinceCount / baselineCount >= 1.6) status = 'spiked';
    else if (sinceCount > 0) status = 'new';
    return { ...item, sinceCount, baselineCount, status };
  }).filter(d => d.status !== null);
};

// Editorial profile — fixed entity→color map (8 validated categorical hues,
// adjacent-pair CVD-checked on the white panel); every other rubrique folds
// into a neutral "Autres" so colors never depend on the data.
export const PROFILE_COLORS = {
  'Politique': '#23805C',
  'Société': '#3A6FB8',
  'Économie': '#D0703A',
  'Sport': '#9E4A8C',
  'Faits Divers / Justice': '#C99A2A',
  'Culture': '#5752B0',
  'Provinces': '#1EA39B',
  'Environnement': '#C9434A',
};
export const PROFILE_OTHER = 'Autres / non classé';
export const PROFILE_OTHER_COLOR = '#6B7A89';
