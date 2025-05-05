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
  | 'pricing.managed.description.essentials'
  | 'pricing.managed.description.growth'
  | 'pricing.managed.description.premium'
  | 'pricing.managed.period'
  | 'pricing.managed.essentials.price'
  | 'pricing.managed.growth.price'
  | 'pricing.managed.premium.price'
  | 'pricing.managed.essentials.button'
  | 'pricing.managed.growth.button'
  | 'pricing.managed.premium.button'
  | 'pricing.managed.essentials.tab'
  | 'pricing.managed.growth.tab'
  | 'pricing.managed.growth.popular'
  | 'pricing.managed.premium.tab'
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
  | 'pricing.addons' // Added pricing.addons
  | 'footer.copyright'
  | 'footer.links'
  | 'footer.privacy'
  | 'footer.legal'
  | 'footer.contact'
  | 'footer.email';

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
  | 'pricing.addons'; // Added pricing.addons

const translations: Record<string, Record<TranslationKey, string | string[]>> = {
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
    'how.title': 'Our Process',
    'how.step1.title': '1. Discovery',
    'how.step1.description': 'We dive into your current processes to pinpoint exactly where automation can save you the most time and money.',
    'how.step2.title': '2. Build Your Solution',
    'how.step2.description': 'Our team designs and builds the custom automated workflows tailored to streamline your specific property management tasks.',
    'how.step3.title': '3. Launch & Optimize',
    'how.step3.description': 'We launch your automations and continuously monitor performance, making adjustments to ensure peak efficiency and adapt to your evolving needs.',
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
    'pilot.title': 'Become a Pilot Partner',
    'pilot.description': 'Get 30% off our CA $950 Diagnostic in exchange for an honest testimonial.',
    'partners.title': 'Trusted & Supported By',
    'pricing.title': 'Transparent Pricing',
    'pricing.pilot.title': 'Quick Start Automation',
    'pricing.pilot.price': 'CA $997',
    'pricing.pilot.description': 'Solve Your Most Pressing PM Bottleneck, Fast. Get tangible results and prove the ROI of automation by tackling one high-impact workflow (like rent reminders or maintenance intake) in just 6-8 weeks. Includes deep-dive discovery and expert build.',
    'pricing.pilot.features': [
      '90-minute deep-dive + ROI worksheet',
      'Process map & recommendations',
      'Build 1 foundational n8n workflow',
      '14-day email support',
      'Bilingual service (EN/FR)',
    ],
    'pricing.pilot.button': 'Explore Quick Start',
    'pricing.pilot.upgrade': 'Need more? Full Automation Setup starts at CA $2,400 for up to 2 workflows.',
    'pricing.managed.title': 'Automation Partnerships',
    'pricing.managed.description.essentials': 'Keep Your Automated Workflows Running Smoothly. Ensure the critical processes we\'ve automated continue delivering value with 24/7 health checks, performance summaries, quarterly value reports, and dedicated support hours. Peace of mind for your core operations.',
    'pricing.managed.description.growth': 'Systematically Eliminate Inefficiency & Enable Scale. Continuously improve your operations through ongoing automation builds (~1 new workflow bi-monthly), proactive monitoring, and expert support. We partner with you to systematically reduce manual work and free up your team for growth.',
    'pricing.managed.description.premium': 'Maximize Efficiency with Strategic Automation & Advanced Tech. Your dedicated automation partner for tackling complex challenges, leveraging AI/Voice solutions, and developing a strategic roadmap for peak operational performance. Includes priority support and development for transformative results.',
    'pricing.managed.period': '/month',
    'pricing.managed.essentials.price': 'CA $647',
    'pricing.managed.growth.price': 'CA $1,497+',
    'pricing.managed.premium.price': 'CA $2,997+',
    'pricing.managed.essentials.button': 'Explore  Essentials',
    'pricing.managed.growth.button': 'Explore  Growth',
    'pricing.managed.premium.button': 'Request Premium Quote',
    'pricing.managed.essentials.tab': 'Essentials',
    'pricing.managed.growth.tab': 'Growth',
    'pricing.managed.growth.popular': 'Most Popular',
    'pricing.managed.premium.tab': 'Premium',
    'pricing.managed.essentials.feature1': '24/7 Workflow Health Checks',
    'pricing.managed.essentials.feature2': 'Monthly Performance Summary',
    'pricing.managed.essentials.feature3': 'Quarterly Performance & Value Report',
    'pricing.managed.essentials.feature4': 'Bilingual Service (EN/FR)',
    'pricing.managed.essentials.feature5': '**2 Included Support Hours / Month**',
    'pricing.managed.essentials.feature6': '*(New Workflow Builds: Available as Separately Quoted Projects)*',
    'pricing.managed.essentials.feature7': '–',
    'pricing.managed.essentials.feature8': '–',
    'pricing.managed.growth.feature1': '24/7 Workflow Health Checks',
    'pricing.managed.growth.feature2': 'Monthly Performance Summary',
    'pricing.managed.growth.feature3': 'Quarterly Performance & Value Report',
    'pricing.managed.growth.feature4': 'Bilingual Service (EN/FR)',
    'pricing.managed.growth.feature5': '**Includes 5 Support & Development Hours/Month**',
    'pricing.managed.growth.feature6': '**New Workflow Builds (~Bi-Monthly) **',
    'pricing.managed.growth.feature7': 'Regular Performance Check-ins',
    'pricing.managed.growth.feature8': '–',
    'pricing.managed.premium.feature1': '24/7 Workflow Health Checks',
    'pricing.managed.premium.feature2': 'Monthly Performance Summary',
    'pricing.managed.premium.feature3': 'Quarterly Performance & Value Report',
    'pricing.managed.premium.feature4': 'Bilingual Service (EN/FR)',
    'pricing.managed.premium.feature5': '**10 Priority Hours/Month (<4hr Response) **',
    'pricing.managed.premium.feature6': '**Custom Complex Workflow & AI Development**',
    'pricing.managed.premium.feature7': '**Monthly Strategic Roadmap Call**',
    'pricing.managed.premium.feature8': '**AI Agent & VoiceBot Support**',
    'pricing.managed.premium.feature9': 'Premium Chatbot/VoiceBot Projects: Starting at CA $4,500 (Chat) / $6,500 (Voice)',
    'pricing.addons': '*(Add-on: Chat or Voice Bot creation available as Premium Add-On Projects starting at CA $4,500 (Chat) and CA $6,500 (Voice). Contact us for details.)*',
    'footer.copyright': '© 2025 WorkflowLeaf. All rights reserved.',
    'footer.links': 'Quick Links',
    'footer.privacy': 'Privacy Policy',
    'footer.legal': 'Legal',
    'footer.contact': 'Contact Us',
    'footer.email': 'hello@workflowleaf.com',
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
    'how.title': 'Notre Processus',
    'how.step1.title': '1. Découverte',
    'how.step1.description': 'Nous analysons vos processus actuels pour cibler précisément où l\'automatisation peut vous faire économiser le plus de temps et d\'argent.',
    'how.step2.title': '2. Créer votre solution',
    'how.step2.description': 'Notre équipe conçoit et met en place les processus de travail automatisés sur mesure pour simplifier vos tâches spécifiques de gestion immobilière.',
    'how.step3.title': '3. Lancement et Optimisation',
    'how.step3.description': 'Nous lançons vos automatisations et surveillons continuellement la performance, en apportant des ajustements pour assurer une efficacité maximale et nous adapter à vos besoins changeants.',
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
    'pilot.title': 'Devenez Partenaire Pilote',
    'pilot.description': 'Obtenez 30% de réduction sur notre Diagnostic de 950$ CA en échange d\'un témoignage honnête.',
    'partners.title': 'Soutenu par',
    'pricing.title': 'Tarification Transparente',
    'pricing.pilot.title': 'Automatisation Démarrage Rapide',
    'pricing.pilot.price': 'CA 997$',
    'pricing.pilot.description': 'Attaquez votre problème le plus urgent et voyez des résultats concrets, rapidement. Prouvez la valeur de l\'automatisation en ciblant un processus clé à fort impact (ex: rappels de loyer, demandes d\'entretien) en 6-8 semaines. Inclut l\'analyse de vos besoins et l\'implantation experte.',
    'pricing.pilot.features': [
      'Session approfondie de 90 min + feuille ROI',
      'Cartographie des processus & recommandations',
      'Construction d\'un processus n8n fondamental',
      'Support email 14 jours',
      'Service bilingue (EN/FR)',
    ],
    'pricing.pilot.button': 'Explorez Démarrage',
    'pricing.pilot.upgrade': 'Besoin de plus? La Configuration Complète commence à 2 400$ CA pour 2 processus de travail.',
    'pricing.managed.title': 'Partenariats d\'Automatisation',
    'pricing.managed.description.essentials': 'Gardez vos automatisations performantes et sans tracas.** Assurez la fiabilité de vos processus clés grâce à la surveillance 24/7, aux bilans de performance mensuels, aux suivis de valeur trimestriels et au support inclus. La tranquillité d\'esprit pour vos opérations.',
    'pricing.managed.description.growth': 'Améliorez votre efficacité, mois après mois, et facilitez votre croissance. Optimisez vos opérations en continu avec de nouvelles automatisations ciblées (env. 1 processus aux deux mois), la surveillance proactive et le support expert. Un partenariat pour réduire le travail manuel et soutenir votre expansion.',
    'pricing.managed.description.premium': 'Atteignez une efficacité maximale grâce à l\'automatisation stratégique et la technologie avancée. Votre partenaire d\'automatisation dédié pour les défis complexes, intégrant l\'IA et les agents vocaux, avec une feuille de route pour optimiser vos opérations. Inclut support et développement prioritaires pour des résultats majeurs.',
    'pricing.managed.period': '/mois',
    'pricing.managed.essentials.price': 'CA $647',
    'pricing.managed.growth.price': 'CA $1,497+',
    'pricing.managed.premium.price': 'CA $2,997+',
    'pricing.managed.essentials.button': 'Explorez Essentiel',
    'pricing.managed.growth.button': 'Explorez Croissance',
    'pricing.managed.premium.button': 'Demandez une Consultation Premium',
    'pricing.managed.essentials.tab': 'Essentiel',
    'pricing.managed.growth.tab': 'Croissance',
    'pricing.managed.growth.popular': 'Le plus populaire',
    'pricing.managed.premium.tab': 'Premium',
    'pricing.managed.essentials.feature1': 'Surveillance Santé des Processus 24/7',
    'pricing.managed.essentials.feature2': 'Sommaire de Performance Mensuel',
    'pricing.managed.essentials.feature3': 'Rapport trimestriel de performance et valeur',
    'pricing.managed.essentials.feature4': 'Service Bilingue (FR/EN)',
    'pricing.managed.essentials.feature5': '**2 Heures de Support Incluses / Mois**',
    'pricing.managed.essentials.feature6': '*(Nouveaux Processus : Disponibles sur devis)*',
    'pricing.managed.essentials.feature7': '–',
    'pricing.managed.essentials.feature8': '–',
    'pricing.managed.growth.feature1': 'Surveillance Santé des Processus 24/7',
    'pricing.managed.growth.feature2': 'Sommaire de Performance Mensuel',
    'pricing.managed.growth.feature3': 'Rapport trimestriel de performance et valeur',
    'pricing.managed.growth.feature4': 'Service Bilingue (FR/EN)',
    'pricing.managed.growth.feature5': '**5 Heures de Support Incluses / Mois**',
    'pricing.managed.growth.feature6': '**Création Nouveau Processus (~Bi-Mensuel) **',
    'pricing.managed.growth.feature7': 'Bilans de Performance Réguliers',
    'pricing.managed.growth.feature8': '–',
    'pricing.managed.premium.feature1': 'Surveillance Santé des Processus 24/7',
    'pricing.managed.premium.feature2': 'Sommaire de Performance Mensuel',
    'pricing.managed.premium.feature3': 'Rapport trimestriel de performance et valeur',
    'pricing.managed.premium.feature4': 'Service Bilingue (FR/EN)',
    'pricing.managed.premium.feature5': '**10 Heures Prioritaires / Mois (Réponse <4h) **',
    'pricing.managed.premium.feature6': '**Développement Processus Complexes & IA Sur Mesure**',
    'pricing.managed.premium.feature7': '**Appel Stratégique Mensuel (Feuille de Route) **',
    'pricing.managed.premium.feature8': '**Support Agent IA & VoiceBot**',
    'pricing.managed.premium.feature9': 'Projets Premium Chatbot/VoiceBot : Dès 4 500$ CA (Chat) / 6 500$ CA (Voice)',
    'pricing.addons': '*(Add-on : Création de Chat ou Voice Bot disponible en tant que Projets Premium Add-On à partir de 4 500$ CA (Chat) et 6 500$ CA (Voice). Contactez-nous pour plus de détails.)*',
    'footer.copyright': '© 2025 WorkflowLeaf. All rights reserved.',
    'footer.links': 'Quick Links',
    'footer.privacy': 'Privacy Policy',
    'footer.legal': 'Légal',
    'footer.contact': 'Contact Us',
    'footer.email': 'hello@workflowleaf.com',
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
    setLocale(prev => (prev === 'en' ? 'fr' : 'en'));

    if (typeof window !== 'undefined') {
      const currentPath = window.location.pathname;
      const newPath = locale === 'en' ? `/fr${currentPath}` : currentPath.replace(/^\/fr/, '');

      if ((window as any).astro && (window as any).astro.navigate) {
        (window as any).astro.navigate(newPath || '/');
      } else {
        window.location.href = newPath || '/';
      }
    }
  };

  const t = (key: TranslationKey | FeatureKey): string | string[] => {
    const translation = translations[locale]?.[key] ?? translations['en']?.[key] ?? key;
    if (translation === key && !translations['en']?.[key]) {
      console.warn(`Translation key "${key}" not found in locale "${locale}" or fallback "en".`);
    }
    return translation;
  };

  return { t, locale, toggleLocale };
}
