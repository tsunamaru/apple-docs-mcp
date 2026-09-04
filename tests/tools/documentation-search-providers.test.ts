jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

jest.mock('../../src/utils/http-client.js', () => ({
  httpClient: {
    getJson: jest.fn(),
    postText: jest.fn(),
  },
}));

jest.mock('../../src/utils/cache.js', () => ({
  indexCache: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

import { lookup } from 'node:dns/promises';
import { indexCache } from '../../src/utils/cache.js';
import { DOCUMENTATION_SEARCH_URLS } from '../../src/utils/constants.js';
import { httpClient } from '../../src/utils/http-client.js';
import {
  parseAppleDocumentationSearchJsonl,
  searchAppleDocumentationProvider,
  searchSearxDocumentationProvider,
  selectSearxInstances,
} from '../../src/tools/documentation-search-providers.js';

const mockLookup = lookup as jest.MockedFunction<typeof lookup>;
const mockGetJson = httpClient.getJson as jest.MockedFunction<typeof httpClient.getJson>;
const mockPostText = httpClient.postText as jest.MockedFunction<typeof httpClient.postText>;
const mockCacheGet = indexCache.get as jest.MockedFunction<typeof indexCache.get>;

function appleMetadata(overrides: Record<string, unknown> = {}) {
  return {
    availability: 'iOS 8.0+',
    description: 'Encodes draw commands for a render pass.',
    hierarchy: 'Metal > MTLRenderCommandEncoder',
    kind: 'symbol',
    metadataKind: 'documentation',
    permalink: 'https://developer.apple.com/documentation/metal/mtlrendercommandencoder',
    title: 'MTLRenderCommandEncoder',
    ...overrides,
  };
}

function healthyInstance(success: number, uptime: number) {
  return {
    analytics: false,
    main: true,
    network_type: 'normal',
    http: {
      status_code: 200,
      error: null,
    },
    timing: {
      search: {
        success_percentage: success,
        all: { value: 0.5 },
      },
    },
    uptime: {
      uptimeMonth: uptime,
    },
  };
}

describe('Apple documentation search provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reconstructs incremental JSONL search results including removeLast edits', () => {
    const finalItem = {
      excerpt: 'Search excerpt',
      value: {
        metadata: appleMetadata(),
        origin: 'documentation',
      },
    };
    const events = [
      JSON.stringify({ kind: 'search', diff: { append: '{"results":[]}', removeLast: 0 } }),
      'not-json',
      JSON.stringify({
        kind: 'search',
        diff: {
          append: `${JSON.stringify(finalItem)}]}`,
          removeLast: 2,
        },
      }),
      JSON.stringify({ kind: 'searchFinished' }),
    ].join('\n');

    const results = parseAppleDocumentationSearchJsonl(events);

    expect(results).toEqual([{
      title: 'MTLRenderCommandEncoder',
      url: 'https://developer.apple.com/documentation/metal/mtlrendercommandencoder',
      type: 'documentation',
      description: 'Encodes draw commands for a render pass.',
      framework: 'Metal',
      beta: false,
    }]);
  });

  it('uses quick-search results when no complete search payload is available', () => {
    const events = [
      JSON.stringify({
        kind: 'quickSearch',
        response: {
          results: [{ metadata: appleMetadata() }],
        },
      }),
      JSON.stringify({ kind: 'quickSearchFinished' }),
    ].join('\n');

    const results = parseAppleDocumentationSearchJsonl(events);

    expect(results[0]).toMatchObject({
      title: 'MTLRenderCommandEncoder',
      framework: 'Metal',
    });
  });

  it('preserves angle brackets in trusted Apple symbol titles', () => {
    const events = JSON.stringify({
      kind: 'quickSearch',
      response: {
        results: [{
          metadata: appleMetadata({
            hierarchy: 'Swift > Array',
            permalink: 'https://developer.apple.com/documentation/swift/array',
            title: 'Array<Element>',
          }),
        }],
      },
    });

    const results = parseAppleDocumentationSearchJsonl(events);

    expect(results[0].title).toBe('Array<Element>');
  });

  it('rejects a malformed final buffer after an earlier valid result', () => {
    const validPayload = JSON.stringify({
      results: [{ metadata: appleMetadata() }],
    });
    const events = [
      JSON.stringify({ kind: 'search', diff: { append: validPayload, removeLast: 0 } }),
      JSON.stringify({ kind: 'search', diff: { append: '{', removeLast: 0 } }),
      JSON.stringify({ kind: 'searchFinished' }),
    ].join('\n');

    expect(() => parseAppleDocumentationSearchJsonl(events)).toThrow(
      'Apple documentation search returned an invalid JSONL response',
    );
  });

  it('rejects Apple result URLs with credentials or nonstandard ports', () => {
    const events = JSON.stringify({
      kind: 'quickSearch',
      response: {
        results: [
          { metadata: appleMetadata({
            permalink: 'https://user@developer.apple.com/documentation/metal',
          }) },
          { metadata: appleMetadata({
            permalink: 'https://developer.apple.com:8443/documentation/metal',
          }) },
        ],
      },
    });

    expect(parseAppleDocumentationSearchJsonl(events)).toEqual([]);
  });

  it('uses Apple metadata kind instead of sample wording in descriptions', () => {
    const events = JSON.stringify({
      kind: 'quickSearch',
      response: {
        results: [{ metadata: appleMetadata({
          description: 'Shows how to use this API in a sample project.',
          kind: 'symbol',
        }) }],
      },
    });

    expect(parseAppleDocumentationSearchJsonl(events, 'documentation')).toHaveLength(1);
    expect(parseAppleDocumentationSearchJsonl(events, 'sample')).toEqual([]);
  });

  it('rejects provider failures that contain no usable results', () => {
    const events = JSON.stringify({ kind: 'error', response: 'searchFailed' });

    expect(() => parseAppleDocumentationSearchJsonl(events)).toThrow(
      'Apple documentation search provider reported a failure',
    );
  });

  it('posts the documented filter shape to Apple search', async () => {
    mockPostText.mockResolvedValue([
      JSON.stringify({ kind: 'search', diff: { append: '{"results":[]}', removeLast: 0 } }),
      JSON.stringify({ kind: 'searchFinished' }),
    ].join('\n'));

    await searchAppleDocumentationProvider('Food Truck', 'sample');

    expect(mockPostText).toHaveBeenCalledWith(
      DOCUMENTATION_SEARCH_URLS.APPLE_PROVIDER,
      JSON.stringify({
        text: 'Food Truck',
        targetResultLocale: 'en_US',
        includedResponses: ['search'],
        filterCategory: { sampleCode: {} },
      }),
      expect.objectContaining({
        headers: {
          'Accept': 'application/jsonl',
          'Content-Type': 'application/json',
        },
      }),
    );
  });
});

describe('SearX documentation search provider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheGet.mockReturnValue(undefined);
    mockLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  it('selects only healthy public HTTPS instances in reliability order', () => {
    const selected = selectSearxInstances({
      instances: {
        'https://second.example/': healthyInstance(80, 100),
        'https://first.example/': healthyInstance(100, 99),
        'https://analytics.example/': {
          ...healthyInstance(100, 100),
          analytics: true,
        },
        'https://127.0.0.1/': healthyInstance(100, 100),
        'https://localhost./': healthyInstance(100, 100),
        'http://insecure.example/': healthyInstance(100, 100),
      },
    });

    expect(selected).toEqual([
      'https://first.example/',
      'https://second.example/',
    ]);
  });

  it('tries the next selected instance and normalizes Apple results', async () => {
    mockGetJson.mockImplementation(async (url: string) => {
      if (url === DOCUMENTATION_SEARCH_URLS.SEARX_INSTANCES) {
        return {
          instances: {
            'https://first.example/': healthyInstance(100, 100),
            'https://second.example/': healthyInstance(90, 100),
          },
        };
      }
      if (url.startsWith('https://first.example/search?')) {
        throw new Error('HTTP 429');
      }
      return {
        results: [{
          title: '<strong>MTLRenderCommandEncoder</strong> | Apple Developer Documentation',
          url: 'https://developer.apple.com/documentation/metal/mtlrendercommandencoder?changes=latest',
          content: 'Encodes commands for a render pass.',
        }],
      };
    });

    const results = await searchSearxDocumentationProvider('MTLRenderCommandEncoder');

    expect(mockGetJson.mock.calls.some(([url]) =>
      url.startsWith('https://first.example/search?'))).toBe(true);
    expect(mockGetJson.mock.calls.some(([url]) =>
      url.startsWith('https://second.example/search?'))).toBe(true);
    const secondSearchCall = mockGetJson.mock.calls.find(([url]) =>
      url.startsWith('https://second.example/search?'));
    expect(secondSearchCall?.[1]).toEqual(expect.objectContaining({ redirect: 'error' }));
    expect(results).toEqual([expect.objectContaining({
      title: 'MTLRenderCommandEncoder',
      url: 'https://developer.apple.com/documentation/metal/mtlrendercommandencoder',
      framework: 'Metal',
    })]);
  });

  it('rejects instances whose host resolves to a non-public address', async () => {
    mockGetJson.mockResolvedValue({
      instances: {
        'https://private.example/': healthyInstance(100, 100),
      },
    });
    mockLookup.mockResolvedValue([{ address: 'fe80::1', family: 6 }]);

    await expect(searchSearxDocumentationProvider('UIView')).rejects.toThrow(
      'SearX instance resolved to a non-public address',
    );
    expect(mockGetJson).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the directory has no usable instances', async () => {
    mockGetJson.mockResolvedValue({
      instances: {
        'http://insecure.example/': healthyInstance(100, 100),
      },
    });

    await expect(searchSearxDocumentationProvider('UIView')).rejects.toThrow(
      'No healthy SearX instances are currently available',
    );
  });
});
