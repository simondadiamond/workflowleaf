import { useState, useEffect } from 'react';

type TranslationKey =
  | 'hero.title'
  | 'hero.subtitle'
  | 'hero.cta'
  | 'nav.home'
  | 'nav.services'
  | 'nav.pricing'
  | 'nav.contact'
  | 'nav.book'
  | 'language.toggle'
  | 'cta.title'
  | 'cta.button'
  | 'challenges.title'
  | 'challenges.rent.title'
  | 'challenges.rent.description'
  | 'challenges.maintenance.title'
  | 'challenges.maintenance.description'
  | 'challenges.onboarding.title'
  | 'challenges.onboarding.description'
  | 'how.title'
  | 'how.step1.title'
  | 'how.step1.description'
  | 'how.step2.title'
  | 'how.step2.description'
  | 'how.step3.title'
  | 'how.step3.description'
  // Updated KPI Keys
  | 'kpi.sectionTitle'
  | 'kpi.introText'
  | 'kpi.time_saved.title'
  | 'kpi.time_saved.value'
  | 'kpi.time_saved.label'
  | 'kpi.errors_reduced.title'
  | 'kpi.errors_reduced.value'
  | 'kpi.errors_reduced.label'
  | 'kpi.roi.title'
  | 'kpi.roi.value'
  | 'kpi.roi.label'
  | 'kpi.footnote'
  // Old KPI Keys (commented out for reference, can be removed)
  // | 'kpi.title'
  // | 'kpi.hours'
  // | 'kpi.errors'
  // | 'kpi.breakeven'
  // | 'kpi.disclaimer'
  | 'pilot.title'
  | 'pilot.description'
  | 'partners.title'
  | 'pricing.title'
  | 'pricing.pilot.title'
  | 'pricing.pilot.price'
  | 'pricing.pilot.description'
  | 'pricing.pilot.features'
  | 'pricing.pilot.button'
  | 'pricing.pilot.upgrade'
  | 'pricing.managed.title'
  | 'pricing.managed.description'
  | 'pricing.managed.features.essentials'
  | 'pricing.managed.features.growth'
  | 'pricing.managed.features.premium'
  | 'pricing.addons'
  | 'footer.copyright'
  | 'footer.links'
  | 'footer.privacy'
  | 'footer.terms'
  | 'footer.contact'
  | 'footer.email';

