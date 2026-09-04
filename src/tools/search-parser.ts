import * as cheerio from 'cheerio';
import type { SearchResult } from './search-result-parser.js';
import { isResultTypeSupported, parseSearchResult } from './search-result-parser.js';
import { API_LIMITS } from '../utils/constants.js';
import { logger } from '../utils/logger.js';
import { normalizeFrameworkName } from '../utils/framework-mapper.js';

/**
 * Formats search results for display
 */
export function formatSearchResults(
  results: SearchResult[],
  query: string,
  filterType: string,
  searchUrl: string,
): string {
  let content = '';

  // Add header
  content += '# Apple Documentation Search Results\n\n';
  content += `**Query:** "${query}"\n`;
  content += `**Filter:** ${filterType}\n`;
  content += `**Results found:** ${results.length}\n\n`;

  // Check if query might be video-related
  const videoSuggestion = getVideoSuggestion(query);
  if (videoSuggestion) {
    content += videoSuggestion;
  }

  if (results.length === 0) {
    content += formatNoResultsMessage(query, filterType, searchUrl);
    return content;
  }

  // Group results by type
  const groupedResults = groupResultsByType(results);

  // Format each group
  Object.entries(groupedResults).forEach(([type, typeResults]) => {
    content += formatResultGroup(type, typeResults);
  });

  // Add footer
  content += formatSearchFooter(searchUrl);

  return content;
}

function normalizeRelevanceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function getMergedResultRelevance(result: SearchResult, query: string): number {
  const normalizedQuery = normalizeRelevanceText(query);
  if (!normalizedQuery) {
    return 0;
  }

  if (normalizeRelevanceText(result.title) === normalizedQuery) {
    return 3;
  }

  try {
    const pathLeaf = new URL(result.url).pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (normalizeRelevanceText(decodeURIComponent(pathLeaf)) === normalizedQuery) {
      return 2;
    }
  } catch {
    // Keep the provider's original order for malformed URLs.
  }

  return normalizeRelevanceText(result.title).startsWith(normalizedQuery) ? 1 : 0;
}

/**
 * Merge provider results with deterministic index results. Provider ordering is
 * retained within each relevance tier, while exact index matches can still
 * move ahead of partial provider matches.
 */
export function mergeDocumentationSearchResults(
  indexResults: SearchResult[],
  providerResults: SearchResult[],
  query: string,
): SearchResult[] {
  const uniqueResults = new Map<string, SearchResult>();

  for (const result of [...providerResults, ...indexResults]) {
    const existing = uniqueResults.get(result.url);
    if (!existing) {
      uniqueResults.set(result.url, result);
      continue;
    }

    uniqueResults.set(result.url, {
      ...existing,
      description: existing.description || result.description,
      framework: existing.framework ?? result.framework,
      beta: existing.beta || result.beta,
    });
  }

  return [...uniqueResults.values()]
    .map((result, position) => ({
      result,
      position,
      relevance: getMergedResultRelevance(result, query),
    }))
    .sort((a, b) => b.relevance - a.relevance || a.position - b.position)
    .slice(0, API_LIMITS.MAX_SEARCH_RESULTS)
    .map(({ result }) => result);
}

/**
 * Format no results message
 */
function formatNoResultsMessage(query: string, filterType: string, searchUrl: string): string {
  let content = '## No Results Found\n\n';
  content += `No ${filterType === 'all' ? '' : filterType + ' '}results found for "${query}".\n\n`;
  content += '### Suggestions:\n';
  content += '- Try using different keywords\n';
  content += '- Check spelling\n';
  content += '- Use more general terms\n';
  content += '- Try searching for framework names (e.g., "SwiftUI", "UIKit")\n';

  // Add video-specific suggestion if applicable
  const videoSuggestion = getVideoSuggestion(query);
  if (videoSuggestion) {
    content += '- For WWDC videos, use the dedicated WWDC tools\n';
  }

  content += `\n[View search on Apple Developer](${searchUrl})`;
  return content;
}

/**
 * Group results by type
 */
function groupResultsByType(results: SearchResult[]): Record<string, SearchResult[]> {
  const groups: Record<string, SearchResult[]> = {};

  results.forEach(result => {
    const displayType = getDisplayType(result.type);
    if (!groups[displayType]) {
      groups[displayType] = [];
    }
    groups[displayType].push(result);
  });

  return groups;
}

