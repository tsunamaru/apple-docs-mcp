import type { SearchResult } from './search-result-parser.js';
import { isResultTypeSupported } from './search-result-parser.js';
import { API_LIMITS, APPLE_URLS } from '../utils/constants.js';
import { httpClient } from '../utils/http-client.js';
import { normalizeFrameworkName } from '../utils/framework-mapper.js';
import { indexCache } from '../utils/cache.js';
import { logger } from '../utils/logger.js';

interface DocumentationIndexItem {
  path?: string;
  title: string;
  type: string;
  beta?: boolean;
  children?: DocumentationIndexItem[];
}

interface DocumentationIndex {
  interfaceLanguages?: Record<string, DocumentationIndexItem[]>;
}

interface ScoredResult {
  result: SearchResult;
  score: number;
}

const indexPromises = new Map<string, Promise<DocumentationIndex | null>>();

const PREFIX_FRAMEWORKS: Array<[RegExp, string[]]> = [
  [/^ui[a-z]/i, ['uikit']],
  [/^ns[a-z]/i, ['foundation', 'appkit']],
  [/^av[a-z]/i, ['avfoundation', 'avfaudio']],
  [/^cg[a-z]/i, ['coregraphics']],
  [/^ca[a-z]/i, ['quartzcore']],
  [/^mk[a-z]/i, ['mapkit']],
  [/^cl[a-z]/i, ['corelocation']],
  [/^hk[a-z]/i, ['healthkit']],
  [/^ar[a-z]/i, ['arkit']],
  [/^vn[a-z]/i, ['vision']],
  [/^nw[a-z]/i, ['network']],
  [/^ne[a-z]/i, ['networkextension']],
  [/^cb[a-z]/i, ['corebluetooth']],
  [/^cm[a-z]/i, ['coremotion']],
  [/^ph[a-z]/i, ['photokit']],
  [/^un[a-z]/i, ['usernotifications']],
];

function collectNamedFrameworks(
  items: DocumentationIndexItem[],
  normalizedQuery: string,
  compactQuery: string,
  candidates: string[],
): void {
  for (const item of items) {
    const pathParts = item.path?.split('/').filter(Boolean) ?? [];
    if (item.type === 'module' && pathParts.length === 2 && pathParts[0] === 'documentation') {
      const normalizedTitle = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const compactTitle = normalizeSearchText(item.title);
      const containsFrameworkName = normalizedTitle.length > 0 &&
        ` ${normalizedQuery} `.includes(` ${normalizedTitle} `);
      const containsCompactFrameworkName = compactTitle.length >= 4 && compactQuery.includes(compactTitle);

      if (containsFrameworkName || containsCompactFrameworkName) {
        candidates.push(pathParts[1].toLowerCase());
      }
    }

    if (item.children) {
      collectNamedFrameworks(item.children, normalizedQuery, compactQuery, candidates);
    }
  }
}

function getCandidateFrameworks(
  query: string,
  filterType: string,
  technologiesIndex: DocumentationIndex | null,
): string[] {
  if (filterType === 'sample') {
    return ['samplecode'];
  }

  const candidates: string[] = [];
  const trimmedQuery = query.trim();

  for (const [pattern, frameworks] of PREFIX_FRAMEWORKS) {
    if (pattern.test(trimmedQuery)) {
      candidates.push(...frameworks);
      break;
    }
  }

  if (technologiesIndex?.interfaceLanguages) {
    const technologyItems = technologiesIndex.interfaceLanguages.swift ??
      Object.values(technologiesIndex.interfaceLanguages)[0] ?? [];
    const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    collectNamedFrameworks(
      technologyItems,
      normalizedQuery,
      normalizeSearchText(query),
      candidates,
    );
  }

  // These two compact indexes cover Apple's modern unprefixed UI and
  // observation APIs, including the regressions that prompted this fallback.
  candidates.push('swiftui', 'observation');
  if (technologiesIndex) {
    candidates.push('technologies');
  }
  return [...new Set(candidates)];
}

