import React, { useState, useEffect } from 'react';
import { useTranslation } from '@/lib/i18n';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Menu, X, Moon, Sun } from 'lucide-react';

export function Header() {
  const { t, locale } = useTranslation();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [currentPath, setCurrentPath] = useState('');

  useEffect(() => {
    setCurrentPath(window.location.pathname);
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);
  }, []);

  const toggleDarkMode = () => {
    const newMode = !isDark;
    setIsDark(newMode);
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', newMode ? 'dark' : 'light');
  };

  const isLegalPage = currentPath === '/legal' || currentPath === '/fr/legal';

  const getAnchorPath = (anchor: string) => {
    const base = locale === 'fr' ? '/fr' : '';
    if (isLegalPage) {
      if (anchor === '#challenges' || anchor === '#how-it-works' || anchor === '#pricing') {
        return `${base}/${anchor}`;
      }
      if (anchor === '/') {
        return `${base}/`;
      }
      return `${base}${anchor}`;
    }
    if (anchor === '/') {
      return `${base}/`;
    }
    return `${base}${anchor}`;
  };

  const leftNavItems = [
    { label: t('nav.home'), path: getAnchorPath('/') },
    { label: 'Solutions', path: getAnchorPath('#challenges') },
    { label: t('how.title'), path: getAnchorPath('#how-it-works') },
    { label: t('nav.pricing'), path: getAnchorPath('#pricing') },
  ];

  return (
    <header
      className={cn(
        "fixed w-full top-0 left-0 z-50 transition-all duration-300",
        isScrolled ? "bg-background dark:bg-secondary-main shadow-sm py-3" : "bg-transparent py-5"
      )}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center">
          <div className="flex items-center">
            <a href={getAnchorPath('/')} className="flex items-center">
              <img src="/logo.svg" alt="WorkflowLeaf Logo" className="h-8 w-8 text-primary-main" />
              <span className="ml-2 text-xl font-semibold">WorkflowLeaf</span>
            </a>

            <nav className="hidden md:flex items-center ml-8 space-x-6">
              {leftNavItems.map((item) => (
                <a
                  key={item.path}
                  href={item.path}
                  className="text-foreground hover:text-primary-main transition-colors font-medium"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </div>

          <div className="flex items-center space-x-4 pr-4 md:pr-0">
            <div className="hidden md:flex items-center space-x-4">
              <LanguageToggle />
              <Button variant="ghost" size="icon" onClick={toggleDarkMode}>
                {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </Button>
              <Button asChild className="bg-primary-main hover:bg-primary-hover text-white">
                <a href="#book">{t('nav.book')}</a>
              </Button>
            </div>

            <div className="flex items-center md:hidden">
              <LanguageToggle />
              <Button variant="ghost" size="icon" onClick={toggleDarkMode} className="mr-2">
                {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Toggle Menu"
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              >
                {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {isMobileMenuOpen && (
        <div className="md:hidden bg-background dark:bg-secondary-main">
          <div className="px-4 pt-2 pb-4 space-y-1">
            {leftNavItems.map((item) => (
              <a
                key={item.path}
                href={item.path}
                className="block py-2 text-foreground hover:text-primary-main transition-colors font-medium"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                {item.label}
              </a>
            ))}
            <Button className="w-full mt-4 bg-primary-main hover:bg-primary-hover text-white" asChild>
              <a href="#book" onClick={() => setIsMobileMenuOpen(false)}>
                {t('nav.book')}
              </a>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
