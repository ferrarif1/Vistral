import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';

const joinClasses = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ');

export type InputProps = InputHTMLAttributes<HTMLInputElement>;
export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;
export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;
export type CheckboxProps = InputHTMLAttributes<HTMLInputElement>;
export type FileInputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref
) {
  return <input ref={ref} className={joinClasses('ui-field', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      className={joinClasses('ui-field', 'ui-field--textarea', className)}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...props },
  ref
) {
  return (
    <select
      ref={ref}
      className={joinClasses('ui-field', 'ui-field--select', className)}
      {...props}
    >
      {children}
    </select>
  );
});

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, type = 'checkbox', ...props },
  ref
) {
  return <input ref={ref} type={type} className={joinClasses('ui-checkbox', className)} {...props} />;
});

export const HiddenFileInput = forwardRef<HTMLInputElement, FileInputProps>(function HiddenFileInput(
  { className, type = 'file', ...props },
  ref
) {
  return <input ref={ref} type={type} className={joinClasses('chat-hidden-file-input', className)} {...props} />;
});
