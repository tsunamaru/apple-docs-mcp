import * as cheerio from 'cheerio';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { SearchResult } from './search-result-parser.js';
import { isResultTypeSupported } from './search-result-parser.js';
import { indexCache } from '../utils/cache.js';
import {
  API_LIMITS,
  DOCUMENTATION_SEARCH_CONFIG,
  DOCUMENTATION_SEARCH_URLS,
} from '../utils/constants.js';
import { normalizeFrameworkName } from '../utils/framework-mapper.js';
import { httpClient } from '../utils/http-client.js';

interface AppleSearchMetadata {
  availability?: string;
  description?: string;
  hierarchy?: string;
  kind?: string;
  metadataKind?: string;
  permalink?: string;
  title?: string;
}

interface SearxInstanceInfo {
  analytics?: boolean;
  main?: boolean;
  network_type?: string;
  http?: {
    status_code?: number;
    error?: unknown;
  };
  timing?: {
    search?: SearxTiming;
    search_go?: SearxTiming;
  };
  uptime?: {
    uptimeMonth?: number;
  };
}

interface SearxTiming {
  success_percentage?: number;
  all?: {
    value?: number;
    median?: number;
    mean?: number;
  } | null;
}

interface SearxInstanceDirectory {
  instances?: Record<string, SearxInstanceInfo>;
}

interface SearxSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
  }>;
}

let searxDirectoryPromise: Promise<SearxInstanceDirectory> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
}

function canonicalizeAppleDocumentationUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'developer.apple.com' ||
        url.username || url.password || url.port) {
      return null;
    }
    if (!url.pathname.startsWith('/documentation/') &&
        !url.pathname.startsWith('/tutorials/')) {
      return null;
    }

    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

function inferResultType(url: URL, kind: string, searchableText: string): string {
  if (url.pathname.startsWith('/tutorials/')) {
    return 'documentation-tutorial';
  }
  if (kind === 'sampleCode') {
    return 'sample-code';
  }
  if (['article', 'overview', 'collection'].includes(kind)) {
    return 'documentation-article';
  }
  if (kind) {
    return 'documentation';
  }
  return /\bsample (?:code|project)\b/i.test(searchableText)
    ? 'sample-code'
    : 'documentation';
}

function extractFramework(url: URL, hierarchy?: string): string | undefined {
  const hierarchyFramework = hierarchy?.split(' > ')[0]?.trim();
  if (hierarchyFramework) {
    return normalizeFrameworkName(hierarchyFramework);
  }
  if (!url.pathname.startsWith('/documentation/')) {
    return undefined;
  }

  const pathFramework = url.pathname.split('/').filter(Boolean)[1];
  if (!pathFramework) {
    return undefined;
  }
  try {
    return normalizeFrameworkName(decodeURIComponent(pathFramework));
  } catch {
    return normalizeFrameworkName(pathFramework);
  }
}

function cleanSearchText(value: string, containsHtml: boolean = false): string {
  const text = containsHtml ? cheerio.load(value).text() : value;
  return text.replace(/\s+/g, ' ').trim();
}

function createSearchResult(
  titleValue: string,
  urlValue: string,
  descriptionValue: string,
  filterType: string,
  options: {
    availability?: string;
    containsHtml?: boolean;
    hierarchy?: string;
    kind?: string;
  } = {},
): SearchResult | null {
  const url = canonicalizeAppleDocumentationUrl(urlValue);
  const title = cleanSearchText(titleValue, options.containsHtml)
    .replace(/\s*[|-]\s*Apple Developer(?: Documentation)?\s*$/i, '')
    .trim();
  if (!url || !title) {
    return null;
  }

  const description = cleanSearchText(descriptionValue, options.containsHtml);
  const type = inferResultType(
    url,
    options.kind ?? '',
    `${title} ${description}`,
  );
  if (!isResultTypeSupported(type, filterType)) {
    return null;
  }

  return {
    title,
    url: url.href,
    type,
    description,
    framework: extractFramework(url, options.hierarchy),
    beta: /\bbeta\b/i.test(`${options.availability ?? ''} ${title} ${description}`),
  };
}

function unwrapAppleSearchItem(item: unknown): {
  metadata: AppleSearchMetadata;
  excerpt: string;
} | null {
  if (!isRecord(item)) {
    return null;
  }

  let node = item;
  const excerpt = typeof node.excerpt === 'string' ? node.excerpt : '';
  if (isRecord(node.value)) {
    node = node.value;
  }
  if (isRecord(node.metadata)) {
    node = node.metadata;
  }
  if (node.metadataKind !== 'documentation') {
    return null;
  }

  return {
    metadata: node as AppleSearchMetadata,
    excerpt,
  };
}

