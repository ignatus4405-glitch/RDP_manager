'use strict';
/**
 * Мини-рендерер Markdown → безопасный HTML.
 * Поддержка: заголовки #..###, **жирный**, *курсив*, `код`, блоки ```,
 * списки - и 1., ссылки [текст](https://...), горизонтальная линия ---.
 * Весь пользовательский текст экранируется.
 */
window.renderMarkdown = function renderMarkdown(src) {
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const lines = String(src || '').split(/\r?\n/);
  const out = [];
  let inCode = false, inList = null; // null | 'ul' | 'ol'

  const closeList = () => { if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null; } };

  const inline = (text) => {
    let t = escapeHtml(text);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|\W)\*([^*]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/^```/.test(line)) {
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { closeList(); out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(raw)); continue; }

    if (/^\s*$/.test(line)) { closeList(); continue; }
    if (/^---+\s*$/.test(line)) { closeList(); out.push('<hr />'); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lvl = h[1].length; out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; } out.push(`<li>${inline(ul[1])}</li>`); continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; } out.push(`<li>${inline(ol[1])}</li>`); continue; }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push('</code></pre>');
  closeList();
  return out.join('\n');
};
