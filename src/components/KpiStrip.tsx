import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { Clock, TrendingDown, CircleDollarSign } from 'lucide-react';
import { cn } from '@/lib/utils';

interface KpiBlockProps {
  icon: React.ReactNode;
  value: string;
  label: string;
  className?: string;
}

function KpiBlock({ icon, value, label, className }: KpiBlockProps) {
  return (
    <Card className={cn(
      "p-6 h-full",
      className
    )}>
      <div className="flex flex-col items-center text-center">
        <div className="text-primary-main mb-2">
          {icon}
        </div>
        <div className="text-4xl font-mono font-medium tracking-tight">
          <span className="text-sm text-muted-foreground">est.</span> {value}
        </div>
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
          <h2 className="text-3xl font-bold mb-4">{t('kpi.title')}</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <KpiBlock
            icon={<Clock className="h-8 w-8" />}
            value="≈ 15"
            label={t('kpi.hours')}
          />
          <KpiBlock
            icon={<TrendingDown className="h-8 w-8" />}
            value="– 40%"
            label={t('kpi.errors')}
          />
          <KpiBlock
            icon={<CircleDollarSign className="h-8 w-8" />}
            value="2"
            label={t('kpi.breakeven')}
          />
        </div>
        <p className="text-center text-sm text-muted-foreground mt-8">
          {t('kpi.disclaimer')}
        </p>
      </div>
    </section>
  );
}
