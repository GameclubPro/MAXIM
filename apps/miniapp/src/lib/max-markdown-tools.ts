export type MaxMarkdownTool =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'link';

export const MAX_MARKDOWN_TOOL_DEFINITIONS: Array<{
  id: MaxMarkdownTool;
  label: string;
  title: string;
}> = [
  { id: 'heading', label: 'H', title: 'Заголовок' },
  { id: 'bold', label: 'B', title: 'Жирный' },
  { id: 'italic', label: 'I', title: 'Курсив' },
  { id: 'underline', label: 'U', title: 'Подчеркнутый' },
  { id: 'strike', label: 'S', title: 'Зачеркнутый' },
  { id: 'code', label: '</>', title: 'Код' },
  { id: 'link', label: 'Link', title: 'Ссылка' },
];
