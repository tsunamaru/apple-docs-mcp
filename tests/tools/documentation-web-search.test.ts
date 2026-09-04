import {
  extractDocumentationWebSearchResults,
  mergeDocumentationSearchResults,
  parseDocumentationWebSearchResults,
} from '../../src/tools/search-parser.js';

describe('parseDocumentationWebSearchResults', () => {
  const appleSearchUrl = 'https://developer.apple.com/search/?q=NavigationStack';

  it('normalizes site-search results into Apple documentation results', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.apple.com%2Fdocumentation%2Fswiftui%2Fnavigationstack%2F&amp;rut=tracking">
          NavigationStack | Apple Developer Documentation
        </a>
        <a class="result__snippet">A view that presents additional views over a root view.</a>
      </div>
    `;

    const response = parseDocumentationWebSearchResults(
      html,
      'NavigationStack',
      appleSearchUrl,
    );
    const text = response.content[0].text;

    expect(text).toContain('**Results found:** 1');
    expect(text).toContain('### 1. NavigationStack');
    expect(text).toContain('**Framework:** SwiftUI');
    expect(text).toContain('https://developer.apple.com/documentation/swiftui/navigationstack');
    expect(text).toContain('A view that presents additional views');
  });

  it('accepts only canonical Apple documentation links and removes duplicates', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://developer.apple.com/documentation/swiftui/navigationstack/">NavigationStack</a>
        <a class="result__snippet">First result.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://developer.apple.com/documentation/swiftui/navigationstack?changes=latest">Duplicate</a>
        <a class="result__snippet">Duplicate result.</a>
      </div>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fevil.example%2Fdocumentation%2Ffake">Fake result</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://developer.apple.com/forums/thread/123">Forum result</a>
      </div>
    `;

    const response = parseDocumentationWebSearchResults(html, 'NavigationStack', appleSearchUrl);
    const text = response.content[0].text;

    expect(text).toContain('**Results found:** 1');
    expect(text).not.toContain('Duplicate result');
    expect(text).not.toContain('Fake result');
    expect(text).not.toContain('Forum result');
  });

  it('rejects DuckDuckGo bot challenges instead of reporting no results', () => {
    const challengeHtml = `
      <form id="challenge-form" action="//duckduckgo.com/anomaly.js">
        <div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div>
      </form>
    `;

    expect(() => extractDocumentationWebSearchResults(challengeHtml)).toThrow(
      'Documentation search provider blocked the automated request',
    );
  });

  it('accepts canonical Apple tutorial links', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://developer.apple.com/tutorials/develop-in-swift/">
          Develop in Swift | Apple Developer
        </a>
        <a class="result__snippet">A collection of tutorials for learning Swift.</a>
      </div>
    `;

    const results = extractDocumentationWebSearchResults(html);

    expect(results).toEqual([expect.objectContaining({
      title: 'Develop in Swift',
      type: 'documentation-tutorial',
      url: 'https://developer.apple.com/tutorials/develop-in-swift',
    })]);
  });

  it('ranks exact merged results ahead of partial index matches', () => {
    const partialIndexResult = {
      title: 'UIViewControllerRepresentable',
      url: 'https://developer.apple.com/documentation/swiftui/uiviewcontrollerrepresentable',
      type: 'documentation',
      description: '',
    };
    const exactProviderResult = {
      title: 'UIViewController',
      url: 'https://developer.apple.com/documentation/uikit/uiviewcontroller',
      type: 'documentation',
      description: 'Manages a UIKit view hierarchy.',
    };

    const results = mergeDocumentationSearchResults(
      [partialIndexResult],
      [exactProviderResult],
      'uiviewcontroller',
    );

    expect(results.map(result => result.title)).toEqual([
      'UIViewController',
      'UIViewControllerRepresentable',
    ]);
  });

  it('preserves documentation and sample filters', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://developer.apple.com/documentation/swiftui/navigationstack">NavigationStack</a>
        <a class="result__snippet">An API reference.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://developer.apple.com/documentation/swiftui/food-truck-building-a-swiftui-multiplatform-app">Food Truck sample</a>
        <a class="result__snippet">Download this sample code project.</a>
      </div>
    `;

    const documentation = parseDocumentationWebSearchResults(
      html,
      'SwiftUI',
      appleSearchUrl,
      'documentation',
    ).content[0].text;
    const sample = parseDocumentationWebSearchResults(
      html,
      'SwiftUI',
      appleSearchUrl,
      'sample',
    ).content[0].text;

    expect(documentation).toContain('NavigationStack');
    expect(documentation).not.toContain('Food Truck sample');
    expect(sample).toContain('Food Truck sample');
    expect(sample).not.toContain('### 1. NavigationStack');
  });
});
