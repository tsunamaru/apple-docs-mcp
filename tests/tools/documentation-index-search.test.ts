jest.mock('../../src/utils/http-client.js', () => ({
  httpClient: {
    getJson: jest.fn(),
  },
}));

jest.mock('../../src/utils/logger.js', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

import { httpClient } from '../../src/utils/http-client.js';
import { indexCache } from '../../src/utils/cache.js';
import { CACHE_TTL } from '../../src/utils/constants.js';
import { searchDocumentationIndexes } from '../../src/tools/documentation-index-search.js';

const mockGetJson = httpClient.getJson as jest.MockedFunction<typeof httpClient.getJson>;

function indexWith(items: unknown[]) {
  return {
    interfaceLanguages: {
      swift: items,
    },
  };
}

function mockIndexResponse(url: string) {
  if (url.endsWith('/technologies')) {
    return indexWith([
      {
        children: [
          {
            path: '/documentation/uikit',
            title: 'UIKit',
            type: 'module',
          },
          {
            path: '/documentation/storekit',
            title: 'StoreKit',
            type: 'module',
          },
        ],
        title: 'App frameworks',
        type: 'groupMarker',
      },
    ]);
  }

  if (url.endsWith('/uikit')) {
    return indexWith([
      {
        path: '/documentation/uikit/uiviewcontroller',
        title: 'UIViewController',
        type: 'class',
      },
    ]);
  }

  if (url.endsWith('/storekit')) {
    return indexWith([
      {
        path: '/documentation/storekit',
        title: 'StoreKit',
        type: 'module',
      },
    ]);
  }

  if (url.endsWith('/metal')) {
    return indexWith([
      {
        path: '/documentation/metal/mtlrendercommandencoder',
        title: 'MTLRenderCommandEncoder',
        type: 'protocol',
      },
    ]);
  }

  if (url.endsWith('/observation')) {
    return indexWith([
      {
        path: '/documentation/observation/observable',
        title: 'Observable',
        type: 'protocol',
      },
    ]);
  }

  if (url.endsWith('/samplecode')) {
    return indexWith([
      {
        path: '/documentation/swiftui/food-truck',
        title: 'Food Truck sample code project',
        type: 'sampleCode',
      },
    ]);
  }

  if (url.endsWith('/swiftui')) {
    return indexWith([
      {
        path: '/documentation/swiftui/navigationstack',
        title: 'NavigationStack',
        type: 'struct',
      },
      {
        path: '/documentation/swiftui/scrollview',
        title: 'ScrollView',
        type: 'struct',
      },
      {
        path: '/documentation/swiftui/uiviewcontrollerrepresentable',
        title: 'UIViewControllerRepresentable',
        type: 'protocol',
      },
      {
        path: '/tutorials/develop-in-swift',
        title: 'Develop in Swift',
        type: 'overview',
      },
    ]);
  }

  return indexWith([]);
}

describe('searchDocumentationIndexes', () => {
  beforeEach(() => {
    indexCache.clear();
    mockGetJson.mockReset();
    mockGetJson.mockImplementation(async (url: string) => mockIndexResponse(url));
  });

  it.each([
    ['NavigationStack', '/documentation/swiftui/navigationstack'],
    ['Observable', '/documentation/observation/observable'],
    ['ScrollView', '/documentation/swiftui/scrollview'],
  ])('finds %s in Apple DocC indexes', async (query, expectedPath) => {
    const results = await searchDocumentationIndexes(query);

    expect(results.some(result => result.url.endsWith(expectedPath))).toBe(true);
  });

  it('matches API prefixes case-insensitively', async () => {
    const results = await searchDocumentationIndexes('uiviewcontroller');

    expect(mockGetJson).toHaveBeenCalledWith(
      'https://developer.apple.com/tutorials/data/index/uikit',
    );
    expect(results[0]).toMatchObject({
      title: 'UIViewController',
      url: 'https://developer.apple.com/documentation/uikit/uiviewcontroller',
    });
  });

  it('finds Metal APIs by their MTL prefix without a provider result', async () => {
    const results = await searchDocumentationIndexes('MTLRenderCommandEncoder');

    expect(mockGetJson).toHaveBeenCalledWith(
      'https://developer.apple.com/tutorials/data/index/metal',
    );
    expect(results[0]).toMatchObject({
      title: 'MTLRenderCommandEncoder',
      url: 'https://developer.apple.com/documentation/metal/mtlrendercommandencoder',
    });
  });

  it('discovers named framework indexes from the technologies index', async () => {
    const results = await searchDocumentationIndexes('StoreKit');

    expect(mockGetJson).toHaveBeenCalledWith(
      'https://developer.apple.com/tutorials/data/index/storekit',
    );
    expect(results.some(result => result.url ===
      'https://developer.apple.com/documentation/storekit')).toBe(true);
  });

  it('returns canonical tutorial paths', async () => {
    const results = await searchDocumentationIndexes('Develop in Swift');

    expect(results).toContainEqual(expect.objectContaining({
      title: 'Develop in Swift',
      type: 'documentation-tutorial',
      url: 'https://developer.apple.com/tutorials/develop-in-swift',
      framework: undefined,
    }));
  });

  it('honors the sample result filter', async () => {
    const results = await searchDocumentationIndexes('Food Truck', 'sample');

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('sample-code');
  });

  it('refreshes framework indexes after the configured cache TTL', async () => {
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      await searchDocumentationIndexes('NavigationStack');
      await searchDocumentationIndexes('NavigationStack');
      expect(mockGetJson.mock.calls.filter(([url]) => url.endsWith('/swiftui'))).toHaveLength(1);

      dateNow.mockReturnValue(1_000 + CACHE_TTL.FRAMEWORK_INDEX + 1);
      await searchDocumentationIndexes('NavigationStack');
      expect(mockGetJson.mock.calls.filter(([url]) => url.endsWith('/swiftui'))).toHaveLength(2);
    } finally {
      dateNow.mockRestore();
    }
  });
});
