/**
 * 将数值限制在 [min, max] 区间内。
 *
 * @param value - 待限制的数值
 * @param min - 允许的最小值
 * @param max - 允许的最大值
 * @returns 限制后的数值
 *
 * @example
 * ```typescript
 * clamp(5, 0, 10);  // 返回 5
 * clamp(-5, 0, 10); // 返回 0
 * clamp(15, 0, 10); // 返回 10
 * ```
 */
export function clamp(value: number, min: number, max: number): number {
  // 先夹下界再夹上界，保证结果落在区间内。
  return Math.min(Math.max(value, min), max);
}

/**
 * 根据步长（step）为数值选择合适的保留小数位数并格式化为字符串。
 *
 * @param value - 待格式化的数值
 * @param step - 步长，用于推算小数位数
 * @returns 格式化后的字符串
 *
 * @example
 * ```typescript
 * formatNumericValue(5, 1);     // 返回 "5"
 * formatNumericValue(0.5, 0.1); // 返回 "0.5"
 * formatNumericValue(0.55, 0.01); // 返回 "0.55"
 * ```
 */
export function formatNumericValue(value: number, step: number): string {
  // 步长为 0 时无需推算小数位，直接输出原值。
  if (step === 0) return value.toString();
  // 10 的负指数：如 step=0.1 → -floor(-1)=1 位小数；step>=1 时结果为 0 位（clamp 到非负）。
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  return value.toFixed(decimals);
}

/**
 * 生成一个唯一的 ID 字符串。
 *
 * @param prefix - 可选的 ID 前缀
 * @returns 唯一的 ID 字符串
 *
 * @example
 * ```typescript
 * generateId('control'); // 返回 "control-abc123"
 * generateId();          // 返回 "abc123"
 * ```
 */
export function generateId(prefix?: string): string {
  // 用随机数转 36 进制并截取 7 个字符作为 ID 主体，碰撞概率足够低。
  const id = Math.random().toString(36).substring(2, 9);
  // 有前缀时拼接为 "prefix-id"，否则直接返回 ID。
  return prefix ? `${prefix}-${id}` : id;
}

/**
 * 对函数调用做防抖（debounce）：delay 时间内反复触发只保留最后一次。
 *
 * @param fn - 需要防抖的函数
 * @param delay - 防抖延迟（毫秒）
 * @returns 防抖后的函数
 *
 * @example
 * ```typescript
 * const debouncedUpdate = debounce(() => updateMap(), 100);
 * window.addEventListener('resize', debouncedUpdate);
 * ```
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  // 记录当前挂起的定时器；null 表示当前没有等待中的调用。
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    // 每次触发先取消上一个尚未执行的定时器，实现“只保留最后一次”。
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    // 重新计时；到期后才真正执行 fn 并清空定时器标记。
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delay);
  };
}

/**
 * 对函数调用做节流（throttle）：limit 毫秒窗口内最多执行一次。
 *
 * @param fn - 需要节流的函数
 * @param limit - 两次调用之间的最小间隔（毫秒）
 * @returns 节流后的函数
 *
 * @example
 * ```typescript
 * const throttledScroll = throttle(() => handleScroll(), 100);
 * window.addEventListener('scroll', throttledScroll);
 * ```
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  // 冷却标记：true 表示仍在冷却期，忽略本次触发。
  let inThrottle = false;

  return (...args: Parameters<T>) => {
    // 只在非冷却期执行；执行后进入冷却并限时解锁。
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      // 冷却期结束后重新允许下一次调用。
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * 由「类名 -> 是否启用」的对象生成 CSS 类字符串。
 *
 * @param classes - 以类名为键、布尔值为值的对象
 * @returns 空格分隔的类名字符串
 *
 * @example
 * ```typescript
 * classNames({ active: true, disabled: false, visible: true });
 * // 返回 "active visible"
 * ```
 */
export function classNames(classes: Record<string, boolean>): string {
  // 只保留值为真值的键名，再以空格拼接。
  return Object.entries(classes)
    .filter(([, value]) => value)
    .map(([key]) => key)
    .join(' ');
}