function mapAppleSearchItems(items: unknown[], filterType: string): SearchResult[] {
  const results = new Map<string, SearchResult>();

  for (const item of items) {
    const unwrapped = unwrapAppleSearchItem(item);
    if (!unwrapped) {
      continue;
    }

    const { metadata, excerpt } = unwrapped;
    if (!metadata.title || !metadata.permalink) {
      continue;
    }
    const result = createSearchResult(
      metadata.title,
      metadata.permalink,
      metadata.description ?? excerpt,
      filterType,
      {
        availability: metadata.availability,
        hierarchy: metadata.hierarchy,
        kind: metadata.kind,
      },
    );
    if (result && !results.has(result.url)) {
      results.set(result.url, result);
    }
  }

  return [...results.values()].slice(0, API_LIMITS.MAX_SEARCH_RESULTS);
}

function parseSearchPayload(buffer: string): unknown[] | null {
  try {
    const payload = JSON.parse(buffer) as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.results)) {
      return null;
    }
    return payload.results;
  } catch {
    return null;
  }
}

/**
 * Parse the JSONL protocol used by Apple's public search frontend. Search
 * events edit a JSON buffer using append/removeLast operations.
 */
export function parseAppleDocumentationSearchJsonl(
  jsonl: string,
  filterType: string = 'all',
): SearchResult[] {
  let searchBuffer = '';
  let latestSearchItems: unknown[] | null = null;
  let quickSearchItems: unknown[] = [];
  let sawRecognizedEvent = false;
  let sawSearchEvent = false;
  let searchFailed = false;

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || typeof event.kind !== 'string') {
      continue;
    }

    if (event.kind === 'quickSearch') {
      sawRecognizedEvent = true;
      if (isRecord(event.response) && Array.isArray(event.response.results)) {
        quickSearchItems = event.response.results;
      }
      continue;
    }

    if (event.kind === 'quickSearchFinished' || event.kind === 'searchFinished') {
      sawRecognizedEvent = true;
      const parsed = parseSearchPayload(searchBuffer);
      if (parsed) {
        latestSearchItems = parsed;
      }
      continue;
    }

    if (event.kind === 'error') {
      sawRecognizedEvent = true;
      searchFailed = event.response === 'searchFailed' ||
        event.response === 'quickSearchFailed';
      continue;
    }

    if (event.kind !== 'search' || !isRecord(event.diff)) {
      continue;
    }

    sawRecognizedEvent = true;
    sawSearchEvent = true;
    const removeLast = typeof event.diff.removeLast === 'number'
      ? event.diff.removeLast
      : 0;
    const append = typeof event.diff.append === 'string' ? event.diff.append : '';
    if (!Number.isInteger(removeLast) || removeLast < 0 || removeLast > searchBuffer.length) {
      throw new Error('Apple documentation search returned an invalid JSONL diff');
    }

    if (removeLast > 0) {
      searchBuffer = searchBuffer.slice(0, -removeLast);
    }
    searchBuffer += append;
    const parsed = parseSearchPayload(searchBuffer);
    if (parsed) {
      latestSearchItems = parsed;
    }
  }

  if (!sawRecognizedEvent) {
    throw new Error('Apple documentation search returned an invalid JSONL response');
  }
  if (sawSearchEvent) {
    const finalSearchItems = parseSearchPayload(searchBuffer);
    if (finalSearchItems === null) {
      throw new Error('Apple documentation search returned an invalid JSONL response');
    }
    latestSearchItems = finalSearchItems;
  }

  const items = [
    ...(latestSearchItems ?? []),
    ...quickSearchItems,
  ];
  const results = mapAppleSearchItems(items, filterType);
  if (results.length === 0 && searchFailed) {
    throw new Error('Apple documentation search provider reported a failure');
  }
  return results;
}

