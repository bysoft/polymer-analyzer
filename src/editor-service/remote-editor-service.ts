/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
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

import * as child_process from 'child_process';
import * as util from 'util';

import {SourceRange} from '../ast/ast';
import {FSUrlLoader} from '../url-loader/fs-url-loader';
import {PackageUrlResolver} from '../url-loader/package-url-resolver';

import {BaseEditor, SourcePosition, TypeaheadCompletion, Warning} from './editor-service';
import {EditorService} from './local-editor-service';

interface RequestWrapper {
  id: number;
  value: Request;
}
interface ResponseWrapper {
  id: number;
  value: SettledValue;
}
type SettledValue = Resolution | Rejection;
interface Resolution {
  kind: 'resolution';
  resolution: any;
}
interface Rejection {
  kind: 'rejection';
  rejection: string;
}

interface Deferred<V> {
  resolve: (resp: V) => void;
  reject: (err: any) => void;
  promise: Promise<V>;
}

type Request = InitRequest | FileChangedRequest | GetWarningsRequest |
    GetDocumentationRequest | GetDefinitionRequest |
    GetTypeaheadCompletionsRequest | ClearCachesRequest;
interface InitRequest {
  kind: 'init';
  basedir: string;
}
interface FileChangedRequest {
  kind: 'fileChanged';
  localPath: string;
  contents?: string;
}
interface GetWarningsRequest {
  kind: 'getWarningsFor';
  localPath: string;
}
interface GetDocumentationRequest {
  kind: 'getDocumentationFor';
  localPath: string;
  position: SourcePosition;
}
interface GetDefinitionRequest {
  kind: 'getDefinitionFor';
  localPath: string;
  position: SourcePosition;
}
interface GetTypeaheadCompletionsRequest {
  kind: 'getTypeaheadCompletionsFor';
  localPath: string;
  position: SourcePosition;
}
interface ClearCachesRequest {
  kind: 'clearCaches';
}

/**
 * Runs this file (remote-editor-service.js) in a new node process and
 * exposes a promise based request API for communicating with it.
 */
class SelfChannel {
  private _child: child_process.ChildProcess;
  private _idCounter = 0;
  private _outstandingRequests = new Map<number, Deferred<any>>();
  constructor() {
    this._child = child_process.fork(__filename, [], {});
    this._child.addListener(
        'message', (m: ResponseWrapper) => this._handleResponse(m));
  }

  async request(req: Request): Promise<any> {
    const id = this._idCounter++;
    const deferred = makeDeferred<any>();
    this._outstandingRequests.set(id, deferred);
    await this._sendRequest(id, req);
    return deferred.promise;
  }

  private _handleResponse(response: ResponseWrapper): void {
    const deferred = this._outstandingRequests.get(response.id);
    if (!deferred) {
      return;
    }
    switch (response.value.kind) {
      case 'resolution':
        return deferred.resolve(response.value.resolution);
      case 'rejection':
        return deferred.reject(response.value.rejection);
      default:
        const never: never = response.value;
        throw new Error(`Got unknown kind of response: ${util.inspect(never)}`);
    }
  }

  private async _sendRequest(id: number, value: Request): Promise<void> {
    const request: RequestWrapper = {id, value: value};
    await new Promise((resolve, reject) => {
      (<any>this._child.send)(
          request, (err: any) => err ? reject(err) : resolve());
    });
  }

  dispose(): void {
    this._child.kill();
  }
}

/**
 * Provides a similar interface to EditorServer, but implemented out of process.
 *
 * This class runs in-process and communicates via SelfChannel with
 * EditorServer, which runs in the child process.
 */
export class RemoteEditorService extends BaseEditor {
  private _channel = new SelfChannel();
  constructor(basedir: string) {
    super();
    this._channel.request({kind: 'init', basedir});
  }
  async getWarningsFor(localPath: string): Promise<Warning[]> {
    return this._channel.request({kind: 'getWarningsFor', localPath});
  }
  async fileChanged(localPath: string, contents?: string): Promise<void> {
    return this._channel.request({kind: 'fileChanged', localPath, contents});
  }

  async getDocumentationFor(localPath: string, position: SourcePosition):
      Promise<string|undefined> {
    return this._channel.request(
        {kind: 'getDocumentationFor', localPath, position});
  }

  async getDefinitionFor(localPath: string, position: SourcePosition):
      Promise<SourceRange> {
    return this._channel.request(
        {kind: 'getDefinitionFor', localPath, position});
  }

  async getTypeaheadCompletionsFor(localPath: string, position: SourcePosition):
      Promise<TypeaheadCompletion|undefined> {
    return this._channel.request(
        {kind: 'getTypeaheadCompletionsFor', localPath, position});
  }

  async clearCaches(): Promise<void> {
    return this._channel.request({kind: 'clearCaches'});
  }

  dispose(): void {
    this._channel.dispose();
  }
}

/**
 * Runs out of process and handles
 */
class EditorServer {
  private _editorService: EditorService;
  constructor(basedir: string) {
    this._editorService = new EditorService({
      urlLoader: new FSUrlLoader(basedir),
      urlResolver: new PackageUrlResolver()
    });
  }

  async handleMessage(message: Request): Promise<any> {
    switch (message.kind) {
      case 'getWarningsFor':
        return this._editorService.getWarningsFor(message.localPath);
      case 'fileChanged':
        await this._editorService.fileChanged(
            message.localPath, message.contents);
        return;
      case 'init':
        throw new Error('Already initialized!');
      case 'getDefinitionFor':
        return this._editorService.getDefinitionFor(
            message.localPath, message.position);
      case 'getDocumentationFor':
        return this._editorService.getDocumentationFor(
            message.localPath, message.position);
      case 'getTypeaheadCompletionsFor':
        return this._editorService.getTypeaheadCompletionsFor(
            message.localPath, message.position);
      case 'clearCaches':
        return this._editorService.clearCaches();
      default:
        // This assignment makes it a type error if we don't handle all possible
        // values of `message.kind`.
        const never: never = message;
        throw new Error(`Got unknown kind of message: ${util.inspect(never)}`);
    }
  }
}

function makeDeferred<V>(): Deferred<V> {
  let resolve: (value: V) => void;
  let reject: (err: any) => void;
  let promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {resolve, reject, promise};
}

if (!module.parent) {
  // We're in the child process! Or we're otherwise being run directly via
  // `node lib/remote-editor-service.js`
  // We're definitely not being imported as a library by other node code.

  let server: EditorServer;
  process.once('message', (initRequest: RequestWrapper) => {
    if (initRequest.value.kind !== 'init') {
      process.send(<ResponseWrapper>{
        id: initRequest.id,
        value: {
          kind: 'rejection',
          rejection: `Expected first message to be 'init', ` +
              `got ${initRequest.value.kind}`
        }
      });
      return;
    }
    server = new EditorServer(initRequest.value.basedir);

    process.on('message', async(request: RequestWrapper) => {
      const result = await getSettledValue(request.value);
      process.send(<ResponseWrapper>{id: request.id, value: result});
    });
  });

  async function getSettledValue(message: Request): Promise<SettledValue> {
    try {
      const value = await server.handleMessage(message);
      return {kind: 'resolution', resolution: value};
    } catch (e) {
      return {
        kind: 'rejection',
        rejection: e.stack || e.message || e.toString()
      };
    }
  }
}