/**
 * Get display type for result
 */
function getDisplayType(type: string): string {
  const typeDisplayNames: Record<string, string> = {
    'documentation': '📚 API Documentation',
    'documentation-article': '📄 Articles',
    'documentation-tutorial': '📖 Tutorials',
    'sample-code': '💻 Sample Code',
    'guide': '📋 Guides',
  };

  return typeDisplayNames[type] || '📝 Other';
}

/**
 * Format a group of results
 */
function formatResultGroup(type: string, results: SearchResult[]): string {
  let content = `## ${type}\n\n`;

  results.forEach((result, index) => {
    content += formatSingleResult(result, index + 1);
  });

  return content;
}

/**
 * Format a single search result
 */
function formatSingleResult(result: SearchResult, index: number): string {
  let content = `### ${index}. ${result.title}`;

  // Add badges
  const badges = [];
  if (result.beta) {
    badges.push('🧪 Beta');
  }
  if (badges.length > 0) {
    content += ` ${badges.join(' ')}`;
  }

  content += '\n\n';

  // Add metadata
  if (result.framework) {
    content += `**Framework:** ${result.framework}\n`;
  }
  content += `**Type:** ${result.type.replace(/-/g, ' ')}\n`;

  // Add description
  if (result.description) {
    content += `**Description:** ${result.description}\n`;
  }

  // Add URL
  content += `**URL:** ${result.url}\n\n`;

  return content;
}

/**
 * Format search footer
 */
function formatSearchFooter(searchUrl: string): string {
  return `---\n\n[View all results on Apple Developer](${searchUrl})`;
}

/**
 * Check if query might be video-related and provide WWDC tool suggestions
 */
function getVideoSuggestion(query: string): string | null {
  const videoKeywords = [
    'video', 'wwdc', 'session', 'presentation', 'talk', 'keynote',
    'demo', 'tutorial', 'walkthrough', 'overview', 'introduction',
    'deep dive', 'best practices', 'tips', 'tricks',
  ];

  const queryLower = query.toLowerCase();
  const hasVideoKeyword = videoKeywords.some(keyword => queryLower.includes(keyword));

  // Also check for year patterns (e.g., "2024", "2025", "wwdc24")
  const hasYearPattern = /\b(20[2-9][0-9]|wwdc[2-9][0-9])\b/i.test(query);

  if (hasVideoKeyword || hasYearPattern) {
    return `## 💡 Looking for WWDC Videos?

This search covers documentation and samples, but not WWDC videos. For WWDC content, try these tools:

- **\`list_wwdc_videos\`** - Browse WWDC videos by year, topic, or code availability
- **\`search_wwdc_content\`** - Search through video transcripts and code examples
- **\`browse_wwdc_topics\`** - Explore videos organized by topic categories

---

`;
  }

  return null;
}

/**
 * Parse search results with reduced complexity
 */
