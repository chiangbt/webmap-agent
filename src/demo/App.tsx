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

type HomepageStrings = (typeof HOMEPAGE_I18N)['en'];

interface ExampleLink {
  href: string;
  titleKey: keyof HomepageStrings;
  descKey: keyof HomepageStrings;
  tags: string[];
}

const EXAMPLES: ExampleLink[] = [
  {
    href: './examples/basic/index.html',
    titleKey: 'basicTitle',
    descKey: 'basicDesc',
    tags: ['Vanilla JS', 'TypeScript'],
  },
  {
    href: './examples/react/index.html',
    titleKey: 'reactTitle',
    descKey: 'reactDesc',
    tags: ['React', 'TypeScript'],
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
];

export function App() {
  const [locale, setLocale] = useState<GeoAgentLocale>(resolveExamplesLocale);
  const t = HOMEPAGE_I18N[locale];

  // Keep the document title and `lang` in step with the chosen locale; the
  // example pages follow the persisted choice via the shared storage key.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = t.title;
  }, [locale, t.title]);

  const changeLocale = (value: string): void => {
    if (value !== 'en' && value !== 'zh-CN') return;
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
          <Select value={locale} onValueChange={changeLocale}>
            <SelectTrigger className="w-32" aria-label={t.language}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
              <SelectItem value="zh-CN">中文</SelectItem>
            </SelectContent>
          </Select>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {EXAMPLES.map((example) => (
            <a key={example.href} href={example.href} className="group block">
              <Card className="h-full gap-4 transition-colors group-hover:border-primary">
                <CardHeader>
                  <CardTitle>{t[example.titleKey]}</CardTitle>
                  <CardDescription>{t[example.descKey]}</CardDescription>
                </CardHeader>
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
