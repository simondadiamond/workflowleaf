import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { Clock, TrendingDown, CircleDollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';

interface KpiBlockProps {
  icon: React.ReactNode;
  title: string; // Added title prop
  value: string;
  label: string;
  className?: string;
}

function KpiBlock({ icon, title, value, label, className }: KpiBlockProps) {
  return (
    <Card className={cn(
      "p-6 h-full bg-card border border-border", // Added bg-card and border
      className
    )}>
      <div className="flex flex-col items-center text-center">
        {/* Increased icon size */}
        <div className="text-primary-main mb-4"> {/* Increased margin-bottom */}
          {icon}
        </div>
        {/* Added title */}
        <h3 className="text-xl font-semibold mb-2">{title}</h3>
        {/* Removed font-mono */}
        <div className="text-3xl font-medium tracking-tight">
          {value}
        </div>
        {/* Kept label */}
        <p className="text-sm text-muted-foreground mt-2">{label}</p>
      </div>
    </Card>
  );
}

export function KpiStrip() {
  const { t } = useTranslation();

  return (
    <section id="expected-outcomes" className="py-16 bg-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          {/* Updated section title */}
          <h2 className="text-3xl font-bold mb-4">{t('kpi.sectionTitle')}</h2>
          {/* Added intro text */}
          <p className="text-muted-foreground">{t('kpi.introText')}</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <KpiBlock
            // Increased icon size
            icon={<Clock className="h-10 w-10" />}
            title={t('kpi.time_saved.title')}
            value={t('kpi.time_saved.value')}
            label={t('kpi.time_saved.label')}
          />
          <KpiBlock
            // Increased icon size
            icon={<TrendingDown className="h-10 w-10" />}
            title={t('kpi.errors_reduced.title')}
            value={t('kpi.errors_reduced.value')}
            label={t('kpi.errors_reduced.label')}
          />
          <KpiBlock
            // Increased icon size
            icon={<CircleDollarSign className="h-10 w-10" />}
            title={t('kpi.roi.title')}
            value={t('kpi.roi.value')}
            label={t('kpi.roi.label')}
          />
        </div>
        {/* Updated footnote */}
        <p className="text-center text-sm text-muted-foreground mt-8">
          {t('kpi.footnote')}
        </p>
      </div>
    </section>
  );
}
