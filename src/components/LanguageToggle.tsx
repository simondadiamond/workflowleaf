import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface LanguageToggleProps {
  className?: string;
}

export function LanguageToggle({ className }: LanguageToggleProps) {
  const { toggleLocale, t } = useTranslation();

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggleLocale}
      className={cn("font-medium", className)}
    >
      {t('language.toggle')}
    </Button>
  );
}
