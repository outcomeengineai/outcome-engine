/**
 * RSS news: feed parsing and market matching.
 *
 * Pure functions, shared between the Deno fetcher and the node test suite.
 * No XML library: the feeds we read are RSS 2.0 or Atom from large outlets,
 * and the four fields we need (title, link, date, summary) are recoverable
 * with a tolerant scan. A malformed item yields nothing rather than an
 * exception -- one broken entry must not cost a whole feed.
 *
 * Matching is by SUBJECT: the proper nouns in a market's question. A market
 * about Bitcoin's price on a date is about Bitcoin; the date and the number
 * are constraints, not the subject, and requiring them in a headline would
 * match nothing. When a question names two subjects (a game between two
 * teams), a headline must name both.
 */
// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------
const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    '#39': "'", '#34': '"', '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”',
};
export function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
        const key = name.toLowerCase();
        if (key in ENTITIES)
            return ENTITIES[key];
        if (key.startsWith('#x')) {
            const code = parseInt(key.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        if (key.startsWith('#')) {
            const code = parseInt(key.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return whole;
    });
}
/** CDATA unwrapped, tags stripped, entities decoded, whitespace collapsed. */
export function cleanText(raw) {
    if (!raw)
        return '';
    let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    s = s.replace(/<[^>]+>/g, ' ');
    // Most feeds ship HTML inside the description as entities (&lt;p&gt;),
    // so markup only appears after decoding. Strip it a second time.
    s = decodeEntities(s);
    s = s.replace(/<[^>]+>/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
}
function tagContent(block, tag) {
    // Namespaced tags (content:encoded, dc:date) are matched by their full name.
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
    const m = re.exec(block);
    return m ? m[1] : undefined;
}
function atomLink(block) {
    // Prefer rel="alternate" (or no rel); ignore self/enclosure/replies.
    const links = block.match(/<link\b[^>]*>/gi) ?? [];
    let fallback;
    for (const l of links) {
        const href = /href\s*=\s*"([^"]+)"/i.exec(l)?.[1];
        if (!href)
            continue;
        const rel = /rel\s*=\s*"([^"]+)"/i.exec(l)?.[1]?.toLowerCase();
        if (!rel || rel === 'alternate')
            return href;
        fallback ??= href;
    }
    return fallback;
}
function parseDate(raw) {
    const s = cleanText(raw);
    if (!s)
        return null;
    const t = Date.parse(s);
    if (!Number.isFinite(t))
        return null;
    // Feeds occasionally carry a far-future or epoch date; both are noise.
    if (t < Date.UTC(2000, 0, 1) || t > Date.now() + 2 * 86_400_000)
        return null;
    return new Date(t).toISOString();
}
/** Parse an RSS 2.0 or Atom document. Unknown or empty input yields []. */
export function parseFeed(xml) {
    if (!xml || typeof xml !== 'string')
        return [];
    const isAtom = /<feed\b[^>]*xmlns\s*=\s*"http:\/\/www\.w3\.org\/2005\/Atom"/i.test(xml) ||
        (!/<item\b/i.test(xml) && /<entry\b/i.test(xml));
    const blockRe = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    const out = [];
    let m;
    while ((m = blockRe.exec(xml)) !== null) {
        const block = m[1];
        const title = cleanText(tagContent(block, 'title'));
        if (!title)
            continue;
        let url;
        if (isAtom) {
            url = atomLink(block);
        }
        else {
            url = cleanText(tagContent(block, 'link')) || undefined;
            if (!url) {
                const guid = tagContent(block, 'guid');
                const permalink = /isPermaLink\s*=\s*"false"/i.test(/<guid[^>]*>/i.exec(block)?.[0] ?? '');
                const g = cleanText(guid);
                if (g && !permalink && /^https?:\/\//i.test(g))
                    url = g;
            }
        }
        if (url && !/^https?:\/\//i.test(url))
            url = undefined;
        const summary = cleanText(tagContent(block, 'description') ?? tagContent(block, 'summary') ??
            tagContent(block, 'content:encoded') ?? tagContent(block, 'content')).slice(0, 400);
        const publishedAt = parseDate(tagContent(block, 'pubDate') ?? tagContent(block, 'published') ??
            tagContent(block, 'updated') ?? tagContent(block, 'dc:date'));
        out.push({ title: title.slice(0, 300), url: url ?? null, summary, publishedAt });
    }
    return out;
}
// --------------------------------------------------------------------------
// Matching
// --------------------------------------------------------------------------
const STOP = new Set([
    'will', 'the', 'a', 'an', 'be', 'is', 'are', 'to', 'of', 'in', 'on', 'at', 'by', 'for',
    'and', 'or', 'above', 'below', 'before', 'after', 'than', 'this', 'that', 'it', 'its',
    'come', 'more', 'less', 'least', 'most', 'any', 'have', 'has', 'do', 'does', 'if', 'when',
    'what', 'which', 'who', 'yes', 'no', 'with', 'from', 'over', 'under', 'between', 'into',
    'out', 'up', 'down', 'win', 'wins', 'reach', 'hit', 'end', 'close', 'open', 'high', 'low',
    'temperature', 'temp', 'game', 'match', 'season', 'week', 'day', 'today', 'tomorrow',
    'price', 'closing', 'ends', 'total', 'points', 'point', 'against', 'vs', 'first', 'last',
    'new', 'next', 'get', 'go', 'make', 'made', 'per', 'via', 'about', 'his', 'her', 'their',
]);
const CALENDAR = new Set([
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep',
    'sept', 'oct', 'nov', 'dec', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
    'saturday', 'sunday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'am', 'pm', 'et',
    'est', 'edt', 'pt', 'pst', 'pdt', 'ct', 'cst', 'cdt', 'utc',
]);
/** Word tokens, lower-cased, letters and digits only. */
export function tokenize(text) {
    return text
        .replace(/[‘’']/g, '')
        .split(/[^A-Za-z0-9]+/)
        .filter((w) => w.length > 0);
}
export function tokenSet(text) {
    return new Set(tokenize(text).map((w) => w.toLowerCase()));
}
export function marketTerms(id, question, category) {
    const raw = question.replace(/[‘’']/g, '').split(/[^A-Za-z0-9$%.,-]+/).filter(Boolean);
    const subject = [];
    const other = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i++) {
        const word = raw[i].replace(/^[$.,-]+|[.,-]+$/g, '');
        if (!word || /\d/.test(word))
            continue;
        const lower = word.toLowerCase();
        if (lower.length < 3 || STOP.has(lower) || CALENDAR.has(lower) || seen.has(lower))
            continue;
        seen.add(lower);
        // Capitalised, and not merely the first word of the sentence.
        const capitalised = /^[A-Z]/.test(word) && i > 0;
        if (capitalised)
            subject.push(lower);
        else if (lower.length >= 4)
            other.push(lower);
    }
    const subj = subject.slice(0, 3);
    const all = [...subj, ...other].slice(0, 8);
    return { id, subject: subj, all: all.length ? all : tokenize(category).map((w) => w.toLowerCase()) };
}
/**
 * Does a headline (as a token set) concern this market?
 * Every subject term must appear. With no subject terms, two content words.
 */
export function matchesTerms(tokens, t) {
    if (t.subject.length > 0) {
        for (const s of t.subject)
            if (!tokens.has(s))
                return false;
        return true;
    }
    let hits = 0;
    for (const w of t.all)
        if (tokens.has(w))
            hits++;
    return hits >= 2;
}
//# sourceMappingURL=news-rss.js.map