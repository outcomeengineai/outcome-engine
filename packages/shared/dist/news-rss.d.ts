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
export interface FeedItem {
    title: string;
    url: string | null;
    summary: string;
    /** ISO timestamp, or null when the feed gave none or gave nonsense. */
    publishedAt: string | null;
}
export declare function decodeEntities(s: string): string;
/** CDATA unwrapped, tags stripped, entities decoded, whitespace collapsed. */
export declare function cleanText(raw: string | undefined): string;
/** Parse an RSS 2.0 or Atom document. Unknown or empty input yields []. */
export declare function parseFeed(xml: string): FeedItem[];
export interface MarketTerms {
    id: string;
    /** Lower-cased proper nouns from the question, at most three. */
    subject: string[];
    /** Subject plus other content words, for the fallback rule and the query string. */
    all: string[];
}
/** Word tokens, lower-cased, letters and digits only. */
export declare function tokenize(text: string): string[];
export declare function tokenSet(text: string): Set<string>;
export declare function marketTerms(id: string, question: string, category: string): MarketTerms;
/**
 * Does a headline (as a token set) concern this market?
 * Every subject term must appear. With no subject terms, two content words.
 */
export declare function matchesTerms(tokens: Set<string>, t: MarketTerms): boolean;
//# sourceMappingURL=news-rss.d.ts.map