export async function searchAppleDocumentationProvider(
  query: string,
  filterType: string = 'all',
): Promise<SearchResult[]> {
  const requestBody: Record<string, unknown> = {
    text: query,
    targetResultLocale: 'en_US',
    includedResponses: filterType === 'all'
      ? ['quickSearch', 'search']
      : ['search'],
  };
  if (filterType === 'documentation') {
    requestBody.filterCategory = { documentation: {} };
  } else if (filterType === 'sample') {
    requestBody.filterCategory = { sampleCode: {} };
  }

  const response = await httpClient.postText(
    DOCUMENTATION_SEARCH_URLS.APPLE_PROVIDER,
    JSON.stringify(requestBody),
    {
      timeout: DOCUMENTATION_SEARCH_CONFIG.APPLE_PROVIDER_TIMEOUT,
      retries: 1,
      headers: {
        'Accept': 'application/jsonl',
        'Content-Type': 'application/json',
      },
    },
  );
  return parseAppleDocumentationSearchJsonl(response, filterType);
}

function getSearxTimingScore(info: SearxInstanceInfo): number {
  return Math.max(
    info.timing?.search?.success_percentage ?? 0,
    info.timing?.search_go?.success_percentage ?? 0,
  );
}

function getSearxLatency(info: SearxInstanceInfo): number {
  const timing = info.timing?.search?.all;
  return timing?.value ?? timing?.median ?? timing?.mean ?? Number.POSITIVE_INFINITY;
}

function normalizeSearxInstanceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        hostname === 'localhost' || hostname.endsWith('.localhost') ||
        hostname.endsWith('.local') || hostname.endsWith('.internal') ||
        isIP(hostname) !== 0) {
      return null;
    }

    url.hostname = hostname;
    url.hash = '';
    url.search = '';
    if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
    }
    return url.href;
  } catch {
    return null;
  }
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet =>
    !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second, third] = octets;
  return first !== 0 && first !== 10 && first !== 127 && first < 224 &&
    !(first === 100 && second >= 64 && second <= 127) &&
    !(first === 169 && second === 254) &&
    !(first === 172 && second >= 16 && second <= 31) &&
    !(first === 192 && second === 0 && (third === 0 || third === 2)) &&
    !(first === 192 && second === 168) &&
    !(first === 198 && (second === 18 || second === 19)) &&
    !(first === 198 && second === 51 && third === 100) &&
    !(first === 203 && second === 0 && third === 113);
}

