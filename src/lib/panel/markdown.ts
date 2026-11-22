import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * 将 markdown 渲染为经过 DOMPurify 消毒的安全 HTML。供 React 面板共用；
 * 原生控件（vanilla control）保留其内联副本，以保证行为逐字节一致。
 * 通过 `afterSanitizeAttributes` 钩子把每个链接加固为在新标签页中安全打开
 * （命令式控件在渲染后会应用相同的加固逻辑）。
 */
// 标记 DOMPurify 钩子是否已安装，避免重复注册同一钩子。
let hooksInstalled = false;

/**
 * 注册 DOMPurify 的 afterSanitizeAttributes 钩子，为所有 `<a>` 标签补上
 * `target="_blank"` 与 `rel="noopener noreferrer"`，防止 tabnabbing 攻击。
 */
function installLinkHardening(): void {
  // 幂等保护：钩子只需注册一次，后续调用直接返回。
  if (hooksInstalled) {
    return;
  }
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // 只处理链接节点：在新标签页打开并切断对 window.opener 的引用。
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * 将 markdown 文本渲染为安全的 HTML 字符串。
 *
 * @param markdown - 原始 markdown 文本；undefined/null 会被视为空串处理
 * @returns 经过 marked 解析、再经 DOMPurify 按 HTML 白名单消毒后的 HTML 字符串
 */
export function renderMarkdownToSafeHtml(markdown: string): string {
  // 渲染前确保链接加固钩子已注册（首次调用时安装）。
  installLinkHardening();
  // marked 同步模式：async=false 返回字符串而非 Promise；开启 GFM 方言，
  // 关闭 breaks（单个换行不产生 <br>），与命令式控件行为保持一致。
  const html = marked(markdown || '', {
    async: false,
    breaks: false,
    gfm: true,
  });
  // USE_PROFILES: { html: true } 只保留纯 HTML 白名单标签（排除 svg/math 等），
  // 滤掉脚本注入向量后返回最终 HTML。
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
  });
}
