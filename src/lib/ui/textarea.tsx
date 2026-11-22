import * as React from 'react';

import { cn } from './utils';

/**
 * 多行文本输入框组件：GeoAgent 面板的 prompt 输入区等场景使用的基础
 * textarea 样式。`field-sizing-content` 让高度随内容自动增长
 * （最小高度 min-h-16）；className 用于覆盖默认样式。
 *
 * React 18 下必须使用 forwardRef：GeoAgentPanel 会传入 ref 来驱动
 * prompt 历史的光标定位（React 19 的 ref-as-prop 在这里不适用，
 * 普通函数组件会静默丢弃 ref）。
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        className={cn(
          'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-2.5 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
