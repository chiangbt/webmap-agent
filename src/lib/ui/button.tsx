import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './utils';

/**
 * button 组件的 cva 样式变体表。
 *
 * variant 含义：
 * - `default`：主题色实底按钮（primary 背景，hover 时降为 90% 不透明度）；
 * - `destructive`：危险操作按钮（红色背景）；
 * - `outline`：描边按钮（透明底 + 边框，hover 时切换到 accent 背景）；
 * - `secondary`：次级实底按钮；
 * - `ghost`：幽灵按钮（无边框无底色，仅 hover 时出现 accent 背景）；
 * - `link`：链接样式按钮（primary 文字 + 下划线）。
 *
 * size 含义：
 * - `default`：标准高度 h-8；
 * - `sm`：小尺寸 h-7、字号 xs；
 * - `lg`：大尺寸 h-9；
 * - `icon`：正方形图标按钮（size-7，仅容纳一个图标）。
 *
 * 基础样式中内置了对内联 svg 的统一约束（默认 size-4、pointer-events-none、
 * shrink-0）以及 focus-visible 时的 ring 描边效果。默认 variant 为 `default`、
 * size 为 `default`。
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive:
          'bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20',
        outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3 py-1.5 has-[>svg]:px-2.5 text-sm',
        sm: 'h-7 rounded-md gap-1 px-2.5 text-xs has-[>svg]:px-2',
        lg: 'h-9 rounded-md px-4 has-[>svg]:px-3',
        icon: 'size-7',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/**
 * 按钮组件：库内 GeoAgent 面板使用的统一按钮样式。
 *
 * 关键 props：
 * - `variant` / `size`：视觉变体与尺寸，见 buttonVariants；
 * - `asChild`：为 true 时通过 Radix 的 Slot 把样式与 ref 合并到子元素上，
 *   不再渲染自身的 button（示例页用它把按钮样式套在 `<a>` 链接上）；
 * - 其余 props 透传给底层 button 元素。
 *
 * 为 React 18 使用 forwardRef：普通函数组件会静默丢弃 ref
 * （开发模式下还会打印 "cannot be given refs" 警告）。基于 Slot 的 asChild
 * 依然可用，因为 Radix 的 Slot 会把转发来的 ref 合并到子元素上。
 */
const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean;
    }
>(({ className, variant, size, asChild = false, ...props }, ref) => {
  // asChild 时渲染宿主为 Slot（样式/ref 合并到子元素），否则渲染原生 button
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      ref={ref}
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
});
Button.displayName = 'Button';

export { Button, buttonVariants };
