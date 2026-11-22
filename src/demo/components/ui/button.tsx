import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/demo/lib/utils';

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
 * - `default`：标准高度 h-9；
 * - `sm`：小尺寸 h-8；
 * - `lg`：大尺寸 h-10；
 * - `icon`：正方形图标按钮（size-9）；
 * - `icon-sm`：小号正方形图标按钮（size-8）。
 *
 * 基础样式中还包含 aria-invalid 时的 destructive ring 描边（表单校验失败态）。
 * 默认 variant 为 `default`、size 为 `default`。
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive:
          'bg-destructive text-white shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-sm': 'size-8 rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

/**
 * 按钮组件：演示站统一按钮样式（shadcn/ui 新版定义，与库内 lib/ui/button 相比
 * 多出 icon-sm 尺寸与 aria-invalid 态）。
 *
 * 关键 props：
 * - `variant` / `size`：视觉变体与尺寸，见 buttonVariants；
 * - `asChild`：为 true 时通过 Radix 的 Slot 把样式合并到子元素上，不再渲染
 *   自身 button（首页与示例页用它把按钮样式套在 `<a>` 链接上）；
 * - 其余 props 透传给底层 button 元素。
 */
function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  // asChild 时渲染宿主为 Slot（样式合并到子元素），否则渲染原生 button
  const Comp = asChild ? Slot : 'button';

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
