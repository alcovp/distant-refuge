import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listing, thread } from '../forum-views.mjs';

const origin = 'https://forum.example';
const created = '2025-02-03T04:05:06.000Z';
const topic = {
  id: 7, title: 'A <topic>', body: 'Hello & welcome', nickname: 'A & B',
  created_at: created, last_activity: created, reply_count: 51,
};

test('home identifies the website and publishes only configured verification tags', () => {
  const defaultHome = listing({ origin });
  assert.ok(defaultHome.includes('itemtype="https://schema.org/WebSite"'));
  assert.ok(defaultHome.includes('href="' + origin + '/" itemprop="url"'));
  assert.ok(defaultHome.includes('itemprop="name">Distant Refuge</span>'));
  assert.ok(defaultHome.includes('<title>Anonymous discussion forum · Distant Refuge</title>'));
  assert.doesNotMatch(defaultHome, /google-site-verification|msvalidate\.01/);

  const seo = { description: 'Our friends & family', googleVerification: 'sample"google', bingVerification: 'sample-bing' };
  const home = listing({ origin, seo });
  assert.ok(home.includes('<meta name="google-site-verification" content="sample&quot;google">'));
  assert.ok(home.includes('<meta name="msvalidate.01" content="sample-bing">'));
  assert.ok(home.includes('<meta name="description" content="Our friends &amp; family">'));
  assert.ok(home.includes('<p class="lead">Our friends &amp; family</p>'));

  const later = listing({ origin, topics: [topic], page: 2, total: 26, seo });
  assert.doesNotMatch(later, /schema\.org\/WebSite|google-site-verification|msvalidate\.01/);
  assert.match(later, /<meta name="description" content="Browse page 2[^\"]*A &lt;topic&gt;/);
});

test('later pages identify the original discussion and link each visible reply to its own page', () => {
  const reply = { id: 52, nickname: 'Anonymous', body: 'Line one\n' + 'Second & last '.repeat(20), created_at: created };
  const html = thread({ origin, topic, replies: [reply], page: 2, total: 51 });
  const root = origin + '/topics/7';
  assert.ok(html.includes('<link rel="canonical" href="' + root + '?page=2">'));
  assert.ok(html.includes('<link itemprop="url" href="' + root + '">'));
  assert.ok(html.includes('<link itemprop="mainEntityOfPage" href="' + root + '?page=2">'));
  assert.ok(html.includes('itemprop="url" href="' + root + '?page=2#reply-52"'));
  assert.ok(html.includes('itemprop="headline">A &lt;topic&gt;</h1>'));
  assert.ok(html.includes('<data itemprop="commentCount" value="51">51 replies</data>'));
  assert.ok(html.includes('itemtype="https://schema.org/DiscussionForumPosting"'));
  assert.equal(html.match(/itemprop="comment" itemscope itemtype="https:\/\/schema.org\/Comment"/g)?.length, 1);
  assert.equal(html.match(/itemprop="author" itemscope itemtype="https:\/\/schema.org\/Person"/g)?.length, 2);
  assert.equal(html.split('datetime="' + created + '" itemprop="datePublished"').length - 1, 2);
  assert.ok(html.includes('itemprop="text">Hello &amp; welcome</p>'));
  assert.ok(html.includes('itemprop="text">' + reply.body.replaceAll('&', '&amp;') + '</p>'));
  assert.ok(html.includes('<meta name="description" content="Replies, page 2'));
  assert.doesNotMatch(html, /google-site-verification|msvalidate\.01|schema\.org\/WebSite/);
});
