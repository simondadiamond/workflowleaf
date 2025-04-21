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

  // Detect scroll to change header appearance
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 10);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Initialize dark mode state
  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);
  }, []);

  // Toggle dark mode
  const toggleDarkMode = () => {
    const newMode = !isDark;
    setIsDark(newMode);
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', newMode ? 'dark' : 'light');
  };

  // Paths for navigation - Using anchor links for sections
  const getAnchorPath = (anchor: string) => {
     // For the home link, use the base path logic
     if (anchor === '/') {
        return locale === 'fr' ? '/fr' : '/';
     }
     // For other anchors, append the anchor to the current locale path
     const base = locale === 'fr' ? '/fr' : '';
     return `${base}${anchor}`;
  };


  const leftNavItems = [
    { label: t('nav.home'), path: getAnchorPath('/') },
    { label: 'Solutions', path: getAnchorPath('#challenges') }, // Anchor to Challenges section
    { label: t('how.title'), path: getAnchorPath('#how-it-works') }, // Anchor to How It Works section
    { label: t('nav.pricing'), path: getAnchorPath('#pricing') }, // Anchor to Pricing section
  ];

  // Note: Language Toggle, Dark Mode Toggle, and Book a Call button are handled separately in JSX

  return (
    <header
      className={cn(
        "fixed w-full top-0 left-0 z-50 transition-all duration-300",
        isScrolled ? "bg-background dark:bg-secondary-main shadow-sm py-3" : "bg-transparent py-5"
      )}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center">
          {/* Logo and Left Navigation */}
          <div className="flex items-center">
            {/* Logo */}
            <a href={getAnchorPath('/')} className="flex items-center">
              <img src="/logo.svg" alt="WorkflowLeaf Logo" className="h-8 w-8 text-primary-main" />
              <span className="ml-2 text-xl font-semibold">WorkflowLeaf</span>
            </a>

            {/* Desktop Left Navigation */}
            <nav className="hidden md:flex items-center ml-8 space-x-6"> {/* Added ml-8 and adjusted space-x */}
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


          {/* Right Navigation (Language, Theme, Book a Call) */}
          {/* Reduced right padding using pr-4 (default is px-4 on parent div) */}
          <div className="flex items-center space-x-4 pr-4 md:pr-0"> {/* Adjusted space-x and padding */}
            {/* Desktop Right Navigation */}
            <div className="hidden md:flex items-center space-x-4"> {/* Adjusted space-x */}
              <LanguageToggle />
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleDarkMode}
              >
                {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </Button>
              {/* Styled the "Book a Call" button the same as the Hero CTA */}
              <Button asChild className="bg-primary-main hover:bg-primary-hover text-white">
                <a href="#book">{t('nav.book')}</a>
              </Button>
            </div>

            {/* Mobile Menu Button (remains on the right) */}
            <div className="flex items-center md:hidden">
               {/* Language and Theme toggles are already on the right in mobile view */}
               <LanguageToggle />
               <Button
                 variant="ghost"
                 size="icon"
                 onClick={toggleDarkMode}
                 className="mr-2" // Keep margin for separation from menu button
               >
                 {isDark ? (
                   <Sun className="h-5 w-5" />
                 ) : (
                   <Moon className="h-5 w-5" />
                 )}
               </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Toggle Menu"
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              >
                {isMobileMenuOpen ? (
                  <X className="h-6 w-6" />
                ) : (
                  <Menu className="h-6 w-6" />
                )}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
         <div className="md:hidden bg-background dark:bg-secondary-main">
          <div className="px-4 pt-2 pb-4 space-y-1">
            {/* Mobile Left Nav Items */}
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
            {/* Styled the mobile "Book a Call" button */}
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
