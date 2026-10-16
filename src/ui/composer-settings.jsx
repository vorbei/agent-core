// The composer's settings popover: a disclosure that closes on an outside pointer or Escape. Its
// content is the product's (ChatSlots.settings). From X Gardener chat/composer-settings.jsx.
import React, { useEffect, useRef } from 'react';

export function ComposerSettings({ children, trigger, label = 'Chat settings' }) {
  const ref = useRef(null);
  useEffect(() => {
    const closeOutside = event => {
      if (!ref.current?.contains(event.target)) ref.current?.removeAttribute('open');
    };
    const escape = event => {
      if (event.key !== 'Escape' || !ref.current?.hasAttribute('open')) return;
      ref.current.removeAttribute('open');
      ref.current.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  return <details ref={ref} className="chat-composer-settings">
    <summary aria-label={label} title={label}>{trigger}</summary>
    <section aria-label={label}>{children}</section>
  </details>;
}