export function parseSearchResults(
  html: string,
  query: string,
  searchUrl: string,
  filterType: string = 'all',
): { content: Array<{ type: string; text: string }> } {
  try {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];

    // Parse each search result (with limit)
    $('.search-result').each((_, element) => {
      if (results.length >= API_LIMITS.MAX_SEARCH_RESULTS) {
        return false; // Stop parsing when limit reached
      }
      const result = parseSearchResult($(element), filterType);
      if (result) {
        results.push(result);
      }
      return true; // Continue parsing
    });

    // Format results
    const formattedContent = formatSearchResults(results, query, filterType, searchUrl);

    return {
      content: [{
        type: 'text',
        text: formattedContent,
      }],
    };
  } catch (error) {
    logger.error('Error parsing search results:', error);
    return {
      content: [{
        type: 'text',
        text: `Error parsing search results: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }],
    };
  }
}

/**
 * Decode a result URL returned by DuckDuckGo's HTML search endpoint.
 *
 * Results normally point at /l/?uddg=<encoded target>, but direct links are
 * accepted as well. Only canonical HTTPS links on developer.apple.com are
 * returned so a malformed search response cannot inject links.
 */
function extractAppleResultUrl(href: string | undefined): URL | null {
  if (!href) {
    return null;
  }

  try {
    const searchResultUrl = new URL(href, 'https://html.duckduckgo.com');
    const redirectTarget = searchResultUrl.searchParams.get('uddg');
    const targetUrl = new URL(redirectTarget ?? searchResultUrl.href);

    if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== 'developer.apple.com') {
      return null;
    }

    if (!targetUrl.pathname.startsWith('/documentation/') &&
        !targetUrl.pathname.startsWith('/tutorials/')) {
      return null;
    }

    targetUrl.hash = '';
    targetUrl.search = '';
    if (targetUrl.pathname.length > 1) {
      targetUrl.pathname = targetUrl.pathname.replace(/\/+$/, '');
    }
    return targetUrl;
  } catch {
    return null;
  }
}

function inferSearchResultType(url: URL, title: string, description: string): string {
  const searchableText = `${title} ${description}`.toLowerCase();

  if (url.pathname.startsWith('/tutorials/') || /\btutorial\b/.test(searchableText)) {
    return 'documentation-tutorial';
  }

  if (url.pathname.startsWith('/documentation/samplecode') ||
      /\bsample (?:code|project)\b/.test(searchableText)) {
    return 'sample-code';
  }

  return 'documentation';
}

function extractFrameworkFromResultUrl(url: URL): string | undefined {
  if (!url.pathname.startsWith('/documentation/')) {
    return undefined;
  }

  const framework = url.pathname.split('/').filter(Boolean)[1];
  return framework ? normalizeFrameworkName(decodeURIComponent(framework)) : undefined;
}

function cleanExternalResultTitle(title: string): string {
  return title
    .replace(/\s*[|-]\s*Apple Developer(?: Documentation)?\s*$/i, '')
    .trim();
}

/**
 * Parse a site-restricted web search into the legacy SearchResult model.
 *
 * Apple's /search/ response is now only a JavaScript shell, and its private
 * client API is not available as a public JSON endpoint.
 */
export function isDocumentationWebSearchChallenge(html: string): boolean {
  try {
    const $ = cheerio.load(html);
    return $('#challenge-form').length > 0 ||
      $('.anomaly-modal').length > 0 ||
      $('form[action*="/anomaly.js"]').length > 0;
  } catch {
    return false;
  }
}

export function extractDocumentationWebSearchResults(
  html: string,
  filterType: string = 'all',
): SearchResult[] {
  if (isDocumentationWebSearchChallenge(html)) {
    throw new Error('Documentation search provider blocked the automated request');
  }

  try {
    const $ = cheerio.load(html);
    const results: SearchResult[] = [];
    const seenUrls = new Set<string>();

    $('.result').each((_, element) => {
      if (results.length >= API_LIMITS.MAX_SEARCH_RESULTS) {
        return false;
      }

      const resultElement = $(element);
      const titleElement = resultElement.find('.result__a').first();
      const url = extractAppleResultUrl(titleElement.attr('href'));
      const title = cleanExternalResultTitle(titleElement.text());

      if (!url || !title) {
        return true;
      }

      const canonicalUrl = url.href;
      if (seenUrls.has(canonicalUrl)) {
        return true;
      }

      const description = resultElement.find('.result__snippet').first().text().trim();
      const type = inferSearchResultType(url, title, description);
      if (!isResultTypeSupported(type, filterType)) {
        return true;
      }

      seenUrls.add(canonicalUrl);
      results.push({
        title,
        url: canonicalUrl,
        type,
        description,
        framework: extractFrameworkFromResultUrl(url),
        beta: /\bbeta\b/i.test(`${title} ${description}`),
      });

      return true;
    });

    return results;
  } catch (error) {
    logger.error('Error parsing documentation web search results:', error);
    return [];
  }
}

export function parseDocumentationWebSearchResults(
  html: string,
  query: string,
  searchUrl: string,
  filterType: string = 'all',
): { content: Array<{ type: string; text: string }> } {
  const results = extractDocumentationWebSearchResults(html, filterType);
  return {
    content: [{
      type: 'text',
      text: formatSearchResults(results, query, filterType, searchUrl),
    }],
  };
}
