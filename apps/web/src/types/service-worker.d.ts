/** Service Worker type definitions */

// Extend the global types to include SW-specific interfaces

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

interface ServiceWorkerGlobalScope extends EventTarget {
  self: ServiceWorkerGlobalScope;
  clients: ClientManager;
  caches: CacheStorage;
  skipWaiting(): void;
}

interface ClientManager {
  claim(): Promise<void>;
  matchAll(options?: ClientQueryOptions): Promise<Client[]>;
  openWindow(url: URL | string): Promise<WindowClient | null>;
}

interface ClientQueryOptions {
  includeUncontrolled?: boolean;
  type?: ClientType;
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

type ClientType = 'window' | 'worker' | 'sharedworker' | 'service' | 'all';
type ClientFrameType = 'nested' | 'top-level' | 'none';
type ClientFocusState = 'none' | 'focused' | 'not-focused';

// Extend Window interface to include SW APIs
declare const self: ServiceWorkerGlobalScope;

// RequestDestination type extension
type RequestDestination =
  | ''
  | 'audio'
  | 'audioworklet'
  | 'document'
  | 'embed'
  | 'font'
  | 'frame'
  | 'iframe'
  | 'image'
  | 'manifest'
  | 'object'
  | 'paintworklet'
  | 'report'
  | 'script'
  | 'sharedworker'
  | 'style'
  | 'track'
  | 'video'
  | 'worker'
  | 'xslt'
  | 'wasm';
