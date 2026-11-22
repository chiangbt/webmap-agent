import * as React from 'react';

import { cn } from '@/demo/lib/utils';

/**
 * 卡片容器组件：演示站的卡片基底（首页示例卡片使用）。
 * 垂直 flex 布局、圆角描边与浅阴影，子区块之间默认 gap-6。
 */
function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn(
        'bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

/**
 * 卡片头部区块：默认两行网格（标题 + 描述）；若内部出现 CardAction
 * （data-slot=card-action），通过 has-data 选择器自动切成「标题列 + 操作列」布局。
 */
function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'grid auto-rows-min grid-rows-[auto_auto] items-start gap-1.5 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto]',
        className,
      )}
      {...props}
    />
  );
}

/** 卡片标题：加粗、无额外行高，通常放在 CardHeader 内。 */
function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('leading-none font-semibold', className)}
      {...props}
    />
  );
}

/** 卡片描述文字：弱化的次要色小字，通常放在 CardHeader 内 CardTitle 下方。 */
function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-muted-foreground text-sm leading-relaxed', className)}
      {...props}
    />
  );
}

/** 卡片操作区：放置在 CardHeader 内的右上角操作元素（按钮、开关等）。 */
function CardAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-action"
      className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)}
      {...props}
    />
  );
}

/** 卡片正文区块：仅提供左右内边距，与头/尾保持水平对齐。 */
function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-6', className)} {...props} />;
}

/** 卡片底部区块：水平 flex 布局，常用于放操作按钮组。 */
function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center px-6', className)}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};
