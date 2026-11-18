import React, { memo, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function preserveSoftBreaks() {
  return function transform(tree) {
    const pending = [tree];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node.children) continue;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text') {
          if (child.children) pending.push(child);
          return [child];
        }
        const lines = child.value.split(/\r\n?|\n/);
        if (lines.length === 1) return [child];
        return lines.flatMap((value, index) => [
          ...(index > 0 ? [{ type: 'break' }] : []),
          { type: 'text', value },
        ]);
      });
    }
  };
}

const plugins = [remarkGfm, preserveSoftBreaks];

function safeMarkdownUrl(value, attribute) {
  if (attribute !== 'href' || typeof value !== 'string' || value.length > 2048 ||
      !/^https:\/\/[^/?#@\s]+(?:[/?#]|$)/i.test(value) || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return undefined;
  const url = URL.parse(value);
  return url?.protocol === 'https:' && url.hostname && !url.username && !url.password && url.href.length <= 2048
    ? url.href : undefined;
}

function CodeBlock({ node, children, copy }) {
  const [copiedSource, setCopiedSource] = useState(null);
  const code = node?.children?.[0];
  const languageClass = code?.properties?.className?.find((value) => value.startsWith('language-'));
  const language = languageClass?.slice('language-'.length);
  // The Markdown renderer appends a newline to nonempty code blocks.
  const source = (code?.children?.[0]?.value ?? '').replace(/\n$/, '');
  const copied = copiedSource === source;
  const label = copied ? 'Code copied' : 'Copy code';

  async function copySource() {
    const result = await copy(source);
    if (result?.ok) setCopiedSource(source);
  }

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-tools">
        {language && <span className="markdown-code-language" title={language}>{language}</span>}
        <button className={`icon-button markdown-copy${copied ? ' copied' : ''}`} type="button"
          aria-label={label} title={label} onClick={() => void copySource()}>
          {copied ? <Check /> : <Copy />}
        </button>
        <span className="markdown-copy-status" role="status">{copied ? label : ''}</span>
      </div>
      <pre tabIndex={0} aria-label={language ? `Code (${language})` : 'Code'}>{children}</pre>
    </div>
  );
}

function ScrollableTable({ children }) {
  return (
    <div className="markdown-table-scroll" tabIndex={0} aria-label="Table">
      <table>{children}</table>
    </div>
  );
}

export const MarkdownMessage = memo(function MarkdownMessage({ text, copy, openLink }) {
  const components = useMemo(() => ({
    pre: ({ node, children }) => <CodeBlock node={node} copy={copy}>{children}</CodeBlock>,
    table: ScrollableTable,
    img: ({ alt }) => alt ? <span className="markdown-image-alt">{alt}</span> : null,
    a: ({ href, children }) => href ? (
      <a href={href} title={href} rel="noreferrer" onClick={(event) => {
        event.preventDefault();
        if (event.nativeEvent.isTrusted) void openLink(href);
      }} onAuxClick={(event) => event.preventDefault()}>{children}</a>
    ) : children,
  }), [copy, openLink]);

  return (
    <Markdown remarkPlugins={plugins} skipHtml urlTransform={safeMarkdownUrl} components={components}>{text}</Markdown>
  );
});
