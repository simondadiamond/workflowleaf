import React, { useState } from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Check, Minus } from 'lucide-react'; // Import Minus icon
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge'; // Import Badge

// Define FeatureKey type locally or import if defined elsewhere
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
  | 'pricing.managed.premium.feature8';


interface PricingCardProps {
  title: string;
  price: string;
  period?: string;
  description: string;
  features: string[] | FeatureKey[]; // Accept both string[] (for pilot) and FeatureKey[] (for managed)
  isPrimary?: boolean;
  buttonText: string;
  buttonVariant?: 'default' | 'outline' | 'secondary';
  additionalInfo?: React.ReactNode;
  // New prop to pass the tabs component specifically for Managed Care
  managedTabs?: React.ReactNode;
  // Pass selected plan to identify specific features like the one to bold
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
  managedTabs, // Destructure the new prop
  selectedPlan, // Destructure selectedPlan
}: PricingCardProps) {
  const { t } = useTranslation();

  // Helper to check if a feature is a FeatureKey
  const isFeatureKey = (feature: string | FeatureKey): feature is FeatureKey => {
    return feature.startsWith('pricing.managed.');
  };

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

      {/* Render managedTabs (the Tabs component) here if it exists */}
      {managedTabs && (
        // Reduced padding-bottom
        <div className="mt-6 pb-4 border-b border-border">
          {managedTabs}
        </div>
      )}

      {/* Reduced top margin (mt-6 instead of mt-8) */}
      <ul className="mt-6 space-y-4 flex-grow min-h-[16rem]"> {/* Adjust min-h value as needed */}
        {features.map((featureOrKey, index) => {
          let featureText: string;
          if (isFeatureKey(featureOrKey)) {
            featureText = t(featureOrKey);
          } else {
            // Assume it's a direct string (for pilot features)
            featureText = featureOrKey;
          }

          const isPlaceholder = featureText.startsWith('–');
          const isItalic = featureText.startsWith('*(');
          // Check if the feature text itself contains '**' OR if it's the specific Growth feature
          const isBold = featureText.includes('**') ||
                         (selectedPlan === 'growth' && featureOrKey === 'pricing.managed.growth.feature7');

          // Clean text: remove markers and trim whitespace
          const cleanText = featureText.replace(/\*\*|\*\(|\)\*|–/g, '').trim();

          return (
            // Use 'invisible' class to hide the content but keep the space
            <li key={index} className={cn("flex items-start", isPlaceholder && "invisible")}>
              {isPlaceholder ? (
                // Use Minus icon for placeholder for better alignment
                <Minus className="h-5 w-5 text-muted-foreground flex-shrink-0 mr-2 mt-0.5" />
              ) : (
                <Check className="h-5 w-5 text-accent-dark flex-shrink-0 mr-2 mt-0.5" />
              )}
              <span className={cn(
                isBold ? 'font-bold' : '', // Apply bold if isBold is true
                isItalic ? 'italic text-muted-foreground' : '',
                isPlaceholder ? 'text-muted-foreground' : '' // Ensure placeholder dash is muted
              )}>
                {/* Render empty string for placeholders, otherwise clean text */}
                {isPlaceholder ? '' : cleanText}
              </span>
            </li>
          );
        })}
      </ul>

      {/* additionalInfo is now only for the Pilot card */}
      {additionalInfo && (
        <div className="mt-6 pt-6 border-t border-border">
          {additionalInfo}
        </div>
      )}

      <div className="mt-8">
        <Button
          className={cn(
            "w-full",
            isPrimary ? "bg-primary-main hover:bg-primary-hover text-white" : ""
          )}
          variant={buttonVariant}
          asChild
        >
          <a href="#book">{buttonText}</a>
        </Button>
      </div>
    </Card>
  );
}

// type PlanType moved outside PricingCard as it's used in Pricing component state

export function Pricing() {
  const { t } = useTranslation();
  // Default view is 'essentials'
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('essentials');

  // Pilot features remain as strings from i18n
  const pilotFeatures = t('pricing.pilot.features') as unknown as string[]; // Assuming t returns string[]

  // Updated managedFeatures to use translation keys
  const managedFeatures: Record<PlanType, FeatureKey[]> = {
    essentials: [
      'pricing.managed.essentials.feature1',
      'pricing.managed.essentials.feature2',
      'pricing.managed.essentials.feature3',
      'pricing.managed.essentials.feature4',
      'pricing.managed.essentials.feature5',
      // Removed 'pricing.managed.essentials.feature6'
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
    ],
  };

  const getPlanPrice = (plan: PlanType) => {
    switch (plan) {
      case 'essentials':
        return 'CA $639'; // Example price
      case 'growth':
        return 'CA $1,259'; // Example price
      case 'premium':
        return 'CA $2,279+'; // Example price
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
          <h2 className="text-3xl font-bold mb-4">{t('pricing.title')}</h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          <PricingCard
            title={t('pricing.pilot.title')}
            price={t('pricing.pilot.price')}
            description={t('pricing.pilot.description')}
            // Pilot features are still direct strings from i18n
            features={pilotFeatures}
            buttonText={t('pricing.pilot.button')}
            buttonVariant="secondary"
            additionalInfo={
              <div className="text-sm text-muted-foreground">
                <p>{t('pricing.pilot.upgrade')}</p>
                <Button variant="link" className="mt-2 p-0 h-auto" asChild>
                  <a href="#learn-more">Learn more</a>
                </Button>
              </div>
            }
          />

          <PricingCard
            title={t('pricing.managed.title')}
            price={getPlanPrice(selectedPlan)}
            period="/month"
            description={t('pricing.managed.description')}
            features={managedFeatures[selectedPlan]} // Pass the array of FeatureKeys
            isPrimary={true}
            buttonText={getPlanButton(selectedPlan)}
            selectedPlan={selectedPlan} // Pass selectedPlan down
            // Pass the Tabs component to the new managedTabs prop
            managedTabs={
              <div className="space-y-4">
                <Tabs
                  value={selectedPlan}
                  onValueChange={(value) => setSelectedPlan(value as PlanType)}
                  className="w-full"
                >
                  <TabsList className="grid grid-cols-3 w-full">
                    <TabsTrigger value="essentials">Essentials</TabsTrigger>
                    {/* Add Badge to Growth tab */}
                    <TabsTrigger value="growth" className="relative">
                      Growth
                      {/* Apply the custom badge-popular class */}
                      <Badge className="badge-popular absolute left-1/2 transform -translate-x-1/2 -top-2">
                        Most Popular
                      </Badge>
                    </TabsTrigger>
                    <TabsTrigger value="premium">Premium</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>
            }
          />
        </div>

        <div className="text-center mt-12 text-sm text-muted-foreground">
          {/* Render the addons text directly for simplicity */}
          <p>
            {t('pricing.addons')}
          </p>
        </div>
      </div>
    </section>
  );
}