const translations: Record<string, Record<TranslationKey, string>> = {
  en: {
    'hero.title': 'Reclaim Your Hours.\nGrow Your Portfolio Effortlessly.',
    'hero.subtitle': 'Smart automation for property managers. Stop wasting time on repetitive tasks, focus on scaling your properties.',
    'hero.cta': 'Book Free Consult',
    'nav.home': 'Home',
    'nav.services': 'Services',
    'nav.pricing': 'Pricing',
    'nav.contact': 'Contact',
    'nav.book': 'Book a Call',
    'language.toggle': 'Fr',
    'cta.title': 'Ready to transform your property management workflow?',
    'cta.button': 'Schedule Your Free Consultation',
    'challenges.title': 'The Challenges We Solve',
    'challenges.rent.title': 'Stop Chasing Late Rent.',
    'challenges.rent.description': 'Get paid faster and save hours every month. Our automated reminders encourage on-time payments (improving consistency by up to 30%!) and free you from chasing tenants, giving you back valuable time.',
    'challenges.maintenance.title': 'Handle Maintenance Requests Instantly.',
    'challenges.maintenance.description': 'Stop drowning in emails and calls. Whether requests come via form or email, our system instantly organizes them, notifies the right vendor, and keeps track—getting issues actioned in minutes, not hours.',
    'challenges.onboarding.title': 'Onboard Great Tenants Faster.',
    'challenges.onboarding.description': 'Fill your vacancies quicker with a smooth, digital process. Collect applications, automatically run background checks, and send lease documents for e-signature in minutes. Reduce paperwork and delays, getting reliable tenants moved in sooner.',
    'how.title': 'How It Works',
    'how.step1.title': '1. Discovery',
    'how.step1.description': 'We dive into your current processes to pinpoint exactly where automation can save you the most time and money.',
    'how.step2.title': '2. Build Your Solution',
    'how.step2.description': 'Our team designs and builds the custom automated workflows tailored to streamline your specific property management tasks.',
    'how.step3.title': '3. Launch & Optimize',
    'how.step3.description': 'We launch your automations and continuously monitor performance, making adjustments to ensure peak efficiency and adapt to your evolving needs.',
    // Updated KPI Section
    'kpi.sectionTitle': 'Expected Outcomes',
    'kpi.introText': 'Based on typical results for property managers like you:',
    'kpi.time_saved.title': 'Save Valuable Time',
    'kpi.time_saved.value': '~ 15 Hours',
    'kpi.time_saved.label': 'typical monthly admin time saved',
    'kpi.errors_reduced.title': 'Reduce Costly Errors',
    'kpi.errors_reduced.value': 'Up to 40%',
    'kpi.errors_reduced.label': 'reduction in manual data errors',
    'kpi.roi.title': 'See Fast ROI',
    'kpi.roi.value': '~ 2 Months',
    'kpi.roi.label': 'typical time to break-even on investment',
    'kpi.footnote': '*Estimates based on typical client scenarios. Real metrics from pilot partners coming soon.',
    // Old KPI keys (can be removed later)
    // 'kpi.title': 'Expected Outcomes',
    // 'kpi.hours': 'hrs admin saved/month',
    // 'kpi.errors': 'manual errors',
    // 'kpi.breakeven': 'months to break-even',
    // 'kpi.disclaimer': 'Real metrics from Pilot Partners coming soon.',
    'pilot.title': 'Become a Pilot Partner',
    'pilot.description': 'Get 30% off our CA $950 Diagnostic in exchange for an honest testimonial.',
    'partners.title': 'Trusted & Supported By',
    'pricing.title': 'Transparent Pricing',
    'pricing.pilot.title': 'Pilot Diagnostic',
    'pricing.pilot.price': 'CA $950',
    'pricing.pilot.description': 'One-time assessment and first workflow (≤8 nodes, 1 integration)',
    'pricing.pilot.features': ['90-minute deep-dive + ROI worksheet', 'Process map & recommendations', 'Build 1 foundational n8n workflow', '14-day email support', 'Bilingual service (EN/FR)'],
    'pricing.pilot.button': 'Book Discovery',
    'pricing.pilot.upgrade': 'Need more? Full Automation Setup starts at CA $2,400 for up to 2 workflows.',
    'pricing.managed.title': 'Managed Care',
    'pricing.managed.description': 'Monitoring, optimisation and incremental improvements',
    'pricing.managed.features.essentials': ['24/7 health checks for all workflows', 'Monthly performance reviews', '2 support hours/month included', 'Quarterly ROI report', 'Bilingual service (EN/FR)'],
    'pricing.managed.features.growth': ['24/7 health checks for all workflows', 'Monthly performance reviews', '5 support hours/month', 'One new simple workflow every 2 months', 'Quarterly ROI report', 'Bilingual service (EN/FR)'],
    'pricing.managed.features.premium': ['24/7 health checks for all workflows', '10+ dedicated hours/month', 'Priority support (<4h response)', 'AI chat agent fine-tuning', 'Voice-bot monitoring', 'Monthly strategic roadmap call', 'Bilingual service (EN/FR)'],
    'pricing.addons': 'Need Chat or Voice Bot creation? Premium Add-On Projects start at CA $4,500 (Chat) and CA $6,500 (Voice). Contact us for details.',
    'footer.copyright': '© 2025 WorkflowLeaf. All rights reserved.',
    'footer.links': 'Quick Links',
    'footer.privacy': 'Privacy Policy',
    'footer.terms': 'Terms of Service',
    'footer.contact': 'Contact Us',
    'footer.email': 'hello@workflowleaf.com'
  },
  fr: {
    'hero.title': 'Récupérez vos heures.\nDéveloppez votre parc immobilier sans effort.',
    'hero.subtitle': 'Automatisation intelligente pour gestionnaires immobiliers au Québec. Cessez de perdre du temps en tâches répétitives, concentrez-vous sur la croissance de votre parc.',
    'hero.cta': 'Consultation Gratuite',
    'nav.home': 'Accueil',
    'nav.services': 'Services',
    'nav.pricing': 'Tarification',
    'nav.contact': 'Contact',
    'nav.book': 'Réserver un Appel',
    'language.toggle': 'En',
    'cta.title': 'Prêt à transformer votre processus de gestion immobilière?',
    'cta.button': 'Planifiez Votre Consultation Gratuite',
    'challenges.title': 'Les défis que nous relevons',
    'challenges.rent.title': 'Ne perdez plus de temps à courir après les loyers.',
    'challenges.rent.description': 'Soyez payé plus rapidement et économisez des heures chaque mois. Nos rappels automatisés favorisent les paiements ponctuels (améliorant la régularité jusqu\'à 30%!) et vous libèrent de la chasse aux locataires, vous redonnant un temps précieux.',
    'challenges.maintenance.title': 'Traitez les demandes de maintenance instantanément.',
    'challenges.maintenance.description': 'Ne vous noyez plus dans les courriels et les appels. Que les demandes arrivent par formulaire ou courriel, notre système les organise instantanément, avise le bon fournisseur et assure le suivi – les problèmes sont pris en charge en quelques minutes, pas en heures.',
    'challenges.onboarding.title': 'Intégrez de bons locataires plus rapidement.',
    'challenges.onboarding.description': 'Louez vos logements plus vite avec un processus numérique fluide. Collectez les candidatures, effectuez automatiquement les vérifications d\'antécédents et envoyez les baux pour signature électronique en quelques minutes. Réduisez la paperasse et les délais pour accueillir plus tôt des locataires fiables.',
    'how.title': 'Comment Ça Marche',
    'how.step1.title': '1. Découverte',
    'how.step1.description': 'Nous analysons vos processus actuels pour cibler précisément où l\'automatisation peut vous faire économiser le plus de temps et d\'argent.',
    'how.step2.title': '2. Créer votre solution',
    'how.step2.description': 'Notre équipe conçoit et met en place les flux de travail automatisés sur mesure pour simplifier vos tâches spécifiques de gestion immobilière.',
    'how.step3.title': '3. Lancement et Optimisation',
    'how.step3.description': 'Nous lançons vos automatisations et surveillons continuellement la performance, en apportant des ajustements pour assurer une efficacité maximale et nous adapter à vos besoins changeants.',
    // Updated KPI Section - French
    'kpi.sectionTitle': 'Résultats Attendus',
    'kpi.introText': 'Basé sur les résultats typiques pour des gestionnaires immobiliers comme vous :',
    'kpi.time_saved.title': 'Économisez un temps précieux',
    'kpi.time_saved.value': '~ 15 Heures',
    'kpi.time_saved.label': 'temps administratif économisé par mois (typique)',
    'kpi.errors_reduced.title': 'Réduisez les erreurs coûteuses',
    'kpi.errors_reduced.value': 'Jusqu\'à 40%',
    'kpi.errors_reduced.label': 'réduction des erreurs de saisie manuelle',
    'kpi.roi.title': 'Rentabilisez rapidement',
    'kpi.roi.value': '~ 2 Mois',
    'kpi.roi.label': 'délai typique pour atteindre le seuil de rentabilité',
    'kpi.footnote': '*Estimations basées sur des scénarios clients typiques. Métriques réelles de nos partenaires pilotes à venir.',
    // Old KPI keys (can be removed later)
    // 'kpi.title': 'Résultats Attendus',
    // 'kpi.hours': 'h admin économisées/mois',
    // 'kpi.errors': 'erreurs manuelles',
    // 'kpi.breakeven': 'mois pour rentabiliser',
    // 'kpi.disclaimer': 'Métriques réelles des Partenaires Pilotes à venir.',
    'pilot.title': 'Devenez Partenaire Pilote',
    'pilot.description': 'Obtenez 30% de réduction sur notre Diagnostic de 950$ CA en échange d\'un témoignage honnête.',
    'partners.title': 'Soutenu par',
    'pricing.title': 'Tarification Transparente',
    'pricing.pilot.title': 'Diagnostic Pilote',
    'pricing.pilot.price': '950$ CA',
    'pricing.pilot.description': 'Évaluation unique et premier flux de travail (≤8 nœuds, 1 intégration)',
    'pricing.pilot.features': ['Session approfondie de 90 min + feuille ROI', 'Cartographie des processus & recommandations', 'Construction d\'un flux n8n fondamental', 'Support email 14 jours', 'Service bilingue (EN/FR)'],
    'pricing.pilot.button': 'Réserver une Découverte',
    'pricing.pilot.upgrade': 'Besoin de plus? La Configuration Complète commence à 2 400$ CA pour 2 flux de travail.',
    'pricing.managed.title': 'Service Géré',
    'pricing.managed.description': 'Surveillance, optimisation et améliorations progressives',
    'pricing.managed.features.essentials': ['Surveillance 24/7 de tous les flux', 'Revues mensuelles de performance', '2 heures de support/mois incluses', 'Rapport ROI trimestriel', 'Service bilingue (EN/FR)'],
    'pricing.managed.features.growth': ['24/7 health checks for all workflows', 'Monthly performance reviews', '5 support hours/month', 'One new simple workflow every 2 months', 'Quarterly ROI report', 'Bilingual service (EN/FR)'],
    'pricing.managed.features.premium': ['Surveillance 24/7 de tous les flux', '10+ dedicated hours/month', 'Priority support (<4h response)', 'AI chat agent fine-tuning', 'Voice-bot monitoring', 'Monthly strategic roadmap call', 'Bilingual service (EN/FR)'],
    'pricing.addons': 'Need Chat or Voice Bot creation? Premium Add-On Projects start at CA $4,500 (Chat) and CA $6,500 (Voice). Contact us for details.',
    'footer.copyright': '© 2025 WorkflowLeaf. All rights reserved.',
    'footer.links': 'Quick Links',
    'footer.privacy': 'Privacy Policy',
    'footer.terms': 'Terms of Service',
    'footer.contact': 'Contact Us',
    'footer.email': 'hello@workflowleaf.com'
  }
};

