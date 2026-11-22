import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';

/** 可折叠容器的根组件：管理展开/收起状态（open / onOpenChange），受 Radix Root 支持。 */
const Collapsible = CollapsiblePrimitive.Root;

/** 折叠触发器：点击后切换 Collapsible 的展开/收起状态，可包任意内容。 */
const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

/** 折叠内容区：仅在展开状态下挂载显示，收起时由 Radix 控制其可见性。 */
const CollapsibleContent = CollapsiblePrimitive.Content;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
