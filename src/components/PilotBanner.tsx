import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { Star } from 'lucide-react';

export function PilotBanner() {
  const { t } = useTranslation();

  return (
    <section className="py-16 bg-secondary-main/5">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <Card className="p-8 text-center border-2 border-primary-main">
          <div className="flex justify-center mb-4">
            <Star className="h-8 w-8 text-primary-main fill-primary-main" />
          </div>
          <h2 className="text-2xl font-bold mb-4">{t('pilot.title')}</h2>
          <p className="text-lg text-muted-foreground">
            {t('pilot.description')}
          </p>
        </Card>
      </div>
    </section>
  );
}
