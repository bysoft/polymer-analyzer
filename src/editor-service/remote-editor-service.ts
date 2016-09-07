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
import * as path from 'path';
import * as util from 'util';

import {SourceRange} from '../ast/ast';

import {Request, RequestWrapper, ResponseWrapper} from './editor-server';
import {EditorService, SourcePosition, TypeaheadCompletion, Warning} from './editor-service';


/**
 * Runs the editor server in a new node process and exposes a promise based
 * request API for communicating with it.
 */
class EditorServerChannel {
  private _child: child_process.ChildProcess;
  private _idCounter = 0;
  private _outstandingRequests = new Map<number, Deferred<any>>();
  constructor() {
    const serverJsFile = path.join(__dirname, 'editor-server.js');
    this._child = child_process.fork(serverJsFile, [], {});
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
 * Runs in-process and communicates to the editor server, which
 * runs in a child process. Exposes the same interface as the
 * LocalEditorService.
 */
export class RemoteEditorService extends EditorService {
  private _channel = new EditorServerChannel();
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

interface Deferred<V> {
  resolve: (resp: V) => void;
  reject: (err: any) => void;
  promise: Promise<V>;
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
