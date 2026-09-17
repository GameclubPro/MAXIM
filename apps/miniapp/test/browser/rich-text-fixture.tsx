import '../../src/styles.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MaxRichTextEditor } from '../../src/components/max-rich-text-editor';
import { MaxMarkdownPreview } from '../../src/components/max-markdown-preview';

function Fixture() {
  const [value, setValue] = useState('');
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 16 }}>
      <MaxRichTextEditor
        value={value}
        onChange={setValue}
        maxLength={4000}
        placeholder="Greeting"
        ariaLabel="Greeting"
      />
      <MaxMarkdownPreview value={value} preserveLinks />
      <output data-testid="markdown" style={{ display: 'none' }}>
        {value}
      </output>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
