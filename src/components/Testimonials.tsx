import React, { useState, useEffect } from 'react';
import { useTranslation } from '@/lib/i18n';
import { Card } from '@/components/ui/card';
import { Star, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TestimonialProps {
  quote: string;
  name: string;
  company: string;
  rating: number;
  image: string;
  isActive: boolean;
}

function Testimonial({ quote, name, company, rating, image, isActive }: TestimonialProps) {
  return (
    <Card 
      className={cn(
        "p-6 transition-all duration-500 transform",
        isActive 
          ? "opacity-100 scale-100" 
          : "opacity-0 scale-90 absolute top-0 left-0"
      )}
    >
      <div className="flex flex-col h-full">
        <div className="flex mb-4">
          {[...Array(5)].map((_, i) => (
            <Star
              key={i}
              className={`w-5 h-5 ${
                i < rating ? 'text-accent-dark fill-accent-dark' : 'text-muted'
              }`}
            />
          ))}
        </div>
        <blockquote className="mb-6 flex-grow">
          <p className="text-lg italic">"{quote}"</p>
        </blockquote>
        <div className="flex items-center mt-auto">
          <div className="w-12 h-12 rounded-full overflow-hidden mr-4 bg-muted flex-shrink-0">
            <img
              src={image}
              alt={name}
              className="w-full h-full object-cover"
            />
          </div>
          <div>
            <p className="font-semibold">{name}</p>
            <p className="text-sm text-muted-foreground">{company}</p>
          </div>
        </div>
      </div>
    </Card>
  );
}

export function Testimonials() {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);

  const testimonials = [
    {
      quote: t('testimonials.client1.quote'),
      name: t('testimonials.client1.name'),
      company: t('testimonials.client1.company'),
      rating: 5,
      image: 'https://images.pexels.com/photos/774909/pexels-photo-774909.jpeg',
    },
    {
      quote: t('testimonials.client2.quote'),
      name: t('testimonials.client2.name'),
      company: t('testimonials.client2.company'),
      rating: 5,
      image: 'https://images.pexels.com/photos/2379004/pexels-photo-2379004.jpeg',
    },
    {
      quote: t('testimonials.client3.quote'),
      name: t('testimonials.client3.name'),
      company: t('testimonials.client3.company'),
      rating: 4,
      image: 'https://images.pexels.com/photos/415829/pexels-photo-415829.jpeg',
    },
  ];

  const nextTestimonial = () => {
    setActiveIndex((prevIndex) => (prevIndex + 1) % testimonials.length);
  };

  const prevTestimonial = () => {
    setActiveIndex(
      (prevIndex) => (prevIndex - 1 + testimonials.length) % testimonials.length
    );
  };

  // Auto slide with pause on hover
  useEffect(() => {
    if (isPaused) return;
    
    const intervalId = setInterval(() => {
      nextTestimonial();
    }, 5000);
    
    return () => clearInterval(intervalId);
  }, [isPaused, testimonials.length]);

  return (
    <section className="py-20 bg-secondary-main/5">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold mb-4">{t('testimonials.title')}</h2>
        </div>
        
        <div 
          className="relative"
          onMouseEnter={() => setIsPaused(true)}
          onMouseLeave={() => setIsPaused(false)}
        >
          <div className="relative h-[300px]">
            {testimonials.map((testimonial, index) => (
              <Testimonial
                key={index}
                {...testimonial}
                isActive={index === activeIndex}
              />
            ))}
          </div>
          
          <div className="flex justify-center mt-6 gap-2">
            {testimonials.map((_, index) => (
              <button
                key={index}
                onClick={() => setActiveIndex(index)}
                className={`w-3 h-3 rounded-full transition-colors ${
                  index === activeIndex ? 'bg-primary-main' : 'bg-gray-300'
                }`}
                aria-label={`Go to testimonial ${index + 1}`}
              />
            ))}
          </div>
          
          <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 flex justify-between pointer-events-none">
            <Button 
              size="icon" 
              variant="ghost" 
              onClick={prevTestimonial}
              className="pointer-events-auto"
            >
              <ChevronLeft className="h-6 w-6" />
              <span className="sr-only">Previous</span>
            </Button>
            
            <Button 
              size="icon" 
              variant="ghost" 
              onClick={nextTestimonial}
              className="pointer-events-auto"
            >
              <ChevronRight className="h-6 w-6" />
              <span className="sr-only">Next</span>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
