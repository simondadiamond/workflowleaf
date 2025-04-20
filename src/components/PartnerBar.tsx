import React from 'react';
import { useTranslation } from '@/lib/i18n';

export function PartnerBar() {
  const { t } = useTranslation();

  const partners = [
    {
      name: 'Google for Startups',
      logo: 'https://storage.googleapis.com/gweb-uniblog-publish-prod/images/Google_for_Startups.max-1000x1000.png',
    },
    {
      name: 'Microsoft for Startups',
      logo: 'https://startups.microsoft.com/wp-content/uploads/2021/05/microsoft-for-startups-logo.png',
    },
    {
      name: 'DigitalOcean Hatch',
      logo: 'https://www.digitalocean.com/static/media/do-logo.0ad86755.svg',
    },
    {
      name: 'AWS Activate',
      logo: 'https://d1.awsstatic.com/logos/aws-activate-logo.1024x512.png',
    },
  ];

  return (
    <section className="py-12 bg-background border-y border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="text-center text-sm font-semibold tracking-wider uppercase font-mono mb-8">
          {t('partners.title')}
        </h2>
        <div className="flex overflow-hidden">
          <div className="flex animate-scroll space-x-16 items-center">
            {[...partners, ...partners].map((partner, index) => (
              <div
                key={index}
                className="flex-shrink-0 h-12 w-auto grayscale opacity-70 hover:grayscale-0 hover:opacity-100 transition-all duration-300"
              >
                <img
                  src={partner.logo}
                  alt={partner.name}
                  className="h-full w-auto object-contain"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}