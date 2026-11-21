import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Render markdown to sanitized HTML. Shared by the React panel; the vanilla
 * control keeps its inline copy so its behavior stays byte-for-byte stable.
 * A `afterSanitizeAttributes` hardens every link to open safely in a new tab
 * (the imperative control applies the same hardening post-render).
 */
let hooksInstalled = false;

function installLinkHardening(): void {
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

export function renderMarkdownToSafeHtml(markdown: string): string {
  installLinkHardening();
  const html = marked(markdown || '', {
    async: false,
    breaks: false,
    gfm: true,
  });
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });
}
