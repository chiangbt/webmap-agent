import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 演示站 UI 组件共用的 className 合并工具。
 *
 * @param inputs 任意个数的 className 输入（字符串、数组、对象等 clsx 支持的形态）。
 * @returns 合并结果：先用 clsx 拼接，再用 tailwind-merge 去除相互冲突的
 *          Tailwind 类（后者优先），保证调用方可以用 className 覆盖默认样式。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
