import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { MapPin, HardDrive, ActivitySquare } from 'lucide-react';

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
        <div className="flex items-center justify-center w-16 h-16 bg-primary-main rounded-full text-white mb-4">
          {icon}
        </div>
        <div className="absolute -top-2 -right-2 w-8 h-8 bg-accent-main rounded-full flex items-center justify-center text-secondary-main font-semibold">
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
      icon: <MapPin className="h-8 w-8" />,
      step: 1,
    },
    {
      title: t('how.step2.title'),
      description: t('how.step2.description'),
      icon: <HardDrive className="h-8 w-8" />,
      step: 2,
    },
    {
      title: t('how.step3.title'),
      description: t('how.step3.description'),
      icon: <ActivitySquare className="h-8 w-8" />,
      step: 3,
    },
  ];

  return (
    <section className="py-20 bg-secondary-main/5">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-4">{t('how.title')}</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 relative">
          {/* Connecting line */}
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
