import React, { useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface PricingCardProps {
  title: string;
  price: string;
  period?: string;
  description: string;
  features: string[];
  isPrimary?: boolean;
  buttonText: string;
  buttonVariant?: 'default' | 'outline';
  additionalInfo?: React.ReactNode;
}

function PricingCard({
  title,
  price,
  period,
  description,
  features,
  isPrimary = false,
  buttonText,
  buttonVariant = 'default',
  additionalInfo,
}: PricingCardProps) {
  return (
    <Card className={cn(
      "p-8 h-full flex flex-col border-2 transition-all duration-300 hover:shadow-md",
      isPrimary 
        ? "border-primary-main" 
        : "border-border hover:border-primary-light"
    )}>
      <div>
        <h3 className="text-2xl font-bold">{title}</h3>
        <div className="mt-4 flex items-baseline">
          <span className="text-4xl font-bold">{price}</span>
          {period && <span className="ml-1 text-lg text-muted-foreground">{period}</span>}
        </div>
        <p className="mt-4 text-muted-foreground">{description}</p>
      </div>
      
      <ul className="mt-8 space-y-4 flex-grow">
        {features.map((feature, index) => (
          <li key={index} className="flex items-start">
            <Check className="h-5 w-5 text-primary-main flex-shrink-0 mr-2 mt-0.5" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {additionalInfo && (
        <div className="mt-6 pt-6 border-t border-border">
          {additionalInfo}
        </div>
      )}
      
      <div className="mt-8">
        <Button 
          className={cn("w-full", isPrimary ? "bg-primary-main hover:bg-primary-hover" : "")} 
          variant={buttonVariant}
          asChild
        >
          <a href="#book">{buttonText}</a>
        </Button>
      </div>
    </Card>
  );
}

type PlanType = 'essentials' | 'growth' | 'premium';

export function Pricing() {
  const { t } = useTranslation();
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('essentials');

  const pilotFeatures = [
    '90-minute deep-dive + ROI worksheet',
    'Process map & recommendations',
    'Build 1 foundational n8n workflow',
    '14-day email support',
    'Bilingual service (EN/FR)',
  ];

  const managedFeatures = {
    essentials: [
      '24/7 health checks for all workflows',
      'Monthly performance reviews',
      '2 support hours/month included',
      'Quarterly ROI report',
      'Bilingual service (EN/FR)',
    ],
    growth: [
      '24/7 health checks for all workflows',
      'Monthly performance reviews',
      '5 support hours/month',
      'One new simple workflow every 2 months',
      'Quarterly ROI report',
      'Bilingual service (EN/FR)',
    ],
    premium: [
      '24/7 health checks for all workflows',
      '10+ dedicated hours/month',
      'Priority support (<4h response)',
      'AI chat agent fine-tuning',
      'Voice-bot monitoring',
      'Monthly strategic roadmap call',
      'Bilingual service (EN/FR)',
    ],
  };

  const getPlanPrice = (plan: PlanType) => {
    switch (plan) {
      case 'essentials':
        return 'CA $650';
      case 'growth':
        return 'CA $1,250';
      case 'premium':
        return 'CA $2,250+';
    }
  };

  const getPlanButton = (plan: PlanType) => {
    switch (plan) {
      case 'essentials':
        return 'Start Essentials';
      case 'growth':
        return 'Start Growth';
      case 'premium':
        return 'Request Premium Quote';
    }
  };

  return (
    <section className="py-20 bg-background" id="pricing">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-4">Transparent Pricing</h2>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          <PricingCard
            title="Pilot Diagnostic"
            price="CA $950"
            description="One-time assessment and first workflow (≤8 nodes, 1 integration)"
            features={pilotFeatures}
            buttonText="Book Discovery"
            buttonVariant="outline"
            additionalInfo={
              <div className="text-sm text-muted-foreground">
                <p>Need more? Full Automation Setup starts at CA $2,400 for up to 2 workflows.</p>
                <Button variant="link" className="mt-2 p-0 h-auto" asChild>
                  <a href="#learn-more">Learn more</a>
                </Button>
              </div>
            }
          />
          
          <PricingCard
            title="Managed Care"
            price={getPlanPrice(selectedPlan)}
            period="/month"
            description="Monitoring, optimisation and incremental improvements"
            features={managedFeatures[selectedPlan]}
            isPrimary={true}
            buttonText={getPlanButton(selectedPlan)}
            additionalInfo={
              <div className="space-y-4">
                <Tabs
                  value={selectedPlan}
                  onValueChange={(value) => setSelectedPlan(value as PlanType)}
                  className="w-full"
                >
                  <TabsList className="grid grid-cols-3 w-full">
                    <TabsTrigger value="essentials">Essentials</TabsTrigger>
                    <TabsTrigger value="growth">Growth</TabsTrigger>
                    <TabsTrigger value="premium">Premium</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            }
          />
        </div>

        <div className="text-center mt-12 text-sm text-muted-foreground">
          <p>
            Need Chat or Voice Bot creation?{' '}
            <a href="#addons" className="text-primary-main hover:underline">
              Premium Add-On Projects
            </a>
            {' '}start at CA $4,500 (Chat) and CA $6,500 (Voice). Contact us for details.
          </p>
        </div>
      </div>
    </section>
  );
}
