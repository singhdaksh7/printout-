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
export { Tabs, type TabItem, type TabsProps } from './actions/Tabs';

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
export { useToast } from './feedback/useToast';
export { Skeleton, type SkeletonProps } from './feedback/Skeleton';
export { EmptyState, type EmptyStateProps } from './feedback/EmptyState';

// Layout and containers
export { Card, CardHeader, StatTile, type CardProps, type CardHeaderProps, type StatTileProps } from './layout/Card';
export { KeyValueList, type KeyValueItem, type KeyValueListProps } from './layout/KeyValueList';
export { Timeline, type TimelineItem, type TimelineProps } from './layout/Timeline';

// Overlays
export { Modal, type ModalProps } from './overlays/Modal';
export { Drawer, type DrawerProps } from './overlays/Drawer';
export { useFocusTrap } from './overlays/useFocusTrap';

// Data display
export { DataTable, type Column, type DataTableProps } from './data/DataTable';
export { LoadMore, type LoadMoreProps } from './data/LoadMore';
export { useMediaQuery } from './useMediaQuery';

// Navigation
export { AppShell, BottomNav, Sidebar, TopBar, type AppShellProps, type BottomNavProps, type NavItem, type SidebarProps, type TopBarProps } from './navigation/navigation';

// Charts
export { BarChart, HBarList, HeartbeatStrip, SegmentedBar, type BarChartProps, type BarDatum, type HBarDatum, type HBarListProps, type HeartbeatState, type HeartbeatStripProps, type Segment, type SegmentedBarProps } from './charts/charts';

// Domain presentation
export {
  FileDeletedLine, JOB_STATUS, JobCode, JobStatusChip, ORDER_STATUS_DISPLAY, OrderStatusChip, PRESENCE, PresenceChip, RetentionNotice, SHOP_STATUS, ShopStatusChip,
  type JobCodeProps, type JobStatusChipProps, type JobStatusKind, type LegacyOrderStatus, type PresenceKind
} from './domain/domain';
