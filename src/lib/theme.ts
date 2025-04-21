/**
 * WorkflowLeaf Theme Tokens
 *
 * This file contains all the design tokens used throughout the application.
 * It serves as the single source of truth for colors, typography, spacing, etc.
 */

export const theme = {
  colors: {
    // Primary colors
    primary: {
      main: '#0A9F9D',
      hover: '#06706E',
      light: '#B3E6E5',
      dark: '#086B6A',
    },
    // Secondary colors
    secondary: {
      main: '#15413C',
      hover: '#0E2A27',
      light: '#A7C5C2',
      dark: '#0D2925',
    },
    // Accent/highlight colors (Muted Champagne)
    accent: {
      main: '#BFA46A', // HSL: 42 40% 58%
      hover: '#A68A5C', // HSL: 42 40% 50%
      light: '#E6D9B8', // HSL: 42 40% 75%
      dark: '#997D52', // HSL: 42 40% 45%
      check: '#BFA46A', // HSL: 42 40% 58% (Same as main)
    },
    // Neutral colors
    neutral: {
      background: '#F7F9F9',
      card: '#ECEDED',
      text: '#2B2D2E',
      textLight: '#6B7280',
      border: '#D1D5DB',
    },
    // Status colors
    status: {
      success: '#10B981',
      warning: '#F59E0B',
      error: '#EF4444',
      info: '#3B82F6',
    },
    // Dark mode colors (Proportionally muted)
    dark: {
      primary: '#18C3C0',
      secondary: '#217572',
      // Dark mode accent colors (Lightness reduced by ~10%)
      accent: {
        main: '#A68A5C', // HSL: 42 40% 48%
        hover: '#806A4A', // HSL: 42 40% 40%
        light: '#D9C9A3', // HSL: 42 40% 65%
        dark: '#735C40', // HSL: 42 40% 35%
        check: '#A68A5C', // HSL: 42 40% 48% (Same as main)
      },
      background: '#1A1D1D',
      card: '#2A2D2D',
      text: '#D9DADA',
      textLight: '#9CA3AF',
      border: '#4B5563',
    },
  },

  typography: {
    fontFamily: {
      base: "'Inter', system-ui, sans-serif",
      mono: "'Roboto Mono', monospace",
    },
    fontSize: {
      xs: '0.75rem', // 12px
      sm: '0.875rem', // 14px
      base: '1rem', // 16px
      lg: '1.125rem', // 18px
      xl: '1.25rem', // 20px
      '2xl': '1.5rem', // 24px
      '3xl': '1.875rem', // 30px
      '4xl': '2.25rem', // 36px
      '5xl': '3rem', // 48px
    },
    fontWeight: {
      normal: '400',
      medium: '500',
      semibold: '600',
      bold: '700',
    },
    lineHeight: {
      none: '1',
      tight: '1.2', // For headings
      normal: '1.5', // For body text
      loose: '1.75',
    },
  },

  spacing: {
    0: '0px',
    1: '0.25rem', // 4px
    2: '0.5rem', // 8px
    3: '0.75rem', // 12px
    4: '1rem', // 16px
    5: '1.25rem', // 20px
    6: '1.5rem', // 24px
    8: '2rem', // 32px
    10: '2.5rem', // 40px
    12: '3rem', // 48px
    16: '4rem', // 64px
    20: '5rem', // 80px
    24: '6rem', // 96px
  },

  borderRadius: {
    none: '0',
    sm: '4px',
    DEFAULT: '8px',
    md: '12px',
    lg: '16px',
    full: '9999px',
  },

  shadows: {
    sm: '0 2px 8px rgba(0, 0, 0, 0.1)',
    md: '0 4px 12px rgba(0, 0, 0, 0.1)',
    lg: '0 8px 24px rgba(0, 0, 0, 0.1)',
  },

  transitions: {
    DEFAULT: '150ms ease',
    slow: '300ms ease',
    fast: '100ms ease',
  },

  breakpoints: {
    sm: '640px',
    md: '768px',
    lg: '1024px',
    xl: '1280px',
    '2xl': '1536px',
  },

  zIndex: {
    0: '0',
    10: '10',
    20: '20',
    30: '30',
    40: '40',
    50: '50',
    auto: 'auto',
  },
};

export default theme;
