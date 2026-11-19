const brand = 'Distant Refuge';
const dateFormat = new Intl.DateTimeFormat('en', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function shortText(value, length) {
  const chars = Array.from(String(value ?? '').replace(/\s+/gu, ' ').trim());
  return chars.length > length ? chars.slice(0, length - 1).join('').trimEnd() + '…' : chars.join('');
}

function time(value, property) {
  const stamp = new Date(value);
  if (!Number.isFinite(stamp.getTime())) return '';
  const itemprop = property ? ' itemprop="' + esc(property) + '"' : '';
  return '<time datetime="' + esc(stamp.toISOString()) + '"' + itemprop + '>' + esc(dateFormat.format(stamp)) + '</time>';
}

function pageUrl(base, page) {
  return page > 1 ? base + '?page=' + page : base;
}

function pagination(base, page, total, pageSize) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return '';
  const previous = page > 1 ? '<a rel="prev" href="' + esc(pageUrl(base, page - 1)) + '">← Previous</a>' : '<span></span>';
  const next = page < pages ? '<a rel="next" href="' + esc(pageUrl(base, page + 1)) + '">Next →</a>' : '<span></span>';
  return '<nav class="pages" aria-label="Pages">' + previous + '<span>Page ' + esc(page) + ' of ' +
    esc(pages) + '</span>' + next + '</nav>';
}

