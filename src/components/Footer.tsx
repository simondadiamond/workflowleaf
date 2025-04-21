import React from 'react';
import { useTranslation } from '@/lib/i18n';

export function Footer() {
  const { t, locale } = useTranslation();
  const getAnchorPath = (path: string) =>
    locale === 'fr' ? `/fr${path}` : path;

  const navLinks = [
    { label: t('nav.home'), path: getAnchorPath('/') },
    { label: 'Solutions',       path: getAnchorPath('#challenges') },
    { label: t('how.title'),    path: getAnchorPath('#how-it-works') },
    { label: t('nav.pricing'),  path: getAnchorPath('#pricing') },
  ];

  return (
    <footer className="bg-secondary-main text-white">
      <div className="max-w-3xl mx-auto py-4 px-4 text-center">
        {/* Logo + Brand */}
        <div className="inline-flex items-center space-x-2 mb-2">
          <img
            src="/logo.svg"
            alt="WorkflowLeaf Logo"
            className="h-6 w-6"
          />
          <span className="text-base font-medium">WorkflowLeaf</span>
        </div>

        {/* Nav Links */}
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

        {/* Legal + Copyright */}
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
