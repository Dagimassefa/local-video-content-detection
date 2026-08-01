import * as LabelPrimitive from '@radix-ui/react-label';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import { Slot } from '@radix-ui/react-slot';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Circle } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';


const buttonVariants = {
  default: 'bg-accent text-accent-fg hover:bg-accent/90 shadow-sm',
  secondary: 'bg-surface-2 text-fg hover:bg-surface-3 border border-line',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white hover:bg-danger/90 shadow-sm',
  outline: 'border border-line bg-transparent text-fg hover:bg-surface-2',
} as const;

const buttonSizes = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-6 text-sm gap-2',
  icon: 'h-8 w-8',
} as const;

export function Button({
  className,
  variant = 'default',
  size = 'md',
  asChild = false,
  ...props
}: ComponentProps<'button'> & {
  variant?: keyof typeof buttonVariants;
  size?: keyof typeof buttonSizes;
  asChild?: boolean;
}) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap',
        'transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        'disabled:pointer-events-none disabled:opacity-50',
        buttonVariants[variant],
        buttonSizes[size],
        className
      )}
      {...props}
    />
  );
}


export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-line bg-surface-1 shadow-sm shadow-black/5',
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex items-start justify-between gap-4 border-b border-line px-4 py-3',
        className
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        {icon ? <span className="mt-0.5 shrink-0 text-muted">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight text-fg">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </header>
  );
}

export function CardBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-4 py-3.5', className)} {...props} />;
}

const badgeTones = {
  neutral: 'bg-surface-2 text-muted border-line',
  accent: 'bg-accent/12 text-accent border-accent/25',
  danger: 'bg-danger/12 text-danger border-danger/25',
  warn: 'bg-warn/12 text-warn border-warn/25',
  ok: 'bg-ok/12 text-ok border-ok/25',
} as const;

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: ComponentProps<'span'> & { tone?: keyof typeof badgeTones }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
        'font-mono text-[11px] leading-none font-medium',
        badgeTones[tone],
        className
      )}
      {...props}
    />
  );
}



export function Meter({
  value,
  tone = 'accent',
  className,
  label,
  valueText,
}: {
  value: number;
  tone?: 'accent' | 'danger' | 'ok' | 'warn';
  className?: string;
  label?: string;
  valueText?: string;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const toneClass = {
    accent: 'bg-accent',
    danger: 'bg-danger',
    ok: 'bg-ok',
    warn: 'bg-warn',
  }[tone];
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={clamped}
      aria-valuetext={valueText}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-300 ease-out', toneClass)}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------------- Switch

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
        'border-2 border-transparent transition-colors outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:bg-accent data-[state=unchecked]:bg-surface-3',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-sm',
          'transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0'
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-xs font-medium text-fg select-none', className)}
      {...props}
    />
  );
}


export function RadioGroup({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('grid gap-2', className)} {...props} />;
}

export function RadioCard({
  value,
  title,
  description,
  id,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  id: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2/40 p-2.5 transition-colors has-[button[data-state=checked]]:border-accent/50 has-[button[data-state=checked]]:bg-accent/8">
      <RadioGroupPrimitive.Item
        id={id}
        value={value}
        className={cn(
          'mt-0.5 aspect-square h-4 w-4 shrink-0 rounded-full border border-line',
          'text-accent outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          'disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent'
        )}
      >
        <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
          <Circle className="h-2 w-2 fill-accent text-accent" />
        </RadioGroupPrimitive.Indicator>
      </RadioGroupPrimitive.Item>
      <div className="min-w-0">
        <Label htmlFor={id} className="cursor-pointer">
          {title}
        </Label>
        {description ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface-2 p-0.5',
        className
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
        'text-muted transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        'data-[state=active]:bg-surface-1 data-[state=active]:text-fg data-[state=active]:shadow-sm',
        className
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn('outline-none focus-visible:ring-2 focus-visible:ring-accent/60', className)}
      {...props}
    />
  );
}

export function TooltipProvider({
  children,
}: {
  children: ReactNode;
}) {
  return <TooltipPrimitive.Provider delayDuration={250}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className={cn(
            'z-50 max-w-xs rounded-md border border-line bg-surface-1 px-2.5 py-1.5',
            'text-xs leading-relaxed text-fg shadow-lg shadow-black/20',
            'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0'
          )}
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}


export function Separator({
  className,
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      className={cn(
        'shrink-0 bg-line data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className
      )}
      {...props}
    />
  );
}


export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'danger' | 'ok' | 'muted';
}) {
  const toneClass = {
    default: 'text-fg',
    danger: 'text-danger',
    ok: 'text-ok',
    muted: 'text-muted',
  }[tone ?? 'default'];
  return (
    <div className="min-w-0">
      <dt className="truncate text-[11px] font-medium tracking-wide text-muted uppercase">
        {label}
      </dt>
      <dd className={cn('mt-0.5 font-mono text-sm tabular-nums', toneClass)}>{value}</dd>
      {hint ? <p className="mt-0.5 text-[11px] leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}
