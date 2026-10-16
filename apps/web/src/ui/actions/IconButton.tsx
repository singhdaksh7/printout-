import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from '../cx';
import { Icon, type IconName } from '../icons/Icon';
import './actions.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  icon: IconName;
  /** Required accessible name (icon-only controls have no visible text). */
  label: string;
  variant?: 'ghost' | 'outline';
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', className, type = 'button', ...rest },
  ref
) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={cx('pb-iconbtn', `pb-iconbtn--${variant}`, `pb-iconbtn--${size}`, className)} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 16 : 20} />
    </button>
  );
});
