import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils';

/**
 * badge 组件的 cva 样式变体表。
 *
 * variant 含义：
 * - `default`：主题色实底徽标（primary 背景 + primary 前景）；
 * - `secondary`：次级实底徽标（secondary 背景）；
 * - `destructive`：危险/错误状态徽标（destructive 红色背景）；
 * - `outline`：无底色描边徽标，仅文字前景色；
 * - `success`：成功状态徽标（primary 的 15% 透明底 + primary 文字）；
 * - `warning`：警告状态徽标（amber 浅黄底 + 深黄文字）。
 *
 * 默认 variant 为 `default`。
 */
const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1 transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'text-foreground',
        success: 'border-transparent bg-primary/15 text-primary',
        warning: 'border-amber-300 bg-amber-50 text-amber-700',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/**
 * 徽标组件：用于展示标签、状态或计数的胶囊形小块。
 *
 * 关键 props：
 * - `variant`：视觉变体，见 badgeVariants（default/secondary/destructive/outline/success/warning）；
 * - `asChild`：为 true 时通过 Radix 的 Slot 把样式合并到子元素上，
 *   不再渲染自身的 span（常用于把 badge 套在 `<a>` 等自定义元素上）；
 * - 其余 props 透传给底层 span 元素。
 */
function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  // asChild 时渲染宿主为 Slot（样式合并到子元素），否则渲染原生 span
  const Comp = asChild ? Slot : 'span';

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
