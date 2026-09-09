import { Bold, Code, Italic, Link, Strikethrough, Type, Underline } from 'iconoir-react';
import { MAX_MARKDOWN_TOOL_DEFINITIONS, type MaxMarkdownTool } from './max-markdown-editor';
import { cn } from '../lib/cn';

const icons = {
  heading: Type,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  strike: Strikethrough,
  code: Code,
  link: Link,
};

export default function ChannelSuggestionFormatToolbar({
  disabled,
  activeTools,
  onApply,
}: {
  disabled: boolean;
  activeTools: ReadonlySet<MaxMarkdownTool>;
  onApply: (tool: MaxMarkdownTool) => void;
}) {
  return (
    <div
      className="channel-suggest-composer__modifier-row"
      role="toolbar"
      aria-label="Форматирование"
    >
      {MAX_MARKDOWN_TOOL_DEFINITIONS.map((tool) => {
        const Icon = icons[tool.id];
        return (
          <button
            key={tool.id}
            type="button"
            className={cn(
              'channel-suggest-composer__modifier',
              activeTools.has(tool.id) && 'is-active',
            )}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onApply(tool.id)}
            disabled={disabled}
            title={tool.title}
            aria-label={tool.title}
            aria-pressed={activeTools.has(tool.id)}
          >
            <Icon aria-hidden focusable="false" />
          </button>
        );
      })}
    </div>
  );
}