async function loadDocumentationIndex(framework: string): Promise<DocumentationIndex | null> {
  const indexUrl = `${APPLE_URLS.TUTORIALS_DATA}index/${framework}`;
  const cached = indexCache.get<DocumentationIndex>(indexUrl);
  if (cached) {
    return cached;
  }

  const existing = indexPromises.get(framework);
  if (existing) {
    return existing;
  }

  const request = httpClient.getJson<DocumentationIndex>(indexUrl)
    .then((index) => {
      indexCache.set(indexUrl, index);
      return index;
    })
    .catch((error) => {
      logger.warn(`Failed to load documentation index for ${framework}:`, error);
      return null;
    })
    .finally(() => {
      indexPromises.delete(framework);
    });
  indexPromises.set(framework, request);
  return request;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function scoreIndexItem(item: DocumentationIndexItem, query: string): number {
  if (!item.path) {
    return 0;
  }

  const normalizedQuery = normalizeSearchText(query);
  const normalizedTitle = normalizeSearchText(item.title);
  const normalizedPath = normalizeSearchText(item.path);
  if (!normalizedQuery) {
    return 0;
  }

  if (normalizedTitle === normalizedQuery) {
    return 100;
  }
  if (normalizedPath.endsWith(normalizedQuery)) {
    return 90;
  }
  if (normalizedTitle.startsWith(normalizedQuery)) {
    return 75;
  }
  if (normalizedTitle.includes(normalizedQuery)) {
    return 60;
  }
  if (normalizedPath.includes(normalizedQuery)) {
    return 45;
  }

  const terms = query.toLowerCase().split(/\s+/).filter(term => term.length > 1);
  const searchableText = `${item.title} ${item.path}`.toLowerCase();
  return terms.length > 1 && terms.every(term => searchableText.includes(term)) ? 25 : 0;
}

function mapIndexItemType(type: string): string {
  if (type === 'sampleCode') {
    return 'sample-code';
  }
  if (type === 'tutorial') {
    return 'documentation-tutorial';
  }
  if (['article', 'overview', 'collection'].includes(type)) {
    return 'documentation-article';
  }
  return 'documentation';
}

function collectIndexResults(
  items: DocumentationIndexItem[],
  framework: string,
  query: string,
  filterType: string,
  results: ScoredResult[],
): void {
  for (const item of items) {
    const score = scoreIndexItem(item, query);
    const isDocumentationPath = item.path?.startsWith('/documentation/') ?? false;
    const isTutorialPath = item.path?.startsWith('/tutorials/') ?? false;
    const type = isTutorialPath ? 'documentation-tutorial' : mapIndexItemType(item.type);

    if (score > 0 && (isDocumentationPath || isTutorialPath) &&
        isResultTypeSupported(type, filterType)) {
      const pathFramework = isDocumentationPath
        ? item.path?.split('/').filter(Boolean)[1]
        : undefined;
      results.push({
        score,
        result: {
          title: item.title,
          url: `https://developer.apple.com${item.path}`,
          type,
          description: '',
          framework: pathFramework ? normalizeFrameworkName(pathFramework) : undefined,
          beta: item.beta ?? false,
        },
      });
    }

    if (item.children) {
      collectIndexResults(item.children, framework, query, filterType, results);
    }
  }
}

/**
 * Search a small set of Apple's public DocC navigator indexes. This is the
 * deterministic fallback for exact API lookups when a web-search provider is
 * throttled or unavailable.
 */
export async function searchDocumentationIndexes(
  query: string,
  filterType: string = 'all',
): Promise<SearchResult[]> {
  const technologiesIndex = filterType === 'sample'
    ? null
    : await loadDocumentationIndex('technologies');
  const frameworks = getCandidateFrameworks(query, filterType, technologiesIndex);
  const indexes = await Promise.all(frameworks.map((framework) =>
    framework === 'technologies' ? technologiesIndex : loadDocumentationIndex(framework),
  ));
  const scoredResults: ScoredResult[] = [];

  indexes.forEach((index, indexPosition) => {
    if (!index?.interfaceLanguages) {
      return;
    }

    const languageItems = index.interfaceLanguages.swift ??
      Object.values(index.interfaceLanguages)[0] ?? [];
    collectIndexResults(
      languageItems,
      frameworks[indexPosition],
      query,
      filterType,
      scoredResults,
    );
  });

  const uniqueResults = new Map<string, ScoredResult>();
  for (const scoredResult of scoredResults) {
    const existing = uniqueResults.get(scoredResult.result.url);
    if (!existing || scoredResult.score > existing.score) {
      uniqueResults.set(scoredResult.result.url, scoredResult);
    }
  }

  return [...uniqueResults.values()]
    .sort((a, b) => b.score - a.score || a.result.title.localeCompare(b.result.title))
    .slice(0, API_LIMITS.MAX_SEARCH_RESULTS)
    .map(({ result }) => result);
}
