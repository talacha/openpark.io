/// <reference lib="webworker" />

import { SwManifest } from '../offline-cache/sw-manifest.js';

// Extend global types for Service Worker context
interface Window {
  addEventListener<K extends keyof ServiceWorkerGlobalScopeEventMap>(
    type: K,
    listener: (this: ServiceWorkerGlobalScope, ev: ServiceWorkerGlobalScopeEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void;
}

interface ServiceWorkerGlobalScopeEventMap {
  install: ExtendableEvent;
  activate: ExtendableEvent;
  fetch: FetchEvent;
  message: ExtendableMessageEvent;
  messageerror: MessageEvent;
}

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

interface ExtendableMessageEvent extends ExtendableEvent {
  data: unknown;
  ports?: MessagePort[];
  source?: MessagePort | Window | ServiceWorker | Worker;
}

interface ServiceWorkerGlobalScope extends WorkerGlobalScope {
  self: ServiceWorkerGlobalScope;
  clients: ClientManager;
  caches: CacheStorage;
  skipWaiting(): void;
  readonly registration: ServiceWorkerRegistration;
}

interface ClientManager {
  claim(): Promise<void>;
  matchAll(options?: ClientQueryOptions): Promise<Client[]>;
  openWindow(url: URL | string): Promise<WindowClient | null>;
}

interface Client {
  id: string;
  url: string;
  frameType: ClientFrameType;
  type: ClientType;
  visible: boolean;
  focused: boolean;
  focusState: ClientFocusState;
}

interface ClientQueryOptions {
  includeUncontrolled?: boolean;
  type?: ClientType;
}

interface WindowClient extends Client {
  focused: boolean;
  visibilityState: VisibilityState;
}

type ClientType = 'window' | 'worker' | 'sharedworker' | 'service' | 'all';
type ClientFrameType = 'nested' | 'top-level' | 'none';
type ClientFocusState = 'none' | 'focused' | 'not-focused';

declare const self: ServiceWorkerGlobalScope;

// SW manifest is injected at build time
declare const __SW_MANIFEST__: SwManifest;
