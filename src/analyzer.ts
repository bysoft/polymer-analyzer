/**
 * @license
 * Copyright (c) 2015 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

/// <reference path="../custom_typings/main.d.ts" />

import * as path from 'path';

import {Document, InlineParsedDocument, LocationOffset, ScannedDocument, ScannedElement, ScannedFeature, ScannedImport, correctSourceRange} from './model/model';
import {CssParser} from './css/css-parser';
import {Severity, Warning, WarningCarryingException} from './editor-service';
import {HtmlImportScanner} from './html/html-import-scanner';
import {HtmlParser} from './html/html-parser';
import {HtmlScriptScanner} from './html/html-script-scanner';
import {HtmlStyleScanner} from './html/html-style-scanner';
import {JavaScriptParser} from './javascript/javascript-parser';
import {JsonParser} from './json/json-parser';
import {ParsedDocument} from './parser/document';
import {Parser} from './parser/parser';
import {Measurement, TelemetryTracker} from './perf/telemetry';
import {BehaviorScanner} from './polymer/behavior-scanner';
import {CssImportScanner} from './polymer/css-import-scanner';
import {DomModuleScanner} from './polymer/dom-module-scanner';
import {PolymerElementScanner} from './polymer/polymer-element-scanner';
import {scan} from './scanning/scan';
import {Scanner} from './scanning/scanner';
import {UrlLoader} from './url-loader/url-loader';
import {UrlResolver} from './url-loader/url-resolver';
import {ElementScanner as VanillaElementScanner} from './vanilla-custom-elements/element-scanner';

export interface Options {
  urlLoader: UrlLoader;
  urlResolver?: UrlResolver;
  parsers?: Map<string, Parser<any>>;
  scanners?: Map<string, Scanner<any, any, any>[]>;
  /*
   * Map from url of an HTML Document to another HTML document it lazily depends
   * on.
   */
  lazyEdges: Map<string, string>;
}

export class NoKnownParserError extends Error {};

/**
 * A static analyzer for web projects.
 *
 * An Analyzer can load and parse documents of various types, and extract
 * arbitratrary information from the documents, and transitively load
 * dependencies. An Analyzer instance is configured with parsers, and scanners
 * which do the actual work of understanding different file types.
 */
export class Analyzer {
  private _parsers = new Map<string, Parser<ParsedDocument<any, any>>>([
    ['html', new HtmlParser()],
    ['js', new JavaScriptParser({sourceType: 'script'})],
    ['css', new CssParser()],
    ['json', new JsonParser()],
  ]);

  private _lazyEdges: Map<string, string>;

  private scanners = new Map<string, Scanner<any, any, any>[]>([
    [
      'html',
      [
        new HtmlImportScanner(this._lazyEdges),
        new HtmlScriptScanner(),
        new HtmlStyleScanner(),
        new DomModuleScanner(),
        new CssImportScanner()
      ]
    ],
    [
      'js',
      [
        new PolymerElementScanner(),
        new BehaviorScanner(),
        new VanillaElementScanner()
      ]
    ],
  ]);

  private _loader: UrlLoader;
  private _resolver: UrlResolver|undefined;
  private _parsedDocuments =
      new Map<string, Promise<ParsedDocument<any, any>>>();
  private _scannedDocuments = new Map<string, Promise<ScannedDocument>>();
  private _telemetryTracker = new TelemetryTracker();

  constructor(options: Options) {
    this._loader = options.urlLoader;
    this._resolver = options.urlResolver;
    this._parsers = options.parsers || this._parsers;
    this.scanners = options.scanners || this.scanners;
    this._lazyEdges = options.lazyEdges;
  }

