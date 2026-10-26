import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TimeField } from '../../src/components/ui/time-field';
import '../../src/styles.css';

function TimeFieldHarness() {
  const params = new URLSearchParams(window.location.search);
  const [value, setValue] = useState(params.get('value') ?? '12:00');
  return (
    <>
      <TimeField
        label="Время"
        value={value}
        minuteStep={Number(params.get('step') ?? 30)}
        onChange={setValue}
      />
      <output aria-label="Сохранённое время">{value}</output>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<TimeFieldHarness />);
