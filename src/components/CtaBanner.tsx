import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

export function CtaBanner() {
  const { t } = useTranslation();

  return (
    <section
      id="book"
      // Use Tailwind classes mapped to theme colors via CSS variables
      className="py-16 bg-gradient-to-r from-primary-main to-accent-main"
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h2 className="text-3xl font-bold text-white mb-6">
          {t('cta.title')}
        </h2>
        <Button
          size="lg"
          // Use Tailwind classes mapped to theme colors via CSS variables
          className="bg-white text-primary-main hover:bg-gray-100"
          asChild
        >
          <a
            href="https://calendly.com/workflowleaf/15min"
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
