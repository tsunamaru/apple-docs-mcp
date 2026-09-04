jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn(),
  })),
}));

jest.mock('../../src/tools/documentation-index-search.js', () => ({
  searchDocumentationIndexes: jest.fn(),
}));

jest.mock('../../src/tools/documentation-search-providers.js', () => ({
  searchAppleDocumentationProvider: jest.fn(),
  searchSearxDocumentationProvider: jest.fn(),
}));

jest.mock('../../src/utils/logger.js', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import AppleDeveloperDocsMCPServer from '../../src/index.js';
import { searchDocumentationIndexes } from '../../src/tools/documentation-index-search.js';
import {
  searchAppleDocumentationProvider,
  searchSearxDocumentationProvider,
} from '../../src/tools/documentation-search-providers.js';

const mockSearchIndexes = searchDocumentationIndexes as jest.MockedFunction<
  typeof searchDocumentationIndexes
>;
const mockSearchApple = searchAppleDocumentationProvider as jest.MockedFunction<
  typeof searchAppleDocumentationProvider
>;
const mockSearchSearx = searchSearxDocumentationProvider as jest.MockedFunction<
  typeof searchSearxDocumentationProvider
>;

function documentationResult(title: string, framework: string, path: string) {
  return {
    title,
    url: `https://developer.apple.com/documentation/${path}`,
    type: 'documentation',
    description: '',
    framework,
    beta: false,
  };
}

describe('AppleDeveloperDocsMCPServer.searchAppleDocs', () => {
  let server: AppleDeveloperDocsMCPServer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchIndexes.mockResolvedValue([]);
    mockSearchApple.mockResolvedValue([]);
    mockSearchSearx.mockResolvedValue([]);
    server = new AppleDeveloperDocsMCPServer();
  });

  it('returns an exact DocC index match without calling external providers', async () => {
    mockSearchIndexes.mockResolvedValue([
      documentationResult(
        'MTLRenderCommandEncoder',
        'Metal',
        'metal/mtlrendercommandencoder',
      ),
    ]);

    const response = await server.searchAppleDocs('MTLRenderCommandEncoder');

    expect(mockSearchApple).not.toHaveBeenCalled();
    expect(mockSearchSearx).not.toHaveBeenCalled();
    expect(response.content[0].text).toContain('### 1. MTLRenderCommandEncoder');
  });

  it('merges Apple results with partial index matches and skips SearX', async () => {
    mockSearchIndexes.mockResolvedValue([
      documentationResult(
        'UIViewControllerRepresentable',
        'SwiftUI',
        'swiftui/uiviewcontrollerrepresentable',
      ),
    ]);
    mockSearchApple.mockResolvedValue([
      {
        ...documentationResult('UIViewController', 'UIKit', 'uikit/uiviewcontroller'),
        description: 'Manages a UIKit view hierarchy.',
      },
    ]);

    const response = await server.searchAppleDocs('uiviewcontroller');
    const text = response.content[0].text;

    expect(mockSearchApple).toHaveBeenCalledWith('uiviewcontroller', 'all');
    expect(mockSearchSearx).not.toHaveBeenCalled();
    expect(text).toContain('**Results found:** 2');
    expect(text.indexOf('### 1. UIViewController\n')).toBeLessThan(
      text.indexOf('### 2. UIViewControllerRepresentable\n'),
    );
  });

  it('uses SearX only when Apple returns no results', async () => {
    mockSearchSearx.mockResolvedValue([
      documentationResult('SKScene', 'SpriteKit', 'spritekit/skscene'),
    ]);

    const response = await server.searchAppleDocs('SKScene');

    expect(mockSearchApple).toHaveBeenCalledTimes(1);
    expect(mockSearchSearx).toHaveBeenCalledWith('SKScene', 'all');
    expect(response.content[0].text).toContain('### 1. SKScene');
  });

  it('uses SearX after an Apple provider failure', async () => {
    mockSearchApple.mockRejectedValue(new Error('Apple unavailable'));
    mockSearchSearx.mockResolvedValue([
      documentationResult('SKScene', 'SpriteKit', 'spritekit/skscene'),
    ]);

    const response = await server.searchAppleDocs('SKScene');

    expect(mockSearchSearx).toHaveBeenCalledTimes(1);
    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toContain('SKScene');
  });

  it('keeps partial index results when both external providers fail', async () => {
    mockSearchIndexes.mockResolvedValue([
      documentationResult('CameraView', 'HomeKit', 'homekit/cameraview'),
    ]);
    mockSearchApple.mockRejectedValue(new Error('Apple unavailable'));
    mockSearchSearx.mockRejectedValue(new Error('SearX unavailable'));

    const response = await server.searchAppleDocs('camera');

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toContain('CameraView');
  });

  it('returns an error when every search source is unavailable', async () => {
    mockSearchApple.mockRejectedValue(new Error('Apple unavailable'));
    mockSearchSearx.mockRejectedValue(new Error('SearX unavailable'));

    const response = await server.searchAppleDocs('UnknownSymbol');

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('Documentation search providers unavailable');
    expect(response.content[0].text).toContain('Apple unavailable');
    expect(response.content[0].text).toContain('SearX unavailable');
  });
});
