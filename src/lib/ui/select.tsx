import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';

import { cn } from './utils';

/** 下拉选择器根组件：管理选中值与开合状态，透传 Radix Root 的 value / onValueChange 等 props。 */
function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

/** 当前选中值的展示位：由 Radix 根据选中项自动渲染其文本。 */
function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

/**
 * 选择器触发按钮：点击后打开下拉面板。
 *
 * 默认在右侧渲染一个向下的 Chevron 图标指示开合；未选中值时通过
 * `data-[placeholder]` 显示占位色。className 用于覆盖默认样式。
 */
function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex h-8 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-2.5 py-1.5 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      {/* 触发器右侧的下拉指示箭头，经 Radix Icon 以 asChild 方式注入 */}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/**
 * 下拉面板内容容器：渲染在 Portal 中避免被父级 overflow/层级裁剪。
 *
 * 关键 props：
 * - `position`：`popper`（默认，浮层定位、与触发器同宽对齐）或
 *   `item-aligned`/`inline`；popper 模式下按弹出方向附加位移修正，
 *   并把 Viewport 宽度同步为触发器宽度；
 * - 其余 props 透传给 Radix Content。
 */
function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    // 经 Portal 挂到 body，避免被地图容器等父级的 overflow 或 z-index 裁剪
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'bg-popover text-popover-foreground relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border shadow-md',
          // popper 定位模式下按弹出方位加 1 像素位移，让面板与触发器之间留出视觉间隙
          position === 'popper' &&
            'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
          className,
        )}
        position={position}
        {...props}
      >
        {/* 选项列表视口：popper 模式下把高度/最小宽度对齐触发器，保证面板宽度不小于触发器 */}
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/**
 * 下拉选项：单个可选项行，选中项右侧显示对勾图标。
 *
 * 通过 Radix Item 的 value 标识取值，disabled 项自动降低不透明度并
 * 禁用指针事件；children 经 ItemText 渲染（参与选中值显示）。
 */
function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'focus:bg-accent focus:text-accent-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      {/* 右侧对勾指示器：仅当前项被选中时由 Radix 渲染出来 */}
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      {/* ItemText 包裹的文本会作为选中值回显到 SelectValue */}
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
