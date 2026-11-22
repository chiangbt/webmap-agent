import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/demo/lib/utils';

/**
 * badge 组件的 cva 样式变体表。
 *
 * variant 含义：
 * - `default`：主题色实底徽标（primary 背景 + primary 前景）；
 * - `secondary`：次级实底徽标（secondary 背景）；
 * - `destructive`：危险/错误状态徽标（destructive 红色背景）；
 * - `outline`：无底色描边徽标，仅文字前景色。
 *
 * 基础样式内置对内联 svg 的约束（size-3、pointer-events-none）与
 * focus-visible 的 ring 描边。默认 variant 为 `default`。
 */
const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-white',
        outline: 'text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/**
 * 徽标组件：用于展示标签、状态或计数的胶囊形小块（演示站首页的示例卡片用它渲染技术标签）。
 *
 * 关键 props：
 * - `variant`：视觉变体，见 badgeVariants；
 * - `asChild`：为 true 时通过 Radix 的 Slot 把样式合并到子元素上，不再渲染自身 span；
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
