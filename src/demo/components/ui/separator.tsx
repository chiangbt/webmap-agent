import * as React from 'react';
import * as SeparatorPrimitive from '@radix-ui/react-separator';

import { cn } from '@/demo/lib/utils';

/**
 * 分隔线组件：基于 Radix UI Separator，用于内容区块之间的视觉切分。
 *
 * 关键 props：
 * - `orientation`：`horizontal`（默认，水平 1px 线占满宽度）或
 *   `vertical`（垂直线占满高度，可配合 className 限高）；
 * - `decorative`：默认 true，表示对屏幕阅读器纯装饰、不参与语义分隔。
 */
function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
