import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
// Updated icon imports
import { Search, Settings, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils'; // Import cn utility

interface StepCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  step: number;
}

function StepCard({ title, description, icon, step }: StepCardProps) {
  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        {/* Icon color is white */}
        <div className="flex items-center justify-center w-16 h-16 bg-primary-dark rounded-full text-white mb-4">
          {icon}
        </div>
        {/* Updated badge background to accent-light */}
        {/* Added dark:text-black class for dark mode */}
        <div className={cn(
          "absolute -top-2 -right-2 w-8 h-8 bg-accent-main rounded-full flex items-center justify-center text-foreground font-semibold text-white"
        )}>
          {step}
        </div>
      </div>
      <h3 className="text-xl font-semibold mb-2">{title}</h3>
      <p className="text-center text-muted-foreground">{description}</p>
    </div>
  );
}

export function HowItWorks() {
  const { t } = useTranslation();

  const steps = [
    {
      title: t('how.step1.title'),
      description: t('how.step1.description'),
      icon: <Search className="h-8 w-8" />, // Changed icon to Search
      step: 1,
    },
    {
      title: t('how.step2.title'),
      description: t('how.step2.description'),
      icon: <Settings className="h-8 w-8" />, // Changed icon to Settings
      step: 2,
    },
    {
      title: t('how.step3.title'),
      description: t('how.step3.description'),
      icon: <Rocket className="h-8 w-8" />, // Changed icon to Rocket
      step: 3,
    },
  ];

  return (
    <section id="how-it-works" className="py-20 bg-secondary-main/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-4">{t('how.title')}</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 relative">
          {/* Connecting line - Uses theme color bg-accent-main */}
          <div className="absolute top-8 left-1/2 hidden md:block">
            <div className="h-1 bg-accent-main w-[80%] -translate-x-1/2"></div>
          </div>

          {steps.map((step, index) => (
            <StepCard
              key={index}
              title={step.title}
              description={step.description}
              icon={step.icon}
              step={step.step}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
