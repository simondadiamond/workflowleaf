import React, { useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

type FeatureKey =
  | 'pricing.managed.essentials.feature1'
  | 'pricing.managed.essentials.feature2'
  | 'pricing.managed.essentials.feature3'
  | 'pricing.managed.essentials.feature4'
  | 'pricing.managed.essentials.feature5'
  | 'pricing.managed.essentials.feature6'
  | 'pricing.managed.essentials.feature7'
  | 'pricing.managed.essentials.feature8'
  | 'pricing.managed.growth.feature1'
  | 'pricing.managed.growth.feature2'
  | 'pricing.managed.growth.feature3'
  | 'pricing.managed.growth.feature4'
  | 'pricing.managed.growth.feature5'
  | 'pricing.managed.growth.feature6'
  | 'pricing.managed.growth.feature7'
  | 'pricing.managed.growth.feature8'
  | 'pricing.managed.premium.feature1'
  | 'pricing.managed.premium.feature2'
  | 'pricing.managed.premium.feature3'
  | 'pricing.managed.premium.feature4'
  | 'pricing.managed.premium.feature5'
  | 'pricing.managed.premium.feature6'
  | 'pricing.managed.premium.feature7'
  | 'pricing.managed.premium.feature8'
  | 'pricing.managed.premium.feature9'
  | 'pricing.addons';

interface PricingCardProps {
  title: string;
  price: string;
  period?: string;
  description: string;
  features: string[] | FeatureKey[];
  isPrimary?: boolean;
  buttonText: string;
  buttonVariant?: 'default' | 'outline' | 'secondary';
  additionalInfo?: React.ReactNode;
  managedTabs?: React.ReactNode;
  selectedPlan?: PlanType;
}

type PlanType = 'essentials' | 'growth' | 'premium';

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
  managedTabs,
  selectedPlan,
}: PricingCardProps) {
  const { t, locale } = useTranslation();

  const isFeatureKey = (feature: string | FeatureKey): feature is FeatureKey => {
    return feature.startsWith('pricing.managed.');
  };

  // Base booking URL depending on locale
  const bookingBaseUrl = locale === 'fr'
    ? 'https://cal.com/workflowleaf/consultation-gratuite'
    : 'https://cal.com/workflowleaf/free-consultation';

  // Helper to get package param for managed plans
  const getPackageParam = (plan: PlanType | 'quickstart' | 'pilot') => {
    switch (plan) {
      case 'quickstart':
        return 'QuickStart';
      case 'essentials':
        return 'Essentials';
      case 'growth':
        return 'Growth';
      case 'premium':
        return 'Premium';
      case 'pilot':
      default:
        return null;
    }
  };

  // Compose href for pricing buttons
  const getHref = () => {
    if (title === t('pricing.pilot.title')) {
      // Pilot plan button
      return `${bookingBaseUrl}?source=WebsitePricing&package=QuickStart`;
    }
    if (selectedPlan) {
      const pkg = getPackageParam(selectedPlan);
      if (pkg) {
        return `${bookingBaseUrl}?source=WebsitePricing&package=${pkg}`;
      }
    }
    // Fallback
    return `${bookingBaseUrl}?source=WebsitePricing`;
  };

  return (
    <Card
      className={cn(
        'p-8 h-full flex flex-col border-2 transition-all duration-300 hover:shadow-md',
        isPrimary ? 'border-primary-main' : 'border-border hover:border-primary-light'
      )}
    >
      <div>
        <h3 className="text-2xl font-bold">{title}</h3>
        <div className="mt-4 flex items-baseline">
          <span className="text-4xl font-bold">{price}</span>
          {period && <span className="ml-1 text-lg text-muted-foreground">{period}</span>}
        </div>
        <p className="mt-4 text-muted-foreground">{description}</p>
      </div>

      {managedTabs && <div className="mt-6 pb-4 border-b border-border">{managedTabs}</div>}

      <ul className="mt-6 space-y-4 flex-grow min-h-[16rem]">
        {features.map((featureOrKey, index) => {
          let featureText: string;
          if (isFeatureKey(featureOrKey)) {
            featureText = t(featureOrKey);
          } else {
            featureText = featureOrKey;
          }

          const isPlaceholder = featureText.startsWith('–');
          const isItalic = featureText.startsWith('*(');
          const isBold =
            featureText.includes('**') ||
            (selectedPlan === 'growth' && featureOrKey === 'pricing.managed.growth.feature7');

          const cleanText = featureText.replace(/\*\*|\*\(|\)\*|–/g, '').trim();

          // Determine icon: Minus for placeholder, Asterisk text for italic (*() start), Check otherwise
          const IconComponent = isPlaceholder
            ? () => <Minus className="h-5 w-5 text-muted-foreground flex-shrink-0 mr-2 mt-0.5" />
            : isItalic
            ? () => (
                <span
                  className="flex-shrink-0 mr-2 mt-0.5 text-muted-foreground text-lg leading-none select-none"
                  aria-label="Addon feature"
                  title="Addon feature"
                  style={{ lineHeight: 1, userSelect: 'none' }}
                >
                  *
                </span>
              )
            : () => <Check className="h-5 w-5 text-accent-dark flex-shrink-0 mr-2 mt-0.5" />;

          return (
            <li key={index} className={cn('flex items-start', isPlaceholder && 'invisible')}>
              <IconComponent />
              <span
                className={cn(
                  isBold ? 'font-bold' : '',
                  isItalic ? 'italic text-muted-foreground' : '',
                  isPlaceholder ? 'text-muted-foreground' : ''
                )}
              >
                {isPlaceholder ? '' : cleanText}
              </span>
            </li>
          );
        })}
      </ul>

      {additionalInfo && <div className="mt-6 pt-6 border-t border-border">{additionalInfo}</div>}

      <div className="mt-8">
        <Button
          className={cn('w-full', isPrimary ? 'bg-primary-main hover:bg-primary-hover text-white' : '')}
          variant={buttonVariant}
          asChild
        >
          <a href={getHref()} target="_blank" rel="noopener noreferrer">
            {buttonText}
          </a>
        </Button>
      </div>
    </Card>
  );
}

