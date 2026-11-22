import * as React from 'react';

import { cn } from './utils';

/**
 * 文本输入框组件：面板内文本框、搜索框等场景使用的基础 input 样式。
 *
 * 通过 forwardRef 转发底层 input 元素的 ref；`type` 决定 input 类型
 * （text/number/password 等），其余 props 原样透传。className 用于覆盖默认样式。
 *
 * 为 React 18 使用 forwardRef：普通函数组件会静默丢弃 ref
 * （开发模式下还会打印 "cannot be given refs" 警告）。
 */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex h-8 w-full min-w-0 rounded-md border bg-transparent px-2.5 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };
