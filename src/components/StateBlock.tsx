import type { ReactNode } from 'react';
import StateView from './ui/StateView';

interface StateBlockProps {
  variant: 'empty' | 'loading' | 'error' | 'success';
  title: string;
  description: string;
  extra?: ReactNode;
}

export default function StateBlock({ variant, title, description, extra }: StateBlockProps) {
  return <StateView variant={variant} title={title} description={description} extra={extra} />;
}