function layout({ title, description, path, origin, body, activeTopics = false, ogType = 'website', verification = {} }) {
  const absolute = path && new URL(path, origin).href;
  const home = path === '/';
  const verificationTags = [
    ['google-site-verification', verification.googleVerification],
    ['msvalidate.01', verification.bingVerification],
  ].filter(([, value]) => value?.trim()).map(([name, value]) =>
    '<meta name="' + name + '" content="' + esc(value.trim()) + '">'
  ).join('\n  ');
  const fullTitle = title + ' · ' + brand;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f7f5ec">
  <title>${esc(fullTitle)}</title>
  <meta name="description" content="${esc(description)}">
  ${absolute ? `<link rel="canonical" href="${esc(absolute)}">
  <meta property="og:type" content="${esc(ogType)}">
  <meta property="og:site_name" content="${brand}">
  <meta property="og:title" content="${esc(fullTitle)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${esc(absolute)}">
  <meta name="twitter:card" content="summary">` : '<meta name="robots" content="noindex, nofollow">'}
  ${home ? verificationTags : ''}
  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
  <link rel="stylesheet" href="/assets/forum.css">
</head>
<body id="top">
  <a class="skip" href="#main">Skip to content</a>
  <div class="wrap">
    <header${home ? ' itemscope itemtype="https://schema.org/WebSite"' : ''}><a class="brand" href="${home ? esc(absolute) : '/'}"${home ? ' itemprop="url"' : ''}><img src="/assets/favicon.svg" width="36" height="36" alt=""><span${home ? ' itemprop="name"' : ''}>${brand}</span></a>
      <nav aria-label="Main"><a ${activeTopics ? 'href="#topics" aria-current="page"' : 'href="/"'}>All topics</a></nav>
    </header>
    <main id="main">${body}</main>
    <footer><span>Distant Refuge</span><a href="#top">Back to top <span aria-hidden="true">↑</span></a></footer>
  </div>
</body>
</html>`;
}

const coast = `<div class="coast" aria-hidden="true"><i class="night"></i><i class="stars"></i><i class="moon"></i>
<i class="beam"></i><i class="water"></i><i class="reflection"></i><i class="horizon-land"></i>
<i class="headland"></i><i class="lighthouse"><b></b><i></i></i><i class="foreground"></i></div>`;

function button(href, label) {
  return '<a class="button" href="' + esc(href) + '">' + esc(label) + ' <span aria-hidden="true">↗</span></a>';
}

function replyCount(count) {
  return esc(count) + (count === 1 ? ' reply' : ' replies');
}

function topicRow(topic) {
  return `<li class="topic-row">
    <div><h3><a href="/topics/${esc(topic.id)}">${esc(topic.title)}</a></h3>
    <p class="metadata"><bdi>${esc(topic.nickname)}</bdi> <span aria-hidden="true">·</span> Latest activity ${time(topic.last_activity)}</p></div>
    <span class="count">${replyCount(topic.reply_count)}</span>
  </li>`;
}

export function listing({ topics = [], total = 0, page = 1, origin, seo = {} }) {
  const introduction = seo.description?.trim() || 'Start a topic or reply anonymously. Share news, ask a question, or catch up with friends and family.';
  const description = page === 1 ? introduction : 'Browse page ' + page + ' of discussions on ' + brand +
    (topics.length ? ', including “' + shortText(topics[0].title, 95) + '”.' : '.');
  const empty = '<div class="empty"><h3>No topics yet</h3><p>The first conversation is yours to start.</p></div>';
  return layout({
    title: page === 1 ? 'Anonymous discussion forum' : 'Topics · Page ' + page, description,
    path: pageUrl('/', page), origin, activeTopics: true, verification: seo,
    body: `<section class="hero">
      <div><h1>${brand} <em>forum</em></h1>
        <p class="lead">${esc(introduction)}</p>
        ${button('/new', 'Start a topic')}
      </div>${coast}</section>
      <section class="topic-section" id="topics" aria-labelledby="topic-heading">
        <div class="section-head"><h2 id="topic-heading">Latest discussions</h2><span class="count">${esc(total)} ${total === 1 ? 'topic' : 'topics'}</span></div>
        ${topics.length ? '<ul class="topic-list">' + topics.map(topicRow).join('') + '</ul>' : empty}
        ${pagination('/', page, total, 25)}
      </section>`,
  });
}

function message(post, replyPageUrl) {
  const date = time(post.created_at, 'datePublished');
  const replyId = 'reply-' + post.id;
  return `<article class="message ${replyPageUrl ? 'reply' : 'opener'}"${replyPageUrl ? ' id="' + esc(replyId) + '" itemprop="comment" itemscope itemtype="https://schema.org/Comment"' : ''}>
    <div class="byline"><span class="name" itemprop="author" itemscope itemtype="https://schema.org/Person"><span itemprop="name"><bdi>${esc(post.nickname)}</bdi></span></span>
    ${replyPageUrl ? '<a class="permalink" itemprop="url" href="' + esc(replyPageUrl + '#' + replyId) + '" aria-label="Link to this reply">' + date + '</a>' : date}</div>
    <p class="prose" dir="auto" itemprop="text">${esc(post.body)}</p>
  </article>`;
}

export function thread({ topic, replies = [], total = 0, page = 1, origin }) {
  const path = '/topics/' + encodeURIComponent(topic.id);
  const currentPath = pageUrl(path, page);
  const currentUrl = new URL(currentPath, origin).href;
  const discussionUrl = new URL(path, origin).href;
  const description = page === 1 ? shortText(topic.body, 155) :
    shortText('Replies, page ' + page + ' · ' + topic.title + '. ' + (replies[0]?.body || ''), 155);
  return layout({
    title: topic.title + (page > 1 ? ' · Page ' + page : ''), description,
    path: currentPath, origin, ogType: 'article',
    body: `<div class="column thread" itemscope itemtype="https://schema.org/DiscussionForumPosting">
      <link itemprop="url" href="${esc(discussionUrl)}">
      <link itemprop="mainEntityOfPage" href="${esc(currentUrl)}">
      <a class="back" href="/">← All topics</a>
      <h1 class="subject" dir="auto" itemprop="headline">${esc(topic.title)}</h1>
      ${message(topic)}
      <section class="replies" aria-labelledby="reply-heading">
        <div class="section-head"><h2 id="reply-heading"><data itemprop="commentCount" value="${esc(total)}">${replyCount(total)}</data></h2>
          ${button(path + '/reply', 'Write a reply')}</div>
        ${replies.map(post => message(post, currentUrl)).join('')}
        ${pagination(path, page, total, 50)}
      </section>
    </div>`,
  });
}

function token(name, value) {
  return '<input type="hidden" name="' + name + '" value="' + esc(value) + '">';
}

function alert(text) {
  return text ? '<p class="error" role="alert">' + esc(text) + '</p>' : '';
}

export function compose({ topic, values = {}, error = '', csrf, nonce, origin }) {
  const path = topic ? '/topics/' + encodeURIComponent(topic.id) : '/';
  const title = topic ? 'Write a reply' : 'Start a topic';
  return layout({
    title, description: title + ' on Distant Refuge.', origin,
    body: `<div class="column form-view">
      <a class="back" href="${esc(path)}">← ${topic ? 'Back to topic' : 'All topics'}</a><h1>${title}</h1>
      ${topic ? '<p class="context">Replying to <a href="' + esc(path) + '">' + esc(topic.title) + '</a></p>' : ''}
      <form action="${topic ? path + '/replies' : '/topics'}" method="post" class="compose">
        ${token('csrf', csrf)}${token('nonce', nonce)}${alert(error)}
        <div class="field short"><label for="nickname">Nickname (optional)</label>
          <input id="nickname" name="nickname" value="${esc(values.nickname)}" autocomplete="nickname" dir="auto" aria-describedby="nickname-hint">
          <p class="hint" id="nickname-hint">Leave blank to post as Anonymous, or enter up to 40 characters.</p></div>
        ${topic ? '' : `<div class="field"><label for="title">Topic title</label>
          <input id="title" name="title" required value="${esc(values.title)}" dir="auto" aria-describedby="title-hint">
          <p class="hint" id="title-hint">Up to 140 characters.</p></div>`}
        <div class="field"><label for="body">${topic ? 'Your reply' : 'Your message'}</label>
          <textarea id="body" name="body" rows="7" required dir="auto" aria-describedby="body-hint">${esc(values.body)}</textarea>
          <p class="hint" id="body-hint">Public once posted. Up to 6,000 characters.</p></div>
        <button class="button" type="submit">${topic ? 'Post reply' : 'Publish topic'} <span aria-hidden="true">→</span></button>
      </form></div>`,
  });
}

export function problem({ status, message: text, origin }) {
  const title = status === 404 ? 'Page not found' : status === 410 ? 'Page retired' : 'Request unsuccessful';
  return layout({ title, description: title, origin, body: `<div class="column form-view">
    <a class="back" href="/">← All topics</a><h1>${title}</h1>
    <p class="intro">${esc(text)}</p></div>` });
}