function parseIpv6(address: string): number[] | null {
  let normalized = address.toLowerCase().split('%')[0];
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = normalized.slice(lastColon + 1);
    if (!isPublicIpv4(ipv4) && isIP(ipv4) !== 4) {
      return null;
    }
    const octets = ipv4.split('.').map(Number);
    normalized = `${normalized.slice(0, lastColon)}:${
      ((octets[0] << 8) | octets[1]).toString(16)
    }:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return null;
  }

  const parts = [
    ...left,
    ...Array.from({ length: missing }, () => '0'),
    ...right,
  ].map(part => Number.parseInt(part, 16));
  if (parts.length !== 8 || parts.some(part =>
    !Number.isInteger(part) || part < 0 || part > 0xffff)) {
    return null;
  }
  return parts;
}

function isPublicIpv6(address: string): boolean {
  const parts = parseIpv6(address);
  if (!parts) {
    return false;
  }

  const allButLastAreZero = parts.slice(0, 7).every(part => part === 0);
  if (parts.every(part => part === 0) || (allButLastAreZero && parts[7] === 1)) {
    return false;
  }
  if ((parts.slice(0, 5).every(part => part === 0) && parts[5] === 0xffff) ||
      parts.slice(0, 6).every(part => part === 0)) {
    const mappedIpv4 = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
    return isPublicIpv4(mappedIpv4);
  }

  const first = parts[0];
  return (first & 0xfe00) !== 0xfc00 &&
    (first & 0xffc0) !== 0xfe80 &&
    (first & 0xffc0) !== 0xfec0 &&
    (first & 0xff00) !== 0xff00 &&
    !(first === 0x2001 && parts[1] === 0x0db8);
}

function isPublicIpAddress(address: string): boolean {
  const family = isIP(address.split('%')[0]);
  return family === 4
    ? isPublicIpv4(address)
    : family === 6 && isPublicIpv6(address);
}

async function assertPublicSearxInstance(instance: string): Promise<void> {
  const hostname = new URL(instance).hostname;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(entry => !isPublicIpAddress(entry.address))) {
    throw new Error('SearX instance resolved to a non-public address');
  }
}

export function selectSearxInstances(directory: SearxInstanceDirectory): string[] {
  return Object.entries(directory.instances ?? {})
    .map(([instanceUrl, info]) => ({
      info: isRecord(info) ? info as SearxInstanceInfo : null,
      url: normalizeSearxInstanceUrl(instanceUrl),
    }))
    .filter((entry): entry is { info: SearxInstanceInfo; url: string } =>
      entry.url !== null &&
      entry.info !== null &&
      entry.info.main === true &&
      entry.info.analytics === false &&
      entry.info.network_type === 'normal' &&
      entry.info.http?.status_code === 200 &&
      !entry.info.http.error &&
      getSearxTimingScore(entry.info) > 0,
    )
    .sort((a, b) =>
      getSearxTimingScore(b.info) - getSearxTimingScore(a.info) ||
      (b.info.uptime?.uptimeMonth ?? 0) - (a.info.uptime?.uptimeMonth ?? 0) ||
      getSearxLatency(a.info) - getSearxLatency(b.info) ||
      a.url.localeCompare(b.url),
    )
    .map(entry => entry.url);
}

async function loadSearxInstanceDirectory(): Promise<SearxInstanceDirectory> {
  const cacheKey = DOCUMENTATION_SEARCH_URLS.SEARX_INSTANCES;
  const cached = indexCache.get<SearxInstanceDirectory>(cacheKey);
  if (cached) {
    return cached;
  }
  if (searxDirectoryPromise) {
    return searxDirectoryPromise;
  }

  searxDirectoryPromise = httpClient.getJson<SearxInstanceDirectory>(cacheKey, {
    timeout: DOCUMENTATION_SEARCH_CONFIG.SEARX_DIRECTORY_TIMEOUT,
    retries: 1,
  })
    .then((directory) => {
      if (!isRecord(directory) || !isRecord(directory.instances)) {
        throw new Error('SearX instance directory returned an invalid response');
      }
      indexCache.set(cacheKey, directory);
      return directory;
    })
    .finally(() => {
      searxDirectoryPromise = null;
    });
  return searxDirectoryPromise;
}

function buildSearxQuery(query: string, filterType: string): string {
  return filterType === 'sample'
    ? `site:developer.apple.com/documentation/ "sample code" ${query}`
    : `site:developer.apple.com ${query}`;
}

function mapSearxResults(response: SearxSearchResponse, filterType: string): SearchResult[] {
  const results = new Map<string, SearchResult>();
  for (const item of response.results ?? []) {
    if (!isRecord(item) || typeof item.title !== 'string' ||
        typeof item.url !== 'string') {
      continue;
    }
    const result = createSearchResult(
      item.title,
      item.url,
      typeof item.content === 'string' ? item.content : '',
      filterType,
      { containsHtml: true },
    );
    if (result && !results.has(result.url)) {
      results.set(result.url, result);
    }
  }
  return [...results.values()].slice(0, API_LIMITS.MAX_SEARCH_RESULTS);
}

/**
 * Last-resort search through a bounded set of healthy public SearXNG
 * instances. The instance directory is cached; individual failures are not.
 */
export async function searchSearxDocumentationProvider(
  query: string,
  filterType: string = 'all',
): Promise<SearchResult[]> {
  const directory = await loadSearxInstanceDirectory();
  const instances = selectSearxInstances(directory)
    .slice(0, DOCUMENTATION_SEARCH_CONFIG.SEARX_MAX_INSTANCE_ATTEMPTS);
  if (instances.length === 0) {
    throw new Error('No healthy SearX instances are currently available');
  }

  let receivedValidResponse = false;
  let lastError: unknown;
  for (const instance of instances) {
    const searchUrl = new URL('search', instance);
    searchUrl.searchParams.set('q', buildSearxQuery(query, filterType));
    searchUrl.searchParams.set('format', 'json');
    searchUrl.searchParams.set('language', 'en');
    searchUrl.searchParams.set('categories', 'general');

    try {
      await assertPublicSearxInstance(instance);
      const response = await httpClient.getJson<SearxSearchResponse>(searchUrl.href, {
        timeout: DOCUMENTATION_SEARCH_CONFIG.SEARX_INSTANCE_TIMEOUT,
        retries: 0,
        redirect: 'error',
      });
      if (!isRecord(response) || !Array.isArray(response.results)) {
        throw new Error('SearX instance returned an invalid response');
      }
      receivedValidResponse = true;
      const results = mapSearxResults(response, filterType);
      if (results.length > 0) {
        return results;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (receivedValidResponse) {
    return [];
  }
  const reason = lastError === undefined ? '' : `: ${getErrorMessage(lastError)}`;
  throw new Error(`All selected SearX instances failed${reason}`);
}
