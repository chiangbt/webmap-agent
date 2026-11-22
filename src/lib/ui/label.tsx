import * as React from 'react';

import { cn } from './utils';

/**
 * 表单标签组件：与 Input/Select 等控件配合使用的 `<label>` 元素。
 *
 * 默认渲染为小号加粗文字（text-xs font-medium）、水平 flex 布局，
 * 原生 htmlFor 关联与 className 覆盖均可用。
 */
function Label({ className, ...props }: React.ComponentProps<'label'>) {
  return (
    <label
      data-slot="label"
      className={cn(
        'flex select-none items-center gap-2 text-xs font-medium leading-none',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
