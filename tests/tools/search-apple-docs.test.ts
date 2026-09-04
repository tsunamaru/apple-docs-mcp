jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    setRequestHandler: jest.fn(),
    connect: jest.fn(),
  })),
}));

jest.mock('../../src/tools/documentation-index-search.js', () => ({
  searchDocumentationIndexes: jest.fn(),
}));

jest.mock('../../src/utils/http-client.js', () => ({
  httpClient: {
    getText: jest.fn(),
  },
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
import { httpClient } from '../../src/utils/http-client.js';

const mockSearchIndexes = searchDocumentationIndexes as jest.MockedFunction<
  typeof searchDocumentationIndexes
>;
const mockGetText = httpClient.getText as jest.MockedFunction<typeof httpClient.getText>;

function providerResultHtml(title: string, path: string, description: string = ''): string {
  return `
    <div class="result">
      <a class="result__a" href="https://developer.apple.com${path}">
        ${title} | Apple Developer Documentation
      </a>
      <a class="result__snippet">${description}</a>
    </div>
  `;
}

describe('AppleDeveloperDocsMCPServer.searchAppleDocs', () => {
  let server: AppleDeveloperDocsMCPServer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchIndexes.mockResolvedValue([]);
    mockGetText.mockResolvedValue('<html><body class="no-results"></body></html>');
    server = new AppleDeveloperDocsMCPServer();
  });

  it('merges provider results even when a partial index result exists', async () => {
    mockSearchIndexes.mockResolvedValue([
      {
        title: 'UIViewControllerRepresentable',
        url: 'https://developer.apple.com/documentation/swiftui/uiviewcontrollerrepresentable',
        type: 'documentation',
        description: '',
      },
    ]);
    mockGetText.mockResolvedValue(providerResultHtml(
      'UIViewController',
      '/documentation/uikit/uiviewcontroller',
      'Manages a UIKit view hierarchy.',
    ));

    const response = await server.searchAppleDocs('uiviewcontroller');
    const text = response.content[0].text;

    expect(mockGetText).toHaveBeenCalledTimes(1);
    expect(text).toContain('**Results found:** 2');
    expect(text.indexOf('### 1. UIViewController\n')).toBeLessThan(
      text.indexOf('### 2. UIViewControllerRepresentable\n'),
    );
  });

  it('returns an error when the provider challenge leaves no index fallback', async () => {
    mockGetText.mockResolvedValue(`
      <form id="challenge-form" action="//duckduckgo.com/anomaly.js">
        <div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div>
      </form>
    `);

    const response = await server.searchAppleDocs('SKScene');

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain(
      'Documentation search provider blocked the automated request',
    );
  });

  it('uses deterministic index results when the provider is challenged', async () => {
    mockSearchIndexes.mockResolvedValue([
      {
        title: 'UIViewController',
        url: 'https://developer.apple.com/documentation/uikit/uiviewcontroller',
        type: 'documentation',
        description: '',
      },
    ]);
    mockGetText.mockResolvedValue('<form id="challenge-form"></form>');

    const response = await server.searchAppleDocs('UIViewController');

    expect(response.isError).toBeUndefined();
    expect(response.content[0].text).toContain('### 1. UIViewController');
  });

  it('does not exclude tutorial paths from the provider query', async () => {
    mockGetText.mockResolvedValue(providerResultHtml(
      'Develop in Swift',
      '/tutorials/develop-in-swift',
      'A collection of tutorials for learning Swift.',
    ));

    const response = await server.searchAppleDocs('Develop in Swift');
    const requestedUrl = mockGetText.mock.calls[0][0];

    expect(decodeURIComponent(requestedUrl)).toContain(
      'site:developer.apple.com Develop in Swift',
    );
    expect(response.content[0].text).toContain('Develop in Swift');
    expect(response.content[0].text).toContain('📖 Tutorials');
  });
});
