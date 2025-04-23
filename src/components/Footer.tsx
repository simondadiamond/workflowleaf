import React from 'react';
import { useTranslation } from '@/lib/i18n';

export function Footer() {
  const { t, locale } = useTranslation();

  // Initialize currentPath state synchronously on the client
  const [currentPath, setCurrentPath] = React.useState(() => {
    if (typeof window !== 'undefined') {
      // Clean path: ensure leading slash, remove trailing slash
      return window.location.pathname.replace(/\/+$/, '') || '/';
    }
    return ''; // Default for SSR
  });

  // Check for legal page based on the synchronously initialized currentPath
  const isLegalPage = currentPath === '/legal' || currentPath === '/fr/legal';

  // Helper to build anchor links that work on legal page and others
  const getAnchorPath = (path: string) => {
    const base = locale === 'fr' ? '/fr' : '';
    let href = '';

    if (isLegalPage) {
      // On legal page, anchors like #pricing do not exist, so link to homepage + anchor
      if (path === '#challenges' || path === '#how-it-works' || path === '#pricing') {
        href = `${base}/#${path.substring(1)}`; // e.g. /#pricing or /fr/#pricing
      } else if (path === '/') {
        href = `${base}/`; // e.g. / or /fr/
      } else {
        href = `${base}${path}`; // For other specific links on legal page if any
      }
    } else {
      // If NOT isLegalPage (i.e., on index page)
      if (path === '/') {
        href = `${base}/`;
      } else {
        href = `${base}${path}`;
      }
    }
    return href;
  };

  const navLinks = [
    { label: t('nav.home'), path: getAnchorPath('/') },
    { label: 'Solutions', path: getAnchorPath('#challenges') },
    { label: t('how.title'), path: getAnchorPath('#how-it-works') },
    { label: t('nav.pricing'), path: getAnchorPath('#pricing') },
  ];

  return (
    <footer className="bg-secondary-main text-white">
      <div className="max-w-3xl mx-auto py-4 px-4 text-center">
        <div className="inline-flex items-center space-x-2 mb-2">
          <img
            src="/logo.svg"
            alt="WorkflowLeaf Logo"
            className="h-8 w-8 footer-logo"
          />
          <span className="text-base font-medium">WorkflowLeaf</span>
        </div>

        <nav className="flex flex-wrap justify-center gap-4 text-neutral-textLight text-sm mb-2">
          {navLinks.map(link => (
            <a
              key={link.path}
              href={link.path}
              className="hover:text-white transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="text-xs text-neutral-textLight">
          <a
            href={getAnchorPath('/legal')}
            className="hover:text-white transition-colors"
          >
            {t('footer.legal')}
          </a>
          <span className="mx-1">•</span>
          © {new Date().getFullYear()} WorkflowLeaf
        </div>
      </div>
    </footer>
  );
}
