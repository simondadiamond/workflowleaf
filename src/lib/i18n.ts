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
  // Old pain keys (commented out or remove if sure)
  // | 'pain.title'
  // | 'pain.card1.title'
  // | 'pain.card1.description'
  // | 'pain.card2.title'
  // | 'pain.card2.description'
  // | 'pain.card3.title'
  // | 'pain.card3.description'
  // New challenges keys
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
  | 'kpi.title'
  | 'kpi.hours'
  | 'kpi.errors'
  | 'kpi.breakeven'
  | 'kpi.disclaimer'
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
    'hero.title': 'Streamline Your Property Management Workflow',
    'hero.subtitle': 'Custom AI solutions that automate administrative tasks, saving you time and reducing errors.',
    'hero.cta': 'Book a Free Consultation',
    'nav.home': 'Home',
    'nav.services': 'Services',
    'nav.pricing': 'Pricing',
    'nav.contact': 'Contact',
    'nav.book': 'Book a Call',
    'language.toggle': 'Fr',
    'cta.title': 'Ready to transform your property management workflow?',
    'cta.button': 'Schedule Your Free Consultation',
    // Updated Challenges Section
    'challenges.title': 'The Challenges We Solve',
    'challenges.rent.title': 'Never Chase Late Rent Again',
    'challenges.rent.description': 'Automated SMS & PAD reminders boost on‑time payments by 30% and reclaim 4 hrs of your month.',
    'challenges.maintenance.title': 'Maintenance Tickets Solved in 60 Seconds',
    'challenges.maintenance.description': 'Form‑ or email‑triggered workflow parses issues instantly, creates help‑desk tickets, and notifies vendors—no bots needed.',
    'challenges.onboarding.title': 'Onboard Quality Tenants in Minutes',
    'challenges.onboarding.description': 'Intake form → background & credit‑check API → summary email + DocuSign link—move‑ins happen in under 10 minutes.',
    'how.title': 'How It Works',
    'how.step1.title': 'Discovery',
    'how.step1.description': 'We map your current workflows and identify automation opportunities.',
    'how.step2.title': 'Implementation',
    'how.step2.description': 'We build custom integrations and automations for your business.',
    'how.step3.title': 'Optimization',
    'how.step3.description': 'We continuously monitor and improve your automated workflows.',
    'kpi.title': 'Expected Outcomes',
    'kpi.hours': 'hrs admin saved/month',
    'kpi.errors': 'manual errors',
    'kpi.breakeven': 'months to break-even',
    'kpi.disclaimer': 'Real metrics from Pilot Partners coming soon.',
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
    'hero.title': 'Optimisez Votre Gestion Immobilière',
    'hero.subtitle': 'Solutions d\'IA personnalisées qui automatisent les tâches administratives, vous faisant gagner du temps et réduisant les erreurs.',
    'hero.cta': 'Réserver une Consultation Gratuite',
    'nav.home': 'Accueil',
    'nav.services': 'Services',
    'nav.pricing': 'Tarification',
    'nav.contact': 'Contact',
    'nav.book': 'Réserver un Appel',
    'language.toggle': 'En',
    'cta.title': 'Prêt à transformer votre processus de gestion immobilière?',
    'cta.button': 'Planifiez Votre Consultation Gratuite',
    // Updated Challenges Section - French
    'challenges.title': 'Les Défis Que Nous Relevons',
    'challenges.rent.title': 'Ne Courez Plus Jamais Après les Loyers en Retard',
    'challenges.rent.description': 'Les rappels automatisés par SMS et DPA augmentent les paiements à temps de 30 % et vous redonnent 4 heures par mois.',
    'challenges.maintenance.title': 'Billets de Maintenance Résolus en 60 Secondes',
    'challenges.maintenance.description': 'Un flux déclenché par formulaire ou e-mail analyse instantanément les problèmes, crée des billets d\'assistance et avertit les fournisseurs—aucun bot requis.',
    'challenges.onboarding.title': 'Intégrez des Locataires de Qualité en Quelques Minutes',
    'challenges.onboarding.description': 'Formulaire d\'admission → API de vérification des antécédents et du crédit → e-mail récapitulatif + lien DocuSign—les emménagements se font en moins de 10 minutes.',
    'how.title': 'Comment Ça Marche',
    'how.step1.title': 'Découverte',
    'how.step1.description': 'Nous cartographions vos flux de travail actuels et identifions les opportunités d\'automatisation.',
    'how.step2.title': 'Implémentation',
    'how.step2.description': 'Nous construisons des intégrations et des automatisations personnalisées pour votre entreprise.',
    'how.step3.title': 'Optimisation',
    'how.step3.description': 'Nous surveillons et améliorons continuellement vos flux de travail automatisés.',
    'kpi.title': 'Résultats Attendus',
    'kpi.hours': 'h admin économisées/mois',
    'kpi.errors': 'erreurs manuelles',
    'kpi.breakeven': 'mois pour rentabiliser',
    'kpi.disclaimer': 'Métriques réelles des Partenaires Pilotes à venir.',
    'pilot.title': 'Devenez Partenaire Pilote',
    'pilot.description': 'Obtenez 30% de réduction sur notre Diagnostic de 950$ CA en échange d\'un témoignage honnête.',
    'partners.title': 'Fait Confiance et Soutenu Par',
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
    'pricing.managed.features.growth': ['Surveillance 24/7 de tous les flux', 'Revues mensuelles de performance', '5 heures de support/mois', 'Un nouveau flux simple tous les 2 mois', 'Rapport ROI trimestriel', 'Service bilingue (EN/FR)'],
    'pricing.managed.features.premium': ['Surveillance 24/7 de tous les flux', '10+ heures dédiées/mois', 'Support prioritaire (<4h réponse)', 'Ajustement agent chat IA', 'Surveillance robot vocal', 'Appel stratégique mensuel', 'Service bilingue (EN/FR)'],
    'pricing.addons': 'Besoin de Chat ou Robot Vocal? Les Projets Premium Add-On commencent à 4 500$ CA (Chat) et 6 500$ CA (Vocal). Contactez-nous pour plus de détails.',
    'footer.copyright': '© 2025 WorkflowLeaf. Tous droits réservés.',
    'footer.links': 'Liens Rapides',
    'footer.privacy': 'Politique de Confidentialité',
    'footer.terms': 'Conditions d\'Utilisation',
    'footer.contact': 'Contactez-Nous',
    'footer.email': 'bonjour@workflowleaf.com'
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
    return translation;
  };

  return { t, locale, toggleLocale };
}
