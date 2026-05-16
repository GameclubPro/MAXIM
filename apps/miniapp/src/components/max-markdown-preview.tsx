import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import {
  renderSupportedMarkdownAsHtml,
  stripSupportedMarkdownToPlainText,
} from '../lib/max-markdown';
import './max-markdown-preview.css';

export function MaxMarkdownPreview({
  value,
  className,
  normalizeWhitespace = false,
  preserveLinks = false,
  fallback = null,
}: {
  value: string;
  className?: string;
  normalizeWhitespace?: boolean;
  preserveLinks?: boolean;
  fallback?: ReactNode;
}) {
  const source = normalizeWhitespace
    ? value.replace(/\r/g, '').replace(/\s+/gu, ' ').trim()
    : value;
  const plainText = stripSupportedMarkdownToPlainText(source).trim();

  if (!plainText) {
    return fallback ? <>{fallback}</> : null;
  }

  const html = renderSupportedMarkdownAsHtml(source, {
    blockMode: 'inline',
    linkMode: preserveLinks ? 'anchor' : 'underline',
  });

  return (
    <span
      className={cn('max-markdown-preview', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
