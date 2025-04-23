import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

export function CtaBanner() {
  const { t, locale } = useTranslation();

  const bookingBaseUrl = locale === 'fr'
    ? 'https://cal.com/workflowleaf/consultation-gratuite'
    : 'https://cal.com/workflowleaf/free-consultation';

  const ctaBookingUrl = `${bookingBaseUrl}?source=WebsiteCtaBanner`;

  return (
    <section
      id="book"
      className="py-16 bg-background text-foreground"
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl font-bold text-foreground mb-6">
          {t('cta.title')}
        </h2>
        <Button
          size="lg"
          className="bg-primary-main hover:bg-primary-hover text-white"
          asChild
        >
          <a
            href={ctaBookingUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('cta.button')}
          </a>
        </Button>
      </div>
    </section>
  );
}
