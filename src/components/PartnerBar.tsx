// src/components/PartnerBar.tsx

import React from 'react';
import { useTranslation } from '@/lib/i18n';

export function PartnerBar() {
  const { t } = useTranslation();

  const partners = [
    {
      name: 'Google for Startups',
      logo: 'https://github.com/simondadiamond/workflowleaf-assets/blob/5bc58a591cdc39c92bcc654a6564abf841a71367/partner-bar/Google%20Cloud%20Startups.png?raw=true',
    },
    {
      name: 'Microsoft for Startups',
      logo: 'https://github.com/simondadiamond/workflowleaf-assets/blob/1ae5d2c4fc3b285cdd60ed5b3c986f0e14a3c4b7/partner-bar/Microsoft%20Startups.png?raw=true',
    },
    {
      name: 'DigitalOcean Hatch',
      logo: 'https://github.com/simondadiamond/workflowleaf-assets/blob/07e0a1d79616959fc3294b71c06da22e0078914d/partner-bar/hatch.png?raw=true',
    },
    {
      name: 'Stripe',
      logo: 'https://github.com/simondadiamond/workflowleaf-assets/blob/1ae5d2c4fc3b285cdd60ed5b3c986f0e14a3c4b7/partner-bar/Stripe%20Logo.svg?raw=true',
    },
    {
      name: 'Airtable',
      logo: 'https://github.com/simondadiamond/workflowleaf-assets/blob/1ae5d2c4fc3b285cdd60ed5b3c986f0e14a3c4b7/partner-bar/Airtable.png?raw=true',
    },
  ];

  const numberOfRepetitions = 6;
  const repeatedPartners = Array(numberOfRepetitions).fill(partners).flat();

  return (
    <section className="pb-12 bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <h2 className="text-center text-sm font-semibold tracking-wider uppercase font-mono mb-8">
          {t('partners.title', 'Trusted & Supported By')}
        </h2>

        <div className="overflow-hidden w-full">
          <div className="flex w-max animate-scroll space-x-24 items-center">
            {repeatedPartners.map((partner, index) => (
              <div
                key={`${partner.name}-${index}-${Math.random()}`}
                className="flex-shrink-0 h-9 w-auto grayscale opacity-70 hover:grayscale-0 hover:opacity-100 transition-all duration-300"
                title={partner.name}
              >
                <img
                  src={partner.logo}
                  alt={`${partner.name} logo`}
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
