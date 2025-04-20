import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { CircuitBoard, Leaf } from 'lucide-react';

export function Hero() {
  const { t } = useTranslation();

  return (
    <section className="pt-32 pb-20 bg-gradient-to-br from-primary-main/10 via-background to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center gap-12">
          <div className="md:w-1/2 space-y-6">
            <h1 className="text-4xl md:text-5xl font-bold leading-tight">
              {t('hero.title')}
            </h1>
            <p className="text-xl text-muted-foreground">
              {t('hero.subtitle')}
            </p>
            <div className="pt-4">
              <Button size="lg" asChild>
                <a href="#book" className="text-base">
                  {t('hero.cta')}
                </a>
              </Button>
            </div>
          </div>
          
          <div className="md:w-1/2 flex justify-center">
            <div className="relative w-[300px] h-[300px] md:w-[400px] md:h-[400px]">
              {/* Leaf outline with circuit board inside */}
              <div className="absolute inset-0 animate-float">
                <div className="relative w-full h-full">
                  {/* Leaf SVG Outline */}
                  <svg 
                    viewBox="0 0 200 200" 
                    fill="none" 
                    xmlns="http://www.w3.org/2000/svg" 
                    className="w-full h-full"
                  >
                    <path 
                      d="M100 10C120 10 160 30 180 100C160 170 120 190 100 190C80 190 40 170 20 100C40 30 80 10 100 10Z" 
                      stroke="#0A9F9D" 
                      strokeWidth="3" 
                      fill="transparent"
                    />
                  </svg>
                  
                  {/* Tech circuit pattern inside */}
                  <div className="absolute inset-[15%] flex items-center justify-center opacity-70">
                    <CircuitBoard className="w-full h-full text-primary-main" />
                  </div>
                  
                  {/* Small leaf in the center */}
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Leaf className="w-16 h-16 text-accent-main animate-pulse" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}