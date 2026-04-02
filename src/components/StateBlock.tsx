import type { ReactNode } from 'react';

interface StateBlockProps {
  variant: 'empty' | 'loading' | 'error' | 'success';
  title: string;
  description: string;
  extra?: ReactNode;
}

export default function StateBlock({ variant, title, description, extra }: StateBlockProps) {
  return (
    <div className={`state-block ${variant}`}>
      <h4>{title}</h4>
      <p>{description}</p>
      {extra}
    </div>
  );
}
