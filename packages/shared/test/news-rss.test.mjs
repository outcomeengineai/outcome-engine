import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, marketTerms, matchesTerms, tokenSet, cleanText } from '../dist/index.js';

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Example</title>
<item>
  <title><![CDATA[Bitcoin falls below $64,000 as traders retreat]]></title>
  <link>https://example.com/a</link>
  <pubDate>Tue, 22 Sep 2026 14:05:00 GMT</pubDate>
  <description>Prices &amp; volumes &lt;b&gt;dropped&lt;/b&gt; sharply.</description>
</item>
<item>
  <title>Lakers beat Celtics in overtime thriller</title>
  <guid isPermaLink="true">https://example.com/b</guid>
  <content:encoded><![CDATA[<p>A <em>record</em> night for the Lakers.</p>]]></content:encoded>
</item>
<item>
  <link>https://example.com/no-title</link>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom feed</title>
<entry>
  <title>Fed holds rates steady, signals cut in December</title>
  <link rel="self" href="https://example.com/self"/>
  <link rel="alternate" href="https://example.com/fed"/>
  <updated>2026-09-22T13:00:00Z</updated>
  <summary type="html">The &#8220;pause&#8221; continues.</summary>
</entry>
</feed>`;

test('parses RSS items with CDATA, entities, guid links and content:encoded', () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2, 'the item without a title is dropped');
  assert.equal(items[0].title, 'Bitcoin falls below $64,000 as traders retreat');
  assert.equal(items[0].url, 'https://example.com/a');
  assert.equal(items[0].publishedAt, '2026-09-22T14:05:00.000Z');
  assert.equal(items[0].summary, 'Prices & volumes dropped sharply.');
  assert.equal(items[1].url, 'https://example.com/b', 'permalink guid stands in for a missing link');
  assert.equal(items[1].summary, 'A record night for the Lakers.');
  assert.equal(items[1].publishedAt, null);
});

test('parses Atom entries and prefers the alternate link', () => {
  const items = parseFeed(ATOM);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/fed');
  assert.equal(items[0].publishedAt, '2026-09-22T13:00:00.000Z');
  assert.equal(items[0].summary, 'The “pause” continues.');
});

test('garbage in, nothing out', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('<html><body>Service unavailable</body></html>'), []);
  assert.equal(cleanText('<p>a &amp; b</p>'), 'a & b');
});

test('market terms keep the subject and drop dates, numbers and scaffolding', () => {
  const btc = marketTerms('m1', 'Will Bitcoin be above $65,000 on Sep 23?', 'Crypto');
  assert.deepEqual(btc.subject, ['bitcoin']);

  const game = marketTerms('m2', 'Will the Lakers beat the Celtics on Tuesday?', 'Sports');
  assert.deepEqual(game.subject, ['lakers', 'celtics']);

  const temp = marketTerms('m3', 'Will the high temp in NYC be above 75° on Sep 22?', 'Climate and Weather');
  assert.deepEqual(temp.subject, ['nyc']);

  const bill = marketTerms('m4', 'Will Trump sign the NDAA before December 31?', 'Politics');
  assert.deepEqual(bill.subject, ['trump', 'ndaa']);

  // No proper nouns at all: falls back to content words, never to nothing.
  const plain = marketTerms('m5', 'Will mortgage rates fall this month?', 'Economics');
  assert.deepEqual(plain.subject, []);
  assert.ok(plain.all.includes('mortgage') && plain.all.includes('rates'));
});

test('a headline matches a market only when it names every subject', () => {
  const btc = marketTerms('m1', 'Will Bitcoin be above $65,000 on Sep 23?', 'Crypto');
  const game = marketTerms('m2', 'Will the Lakers beat the Celtics on Tuesday?', 'Sports');
  const plain = marketTerms('m5', 'Will mortgage rates fall this month?', 'Economics');

  const btcNews = tokenSet('Bitcoin falls below $64,000 as traders retreat');
  const lakersOnly = tokenSet('Lakers sign a new guard');
  const both = tokenSet("Lakers beat Celtics in overtime; Celtics' streak ends");
  const rates = tokenSet('Mortgage rates dip for a third week');

  assert.equal(matchesTerms(btcNews, btc), true);
  assert.equal(matchesTerms(btcNews, game), false);
  assert.equal(matchesTerms(lakersOnly, game), false, 'one team is not the game');
  assert.equal(matchesTerms(both, game), true);
  assert.equal(matchesTerms(rates, plain), true, 'two content words carry a subject-less market');
  assert.equal(matchesTerms(tokenSet('Rates of return on bonds'), plain), false);
});