  /**
   * Loads, parses and analyzes the root document of a dependency graph and its
   * transitive dependencies.
   *
   * Note: The analyzer only supports analyzing a single root for now. This
   * is because each analyzed document in the dependency graph has a single
   * root. This mean that we can't properly analyze app-shell-style, lazy
   * loading apps.
   *
   * @param contents Optional contents of the file when it is known without
   * reading it from disk. Clears the caches so that the news contents is used
   * and reanalyzed. Useful for editors that want to re-analyze changed files.
   */
  async analyzeRoot(url: string, contents?: string): Promise<Document> {
    const resolvedUrl = this._resolveUrl(url);

    // if we're given new contents, clear the cache
    // TODO(justinfagnani): It might be better to preserve a single code path
    // for loading file contents via UrlLoaders, and just offer a method to
    // re-analyze a particular file. Editors can use a UrlLoader that reads from
    // it's internal buffers.
    if (contents != null) {
      this._scannedDocuments.delete(resolvedUrl);
      this._parsedDocuments.delete(resolvedUrl);
    }

    const scannedDocument = await this._scanResolved(resolvedUrl, contents);
    const doneTiming =
        this._telemetryTracker.start('Document.makeRootDocument', url);
    const document = Document.makeRootDocument(scannedDocument);
    doneTiming();
    return document;
  }

  async getTelemetryMeasurements(): Promise<Measurement[]> {
    return this._telemetryTracker.getMeasurements();
  }

  private async _scanResolved(resolvedUrl: string, contents?: string):
      Promise<ScannedDocument> {
    const cachedResult = this._scannedDocuments.get(resolvedUrl);
    if (cachedResult) {
      return cachedResult;
    }
    const promise = (async() => {
      // Make sure we wait and return a Promise before doing any work, so that
      // the Promise is cached before anything else happens.
      await Promise.resolve();
      const document = await this._loadResolved(resolvedUrl, contents);
      return this._scanDocument(document);
    })();
    this._scannedDocuments.set(resolvedUrl, promise);
    return promise;
  }

  /**
   * Parses and scans a document from source.
   */
  private async _scanSource(
      type: string, contents: string, url: string,
      locationOffset?: LocationOffset,
      attachedComment?: string): Promise<ScannedDocument> {
    const resolvedUrl = this._resolveUrl(url);
    const document = this._parse(type, contents, resolvedUrl);
    return await this._scanDocument(document, locationOffset, attachedComment);
  }

  /**
   * Scans a parsed Document object.
   */
  private async _scanDocument(
      document: ParsedDocument<any, any>, maybeLocationOffset?: LocationOffset,
      maybeAttachedComment?: string): Promise<ScannedDocument> {
    // TODO(rictic): We shouldn't be calling _scanDocument with
    // null/undefined.
    if (document == null) {
      return null;
    }
    const locationOffset =
        maybeLocationOffset || {line: 0, col: 0, filename: document.url};
    const warnings: Warning[] = [];
    let scannedFeatures = await this._getScannedFeatures(document);
    // TODO(rictic): invert this and push the location offsets into the inline
    // documents so that the source ranges are correct when they're first
    // created.
    for (const scannedFeature of scannedFeatures) {
      if (scannedFeature instanceof ScannedElement) {
        scannedFeature.applyLocationOffset(locationOffset);
      }
    }
    // If there's an HTML comment that applies to this document then we assume
    // that it applies to the first feature.
    const firstScannedFeature = scannedFeatures[0];
    if (firstScannedFeature && firstScannedFeature instanceof ScannedElement) {
      firstScannedFeature.applyHtmlComment(maybeAttachedComment);
    }

    const scannedDependencies: ScannedFeature[] = scannedFeatures.filter(
        (e) => e instanceof InlineParsedDocument || e instanceof ScannedImport);
    const scannedSubDocuments =
        scannedDependencies.map(async(scannedDependency) => {
          if (scannedDependency instanceof InlineParsedDocument) {
            return this._scanInlineDocument(
                scannedDependency, document, warnings);
          } else if (scannedDependency instanceof ScannedImport) {
            return this._scanImport(scannedDependency, warnings);
          } else {
            throw new Error(`Unexpected dependency type: ${scannedDependency}`);
          }
        });

    const dependencies =
        (await Promise.all(scannedSubDocuments)).filter(s => !!s);

    return new ScannedDocument(
        document, dependencies, scannedFeatures, locationOffset, warnings);
  }

