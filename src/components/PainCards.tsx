import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { CircleDollarSign, Clock, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PainCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  className?: string;
}

function PainCard({ title, description, icon, className }: PainCardProps) {
  return (
    <Card className={cn(
      "p-6 transition-all duration-300 hover:shadow-md hover:border-primary-main",
      className
    )}>
      <div className="flex flex-col items-center text-center">
        <div className="p-3 rounded-full bg-accent-light text-primary-main mb-4">
          {icon}
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
      title: t('pain.card1.title'),
      description: t('pain.card1.description'),
      icon: <CircleDollarSign className="h-8 w-8" />,
    },
    {
      title: t('pain.card2.title'),
      description: t('pain.card2.description'),
      icon: <Wrench className="h-8 w-8" />,
    },
    {
      title: t('pain.card3.title'),
      description: t('pain.card3.description'),
      icon: <Clock className="h-8 w-8" />,
    },
  ];

  return (
    <section className="py-20 bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-4">{t('pain.title')}</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {cards.map((card, index) => (
            <PainCard
              key={index}
              title={card.title}
              description={card.description}
              icon={card.icon}
            />
          ))}
        </div>
      </div>
    </section>
  );
}