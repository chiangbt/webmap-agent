/**
 * 演示站首页的 React 挂载入口：引入 demo 样式后把 App 渲染到 #root。
 */
import { createRoot } from 'react-dom/client';
import { App } from '@/demo/App';
// 首页的全局样式（字体、布局基调等）
import '@/demo/demo.css';

// 非空断言：index.html 保证存在 #root 容器
createRoot(document.getElementById('root')!).render(<App />);
