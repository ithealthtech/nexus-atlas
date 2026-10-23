/** Deliberately small formatting vocabulary. User HTML is always escaped, including interpolated fields. */
export function formattedTeamsHtml(content: string): string {
  const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const inline = (s: string) => escape(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return content
    .split('\n')
    .map((line) => {
      if (line.startsWith('## ')) return `<p><strong>${inline(line.slice(3))}</strong></p>`;
      if (line.startsWith('- ')) return `<p>• ${inline(line.slice(2))}</p>`;
      const value = line.trim();
      if (/^https?:\/\/\S+$/i.test(value)) {
        try {
          const url = new URL(value);
          if (!url.username && !url.password) return `<p><a href="${escape(url.href)}">Open in Atlas</a></p>`;
        } catch {
          /* Invalid URLs remain literal text. */
        }
      }
      return line ? `<p>${inline(line)}</p>` : '<br>';
    })
    .join('');
}