  /**
   * Scan an inline document found within a containing parsed doc.
   */
  private async _scanInlineDocument(
      inlineDoc: InlineParsedDocument,
      containingDocument: ParsedDocument<any, any>,
      warnings: Warning[]): Promise<ScannedDocument|null> {
    const locationOffset: LocationOffset = {
      line: inlineDoc.locationOffset.line,
      col: inlineDoc.locationOffset.col,
      filename: containingDocument.url
    };
    try {
      const scannedDocument = await this._scanSource(
          inlineDoc.type, inlineDoc.contents, containingDocument.url,
          locationOffset, inlineDoc.attachedComment);
      inlineDoc.scannedDocument = scannedDocument;
      inlineDoc.scannedDocument.isInline = true;
      return scannedDocument;
    } catch (err) {
      if (err instanceof WarningCarryingException) {
        const e: WarningCarryingException = err;
        e.warning.sourceRange =
            correctSourceRange(e.warning.sourceRange, locationOffset);
        warnings.push(e.warning);
        return null;
      }
      throw err;
    }
  }

  private async _scanImport(scannedImport: ScannedImport, warnings: Warning[]):
      Promise<ScannedDocument|null> {
    let scannedDocument: ScannedDocument;
    try {
      // HACK(rictic): this isn't quite right either, we need to get
      //     the scanned dependency's url relative to the basedir don't
      //     we?
      scannedDocument =
          await this._scanResolved(this._resolveUrl(scannedImport.url));
    } catch (error) {
      if (error instanceof NoKnownParserError) {
        // We probably don't want to fail when importing something
        // that we don't know about here.
        return null;
      }
      error = error || '';
      warnings.push({
        code: 'could-not-load',
        message: `Unable to load import: ${error.message || error}`,
        sourceRange: scannedImport.sourceRange,
        severity: Severity.ERROR
      });
      return null;
    }
    scannedImport.scannedDocument = scannedDocument;
    return scannedDocument;
  }

  private async _loadResolved(resolvedUrl: string, providedContents?: string):
      Promise<ParsedDocument<any, any>> {
    const cachedResult = this._parsedDocuments.get(resolvedUrl);
    if (cachedResult) {
      return cachedResult;
    }
    if (!this._loader.canLoad(resolvedUrl)) {
      throw new Error(`Can't load URL: ${resolvedUrl}`);
    }
    // Use an immediately executed async function to create the final Promise
    // synchronously so we can store it in this._documents before any other
    // async operations to avoid any race conditions.
    const promise = (async() => {
      // Make sure we wait and return a Promise before doing any work, so that
      // the Promise can be cached.
      await Promise.resolve();
      const content = providedContents == null ?
          await this._loader.load(resolvedUrl) :
          providedContents;
      const extension = path.extname(resolvedUrl).substring(1);

      const doneTiming = this._telemetryTracker.start('parse', 'resolvedUrl');
      const parsedDoc = this._parse(extension, content, resolvedUrl);
      doneTiming();
      return parsedDoc;
    })();
    this._parsedDocuments.set(resolvedUrl, promise);
    return promise;
  }

  private _parse(type: string, contents: string, url: string):
      ParsedDocument<any, any> {
    const parser = this._parsers.get(type);
    if (parser == null) {
      throw new NoKnownParserError(`No parser for for file type ${type}`);
    }
    try {
      return parser.parse(contents, url);
    } catch (error) {
      if (error instanceof WarningCarryingException) {
        throw error;
      }
      throw new Error(`Error parsing ${url}:\n ${error.stack}`);
    }
  }

  private async _getScannedFeatures(document: ParsedDocument<any, any>):
      Promise<ScannedFeature[]> {
    const scanners = this.scanners.get(document.type);
    if (scanners) {
      return scan(document, scanners);
    }
    return [];
  }

  /**
   * Resolves a URL with this Analyzer's `UrlResolver` if it has one, otherwise
   * returns the given URL.
   */
  private _resolveUrl(url: string): string {
    return this._resolver && this._resolver.canResolve(url) ?
        this._resolver.resolve(url) :
        url;
  }
}
