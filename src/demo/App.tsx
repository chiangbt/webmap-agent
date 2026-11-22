import { useEffect, useState } from 'react';
import type { GeoAgentLocale } from '@/lib/i18n';
import { Badge } from '@/demo/components/ui/badge';
import { Button } from '@/demo/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/demo/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/demo/components/ui/select';
import { HOMEPAGE_I18N } from '@/demo/i18n';
import { persistExamplesLocale, resolveExamplesLocale } from '@/demo/locale';

/** 首页文案的英文基准键集，用于约束示例条目的 titleKey/descKey 取值。 */
type HomepageStrings = (typeof HOMEPAGE_I18N)['en'];

/** 首页单个示例卡片的链接信息。 */
interface ExampleLink {
  /** 示例页相对路径（构建后为静态页面）。 */
  href: string;
  /** 示例标题在 i18n 文案表中的键名。 */
  titleKey: keyof HomepageStrings;
  /** 示例描述在 i18n 文案表中的键名。 */
  descKey: keyof HomepageStrings;
  /** 卡片底部展示的技术标签，如地图引擎与运行方式。 */
  tags: string[];
}

/** 首页展示的示例清单：与 docs/examples 产出的静态示例页一一对应。 */
const EXAMPLES: ExampleLink[] = [
  {
    href: './examples/basic/index.html',
    titleKey: 'basicTitle',
    descKey: 'basicDesc',
    tags: ['MapLibre', 'Vanilla JS'],
  },
  {
    href: './examples/react/index.html',
    titleKey: 'reactTitle',
    descKey: 'reactDesc',
    tags: ['MapLibre', 'React'],
  },
  {
    href: './examples/earth-engine/index.html',
    titleKey: 'earthEngineTitle',
    descKey: 'earthEngineDesc',
    tags: ['Earth Engine', 'OAuth'],
  },
  {
    href: './examples/leaflet/index.html',
    titleKey: 'leafletTitle',
    descKey: 'leafletDesc',
    tags: ['Leaflet', 'mapEngine'],
  },
  {
    href: './examples/openlayers/index.html',
    titleKey: 'openlayersTitle',
    descKey: 'openlayersDesc',
    tags: ['OpenLayers', 'mapEngine'],
  },
  {
    href: './examples/arcgis-map/index.html',
    titleKey: 'arcgisMapTitle',
    descKey: 'arcgisMapDesc',
    tags: ['ArcGIS', 'MapView', '2D'],
  },
  {
    href: './examples/arcgis-scene/index.html',
    titleKey: 'arcgisSceneTitle',
    descKey: 'arcgisSceneDesc',
    tags: ['ArcGIS', 'SceneView', '3D'],
  },
];

/**
 * 示例站首页组件：头部展示项目名与简介、语言切换下拉框，
 * 中部为各示例页的卡片网格（标题/描述/技术标签），底部为仓库与 npm 链接。
 *
 * 语言状态保存在 localStorage（共享 key），示例页会自动跟随首页的选择。
 */
export function App() {
  // 以 resolveExamplesLocale 作为惰性初始化器：首次渲染即按存储/浏览器语言定值
  const [locale, setLocale] = useState<GeoAgentLocale>(resolveExamplesLocale);
  // 当前语言对应的文案表，组件内所有文字都从这里取键
  const t = HOMEPAGE_I18N[locale];

  // 让 document 的标题与 `lang` 属性跟随所选语言；示例页通过共享的
  // storage key 读取持久化的语言选择。
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t.title;
    // 语言或对应标题变化时同步一次文档属性
  }, [locale, t.title]);

  /** 语言切换回调：校验取值合法后更新状态并持久化到 localStorage。 */
  const changeLocale = (value: string): void => {
    // Select 的 onValueChange 类型宽泛，这里白名单过滤非法值
    if (value !== 'en' && value !== 'zh-CN' && value !== 'zh-TW') return;
    setLocale(value);
    persistExamplesLocale(value);
  };

  return (
    <div className="min-h-screen bg-muted/50">
      <div className="mx-auto w-4/5 max-w-6xl py-10">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-4xl leading-tight font-semibold tracking-tight">
              web-geoagent
            </h1>
            <p className="mt-2.5 text-lg text-muted-foreground">{t.subtitle}</p>
          </div>
          {/* 语言切换下拉框：value 受控绑定 locale，切换即写入 localStorage */}
          <Select value={locale} onValueChange={changeLocale}>
            <SelectTrigger className="w-32" aria-label={t.language}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh-CN">简体中文</SelectItem>
              <SelectItem value="zh-TW">繁體中文</SelectItem>
            </SelectContent>
          </Select>
        </header>

        {/* 示例卡片网格：响应式 1/2/3 列，整张卡片作为链接可点 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {EXAMPLES.map((example) => (
            <a key={example.href} href={example.href} className="group block">
              {/* group-hover 让卡片在外层链接 hover 时高亮描边 */}
              <Card className="h-full gap-4 transition-colors group-hover:border-primary">
                <CardHeader>
                  <CardTitle>{t[example.titleKey]}</CardTitle>
                  <CardDescription>{t[example.descKey]}</CardDescription>
                </CardHeader>
                {/* mt-auto 把标签区推到卡片底部，保证多卡片高度不齐时对齐 */}
                <CardContent className="mt-auto">
                  <div className="flex flex-wrap gap-2">
                    {example.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </a>
          ))}
        </div>

        {/* 页脚：仓库与 npm 包的链接按钮 */}
        <footer className="mt-8 flex items-center gap-2 text-muted-foreground">
          <Button asChild variant="link" className="h-auto p-0 font-semibold">
            <a
              href="https://gitea.geoportal.cn/AI/webmap-agent"
              target="_blank"
              rel="noreferrer"
            >
              {t.github}
            </a>
          </Button>
          <span>·</span>
          <Button asChild variant="link" className="h-auto p-0 font-semibold">
            <a
              href="https://www.npmjs.com/package/web-geoagent"
              target="_blank"
              rel="noreferrer"
            >
              {t.npm}
            </a>
          </Button>
        </footer>
      </div>
    </div>
  );
}
