import { useLayoutEffect, useState } from 'react';

/** Detect text scaling without contributing to document layout or scrolling. */
export function useExpandedText(): boolean {
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.textContent = 'M';
    probe.style.cssText =
      'position:fixed;top:0;left:0;visibility:hidden;font-size:1rem;line-height:1;pointer-events:none';
    document.body.append(probe);
    const measure = () => setExpanded(probe.getBoundingClientRect().height > 16.5);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => {
      observer.disconnect();
      probe.remove();
    };
  }, []);
  return expanded;
}