export function Pricing() {
  const { t } = useTranslation();
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('essentials');

  const pilotFeatures = t('pricing.pilot.features') as unknown as string[];

  const managedFeatures: Record<PlanType, FeatureKey[]> = {
    essentials: [
      'pricing.managed.essentials.feature1',
      'pricing.managed.essentials.feature2',
      'pricing.managed.essentials.feature3',
      'pricing.managed.essentials.feature4',
      'pricing.managed.essentials.feature5',
      'pricing.managed.essentials.feature6',
      'pricing.managed.essentials.feature7',
      'pricing.managed.essentials.feature8',
    ],
    growth: [
      'pricing.managed.growth.feature1',
      'pricing.managed.growth.feature2',
      'pricing.managed.growth.feature3',
      'pricing.managed.growth.feature4',
      'pricing.managed.growth.feature5',
      'pricing.managed.growth.feature6',
      'pricing.managed.growth.feature7',
      'pricing.managed.growth.feature8',
    ],
    premium: [
      'pricing.managed.premium.feature1',
      'pricing.managed.premium.feature2',
      'pricing.managed.premium.feature3',
      'pricing.managed.premium.feature4',
      'pricing.managed.premium.feature5',
      'pricing.managed.premium.feature6',
      'pricing.managed.premium.feature7',
      'pricing.managed.premium.feature8',
      'pricing.managed.premium.feature9',
    ],
  };

  const getPlanPrice = (plan: PlanType) => {
    switch (plan) {
      case 'essentials':
        return t('pricing.managed.essentials.price');
      case 'growth':
        return t('pricing.managed.growth.price');
      case 'premium':
        return t('pricing.managed.premium.price');
    }
  };

  const getPlanButton = (plan: PlanType) => {
    switch (plan) {
      case 'essentials':
        return t('pricing.managed.essentials.button');
      case 'growth':
        return t('pricing.managed.growth.button');
      case 'premium':
        return t('pricing.managed.premium.button');
    }
  };

  // New function to get dynamic description based on selectedPlan
  const getPlanDescription = (plan: PlanType) => {
    switch (plan) {
      case 'essentials':
        return t('pricing.managed.description.essentials');
      case 'growth':
        return t('pricing.managed.description.growth');
      case 'premium':
        return t('pricing.managed.description.premium');
    }
  };

  return (
    <section className="py-20 bg-background" id="pricing">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-4">{t('pricing.title')}</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          <PricingCard
            title={t('pricing.pilot.title')}
            price={t('pricing.pilot.price')}
            description={t('pricing.pilot.description')}
            features={pilotFeatures}
            buttonText={t('pricing.pilot.button')}
            buttonVariant="secondary"
          />

          <PricingCard
            title={t('pricing.managed.title')}
            price={getPlanPrice(selectedPlan)}
            period={t('pricing.managed.period')}
            description={getPlanDescription(selectedPlan)}
            isPrimary={true}
            buttonText={getPlanButton(selectedPlan)}
            selectedPlan={selectedPlan}
            features={managedFeatures[selectedPlan]}
            managedTabs={
              <div className="space-y-4">
                <Tabs
                  value={selectedPlan}
                  onValueChange={(value) => setSelectedPlan(value as PlanType)}
                  className="w-full"
                >
                  <TabsList className="grid grid-cols-3 w-full">
                    <TabsTrigger value="essentials">{t('pricing.managed.essentials.tab')}</TabsTrigger>
                    <TabsTrigger value="growth" className="relative">
                      {t('pricing.managed.growth.tab')}
                      <Badge className="badge-popular absolute left-1/2 transform -translate-x-1/2 -top-2">
                        {t('pricing.managed.growth.popular')}
                      </Badge>
                    </TabsTrigger>
                    <TabsTrigger value="premium">{t('pricing.managed.premium.tab')}</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            }
          />
        </div>
      </div>
    </section>
  );
}
