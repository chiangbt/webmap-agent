/**
 * @google/earthengine 包的类型垫片（shim）。
 *
 * 该官方包没有可用的 TypeScript 类型声明，这里用一个环境模块声明（ambient
 * module declaration）把它声明为默认导出 `unknown`，使 `earth-engine.ts`
 * 中的动态 `import("@google/earthengine")` 能通过类型检查；实际的 ee API
 * 形状由 `earth-engine.ts` 内部的 `EeModule` / `EeObject` 接口手工描述。
 */
declare module "@google/earthengine" {
  // 仅有默认导出，具体类型刻意保持 unknown，由调用方自行收窄。
  const ee: unknown;
  export default ee;
}