export function useTranslation() {
  const [locale, setLocale] = useState<'en' | 'fr'>(() => {
    if (typeof window !== 'undefined') {
      const path = window.location.pathname;
      return path.startsWith('/fr') ? 'fr' : 'en';
    }
    return 'en';
  });

  const toggleLocale = () => {
    setLocale(prev => prev === 'en' ? 'fr' : 'en');

    if (typeof window !== 'undefined') {
      const currentPath = window.location.pathname;
      const newPath = locale === 'en'
        ? `/fr${currentPath}`
        : currentPath.replace(/^\/fr/, '');

      // Use Astro's view transitions API if available, otherwise fallback to full reload
      if ((window as any).astro && (window as any).astro.navigate) {
        (window as any).astro.navigate(newPath || '/');
      } else {
        window.location.href = newPath || '/';
      }
    }
  };

  const t = (key: TranslationKey): string => {
    // Fallback logic: if a key doesn't exist in the current locale, try English
    const translation = translations[locale]?.[key] ?? translations['en']?.[key] ?? key;
    // If still no translation found, return the key itself for debugging
    if (translation === key && !translations['en']?.[key]) {
      console.warn(`Translation key "${key}" not found in locale "${locale}" or fallback "en".`);
    }
    return translation;
  };

  return { t, locale, toggleLocale };
}
