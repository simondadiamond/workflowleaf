import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Leaf, Mail, Phone } from 'lucide-react';

export function Footer() {
  const { t, locale } = useTranslation();
  
  // Helper to get the right path based on locale
  const getPath = (path: string) => {
    return locale === 'fr' ? `/fr${path}` : path;
  };

  return (
    <footer className="bg-secondary-main text-white">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Logo and company info */}
          <div className="col-span-1 md:col-span-1">
            <div className="flex items-center">
              <Leaf className="h-8 w-8" />
              <span className="ml-2 text-xl font-semibold">WorkflowLeaf</span>
            </div>
            <p className="mt-4 text-sm text-gray-200">
              {t('footer.copyright')}
            </p>
            <div className="mt-4">
              <LanguageToggle className="p-0 text-white hover:text-accent-main" />
            </div>
          </div>

          {/* Quick links */}
          <div className="col-span-1">
            <h3 className="text-lg font-semibold mb-4">{t('footer.links')}</h3>
            <ul className="space-y-2">
              <li>
                <a href={getPath('/')} className="text-gray-200 hover:text-white transition-colors">
                  {t('nav.home')}
                </a>
              </li>
              <li>
                <a href={getPath('/services')} className="text-gray-200 hover:text-white transition-colors">
                  {t('nav.services')}
                </a>
              </li>
              <li>
                <a href={getPath('/pricing')} className="text-gray-200 hover:text-white transition-colors">
                  {t('nav.pricing')}
                </a>
              </li>
              <li>
                <a href={getPath('/contact')} className="text-gray-200 hover:text-white transition-colors">
                  {t('nav.contact')}
                </a>
              </li>
            </ul>
          </div>

          {/* Legal */}
          <div className="col-span-1">
            <h3 className="text-lg font-semibold mb-4">Legal</h3>
            <ul className="space-y-2">
              <li>
                <a href={getPath('/privacy')} className="text-gray-200 hover:text-white transition-colors">
                  {t('footer.privacy')}
                </a>
              </li>
              <li>
                <a href={getPath('/terms')} className="text-gray-200 hover:text-white transition-colors">
                  {t('footer.terms')}
                </a>
              </li>
            </ul>
          </div>

          {/* Contact */}
          <div className="col-span-1">
            <h3 className="text-lg font-semibold mb-4">{t('footer.contact')}</h3>
            <ul className="space-y-3">
              <li className="flex items-center">
                <Mail className="h-5 w-5 mr-2" />
                <a href="mailto:hello@workflowleaf.com" className="text-gray-200 hover:text-white transition-colors">
                  {t('footer.email')}
                </a>
              </li>
              <li className="flex items-center">
                <Phone className="h-5 w-5 mr-2" />
                <a href="tel:+14185551234" className="text-gray-200 hover:text-white transition-colors">
                  +1 418-555-1234
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
}
