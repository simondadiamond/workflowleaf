// src/components/PartnerBar.jsx (or your preferred path)

import React from 'react';
// Make sure this path matches your project structure for i18n
import { useTranslation } from '@/lib/i18n'; 

export function PartnerBar() {
  // Initialize the translation hook
  const { t } = useTranslation();

  // Define the list of partners
  const partners = [
    {
      name: 'Google for Startups',
      logo: 'https://github.com/simondadiamond/workflowleaf-assets/blob/dd300a69ecf458c7dfc7950569cc29ae7985e0b0/google_for_startups.png?raw=true',
    },
    {
      name: 'Microsoft for Startups',
      logo: 'https://github.com/simondadiamond/workflowleaf-assets/blob/dd300a69ecf458c7dfc7950569cc29ae7985e0b0/ms_startups.webp?raw=true',
    },
    {
      name: 'DigitalOcean Hatch',
      logo: 'https://github.com/simondadiamond/workflowleaf-assets/blob/d33a71244a18024b2d6ac2c8925f5d1bd541dcfb/hatch.png?raw=true',
    },
    // Add more partners here if needed
  ];

  // *** INCREASED DUPLICATION ***
  // Repeat the original partners array multiple times (e.g., 4 times)
  // This creates a much longer strip: [p1, p2, p3, p1, p2, p3, p1, p2, p3, p1, p2, p3]
  // Use Array.fill() and flat() for a concise way to repeat
  const numberOfRepetitions = 4; // Adjust this number if needed (3, 5, 6...)
  const repeatedPartners = Array(numberOfRepetitions).fill(partners).flat(); 

  return (
    <section className="pb-12 bg-background"> {/* Section background and padding */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8"> {/* Centered content container */}
        
        {/* Section Title */}
        <h2 className="text-center text-sm font-semibold tracking-wider uppercase font-mono mb-8">
          {/* Use translation key with a fallback text */}
          {t('partners.title', 'Trusted & Supported By')} 
        </h2>

        {/* Marquee Container: Masks the overflow */}
        <div className="overflow-hidden w-full"
             style={{ 
               // Optional: Add gradient masks for a fade-out effect if desired
               // maskImage: 'linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)',
               // WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 10%, black 90%, transparent 100%)' 
             }}
        >
          {/* Scrolling Element: Contains REPEATED logos and applies animation */}
          {/* Keep animate-scroll linked to the keyframes translating by -50% (or adjust if needed) */}
          <div className="flex w-max animate-scroll space-x-24 items-center"> 
            {/* Adjust space-x-24 if the spacing seems too large or small */}
            
            {/* Map through the REPEATED partners array */}
            {repeatedPartners.map((partner, index) => (
              <div
                // Using name, index, and Math.random() for a very robust unique key
                key={`${partner.name}-${index}-${Math.random()}`} 
                // Styling for each logo container
                className="flex-shrink-0 h-12 w-auto grayscale opacity-70 hover:grayscale-0 hover:opacity-100 transition-all duration-300"
                // Accessibility: provides tooltip on hover
                title={partner.name}
              >
                <img
                  src={partner.logo}
                  // Alt text for screen readers
                  alt={`${partner.name} logo`}
                  // Image styling
                  className="h-full w-auto object-contain"
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// Optional: Export the component if needed elsewhere
// export default PartnerBar;
