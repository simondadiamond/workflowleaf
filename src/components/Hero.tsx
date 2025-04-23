import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

export function Hero() {
  const { t, locale } = useTranslation();

  const titleLines = t('hero.title').split('\n');

  const bookingBaseUrl = locale === 'fr'
    ? 'https://cal.com/workflowleaf/consultation-gratuite'
    : 'https://cal.com/workflowleaf/free-consultation';

  const heroBookingUrl = `${bookingBaseUrl}?source=WebsiteHero`;

  return (
    <section className="pt-32 pb-20 bg-gradient-to-br from-primary-main/20 via-background to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center gap-12">
          <div className="md:w-full text-center space-y-6">
            <h1 className="text-4xl md:text-6xl font-bold leading-tight">
              {titleLines[0]}
              <br />
              <span className="text-gradient-forest-teal">
                {titleLines[1]}
              </span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              {t('hero.subtitle')}
            </p>
            <div className="pt-4">
              <Button
                size="lg"
                asChild
                className="text-base bg-primary-main hover:bg-primary-hover text-white"
              >
                <a href={heroBookingUrl} target="_blank" rel="noopener noreferrer">
                  {t('hero.cta')}
                </a>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
