import { useEffect } from 'react';
import { BRAND } from '../brand';

/**
 * Custom hook to set document title dynamically.
 * Automatically appends the " | <brand name>" suffix.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = `${title} | ${BRAND.name}`;

    return () => {
      document.title = previousTitle;
    };
  }, [title]);
}
