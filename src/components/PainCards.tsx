import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
// Import Lucide icons
import { Clock, Settings, UserPlus } from 'lucide-react';

interface PainCardProps {
  title: string;
  description: string;
  icon: React.ReactNode; // Changed to accept a React Node for the icon
  className?: string;
}

function PainCard({ title, description, icon, className }: PainCardProps) {
  return (
    <Card className={cn(
      "p-6 transition-all duration-300 hover:shadow-md hover:border-primary-main",
      className
    )}>
      <div className="flex flex-col items-center text-center">
        {/* Updated icon color to white */}
        {/* Background is primary-dark, icon color is white */}
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary-dark text-white mb-4">
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
      title: t('challenges.rent.title'),
      description: t('challenges.rent.description'),
      icon: <Clock className="h-8 w-8" />, // Using Clock icon
    },
    {
      title: t('challenges.maintenance.title'),
      description: t('challenges.maintenance.description'),
      icon: <Settings className="h-8 w-8" />, // Using Settings icon
    },
    {
      title: t('challenges.onboarding.title'),
      description: t('challenges.onboarding.description'),
      icon: <UserPlus className="h-8 w-8" />, // Using UserPlus icon
    },
  ];

  return (
    <section id="challenges" className="py-20 bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-4">{t('challenges.title')}</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {cards.map((card, index) => (
            <PainCard
              key={index}
              title={card.title}
              description={card.description}
              icon={card.icon} // Passing the icon component
            />
          ))}
        </div>
      </div>
    </section>
  );
}
