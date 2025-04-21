import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface PainCardProps {
  title: string;
  description: string;
  iconSrc: string; // Changed to iconSrc for SVG path
  className?: string;
}

function PainCard({ title, description, iconSrc, className }: PainCardProps) {
  return (
    <Card className={cn(
      "p-6 transition-all duration-300 hover:shadow-md hover:border-primary-main",
      className
    )}>
      <div className="flex flex-col items-center text-center">
        <div className="p-3 rounded-full bg-accent-light text-primary-main mb-4">
          {/* Use img tag for SVG */}
          <img 
            src={iconSrc} 
            alt="" // Empty alt as per requirement
            className="h-8 w-8" 
            aria-hidden="true" // Hide decorative icon from screen readers
          />
        </div>
        <h3 className="text-xl font-semibold mb-2">{title}</h3>
        <p className="text-muted-foreground">{description}</p>
      </div>
    </Card>
  );
}

export function PainCards() {
  const { t } = useTranslation();

  const cards = [
    {
      title: t('challenges.rent.title'),
      description: t('challenges.rent.description'),
      iconSrc: '/icons/icon-rent-reminder.svg',
    },
    {
      title: t('challenges.maintenance.title'),
      description: t('challenges.maintenance.description'),
      iconSrc: '/icons/icon-maintenance-triage.svg',
    },
    {
      title: t('challenges.onboarding.title'),
      description: t('challenges.onboarding.description'),
      iconSrc: '/icons/icon-tenant-onboarding.svg',
    },
  ];

  return (
    <section id="challenges" className="py-20 bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          {/* Changed title key */}
          <h2 className="text-3xl font-bold mb-4">{t('challenges.title')}</h2> 
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {cards.map((card, index) => (
            <PainCard
              key={index}
              title={card.title}
              description={card.description}
              iconSrc={card.iconSrc}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
