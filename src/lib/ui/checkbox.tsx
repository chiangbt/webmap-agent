import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { CheckIcon } from 'lucide-react';

import { cn } from './utils';

/**
 * 复选框组件：基于 Radix UI Checkbox 的受控/非受控勾选框。
 *
 * 选中态通过 `data-[state=checked]` 切换为主题色底 + 白色对勾图标；
 * 支持 Radix Root 的 checked / onCheckedChange / disabled 等全部 props。
 * className 用于覆盖默认样式。
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer border-input focus-visible:border-ring focus-visible:ring-ring/50 size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary',
        className,
      )}
      {...props}
    >
      {/* Indicator 仅在勾选状态下渲染，内部放对勾图标，颜色跟随文字前景色 */}
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
