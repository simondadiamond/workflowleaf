import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

export function CtaBanner() {
  const { t } = useTranslation();

  return (
    <section
      id="book"
      // Changed background to match the pricing section (bg-background)
      className="py-16 bg-background text-foreground"
    >
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        {/* Explicitly set text color to foreground */}
        <h2 className="text-3xl font-bold text-foreground mb-6">
          {t('cta.title')}
        </h2>
        <Button
          size="lg"
          // Styled as a primary button (teal background, white text)
          className="bg-primary-main hover:bg-primary-hover text-white"
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
