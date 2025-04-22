import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center justify-center rounded-md p-1 text-muted-foreground',
      // Light mode: Use a slightly darker background (neutral-200) and keep border/shadow
      'bg-neutral-200 border border-border/70 shadow-sm',
      // Dark mode: Keep muted background and standard border
      'dark:bg-muted dark:border-border',
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
      // Default state (inactive): subtle text color
      'text-muted-foreground',
      // Active state:
      // Light mode: Use background color for stronger contrast, keep shadow
      'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
      // Dark mode: Use muted background (slightly darker than main dark bg), keep shadow
      'dark:data-[state=active]:bg-border dark:data-[state=active]:text-foreground dark:data-[state=active]:shadow-sm', // Slightly adjust dark active bg if needed
      // Hover state:
      // Light mode: Subtle background change on the darker TabsList bg
      'hover:bg-neutral-300/50', // Adjusted hover for the new bg
      // Dark mode: Subtle background change
      'dark:hover:bg-border/30',
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
