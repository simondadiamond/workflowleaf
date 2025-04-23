import React, { useEffect } from 'react';

export function AnchorScrollHandler() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const hash = window.location.hash;
    if (hash) {
      // Use requestAnimationFrame to ensure DOM is ready before scrolling
      requestAnimationFrame(() => {
        const element = document.getElementById(hash.substring(1));
        if (element) {
          element.scrollIntoView({ behavior: 'smooth' });
        }
      });
    }
  }, []);

  return null;
}
