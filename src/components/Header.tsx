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

  // Initialize currentPath state synchronously on the client
  const [currentPath, setCurrentPath] = useState(() => {
    if (typeof window !== 'undefined') {
      // Clean path: ensure leading slash, remove trailing slash
      return window.location.pathname.replace(/\/+$/, '') || '/';
    }
    return ''; // Default for SSR
  });

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const toggleDarkMode = () => {
    const newMode = !isDark;
    setIsDark(newMode);
    if (newMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  };

  // Check for legal page based on the synchronously initialized currentPath
  const isLegalPage = currentPath === '/legal' || currentPath === '/fr/legal';

  // Helper to build anchor links that work on legal page and others
  const getAnchorPath = (anchor: string) => {
    const base = locale === 'fr' ? '/fr' : '';
    const baseUrl = 'https://workflowleaf.com'; // Define base URL

    let href = '';

    // When on a legal page, always link to the homepage with the full domain
    if (isLegalPage) {
      if (anchor === '#challenges' || anchor === '#how-it-works' || anchor === '#pricing') {
        // Explicitly construct full URL to homepage with anchor
        href = `${baseUrl}${base}/#${anchor.substring(1)}`; // e.g. https://workflowleaf.com/#challenges or https://workflowleaf.com/fr/#challenges
      } else if (anchor === '/') {
        // Link to the root of the site with full domain
        href = `${baseUrl}${base}/`; // e.g. https://workflowleaf.com/ or https://workflowleaf.com/fr/
      } else {
         // For other specific links on legal page if any (e.g. /legal)
         // Ensure these are also absolute if needed, or handle differently
         href = `${baseUrl}${base}${anchor}`;
      }
    } else {
      // If NOT isLegalPage (i.e., on index page), use relative or root-relative paths
      if (anchor === '/') {
        href = `${base}/`; // e.g. / or /fr/
      } else {
        href = `${base}${anchor}`; // e.g. /#pricing or /fr/#pricing
      }
    }
    return href;
  };

  const leftNavItems = [
    { label: t('nav.home'), path: getAnchorPath('/') },
    { label: 'Solutions', path: getAnchorPath('#challenges') },
    { label: t('how.title'), path: getAnchorPath('#how-it-works') },
    { label: t('nav.pricing'), path: getAnchorPath('#pricing') },
  ];

  // Add useEffect to log generated hrefs after mount
  useEffect(() => {
    leftNavItems.forEach(item => {
      console.log(`Header Link (Generated): ${item.label} -> ${item.path}`);
    });
  }, [leftNavItems]);


  // Booking URLs with tracking parameters
  const bookingBaseUrl = locale === 'fr'
    ? 'https://cal.com/workflowleaf/consultation-gratuite'
    : 'https://cal.com/workflowleaf/free-consultation';

  const headerBookingUrl = `${bookingBaseUrl}?source=WebsiteNavbar`;

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
                  // Add onClick handler to force full page navigation on legal pages
                  onClick={(e) => {
                    // Check if current page is legal AND the link is an absolute homepage anchor
                    const isAnchorToHomepage = item.path.startsWith('https://workflowleaf.com/') && item.path.includes('#');
                    const isFrenchAnchorToHomepage = item.path.startsWith('https://workflowleaf.com/fr/') && item.path.includes('#');

                    if (isLegalPage && (isAnchorToHomepage || isFrenchAnchorToHomepage)) {
                       console.log(`Header Link (Clicked): Forcing full navigation for ${item.label} to ${item.path}`); // Debug log
                       e.preventDefault();
                       window.location.href = item.path;
                    } else {
                       console.log(`Header Link (Clicked): Allowing default navigation for ${item.label} to ${item.path}`); // Debug log
                    }
                  }}
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
                <a href={headerBookingUrl} target="_blank" rel="noopener noreferrer">
                  {t('nav.book')}
                </a>
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
                onClick={(e) => {
                   // Check if current page is legal AND the link is an absolute homepage anchor
                   const isAnchorToHomepage = item.path.startsWith('https://workflowleaf.com/') && item.path.includes('#');
                   const isFrenchAnchorToHomepage = item.path.startsWith('https://workflowleaf.com/fr/') && item.path.includes('#');

                   if (isLegalPage && (isAnchorToHomepage || isFrenchAnchorToHomepage)) {
                      console.log(`Header Mobile Link (Clicked): Forcing full navigation for ${item.label} to ${item.path}`); // Debug log
                      e.preventDefault();
                      window.location.href = item.path;
                   } else {
                      console.log(`Header Mobile Link (Clicked): Allowing default navigation for ${item.label} to ${item.path}`); // Debug log
                   }
                  setIsMobileMenuOpen(false); // Close menu after click
                }}
              >
                {item.label}
              </a>
            ))}
            <Button className="w-full mt-4 bg-primary-main hover:bg-primary-hover text-white" asChild>
              <a href={headerBookingUrl} target="_blank" rel="noopener noreferrer" onClick={() => setIsMobileMenuOpen(false)}>
                {t('nav.book')}
              </a>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
