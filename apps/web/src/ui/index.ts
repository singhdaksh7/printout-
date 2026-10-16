// PrintoutBuddy UI library. Import components from the `ui` folder; each component imports its own CSS.
import './tokens.css';
import './fonts.css';
import './base.css';

export { cx } from './cx';
export { Icon, ICON_NAMES, type IconName, type IconProps } from './icons/Icon';

// Actions
export { Button, buttonClass, type ButtonProps, type ButtonSize, type ButtonVariant } from './actions/Button';
export { IconButton, type IconButtonProps } from './actions/IconButton';
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption } from './actions/SegmentedControl';

// Inputs
export { TextField, type TextFieldProps } from './inputs/TextField';
export { TextArea, type TextAreaProps } from './inputs/TextArea';
export { Select, type SelectProps } from './inputs/Select';
export { Checkbox, type CheckboxProps } from './inputs/Checkbox';
export { RadioGroup, type RadioGroupProps, type RadioOption } from './inputs/RadioGroup';
export { describedBy, useFieldIds } from './inputs/FieldFrame';

// Status
export { Chip, type ChipProps, type ChipTone } from './status/Chip';
export { Badge, type BadgeProps } from './status/Badge';
export { Spinner, type SpinnerProps } from './status/Spinner';
export { ProgressBar, type ProgressBarProps } from './status/ProgressBar';

// Feedback
export { Banner, type BannerProps, type BannerTone } from './feedback/Banner';
export { ToastRegion, type ToastRegionProps } from './feedback/ToastRegion';
export { Skeleton, type SkeletonProps } from './feedback/Skeleton';
export { EmptyState, type EmptyStateProps } from './feedback/EmptyState';
