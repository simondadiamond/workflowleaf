import React from 'react';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
// Removed unused imports: CircuitBoard, Leaf

export function Hero() {
  const { t } = useTranslation();

  // Split the title into two lines based on the newline character
  const titleLines = t('hero.title').split('\n');

  return (
    <section className="pt-32 pb-20 bg-gradient-to-br from-primary-main/10 via-background to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center gap-12">
          <div className="md:w-full text-center space-y-6"> {/* Changed to full width and centered text */}
            <h1 className="text-4xl md:text-6xl font-bold leading-tight"> {/* Increased font size */}
              {/* Render the first line */}
              {titleLines[0]}
              <br /> {/* Add a line break */}
              {/* Render the second line with gradient */}
              <span className="text-gradient-forest-teal">
                {titleLines[1]}
              </span>
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto"> {/* Added max-width and auto margin for centering */}
              {t('hero.subtitle')}
            </p>
            <div className="pt-4">
              <Button
                size="lg"
                asChild
                // Styled to match the solid teal button
                className="text-base bg-primary-main hover:bg-primary-hover text-white"
              >
                <a href="#book">
                  {t('hero.cta')}
                </a>
              </Button>
            </div>
          </div>

          {/* Removed the image/SVG placeholder div */}

        </div>
      </div>
    </section>
  );
}
